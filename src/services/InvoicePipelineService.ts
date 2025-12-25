import prisma from '../infrastructure/prismaClient';
import { s3Service } from './S3Service';
import { ocrService } from './OcrService';
import { supplierResolutionService } from './SupplierResolutionService';
import { imagePreprocessingService } from './ImagePreprocessingService';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, SupplierSourceType, SupplierStatus as PrismaSupplierStatus, OcrFailureCategory, VerificationSource } from '@prisma/client';
import { randomUUID } from 'crypto';
import { MANUAL_COGS_ACCOUNT_CODE } from '../config/constants';
import { assertDateRangeOrThrow, assertWindowIfDeepPagination, getOffsetPaginationOrThrow, parseDateOrThrow } from '../utils/paginationGuards';

import { getProductKeyFromLineItem } from './helpers/productKey';
import { assertCanonicalInvoiceLegacyLink, canonicalizeLine } from './canonical';

export class InvoiceFileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceFileNotFoundError';
  }
}

export class BulkActionError extends Error {
    results: any;
    constructor(message: string, results: any) {
        super(message);
        this.name = 'BulkActionError';
        this.results = results;
    }
}

import { pusherService } from './pusherService';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';

const DEFAULT_CURRENCY_CODE = 'AUD';

// ============================================================================
// Auto-Approval Configuration & Types
// ============================================================================

/**
 * Confidence threshold for auto-approval eligibility.
 * Invoices with confidenceScore >= this value are considered high-confidence.
 */
const HIGH_CONFIDENCE_THRESHOLD = 90;

/**
 * Type for line-item quality summary used in auto-approval decisions.
 */
type LineItemQualitySummary = {
  totalCount: number;
  includedCount: number;
  excludedCount: number;
  excludedReasons: string[];
  totalSpend: number;
  excludedSpend: number;
  excludedSpendPct: number | null;
};

/**
 * Result of auto-approval eligibility check.
 * Returns explicit reason codes for debugging and logging.
 */
type AutoApprovalResult =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Pure function to determine if an invoice is eligible for auto-approval.
 * 
 * @param invoiceFile - The invoice file record
 * @param invoice - The invoice record (with total and supplier for security checks)
 * @param lineItemQualitySummary - Quality summary from canonical line items
 * @param locationAutoApproveEnabled - Whether the location has auto-approval enabled
 * @returns Eligibility result with explicit reason if not eligible
 */
function isInvoiceAutoApprovable(
  invoiceFile: { reviewStatus: ReviewStatus; processingStatus: ProcessingStatus; confidenceScore: number | null },
  invoice: { total: any; supplier?: { status: PrismaSupplierStatus } | null },
  lineItemQualitySummary: LineItemQualitySummary | null,
  locationAutoApproveEnabled: boolean
): AutoApprovalResult {
  // 1. Feature flag must be enabled
  if (!locationAutoApproveEnabled) {
    return { eligible: false, reason: 'FEATURE_DISABLED' };
  }

  // 2. Already verified - skip (idempotent)
  if (invoiceFile.reviewStatus === ReviewStatus.VERIFIED) {
    return { eligible: false, reason: 'ALREADY_VERIFIED' };
  }

  // 3. Manual edits block auto-approval (manual always wins)
  if (invoiceFile.processingStatus === ProcessingStatus.MANUALLY_UPDATED) {
    return { eligible: false, reason: 'HAS_MANUAL_EDITS' };
  }

  // 4. Supplier must exist and be ACTIVE (prevents "Trojan Horse" attacks)
  // New suppliers auto-created from OCR have PENDING_REVIEW status and must be
  // manually verified before their invoices can be auto-approved.
  if (!invoice.supplier) {
    return { eligible: false, reason: 'NO_SUPPLIER' };
  }
  if (invoice.supplier.status !== PrismaSupplierStatus.ACTIVE) {
    return { eligible: false, reason: 'SUPPLIER_NOT_ACTIVE' };
  }

  // 5. Must have quality data
  if (!lineItemQualitySummary) {
    return { eligible: false, reason: 'NO_QUALITY_DATA' };
  }

  // 6. Must have line items
  if (lineItemQualitySummary.totalCount === 0) {
    return { eligible: false, reason: 'NO_LINE_ITEMS' };
  }

  // 7. All line items must be included in analytics (excludedCount === 0)
  if (lineItemQualitySummary.excludedCount > 0) {
    return { eligible: false, reason: 'HAS_EXCLUDED_LINES' };
  }

  // 8. Confidence threshold check
  const confidence = invoiceFile.confidenceScore ?? 0;
  if (confidence < HIGH_CONFIDENCE_THRESHOLD) {
    return { eligible: false, reason: 'LOW_CONFIDENCE' };
  }

  // 9. Credit note proxy - negative totals blocked until we have invoiceType
  const total = invoice.total?.toNumber?.() ?? Number(invoice.total) ?? 0;
  if (total < 0) {
    return { eligible: false, reason: 'NEGATIVE_TOTAL' };
  }

  return { eligible: true };
}

/**
 * Classify OCR failure based on error, confidence, and text detection
 */
function classifyOcrFailure(
  error: any,
  confidenceScore?: number,
  detectedTextWords?: number
): { category: OcrFailureCategory; detail: string } {
  // Early abort cases (low quality input)
  if (detectedTextWords !== undefined && detectedTextWords < 5) {
    return {
      category: OcrFailureCategory.NOT_A_DOCUMENT,
      detail: `Detected only ${detectedTextWords} words, likely not a document`,
    };
  }

  if (confidenceScore !== undefined && confidenceScore < 10) {
    return {
      category: OcrFailureCategory.NOT_A_DOCUMENT,
      detail: `Confidence score ${confidenceScore}% is too low`,
    };
  }

  // AWS Textract specific errors
  const errorMessage = error?.message || error?.toString() || '';
  const errorCode = error?.name || error?.code || '';

  if (errorCode === 'ThrottlingException' || errorMessage.includes('throttle')) {
    return {
      category: OcrFailureCategory.PROVIDER_TIMEOUT,
      detail: 'OCR provider rate limit exceeded',
    };
  }

  if (errorCode === 'InvalidParameterException' || errorMessage.includes('invalid')) {
    return {
      category: OcrFailureCategory.DOCUMENT_TYPE_MISMATCH,
      detail: 'Invalid document format or type',
    };
  }

  if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
    return {
      category: OcrFailureCategory.PROVIDER_TIMEOUT,
      detail: 'OCR processing timed out',
    };
  }

  if (errorMessage.includes('blur') || errorMessage.includes('Blur')) {
    return {
      category: OcrFailureCategory.BLURRY,
      detail: 'Image is too blurry for OCR',
    };
  }

  if (errorMessage.includes('resolution') || errorMessage.includes('Resolution')) {
    return {
      category: OcrFailureCategory.LOW_RESOLUTION,
      detail: 'Image resolution is too low',
    };
  }

  // Generic provider errors
  if (errorCode || errorMessage) {
    return {
      category: OcrFailureCategory.PROVIDER_ERROR,
      detail: errorMessage || `Provider error: ${errorCode}`,
    };
  }

  // Default fallback
  return {
    category: OcrFailureCategory.UNKNOWN,
    detail: 'OCR processing failed for unknown reason',
  };
}

/**
 * Count detected words from parsed OCR result
 */
function countDetectedWords(parsed: any): number {
  let wordCount = 0;
  
  if (parsed.supplierName) wordCount += parsed.supplierName.split(/\s+/).length;
  if (parsed.invoiceNumber) wordCount += parsed.invoiceNumber.split(/\s+/).length;
  
  if (parsed.lineItems) {
    for (const item of parsed.lineItems) {
      if (item.description) {
        wordCount += item.description.split(/\s+/).length;
      }
    }
  }
  
  return wordCount;
}

export const invoicePipelineService = {
  /**
   * Line-item quality summary for trust + analytics inclusion (price monitoring).
   *
   * Definitions:
   * - "included" lines are qualityStatus=OK (included in analytics)
   * - "excluded" lines are qualityStatus=WARN (currently excluded from analytics)
   * - Spend is "merchandise spend only": sum(max(0, lineTotal)) using integer cents
   */
  async computeLineItemQualitySummary(legacyInvoiceId: string) {
      const prismaAny = prisma as any;

      const canonical = await prismaAny.canonicalInvoice.findUnique({
          where: { legacyInvoiceId },
          select: {
              lineItems: {
                  select: {
                      qualityStatus: true,
                      warnReasons: true,
                      lineTotal: true,
                  },
              },
          },
      });

      if (!canonical) return null;

      const lines = (canonical.lineItems || []) as Array<{
          qualityStatus: 'OK' | 'WARN';
          warnReasons: string[] | null;
          lineTotal: any;
      }>;

      const toNumber = (v: any): number => {
          if (v === null || v === undefined) return 0;
          if (typeof v === 'number') return v;
          if (typeof v?.toNumber === 'function') return v.toNumber();
          return Number(v);
      };

      const toMerchCents = (lineTotal: any): number => {
          const n = toNumber(lineTotal);
          if (!Number.isFinite(n)) return 0;
          return Math.max(0, Math.round(n * 100));
      };

      const totalCount = lines.length;
      const includedCount = lines.filter((l) => l.qualityStatus === 'OK').length;
      const excludedLines = lines.filter((l) => l.qualityStatus === 'WARN');
      const excludedCount = excludedLines.length;

      const excludedReasons = Array.from(
          new Set(excludedLines.flatMap((l) => l.warnReasons || []))
      ).sort();

      const totalSpendCents = lines.reduce((sum, l) => sum + toMerchCents(l.lineTotal), 0);
      const excludedSpendCents = excludedLines.reduce((sum, l) => sum + toMerchCents(l.lineTotal), 0);

      const totalSpend = totalSpendCents / 100;
      const excludedSpend = excludedSpendCents / 100;
      const excludedSpendPct =
          totalSpendCents > 0 ? Math.round((excludedSpendCents / totalSpendCents) * 10000) / 100 : null; // percent, 2dp

      return {
          totalCount,
          includedCount,
          excludedCount,
          excludedReasons,
          totalSpend,
          excludedSpend,
          excludedSpendPct,
      };
  },

  /**
   * Per-line issues for the Invoice Review Modal.
   *
   * Purpose: allow the UI to highlight which specific invoice line item(s) are excluded from analytics.
   *
   * Mapping strategy:
   * - For MANUAL canonical lines, sourceLineRef encodes the legacy invoiceLineItem id (stable mapping).
   * - For OCR canonical lines, sourceLineRef encodes an index "line:{idx}" scoped to invoiceFileId. We map idx
   *   to the legacy invoice line items ordered by createdAt ASC (creation order from OCR ingestion).
   */
  async computeLineItemQualityIssues(params: { legacyInvoiceId: string; invoiceFileId?: string | null }) {
      const prismaAny = prisma as any;

      const canonical = await prismaAny.canonicalInvoice.findUnique({
          where: { legacyInvoiceId: params.legacyInvoiceId },
          select: {
              lineItems: {
                  select: {
                      qualityStatus: true,
                      warnReasons: true,
                      sourceLineRef: true,
                  },
              },
          },
      });

      if (!canonical) return null;

      const excludedCanonicalLines = (canonical.lineItems || []).filter(
          (l: any) => l?.qualityStatus === 'WARN'
      ) as Array<{ warnReasons: string[] | null; sourceLineRef: string | null }>;

      if (excludedCanonicalLines.length === 0) return [];

      // Fetch legacy line items in a stable order for OCR idx mapping.
      const legacyInvoice = await prismaAny.invoice.findUnique({
          where: { id: params.legacyInvoiceId },
          select: {
              lineItems: {
                  orderBy: { createdAt: 'asc' },
                  select: { id: true },
              },
          },
      });

      const legacyLineItems = (legacyInvoice?.lineItems || []) as Array<{ id: string }>;

      const issues: Array<{ invoiceLineItemId: string; reasons: string[] }> = [];

      for (const l of excludedCanonicalLines) {
          const reasons = Array.from(new Set((l.warnReasons || []).filter(Boolean)));
          const ref = l.sourceLineRef || '';

          // MANUAL path: invoiceId:{invoiceId}:manual:{invoiceLineItemId}
          const manualMatch = ref.match(/:manual:([^:]+)$/);
          if (manualMatch?.[1]) {
              issues.push({ invoiceLineItemId: manualMatch[1], reasons });
              continue;
          }

          // OCR path: invoiceFileId:{fileId}:line:{idx}
          const idxMatch = ref.match(/:line:(\d+)$/);
          const idx = idxMatch ? Number(idxMatch[1]) : NaN;
          if (
              Number.isFinite(idx) &&
              idx >= 0 &&
              params.invoiceFileId &&
              ref.startsWith(`invoiceFileId:${params.invoiceFileId}:line:`)
          ) {
              const legacyLine = legacyLineItems[idx];
              if (legacyLine?.id) {
                  issues.push({ invoiceLineItemId: legacyLine.id, reasons });
              }
          }
      }

      return issues;
  },

  /**
   * Compute reconciliation and analytics exclusion summary for a legacy (OCR/MANUAL) invoice
   * using canonical line items.
   *
   * Notes:
   * - excludedCount represents lines excluded from analytics (currently equivalent to qualityStatus=WARN)
   * - all monetary math is done server-side and summed in integer cents to reduce float drift
   */
  async computeReconciliationSummary(params: {
      invoiceId: string;
      documentSubtotal: number | null | undefined;
      documentTotal: number | null | undefined;
      documentTax: number | null | undefined;
  }) {
      const prismaAny = prisma as any;

      // Only select the minimal fields required for the summary (performance + payload).
      const canonical = await prismaAny.canonicalInvoice.findUnique({
          where: { legacyInvoiceId: params.invoiceId },
          select: {
              lineItems: {
                  select: {
                      qualityStatus: true,
                      warnReasons: true,
                      lineTotal: true,
                  }
              }
          }
      });

      if (!canonical) return null;

      const lines = (canonical.lineItems || []) as Array<{
          qualityStatus: 'OK' | 'WARN';
          warnReasons: string[] | null;
          lineTotal: any;
      }>;

      const totalCount = lines.length;
      const warnLines = lines.filter((l) => l.qualityStatus === 'WARN');

      // excludedCount = lines excluded from analytics (currently = WARN qualityStatus)
      const excludedCount = warnLines.length;

      // Guard null warnReasons, sort for stable UI
      const excludedReasons = Array.from(
          new Set(warnLines.flatMap((l) => l.warnReasons || []))
      ).sort();

      const toNumber = (v: any): number => {
          if (v === null || v === undefined) return 0;
          if (typeof v === 'number') return v;
          if (typeof v?.toNumber === 'function') return v.toNumber();
          return Number(v);
      };

      // Sum in integer cents to avoid floating point drift across many lines.
      const sumCents = lines.reduce((sum, l) => sum + Math.round(toNumber(l.lineTotal) * 100), 0);
      const sumLineTotal = sumCents / 100;

      // Inputs (document-level fields):
      const documentSubtotalMissing =
          params.documentSubtotal === null || params.documentSubtotal === undefined;
      const documentTotalMissing =
          params.documentTotal === null || params.documentTotal === undefined;

      const docSubtotal = documentSubtotalMissing ? null : toNumber(params.documentSubtotal);
      const docTotal = documentTotalMissing ? null : toNumber(params.documentTotal);
      const docTax =
          params.documentTax === null || params.documentTax === undefined ? null : toNumber(params.documentTax);

      // Adjustments awareness: taxes/discounts/fees are not products and must not invalidate subtotal parity.
      // We treat "adjustmentsPresent" as:
      // - explicit tax > 0
      // - OR subtotal and total differ by > 1 cent
      const adjustmentsValue =
          docSubtotal !== null && docTotal !== null ? Math.round((docTotal - docSubtotal) * 100) / 100 : null;
      const adjustmentsPresent =
          (docTax !== null && Math.abs(docTax) > 0.01) ||
          (adjustmentsValue !== null && Math.abs(adjustmentsValue) > 0.01);

      // Primary reconciliation: line item sum vs document subtotal
      let deltaSubtotalValue: number | null = null;
      if (docSubtotal !== null) {
          const docSubtotalCents = Math.round(docSubtotal * 100);
          deltaSubtotalValue = (sumCents - docSubtotalCents) / 100;
      }

      let deltaSubtotalPct: number | null = null;
      if (docSubtotal !== null && docSubtotal !== 0 && deltaSubtotalValue !== null) {
          deltaSubtotalPct = Math.round((deltaSubtotalValue / docSubtotal) * 10000) / 100;
      }

      // Secondary/reference delta: line item sum vs document grand total (informational only)
      let deltaTotalValue: number | null = null;
      if (docTotal !== null) {
          const docTotalCents = Math.round(docTotal * 100);
          deltaTotalValue = (sumCents - docTotalCents) / 100;
      }

      let deltaTotalPct: number | null = null;
      if (docTotal !== null && docTotal !== 0 && deltaTotalValue !== null) {
          deltaTotalPct = Math.round((deltaTotalValue / docTotal) * 10000) / 100;
      }

      return {
          totalCount,
          excludedCount,
          excludedReasons,
          sumLineTotal,
          documentSubtotal: docSubtotal,
          documentTotal: docTotal,
          documentTax: docTax,
          adjustmentsPresent,
          adjustmentsValue,
          documentSubtotalMissing,
          deltaSubtotalValue,
          deltaSubtotalPct,
          deltaTotalValue,
          deltaTotalPct,
      };
  },

  async processPendingOcrJobs() {
      // 1. Find all files that are currently processing
      const processingFiles = await prisma.invoiceFile.findMany({
          where: { 
              processingStatus: ProcessingStatus.OCR_PROCESSING, 
              ocrJobId: { not: null },
              deletedAt: null
          } as any,
          take: 50 // Batch size limit
      });

      if (processingFiles.length === 0) return;

      console.log(`[InvoicePipeline] Checking ${processingFiles.length} pending OCR jobs...`);

      // 2. Check each one
      for (const file of processingFiles) {
          try {
              // Keep a copy of the original status
              const originalStatus = file.processingStatus;
              
              // Call pollProcessing to get the latest status (it updates the DB)
              const updated = await this.pollProcessing(file.id);
              
              // 3. If status changed (e.g., to OCR_COMPLETE or OCR_FAILED), trigger Pusher
              if (updated.processingStatus !== originalStatus) {
                  console.log(`[InvoicePipeline] Status changed for ${file.id}: ${originalStatus} -> ${updated.processingStatus}`);
                  
                  const channel = pusherService.getOrgChannel(updated.organisationId);
                  
                  await pusherService.triggerEvent(channel, 'invoice-status-updated', {
                      invoiceFileId: updated.id,
                      status: updated.processingStatus,
                      locationId: updated.locationId,
                      updatedAt: updated.updatedAt,
                      reviewStatus: updated.reviewStatus,
                      verificationSource: updated.verificationSource ?? null,
                      verifiedAt: updated.verifiedAt ?? null,
                      invoice: updated.invoice ?? null,
                      ocrFailureCategory: updated.ocrFailureCategory ?? null,
                      ocrFailureDetail: updated.ocrFailureDetail ?? null,
                      // Canonicalization quality data (available after OCR_COMPLETE)
                      lineItemQualitySummary: updated.lineItemQualitySummary ?? null,
                      lineItemQualityIssues: updated.lineItemQualityIssues ?? null,
                  });
              }
          } catch (err) {
              console.error(`[InvoicePipeline] Error processing pending OCR job for file ${file.id}:`, err);
              // Continue to next file
          }
      }
  },

  async cleanupOrphanedOcrJobs() {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes
    
    const orphanedFiles = await prisma.invoiceFile.findMany({
      where: {
        deletedAt: null,
        updatedAt: { lt: staleThreshold }, // Use updatedAt, not createdAt
        OR: [
          { processingStatus: ProcessingStatus.PENDING_OCR },
          { 
            processingStatus: ProcessingStatus.OCR_PROCESSING,
            ocrJobId: null // Only if no job started
          }
        ]
      },
      take: 10 // Small batch to avoid DB thrash
    });

    if (orphanedFiles.length === 0) return;

    console.log(`[InvoicePipeline] Cleaning up ${orphanedFiles.length} orphaned OCR jobs...`);

    for (const file of orphanedFiles) {
      if ((file.ocrAttemptCount || 0) < 3) {
        // RETRY: Explicitly reset state for clean retry
        const attemptCount = (file.ocrAttemptCount || 0) + 1;
        const res = await prisma.invoiceFile.updateMany({
          where: {
            id: file.id,
            deletedAt: null,
            updatedAt: { lt: staleThreshold },
            processingStatus: file.processingStatus,
            ocrAttemptCount: file.ocrAttemptCount || 0,
            ...(file.processingStatus === ProcessingStatus.OCR_PROCESSING ? { ocrJobId: null } : {}),
          } as any,
          data: {
            processingStatus: ProcessingStatus.PENDING_OCR,
            ocrAttemptCount: { increment: 1 },
            // Clear failure fields for clean slate
            ocrFailureCategory: null,
            ocrFailureDetail: null,
            failureReason: null,
            ocrJobId: null,
          },
        });
        if (res.count === 0) {
          // Lost the race / already handled
          continue;
        }
        // Let processPendingOcrJobs() pick it up on next tick
        console.log(`[InvoicePipeline] Reset orphaned file ${file.id} to PENDING_OCR for retry (attempt ${attemptCount})`);
      } else {
        // FAIL: Max attempts reached
        const res = await prisma.invoiceFile.updateMany({
          where: {
            id: file.id,
            deletedAt: null,
            updatedAt: { lt: staleThreshold },
            processingStatus: file.processingStatus,
            ocrAttemptCount: file.ocrAttemptCount || 0,
            ...(file.processingStatus === ProcessingStatus.OCR_PROCESSING ? { ocrJobId: null } : {}),
          } as any,
          data: {
            processingStatus: ProcessingStatus.OCR_FAILED,
            ocrFailureCategory: OcrFailureCategory.PROVIDER_TIMEOUT,
            ocrFailureDetail: 'Processing timed out after multiple attempts',
            failureReason: 'Processing timed out after multiple attempts',
          },
        });
        if (res.count === 0) {
          // Lost the race / already handled
          continue;
        }

        const updated = await prisma.invoiceFile.findUnique({
          where: { id: file.id },
          select: { organisationId: true, locationId: true, updatedAt: true },
        });
        
        // Send Pusher (non-blocking)
        if (updated?.organisationId) {
          try {
            const channel = pusherService.getOrgChannel(updated.organisationId);
            await pusherService.triggerEvent(channel, 'invoice-status-updated', {
              invoiceFileId: file.id,
              status: ProcessingStatus.OCR_FAILED,
              locationId: updated.locationId,
              updatedAt: updated.updatedAt,
              ocrFailureCategory: OcrFailureCategory.PROVIDER_TIMEOUT,
              ocrFailureDetail: 'Processing timed out after multiple attempts',
            });
          } catch (e) {
            console.warn(`[InvoicePipeline] Pusher emit failed for orphaned file ${file.id}:`, e);
          }
        }
        console.log(`[InvoicePipeline] Marked orphaned file ${file.id} as OCR_FAILED (max attempts reached)`);
      }
    }
  },

  async startOcrProcessing(invoiceFileId: string) {
    try {
      const file = await prisma.invoiceFile.findFirst({
        where: { 
          id: invoiceFileId, 
          processingStatus: { in: [ProcessingStatus.PENDING_OCR, ProcessingStatus.OCR_FAILED] },
          deletedAt: null 
        } as any,
        select: {
          id: true,
          organisationId: true,
          locationId: true,
          storageKey: true,
          mimeType: true,
          ocrAttemptCount: true,
        }
      });

      if (!file) {
        throw new Error(`InvoiceFile ${invoiceFileId} not found or not in valid status for OCR`);
      }

      if (!file.storageKey) {
        throw new Error(`InvoiceFile ${invoiceFileId} has no storageKey`);
      }

      // Capture for Pusher in case of failure
      const { organisationId, locationId } = file;

      // Check attempt count (max 3 attempts)
      const attemptCount = (file.ocrAttemptCount || 0) + 1;
      if (attemptCount > 3) {
        throw new Error(`Maximum OCR attempts (3) reached for ${invoiceFileId}`);
      }

      // Determine if this is an image that needs preprocessing
      const isImage = imagePreprocessingService.isImageFile(file.mimeType);
      let s3KeyToUse = file.storageKey;
      let preprocessingFlags: any = {};

      // Apply preprocessing based on attempt number (images only)
      if (isImage) {
        if (attemptCount === 1) {
          // Attempt 1: Baseline - auto-rotate only
          console.log(`[InvoicePipeline] Attempt 1: Baseline preprocessing for ${invoiceFileId}`);
          try {
            const result = await imagePreprocessingService.preprocessImage(file.storageKey, {
              autoRotate: true,
              contrastBoost: false,
              upscale: false,
              noiseReduction: false,
            });
            s3KeyToUse = result.processedS3Key;
            preprocessingFlags = result.flags;
          } catch (preprocessError: any) {
            console.error(`[InvoicePipeline] Preprocessing failed for ${invoiceFileId}:`, preprocessError);
            // Continue with original file if preprocessing fails
          }
        } else if (attemptCount === 2) {
          // Attempt 2: Aggressive preprocessing
          console.log(`[InvoicePipeline] Attempt 2: Aggressive preprocessing for ${invoiceFileId}`);
          try {
            const result = await imagePreprocessingService.preprocessImage(file.storageKey, {
              autoRotate: true,
              contrastBoost: true,
              upscale: true,
              noiseReduction: true,
            });
            s3KeyToUse = result.processedS3Key;
            preprocessingFlags = result.flags;
          } catch (preprocessError: any) {
            console.error(`[InvoicePipeline] Aggressive preprocessing failed for ${invoiceFileId}:`, preprocessError);
            // Continue with original file if preprocessing fails
          }
        } else if (attemptCount === 3) {
          // Attempt 3: Last resort - use original or minimal preprocessing
          console.log(`[InvoicePipeline] Attempt 3: Final attempt for ${invoiceFileId}`);
          // Use original file or try with provider's native deskew
          s3KeyToUse = file.storageKey;
          preprocessingFlags = { providerDeskewUsed: true };
        }
      }

      // Update attempt tracking before starting OCR
      const claimed = await prisma.invoiceFile.updateMany({
        where: {
          id: invoiceFileId,
          deletedAt: null,
          processingStatus: { in: [ProcessingStatus.PENDING_OCR, ProcessingStatus.OCR_FAILED] },
          ocrAttemptCount: file.ocrAttemptCount || 0,
        } as any,
        data: {
          ocrAttemptCount: attemptCount,
          lastOcrAttemptAt: new Date(),
          preprocessingFlags: preprocessingFlags,
          processingStatus: ProcessingStatus.OCR_PROCESSING,
          // Clear job/failure fields for clean retry
          ocrJobId: null,
          ocrFailureCategory: null,
          ocrFailureDetail: null,
          failureReason: null,
        },
      });
      if (claimed.count === 0) {
        // Lost the race / already handled
        return;
      }

      console.log(`[InvoicePipeline] Starting OCR attempt ${attemptCount} for ${invoiceFileId} using ${s3KeyToUse}`);
      const jobId = await ocrService.startAnalysis(s3KeyToUse);
      
      const setJob = await prisma.invoiceFile.updateMany({
        where: {
          id: invoiceFileId,
          deletedAt: null,
          processingStatus: ProcessingStatus.OCR_PROCESSING,
          ocrAttemptCount: attemptCount,
          ocrJobId: null,
        } as any,
        data: { ocrJobId: jobId },
      });
      if (setJob.count === 0) {
        // Lost the race / do not overwrite a newer attempt
        return;
      }
      
      console.log(`[InvoicePipeline] OCR started for ${invoiceFileId}, JobId: ${jobId}, Attempt: ${attemptCount}`);
    } catch (error: any) {
      // ALWAYS log the original error with context
      console.error(`[InvoicePipeline] Failed to start OCR for ${invoiceFileId}:`, {
        error: error.message,
        stack: error.stack,
        invoiceFileId,
      });
      
      const failureReason = error.message || 'Failed to start OCR processing';
      const classification = classifyOcrFailure(error);
      
      // 1. Update DB first (critical path)
      let updated;
      try {
        const res = await prisma.invoiceFile.updateMany({
          where: {
            id: invoiceFileId,
            deletedAt: null,
            // Never move backwards from terminal states
            processingStatus: { in: [ProcessingStatus.PENDING_OCR, ProcessingStatus.OCR_PROCESSING] },
          } as any,
          data: { 
            processingStatus: ProcessingStatus.OCR_FAILED,
            failureReason,
            ocrFailureCategory: classification.category,
            ocrFailureDetail: classification.detail,
          },
        });
        if (res.count === 0) {
          // Lost the race / already handled
          return;
        }
        updated = await prisma.invoiceFile.findUnique({
          where: { id: invoiceFileId },
          select: { organisationId: true, locationId: true, updatedAt: true },
        });
      } catch (dbError) {
        console.error(`[InvoicePipeline] Failed to update status for ${invoiceFileId}:`, dbError);
        return; // Exit - can't proceed without DB update
      }

      // 2. Send Pusher event NON-BLOCKING (wrap in try/catch)
      if (updated?.organisationId) {
        try {
          const channel = pusherService.getOrgChannel(updated.organisationId);
          await pusherService.triggerEvent(channel, 'invoice-status-updated', {
            invoiceFileId,
            status: ProcessingStatus.OCR_FAILED,
            locationId: updated.locationId,
            updatedAt: updated.updatedAt,
            ocrFailureCategory: classification.category,
            ocrFailureDetail: classification.detail,
          });
        } catch (pusherError) {
          // Log but don't throw - Pusher failure shouldn't break the handler
          console.warn(`[InvoicePipeline] Pusher emit failed for ${invoiceFileId}:`, pusherError);
        }
      }
    }
  },

  async submitForProcessing(
    fileStream: any, 
    metadata: { 
        organisationId: string; 
        locationId: string; 
        fileName: string; 
        mimeType: string; 
        sourceType?: InvoiceSourceType;
        sourceReference?: string;
    }
  ) {
    // Guard: Check if stream is readable
    if (fileStream.readable === false) {
        throw new Error("Invalid file stream: not readable");
    }

    const key = `invoices/${metadata.organisationId}/${randomUUID()}.pdf`;
    
    // 1. Upload to S3
    console.log(`[InvoicePipeline] Starting S3 upload for ${key}`);
    try {
        await s3Service.uploadFile(fileStream, key, metadata.mimeType);
        console.log(`[InvoicePipeline] S3 upload complete for ${key}`);
    } catch (err: any) {
        err.stage = 's3-upload';
        throw err;
    }

    // 2. Create InvoiceFile
    console.log(`[InvoicePipeline] Creating InvoiceFile record for ${key}`);
    let invoiceFile;
    try {
        invoiceFile = await prisma.invoiceFile.create({
            data: {
                organisationId: metadata.organisationId,
                locationId: metadata.locationId,
                sourceType: metadata.sourceType ?? InvoiceSourceType.UPLOAD,
                sourceReference: metadata.sourceReference,
                fileName: metadata.fileName,
                mimeType: metadata.mimeType,
                storageKey: key,
                processingStatus: ProcessingStatus.PENDING_OCR,
                reviewStatus: ReviewStatus.NONE,
            }
        });
        console.log(`[InvoicePipeline] InvoiceFile created: ${invoiceFile.id}`);
    } catch (err: any) {
        err.stage = 'db-create';
        throw err;
    }

    // 3. Start OCR
    console.log(`[InvoicePipeline] Starting OCR for ${invoiceFile.id}`);
    try {
        const jobId = await ocrService.startAnalysis(key);
        
        const updated = await prisma.invoiceFile.update({
            where: { id: invoiceFile.id },
            data: {
                ocrJobId: jobId,
                processingStatus: ProcessingStatus.OCR_PROCESSING
            }
        });
        console.log(`[InvoicePipeline] OCR started for ${invoiceFile.id}, JobId: ${jobId}`);
        return updated;
    } catch (error: any) {
        console.error(`[InvoicePipeline] Failed to start OCR for ${invoiceFile.id}:`, error);
        
        // Capture AWS specific error codes
        const awsCode = error.name || (error as any).code;

        await prisma.invoiceFile.update({
            where: { id: invoiceFile.id },
            data: { processingStatus: ProcessingStatus.OCR_FAILED }
        });
        
        // Rethrow with stage info so controller can log it
        error.stage = 'ocr-start';
        error.awsCode = awsCode;
        throw error;
    }
  },

  async pollProcessing(invoiceFileId: string) {
    const file = await prisma.invoiceFile.findFirst({
        where: { id: invoiceFileId, deletedAt: null } as any,
        include: { 
            invoice: { include: { lineItems: true, supplier: true } }, 
            ocrResult: true 
        }
    });

    if (!file) throw new InvoiceFileNotFoundError('Invoice file not found');

    console.log(`[InvoicePipeline] pollProcessing fileId=${file.id} status=${file.processingStatus} storageKey=${file.storageKey ? 'YES' : 'NO'}`);

    // If complete or failed, return status immediately
    if (file.processingStatus === ProcessingStatus.OCR_COMPLETE || file.processingStatus === ProcessingStatus.OCR_FAILED || file.processingStatus === ProcessingStatus.PENDING_OCR) {
         return this.enrichStatus(file);
    }

    if (file.processingStatus === ProcessingStatus.OCR_PROCESSING && file.ocrJobId) {
        // Check if we need to update status
        try {
             const result = await ocrService.getAnalysisResults(file.ocrJobId);
             
             if (result.JobStatus === 'SUCCEEDED') {
                 // ... (Processing Logic) ...
                 // Parse
                 const parsed = ocrService.parseTextractOutput(result);

                 // Early abort check: If confidence or word count is too low, fail immediately
                 const detectedWords = countDetectedWords(parsed);
                 const confidenceScore = parsed.confidenceScore || 0;

                 if (detectedWords < 5 || confidenceScore < 10) {
                   console.log(
                     `[InvoicePipeline] Early abort for ${file.id}: words=${detectedWords}, confidence=${confidenceScore}%`
                   );

                   const classification = classifyOcrFailure(
                     { message: 'Low quality input detected' },
                     confidenceScore,
                     detectedWords
                   );

                   const res = await prisma.invoiceFile.updateMany({
                     where: {
                       id: file.id,
                       deletedAt: null,
                       processingStatus: ProcessingStatus.OCR_PROCESSING,
                       ocrJobId: file.ocrJobId,
                       ocrAttemptCount: file.ocrAttemptCount || 0,
                     } as any,
                     data: {
                       processingStatus: ProcessingStatus.OCR_FAILED,
                       ocrFailureCategory: classification.category,
                       ocrFailureDetail: classification.detail,
                       failureReason: `Early abort: ${classification.detail}`,
                       confidenceScore: confidenceScore,
                     },
                   });
                   if (res.count === 0) return this.enrichStatus(file);

                   const updated = await prisma.invoiceFile.findUnique({
                     where: { id: file.id },
                     include: { invoice: { include: { lineItems: true, supplier: true } }, ocrResult: true },
                   });
                   return this.enrichStatus(updated as any);
                 }

                 // Default to OCR date (parsed.date is likely a Date object or ISO string suitable for Prisma)
                 let invoiceDate = parsed.date;
                 let xeroSupplierId: string | undefined;

                 // Check for Xero Date Override
                 if (file.sourceType === InvoiceSourceType.XERO && file.sourceReference) {
                     try {
                         const xeroInvoice = await prisma.xeroInvoice.findFirst({
                             where: {
                                 xeroInvoiceId: file.sourceReference,
                                 organisationId: file.organisationId
                             },
                             include: { supplier: true }
                         });
                         
                         if (xeroInvoice) {
                             if (xeroInvoice.date) {
                                 console.log(`[InvoicePipeline] Overriding OCR date (${invoiceDate}) with Xero date (${xeroInvoice.date}) for file ${file.id}`);
                                 invoiceDate = xeroInvoice.date;
                             }
                             if (xeroInvoice.supplier) {
                                  console.log(`[InvoicePipeline] Overriding OCR supplier (${parsed.supplierName}) with Xero supplier (${xeroInvoice.supplier.name}) for file ${file.id}`);
                                  parsed.supplierName = xeroInvoice.supplier.name;
                                  xeroSupplierId = xeroInvoice.supplier.id;
                             }
                         }
                     } catch (err) {
                         console.warn(`[InvoicePipeline] Failed to look up Xero invoice for overrides on file ${file.id}`, err);
                     }
                 }
                 
                 // Resolve Supplier
                 let resolution;
                 if (xeroSupplierId) {
                      resolution = { supplier: { id: xeroSupplierId } };
                 } else {
                      resolution = await supplierResolutionService.resolveSupplier(parsed.supplierName || '', file.organisationId);
                 }
                 
                 // Create or Update OcrResult
                 await prisma.invoiceOcrResult.upsert({
                     where: { invoiceFileId: file.id },
                     create: {
                         invoiceFileId: file.id,
                         rawResultJson: result as any,
                         parsedJson: parsed as any
                     },
                     update: {
                         rawResultJson: result as any,
                         parsedJson: parsed as any
                     }
                 });

                 // Create Invoice if not exists
                 const currentFile = await prisma.invoiceFile.findUnique({
                     where: { id: file.id },
                     include: { invoice: true }
                 });
                 
                 if (!currentFile?.invoice) {
                     // Validate organisation and location exist before creating invoice
                     const [organisation, location] = await Promise.all([
                         prisma.organisation.findUnique({
                             where: { id: file.organisationId },
                             select: { id: true }
                         }),
                         prisma.location.findUnique({
                             where: { id: file.locationId },
                             select: { id: true }
                         })
                     ]);
                     
                     if (!organisation) {
                         console.error(`[InvoicePipeline] Organisation ${file.organisationId} not found for file ${file.id}. Skipping invoice creation.`);
                         await prisma.invoiceFile.updateMany({
                           where: {
                             id: file.id,
                             deletedAt: null,
                             processingStatus: ProcessingStatus.OCR_PROCESSING,
                             ocrJobId: file.ocrJobId,
                             ocrAttemptCount: file.ocrAttemptCount || 0,
                           } as any,
                           data: {
                             processingStatus: ProcessingStatus.OCR_FAILED,
                             failureReason: `Organisation ${file.organisationId} not found`,
                           },
                         });
                         return this.enrichStatus(await prisma.invoiceFile.findUnique({ where: { id: file.id } }) as any);
                     }
                     
                     if (!location) {
                         console.error(`[InvoicePipeline] Location ${file.locationId} not found for file ${file.id}. Skipping invoice creation.`);
                         await prisma.invoiceFile.updateMany({
                           where: {
                             id: file.id,
                             deletedAt: null,
                             processingStatus: ProcessingStatus.OCR_PROCESSING,
                             ocrJobId: file.ocrJobId,
                             ocrAttemptCount: file.ocrAttemptCount || 0,
                           } as any,
                           data: {
                             processingStatus: ProcessingStatus.OCR_FAILED,
                             failureReason: `Location ${file.locationId} not found`,
                           },
                         });
                         return this.enrichStatus(await prisma.invoiceFile.findUnique({ where: { id: file.id } }) as any);
                     }
                     
                     try {
                        await prisma.invoice.create({
                            data: {
                                organisationId: file.organisationId,
                                locationId: file.locationId,
                                invoiceFileId: file.id,
                                supplierId: resolution?.supplier.id,
                                invoiceNumber: parsed.invoiceNumber,
                                date: invoiceDate,
                                total: parsed.total,
                                tax: parsed.tax,
                                subtotal: parsed.subtotal,
                                sourceType: file.sourceType,
                                lineItems: {
                                    create: parsed.lineItems.map(item => ({
                                        description: item.description,
                                        quantity: item.quantity,
                                        unitPrice: item.unitPrice,
                                        lineTotal: item.lineTotal,
                                        productCode: item.productCode,
                                        accountCode: MANUAL_COGS_ACCOUNT_CODE
                                    }))
                                }
                            }
                        });
                     } catch (e: any) {
                         // Handle foreign key constraint violations
                         if (e.code === 'P2003') {
                             console.error(`[InvoicePipeline] Foreign key constraint violation for file ${file.id}: ${e.meta?.field_name}. Organisation or location may not exist.`);
                             await prisma.invoiceFile.updateMany({
                               where: {
                                 id: file.id,
                                 deletedAt: null,
                                 processingStatus: ProcessingStatus.OCR_PROCESSING,
                                 ocrJobId: file.ocrJobId,
                                 ocrAttemptCount: file.ocrAttemptCount || 0,
                               } as any,
                               data: {
                                 processingStatus: ProcessingStatus.OCR_FAILED,
                                 failureReason: `Foreign key constraint violation: ${e.meta?.field_name || 'unknown'}`,
                               },
                             });
                             return this.enrichStatus(await prisma.invoiceFile.findUnique({ where: { id: file.id } }) as any);
                         }
                         // Ignore P2002 (Unique constraint) as it means it was created concurrently
                         if (e.code !== 'P2002') throw e;
                         console.log(`[InvoicePipeline] Invoice already exists for file ${file.id}, skipping creation.`);
                     }
                 }

                 // Sprint A: Dual-write CanonicalInvoice + CanonicalInvoiceLineItem (idempotent)
                 // Do this AFTER ensuring legacy Invoice exists, and do it transactionally for strict FKs.
                 try {
                   const legacyInvoice = await prisma.invoice.findUnique({
                     where: { invoiceFileId: file.id },
                     select: {
                       id: true,
                       organisationId: true,
                       locationId: true,
                       supplierId: true,
                       date: true,
                       deletedAt: true,
                     },
                   });

                   if (legacyInvoice) {
                     const headerCurrencyCode = (parsed.currency || DEFAULT_CURRENCY_CODE).toUpperCase();
                     assertCanonicalInvoiceLegacyLink({
                       source: 'OCR' as any,
                       legacyInvoiceId: legacyInvoice.id,
                       legacyXeroInvoiceId: null,
                     });

                     await prisma.$transaction(async (tx) => {
                       const txAny = tx as any;
                       const canonical = await txAny.canonicalInvoice.upsert({
                         where: { legacyInvoiceId: legacyInvoice.id },
                         create: {
                           organisationId: legacyInvoice.organisationId,
                           locationId: legacyInvoice.locationId,
                           supplierId: legacyInvoice.supplierId,
                           source: 'OCR',
                           legacyInvoiceId: legacyInvoice.id,
                           legacyXeroInvoiceId: null,
                           sourceInvoiceRef: `invoiceFileId:${file.id}`,
                           date: legacyInvoice.date ?? (invoiceDate ? new Date(invoiceDate) : null),
                           currencyCode: headerCurrencyCode,
                           deletedAt: legacyInvoice.deletedAt ?? null,
                         } as any,
                         update: {
                           organisationId: legacyInvoice.organisationId,
                           locationId: legacyInvoice.locationId,
                           supplierId: legacyInvoice.supplierId,
                           source: 'OCR',
                           sourceInvoiceRef: `invoiceFileId:${file.id}`,
                           date: legacyInvoice.date ?? (invoiceDate ? new Date(invoiceDate) : undefined),
                           currencyCode: headerCurrencyCode,
                           deletedAt: legacyInvoice.deletedAt ?? null,
                         } as any,
                         select: { id: true, currencyCode: true },
                       });

                       const canonicalLineData = parsed.lineItems.map((item, idx) => {
                         const canon = canonicalizeLine({
                           source: 'OCR' as any,
                           rawDescription: item.description,
                           productCode: item.productCode ?? null,
                           quantity: item.quantity ?? null,
                           unitLabel: (item as any).unitLabel ?? null,
                           unitPrice: item.unitPrice ?? null,
                           lineTotal: item.lineTotal ?? null,
                           taxAmount: null,
                           currencyCode: null,
                           headerCurrencyCode: canonical.currencyCode ?? headerCurrencyCode,
                           adjustmentStatus: 'NONE' as any,
                           numericParseWarnReasons: (item as any).numericParseWarnReasons ?? [],
                         });

                         return {
                           canonicalInvoiceId: canonical.id,
                           organisationId: legacyInvoice.organisationId,
                           locationId: legacyInvoice.locationId,
                           supplierId: legacyInvoice.supplierId,
                           source: 'OCR',
                           sourceLineRef: `invoiceFileId:${file.id}:line:${idx}`,
                           normalizationVersion: 'v1',
                           rawDescription: canon.rawDescription,
                           normalizedDescription: canon.normalizedDescription,
                           productCode: item.productCode?.trim() || null,
                         rawQuantityText: (item as any).rawQuantityText ?? null,
                         rawUnitText: (item as any).unitLabel ?? null,
                         rawDeliveredText: (item as any).rawDeliveredText ?? null,
                         rawSizeText: (item as any).rawSizeText ?? null,
                           quantity: item.quantity ?? null,
                           unitLabel: canon.unitLabel,
                           unitCategory: canon.unitCategory,
                           unitPrice: item.unitPrice ?? null,
                           lineTotal: item.lineTotal ?? null,
                           taxAmount: null,
                           currencyCode: canon.currencyCode ?? canonical.currencyCode ?? headerCurrencyCode,
                           adjustmentStatus: canon.adjustmentStatus,
                           qualityStatus: canon.qualityStatus,
                         warnReasons: canon.qualityWarnReasons ?? [],
                           confidenceScore: parsed.confidenceScore ?? null,
                         } as any;
                       });

                       if (canonicalLineData.length > 0) {
                         await txAny.canonicalInvoiceLineItem.createMany({
                           data: canonicalLineData,
                           skipDuplicates: true,
                         });
                       }
                     });
                   }
                 } catch (e) {
                   console.warn(`[InvoicePipeline] Canonical dual-write failed for invoiceFileId=${file.id}:`, e);
                   // Non-blocking for Sprint A (legacy remains source of truth until cutover)
                 }

                 // Determine Review Status
                 let reviewStatus = ReviewStatus.NEEDS_REVIEW;
                 if (parsed.confidenceScore >= 95) {
                     // reviewStatus = ReviewStatus.VERIFIED; 
                 }

                 // Update File Status and return FRESH enriched object
                const res = await prisma.invoiceFile.updateMany({
                  where: {
                    id: file.id,
                    deletedAt: null,
                    processingStatus: ProcessingStatus.OCR_PROCESSING,
                    ocrJobId: file.ocrJobId,
                    ocrAttemptCount: file.ocrAttemptCount || 0,
                  } as any,
                  data: {
                    processingStatus: ProcessingStatus.OCR_COMPLETE,
                    reviewStatus: reviewStatus,
                    confidenceScore: parsed.confidenceScore,
                  },
                });
                if (res.count === 0) return this.enrichStatus(file);

                // Fetch the updated file with relations for auto-approval check
                const updatedFile = await prisma.invoiceFile.findUnique({
                  where: { id: file.id },
                  include: { invoice: { include: { lineItems: true, supplier: true } }, ocrResult: true }
                });
                
                if (!updatedFile) {
                  return this.enrichStatus(file);
                }

                // Auto-approval check runs exactly once here when OCR first completes
                const outcome = await this.checkAndApplyAutoApproval(updatedFile);
                
                // Use the (possibly updated) file for enrichStatus to ensure fresh data in Pusher
                return this.enrichStatus(outcome.updatedFile);

             } else if (result.JobStatus === 'FAILED') {
                  // Classify the failure
                  const classification = classifyOcrFailure(
                    { message: 'OCR job failed', code: 'JobFailed' },
                    undefined,
                    undefined
                  );

                  const res = await prisma.invoiceFile.updateMany({
                    where: {
                      id: file.id,
                      deletedAt: null,
                      processingStatus: ProcessingStatus.OCR_PROCESSING,
                      ocrJobId: file.ocrJobId,
                      ocrAttemptCount: file.ocrAttemptCount || 0,
                    } as any,
                    data: { 
                      processingStatus: ProcessingStatus.OCR_FAILED,
                      ocrFailureCategory: classification.category,
                      ocrFailureDetail: classification.detail,
                      failureReason: `OCR job failed: ${classification.detail}`
                    }
                  });
                  if (res.count === 0) return this.enrichStatus(file);

                  const updated = await prisma.invoiceFile.findUnique({
                    where: { id: file.id },
                    include: { invoice: { include: { lineItems: true, supplier: true } }, ocrResult: true }
                  });
                  return this.enrichStatus(updated as any);
             }
        } catch (e) {
            console.error(`Error polling job ${file.ocrJobId}`, e);
            // Fall through to return current status
        }
    }

    // Always return enriched status for any other state (PENDING, COMPLETE, VERIFIED, FAILED)
    return this.enrichStatus(file);
  },

  /**
   * Check if an invoice is eligible for auto-approval and apply it if so.
   * Must be called only once when OCR first transitions to OCR_COMPLETE.
   * 
   * Returns the (possibly updated) file with relations, ensuring no stale data flows to Pusher.
   */
  async checkAndApplyAutoApproval(
    file: any // InvoiceFile with invoice relation
  ): Promise<{ applied: boolean; reason?: string; updatedFile: any }> {
    // Guard: invoice relation must exist
    if (!file.invoice?.id) {
      return { applied: false, reason: 'NO_INVOICE_RELATION', updatedFile: file };
    }

    // Fast path: check location flag first (before expensive quality computation)
    const location = await prisma.location.findUnique({
      where: { id: file.locationId },
      select: { autoApproveCleanInvoices: true },
    });
    const enabled = location?.autoApproveCleanInvoices ?? false;
    if (!enabled) {
      return { applied: false, reason: 'FEATURE_DISABLED', updatedFile: file };
    }

    // Compute quality summary only if feature is enabled
    const summary = await this.computeLineItemQualitySummary(file.invoice.id);

    // Eligibility decision
    const decision = isInvoiceAutoApprovable(file, file.invoice, summary, enabled);
    if (!decision.eligible) {
      console.log('[InvoicePipeline] Auto-approval skipped', {
        invoiceFileId: file.id,
        invoiceId: file.invoice.id,
        locationId: file.locationId,
        supplierId: file.invoice.supplier?.id ?? null,
        supplierStatus: file.invoice.supplier?.status ?? null,
        reason: decision.reason,
      });
      return { applied: false, reason: decision.reason, updatedFile: file };
    }

    // Apply updates transactionally (keep InvoiceFile and Invoice in sync)
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.invoiceFile.update({
        where: { id: file.id },
        data: {
          reviewStatus: ReviewStatus.VERIFIED,
          verificationSource: VerificationSource.AUTO,
          verifiedAt: now,
        },
      });
      await tx.invoice.update({
        where: { id: file.invoice.id },
        data: { isVerified: true },
      });
    });

    console.log('[InvoicePipeline] Auto-approved invoice', {
      event: 'invoice.auto_approved',
      invoiceFileId: file.id,
      invoiceId: file.invoice.id,
      locationId: file.locationId,
      supplierId: file.invoice.supplier?.id ?? null,
      supplierName: file.invoice.supplier?.name ?? null,
      confidenceScore: file.confidenceScore,
      lineItemCount: summary?.totalCount ?? null,
    });

    // Re-fetch to avoid stale data flowing to enrichStatus and Pusher
    const refreshed = await prisma.invoiceFile.findUnique({
      where: { id: file.id },
      include: { invoice: { include: { lineItems: true, supplier: true } }, ocrResult: true },
    });

    return { applied: true, updatedFile: refreshed ?? file };
  },

  async enrichStatus(file: any) {
      // Generate presigned URL
      let presignedUrl: string | null = null;
      console.log(`[InvoicePipeline] enrichStatus fileId=${file.id} hasStorageKey=${!!file.storageKey}`);
      if (file.storageKey) {
          try {
            presignedUrl = await s3Service.getSignedUrl(file.storageKey, file.mimeType || 'application/pdf');
            console.log(`[InvoicePipeline] Generated presignedUrl length=${presignedUrl?.length}`);
          } catch (e) {
            console.error('Error generating presigned URL', e);
          }
      }

      // Canonical line-item quality summary (trust + analytics inclusion).
      // If canonical is not ready/available yet, summary will be null and FE should HIDE the banner.
      let lineItemQualitySummary = null;
      if (file.invoice?.id) {
          lineItemQualitySummary = await this.computeLineItemQualitySummary(file.invoice.id);
      }

      // Per-line issues for row-level highlighting in the Invoice Review Modal.
      // If canonical is not ready/available yet, issues will be null (UI should treat as no row highlights).
      let lineItemQualityIssues = null;
      if (file.invoice?.id) {
          lineItemQualityIssues = await this.computeLineItemQualityIssues({
              legacyInvoiceId: file.invoice.id,
              invoiceFileId: file.id,
          });
      }
      return {
          ...file,
          presignedUrl,
          lineItemQualitySummary,
          lineItemQualityIssues,
      };
  },

  async verifyInvoice(invoiceId: string, data: { 
      supplierId?: string; 
      supplierName?: string;
      total?: number; 
      createAlias?: boolean;
      aliasName?: string;
      selectedLineItemIds?: string[]; // Kept for backward compatibility but ignored in new logic if items are provided
      date?: string | Date;
      items?: Array<{
          id: string;
          description?: string;
          quantity?: number;
          lineTotal?: number;
          productCode?: string;
      }>;
      hasManuallyAddedItems?: boolean;
  }) {
      console.log('[InvoicePipeline] verifyInvoice start', { invoiceId, ...data });

      if (!data.supplierId && !data.supplierName) {
          throw new Error("Supplier is required (either supplierId or supplierName)");
      }

      // 1. Fetch Invoice
      const invoice = await prisma.invoice.findUnique({
          where: { id: invoiceId },
          include: { invoiceFile: true }
      });
      
      if (!invoice) {
        console.log(`[InvoicePipeline] verifyInvoice failed: Invoice ${invoiceId} not found`);
        const err: any = new Error(`Invoice ${invoiceId} not found`);
        err.statusCode = 404;
        err.code = 'INVOICE_NOT_FOUND';
        throw err;
      }

      // Run everything in a transaction to ensure atomicity
      // CRITICAL: Validation + write occur in the same transaction to prevent race conditions
      // where supplier could be deleted/modified between validation and invoice update
      return await prisma.$transaction(async (tx) => {
          // Fetch InvoiceFile fresh to avoid stale relation data
          let invoiceFile = null;
          if (invoice.invoiceFileId) {
              invoiceFile = await tx.invoiceFile.findUnique({
                  where: { id: invoice.invoiceFileId },
                  select: { id: true, processingStatus: true }
              });
          }
          let targetSupplierId = data.supplierId;

          // 2. Validate supplierId if provided (must exist and belong to org)
          // NOTE: This validation happens inside the transaction, ensuring the supplier
          // still belongs to the organisation when we write to Invoice.supplierId below
          if (targetSupplierId) {
              const supplier = await tx.supplier.findUnique({
                  where: { id: targetSupplierId }
              });

              if (!supplier) {
                  console.error('[InvoicePipeline] Invalid supplierId provided - supplier does not exist', {
                      invoiceId,
                      invoiceFileId: invoice.invoiceFileId,
                      supplierId: targetSupplierId,
                      organisationId: invoice.organisationId
                  });
                  const err: any = new Error(`Supplier ID ${targetSupplierId} does not exist.`);
                  err.statusCode = 400;
                  err.code = 'INVALID_SUPPLIER_ID';
                  throw err;
              }

              // Check organisationId separately
              if (supplier.organisationId !== invoice.organisationId) {
                  console.error('[InvoicePipeline] Invalid supplierId provided - wrong organisation', {
                      invoiceId,
                      invoiceFileId: invoice.invoiceFileId,
                      supplierId: targetSupplierId,
                      supplierOrganisationId: supplier.organisationId,
                      invoiceOrganisationId: invoice.organisationId
                  });
                  const err: any = new Error(`Supplier ID ${targetSupplierId} does not belong to this organisation.`);
                  err.statusCode = 400;
                  err.code = 'INVALID_SUPPLIER_ID';
                  throw err;
              }
              
              // Supplier is valid, use it
              console.log('[InvoicePipeline] Using provided supplierId', {
                  invoiceId,
                  supplierId: targetSupplierId,
                  supplierName: supplier.name
              });
          }

          // 3. Resolve or Create Supplier if needed (only if supplierId was not provided or invalid)
          if (!targetSupplierId && data.supplierName) {
              // Use existing normalization utility (handles suffixes, punctuation, etc.)
              const normalizedName = normalizeSupplierName(data.supplierName);
              
              // Check if exists
              const existingSupplier = await tx.supplier.findFirst({
                  where: {
                      organisationId: invoice.organisationId,
                      normalizedName
                  }
              });

              if (existingSupplier) {
                  targetSupplierId = existingSupplier.id;
                  // Ensure supplier is active if it was pending review
                  if (existingSupplier.status === PrismaSupplierStatus.PENDING_REVIEW) {
                      await tx.supplier.update({
                          where: { id: existingSupplier.id },
                          data: { status: PrismaSupplierStatus.ACTIVE }
                      });
                  }
              } else {
                  // Create new supplier
                  const newSupplier = await tx.supplier.create({
                      data: {
                          organisationId: invoice.organisationId,
                          name: data.supplierName.trim(),
                          normalizedName,
                          sourceType: SupplierSourceType.MANUAL,
                          status: PrismaSupplierStatus.ACTIVE
                      }
                  });
                  targetSupplierId = newSupplier.id;
                  console.log(`[InvoicePipeline] Created new supplier: ${newSupplier.name} (${newSupplier.id})`);
              }
          }

          // 4. Delete All Existing Line Items
          // We replace them entirely with the verified list to ensure source of truth
          console.log(`[InvoicePipeline] Clearing existing line items for invoice ${invoiceId}...`);
          await tx.invoiceLineItem.deleteMany({
              where: { invoiceId: invoiceId }
          });

          // 5. Create New Line Items (Normalized)
          if (data.items && data.items.length > 0) {
              console.log(`[InvoicePipeline] Creating ${data.items.length} verified line items...`);
              
              const newItems = data.items.map(item => {
                  // Data Normalization & Divide-by-Zero Guard
                  const qty = Number(item.quantity) || 1; // Default to 1 if 0/missing
                  const total = Number(item.lineTotal) || 0;
                  const unitPrice = qty > 0 ? total / qty : 0;

                  return {
                      invoiceId: invoiceId,
                      description: item.description ?? '',
                      quantity: qty,
                      lineTotal: total,
                      unitPrice: unitPrice,
                      productCode: item.productCode?.trim() || null,
                      accountCode: MANUAL_COGS_ACCOUNT_CODE
                  };
              });

              await tx.invoiceLineItem.createMany({
                  data: newItems
              });
          }

          // 6. Update Invoice Header
          // NOTE: supplierId validation (step 2) and this write occur in the same transaction,
          // ensuring the supplier still belongs to the organisation at write time
          const updatedInvoice = await tx.invoice.update({
              where: { id: invoiceId },
              data: {
                  supplierId: targetSupplierId,
                  total: data.total,
                  isVerified: true,
                  date: data.date ? new Date(data.date) : undefined
              },
              include: { supplier: true, lineItems: true }
          });

          // Sprint A: Dual-write canonical (manual-verified truth)
          // Transactional with invoice edits to satisfy strict FKs.
          try {
            assertCanonicalInvoiceLegacyLink({
              source: 'MANUAL' as any,
              legacyInvoiceId: updatedInvoice.id,
              legacyXeroInvoiceId: null,
            });

            const headerCurrencyCode = DEFAULT_CURRENCY_CODE;
            const txAny = tx as any;
            const canonical = await txAny.canonicalInvoice.upsert({
              where: { legacyInvoiceId: updatedInvoice.id },
              create: {
                organisationId: updatedInvoice.organisationId,
                locationId: updatedInvoice.locationId,
                supplierId: targetSupplierId ?? null,
                source: 'MANUAL',
                legacyInvoiceId: updatedInvoice.id,
                legacyXeroInvoiceId: null,
                sourceInvoiceRef: invoice.invoiceFileId ? `invoiceFileId:${invoice.invoiceFileId}` : `invoiceId:${updatedInvoice.id}`,
                date: updatedInvoice.date ?? null,
                currencyCode: headerCurrencyCode,
                deletedAt: null,
              } as any,
              update: {
                organisationId: updatedInvoice.organisationId,
                locationId: updatedInvoice.locationId,
                supplierId: targetSupplierId ?? null,
                source: 'MANUAL',
                sourceInvoiceRef: invoice.invoiceFileId ? `invoiceFileId:${invoice.invoiceFileId}` : `invoiceId:${updatedInvoice.id}`,
                date: updatedInvoice.date ?? undefined,
                currencyCode: headerCurrencyCode,
                deletedAt: null,
              } as any,
              select: { id: true, currencyCode: true },
            });

            // Replace canonical lines for this invoice on verification (sourceLineRef changes with new InvoiceLineItem IDs).
            await txAny.canonicalInvoiceLineItem.deleteMany({
              where: { canonicalInvoiceId: canonical.id },
            });

            const lineData = (updatedInvoice.lineItems || []).map((li) => {
              const canon = canonicalizeLine({
                source: 'MANUAL' as any,
                rawDescription: li.description,
                productCode: li.productCode ?? null,
                quantity: li.quantity ? Number(li.quantity) : null,
                unitPrice: li.unitPrice ? Number(li.unitPrice) : null,
                lineTotal: li.lineTotal ? Number(li.lineTotal) : null,
                taxAmount: null,
                currencyCode: null,
                headerCurrencyCode: canonical.currencyCode ?? headerCurrencyCode,
                adjustmentStatus: 'MODIFIED' as any,
              });

              return {
                canonicalInvoiceId: canonical.id,
                organisationId: updatedInvoice.organisationId,
                locationId: updatedInvoice.locationId,
                supplierId: targetSupplierId ?? null,
                source: 'MANUAL',
                sourceLineRef: `invoiceId:${updatedInvoice.id}:manual:${li.id}`,
                normalizationVersion: 'v1',
                rawDescription: canon.rawDescription,
                normalizedDescription: canon.normalizedDescription,
                productCode: li.productCode ?? null,
                rawQuantityText:
                  li.quantity !== null && li.quantity !== undefined ? String(li.quantity) : null,
                rawUnitText: null,
                rawDeliveredText: null,
                rawSizeText: null,
                quantity: li.quantity,
                unitLabel: canon.unitLabel,
                unitCategory: canon.unitCategory,
                unitPrice: li.unitPrice,
                lineTotal: li.lineTotal,
                taxAmount: null,
                currencyCode: canon.currencyCode ?? canonical.currencyCode ?? headerCurrencyCode,
                adjustmentStatus: canon.adjustmentStatus,
                qualityStatus: canon.qualityStatus,
                warnReasons: canon.qualityWarnReasons ?? [],
                confidenceScore: invoice.invoiceFile?.confidenceScore ?? null,
              } as any;
            });

            if (lineData.length > 0) {
              await txAny.canonicalInvoiceLineItem.createMany({ data: lineData });
            }
          } catch (e) {
            console.warn(`[InvoicePipeline] Canonical dual-write failed during verifyInvoice invoiceId=${invoiceId}:`, e);
          }

          // 6. Update InvoiceFile Status
          if (invoice.invoiceFileId && invoiceFile) {
              // Determine if we should mark as MANUALLY_UPDATED
              // Guard: only if hasManuallyAddedItems is true AND items.length > 0 (backend sanity check)
              const shouldMarkAsManual = data.hasManuallyAddedItems === true 
                  && data.items && data.items.length > 0
                  && invoiceFile.processingStatus === ProcessingStatus.OCR_FAILED;

              await tx.invoiceFile.update({
                  where: { id: invoice.invoiceFileId },
                  data: { 
                      reviewStatus: ReviewStatus.VERIFIED,
                      verificationSource: VerificationSource.MANUAL,
                      // NOTE: Prisma client may be stale in some environments; keep this cast safe.
                      ...(shouldMarkAsManual && { processingStatus: 'MANUALLY_UPDATED' as any })
                  }
              });
          }

          // 7. Upsert Products for Verified Line Items
          if (updatedInvoice.lineItems.length > 0) {
              for (const item of updatedInvoice.lineItems) {
                  const productKey = getProductKeyFromLineItem(item.productCode, item.description);
                  
                  if (productKey !== 'unknown') {
                      await tx.product.upsert({
                          where: {
                              organisationId_locationId_productKey: {
                                  organisationId: updatedInvoice.organisationId,
                                  locationId: updatedInvoice.locationId,
                                  productKey
                              }
                          },
                          update: {
                              supplierId: targetSupplierId
                          },
                          create: {
                              organisationId: updatedInvoice.organisationId,
                              locationId: updatedInvoice.locationId,
                              productKey,
                              name: (item.productCode || item.description).trim(),
                              supplierId: targetSupplierId
                          }
                      });
                  }
              }
          }

          // 8. Create Alias if requested
          if (data.createAlias && targetSupplierId) {
              const aliasName = data.aliasName || data.supplierName;
              if (aliasName) {
                  const normalized = aliasName.toLowerCase().trim();
                  await tx.supplierAlias.upsert({
                      where: {
                          organisationId_normalisedAliasName: {
                              organisationId: invoice.organisationId,
                              normalisedAliasName: normalized
                          }
                      },
                      update: { supplierId: targetSupplierId },
                      create: {
                          organisationId: invoice.organisationId,
                          supplierId: targetSupplierId,
                          aliasName: aliasName,
                          normalisedAliasName: normalized
                      }
                  });
              }
          }

          console.log('[InvoicePipeline] verifyInvoice success', { invoiceId, supplierId: targetSupplierId });
          
          // After transaction completes, fetch enriched data
          if (!invoice.invoiceFileId) {
            // If no invoiceFile, return just the invoice (shouldn't happen but handle gracefully)
            return {
              invoice: updatedInvoice,
              invoiceFile: null,
              location: null,
            };
          }

          const enrichedInvoiceFile = await prisma.invoiceFile.findUnique({
              where: { id: invoice.invoiceFileId },
              select: {
                  id: true,
                  reviewStatus: true,
                  verificationSource: true,
                  locationId: true,
              }
          });

          if (!enrichedInvoiceFile) {
            return {
              invoice: updatedInvoice,
              invoiceFile: null,
              location: null,
            };
          }

          const location = await prisma.location.findUnique({
              where: { id: updatedInvoice.locationId },
              select: {
                  autoApproveCleanInvoices: true,
                  hasSeenAutoApprovePrompt: true,
              }
          });

          return {
              invoice: updatedInvoice,
              invoiceFile: enrichedInvoiceFile,
              location: location || null,  // Graceful if location missing
          };
      }, { timeout: 10000 });
  },
  
  async listInvoices(
      locationId: string, 
      page = 1, 
      limit = 20, 
      filters?: {
          search?: string;
          sourceType?: string; // 'ALL' | 'XERO' | 'EMAIL' | 'MANUAL'
          startDate?: string;
          endDate?: string;
          status?: 'ALL' | 'REVIEWED' | 'PENDING' | 'DELETED';
          refreshProcessing?: boolean;
      }
  ) {
      const { skip: rawSkip, page: safePage, limit: safeLimit } = getOffsetPaginationOrThrow({ page, limit, maxLimit: 100, maxOffset: 5000 });

      const start = parseDateOrThrow(filters?.startDate, 'startDate');
      const end = parseDateOrThrow(filters?.endDate, 'endDate');
      assertDateRangeOrThrow({ start, end, maxDays: 366 });
      assertWindowIfDeepPagination({ skip: rawSkip, hasWindow: Boolean(start || end) });
      
      const skip = rawSkip;
      const where: any = { locationId };

      // Apply Status Filter (Handles deletedAt and reviewStatus)
      if (filters?.status === 'DELETED') {
          where.deletedAt = { not: null };
      } else {
          where.deletedAt = null; // Default: Exclude deleted
          
          if (filters?.status === 'REVIEWED') {
              where.reviewStatus = 'VERIFIED';
          } else if (filters?.status === 'PENDING') {
              where.reviewStatus = { not: 'VERIFIED' };
          }
          // 'ALL' keeps deletedAt = null and no extra reviewStatus constraint
      }

      // Apply Source Filter
      if (filters?.sourceType && filters.sourceType !== 'ALL') {
          if (filters.sourceType === 'XERO') {
              where.sourceType = InvoiceSourceType.XERO;
          } else if (filters.sourceType === 'EMAIL') {
              where.sourceType = InvoiceSourceType.EMAIL;
          } else if (filters.sourceType === 'MANUAL') {
              // Manual includes UPLOAD only (EMAIL is separate)
              where.sourceType = InvoiceSourceType.UPLOAD;
          }
      }

      // Apply Date Range Filter
      if (start || end) {
          const dateFilter: any = {};
          if (start) dateFilter.gte = start;
          if (end) dateFilter.lte = end;

          // Filter by Invoice Date OR Upload Date to match user intuition
          where.OR = [
              { invoice: { date: dateFilter } },
              { createdAt: dateFilter }
          ];
      }

      // Apply Search
      if (filters?.search) {
          const search = filters.search.trim();
          const searchOR: any[] = [
              { fileName: { contains: search, mode: 'insensitive' } },
              { 
                  invoice: {
                      OR: [
                          { invoiceNumber: { contains: search, mode: 'insensitive' } },
                          { supplier: { name: { contains: search, mode: 'insensitive' } } },
                          { 
                              lineItems: {
                                  some: {
                                      OR: [
                                          { description: { contains: search, mode: 'insensitive' } },
                                          { productCode: { contains: search, mode: 'insensitive' } }
                                      ]
                                  }
                              }
                          }
                      ]
                  }
              }
          ];

          // Combine with Date Range OR if present
          if (where.OR) {
              where.AND = [
                  { OR: where.OR },
                  { OR: searchOR }
              ];
              delete where.OR;
          } else {
              where.OR = searchOR;
          }
      }

      let [items, count] = await Promise.all([
          prisma.invoiceFile.findMany({
              where,
              include: { 
                  invoice: { include: { supplier: true, lineItems: true } },
                  ocrResult: true
              },
              orderBy: { createdAt: 'desc' },
              take: safeLimit,
              skip
          }),
          prisma.invoiceFile.count({ where })
      ]);
      
      // Realtime-first: list should be cheap by default.
      // If explicitly requested, refresh a capped number of processing items.
      if (filters?.refreshProcessing === true) {
          const MAX_REFRESH_PER_LIST = 5;
          const processingItems = items
              .filter(item => item.processingStatus === ProcessingStatus.OCR_PROCESSING && item.ocrJobId)
              .slice(0, MAX_REFRESH_PER_LIST);

          if (processingItems.length > 0) {
              console.log(`[InvoicePipeline] refreshProcessing enabled; checking ${processingItems.length} OCR jobs (capped).`);
              try {
                  const updates = await Promise.allSettled(
                      processingItems.map(item => this.pollProcessing(item.id))
                  );

                  const updatedMap = new Map();
                  updates.forEach((result, index) => {
                      if (result.status === 'fulfilled' && result.value) {
                          updatedMap.set(processingItems[index].id, result.value);
                      }
                  });

                  items = items.map(item => updatedMap.has(item.id) ? (updatedMap.get(item.id) as any) : item);
              } catch (e) {
                  console.error("[InvoicePipeline] refreshProcessing failed", e);
              }
          }
      }

      // Ensure all items have presigned URLs (enrichStatus)
      // pollProcessing returns enriched items, but the initial DB fetch does not.
      items = await Promise.all(items.map(async (item) => {
          if ((item as any).presignedUrl) return item; // Already enriched
          return this.enrichStatus(item);
      }));

      return {
          items,
          total: count,
          page: safePage,
          pages: Math.ceil(count / safeLimit)
      };
  },

  async deleteInvoice(invoiceId: string, organisationId: string) {
      console.log(`[InvoicePipeline] Request to delete invoice ${invoiceId} for org ${organisationId}`);

      // 1. Fetch Invoice to get File ID and verify ownership
      const invoice = await prisma.invoice.findFirst({
          where: { id: invoiceId, organisationId, deletedAt: null } as any,
          include: { invoiceFile: true }
      });

      if (!invoice) {
          throw new Error('Invoice not found or access denied');
      }

      const invoiceFileId = invoice.invoiceFileId;

      console.log(`[InvoicePipeline] Deleting invoice ${invoiceId}. Linked File: ${invoiceFileId || 'None'}`);

      // 2. Perform Soft Deletion Transaction
      await prisma.$transaction(async (tx) => {
          const now = new Date();
          // Soft delete Invoice
          await tx.invoice.update({
              where: { id: invoiceId } as any,
              data: { deletedAt: now } as any
          });

          // Soft delete InvoiceFile if present
          if (invoiceFileId) {
             await tx.invoiceFile.update({
                 where: { id: invoiceFileId } as any,
                 data: { deletedAt: now } as any
             });
          }

          // Mirror soft-delete to canonical header (chosen default truth)
          await (tx as any).canonicalInvoice.updateMany({
            where: { legacyInvoiceId: invoiceId } as any,
            data: { deletedAt: now } as any,
          });

          // Soft delete XeroInvoice if linked
          if (invoice.sourceType === InvoiceSourceType.XERO && invoice.sourceReference) {
              // sourceReference is typically the Xero InvoiceID (GUID)
              // We need to find the matching XeroInvoice record
              const xeroInvoice = await tx.xeroInvoice.findFirst({
                  where: {
                      xeroInvoiceId: invoice.sourceReference,
                      organisationId: organisationId
                  }
              });

              if (xeroInvoice) {
                  console.log(`[InvoicePipeline] Soft deleting linked XeroInvoice ${xeroInvoice.id}`);
                  await tx.xeroInvoice.update({
                      where: { id: xeroInvoice.id } as any,
                      data: { deletedAt: now } as any
                  });

                  // Mirror soft-delete to canonical header linked to this XeroInvoice (if any)
                  await (tx as any).canonicalInvoice.updateMany({
                    where: { legacyXeroInvoiceId: xeroInvoice.id } as any,
                    data: { deletedAt: now } as any,
                  });
              }
          }
      });

      console.log(`[InvoicePipeline] Successfully soft-deleted invoice ${invoiceId} and associated file.`);
      return true;
  },

  async bulkDeleteInvoices(ids: string[], organisationId: string) {
      console.log(`[InvoicePipeline] Request to bulk delete ${ids.length} items for org ${organisationId}`);

      // 1. Fetch InvoiceFiles (primary entity in list)
      const files = await prisma.invoiceFile.findMany({
          where: { 
              id: { in: ids }, 
              organisationId, 
              deletedAt: null 
          } as any,
          include: { invoice: true }
      });

      if (files.length === 0) {
          return { deletedCount: 0, message: "No matching files found to delete" };
      }

      const foundFileIds = files.map(f => f.id);
      
      // Collect associated Invoice IDs
      const invoiceIds = files
          .map(f => f.invoice?.id)
          .filter((id): id is string => id !== undefined && id !== null);

      console.log(`[InvoicePipeline] Found ${files.length} files and ${invoiceIds.length} associated invoices to delete.`);

      // 2. Perform Soft Deletion Transaction
      await prisma.$transaction(async (tx) => {
          const now = new Date();
          // Soft delete InvoiceFiles
          await tx.invoiceFile.updateMany({
              where: { id: { in: foundFileIds } } as any,
              data: { deletedAt: now } as any
          });

          // Soft delete Invoices
          if (invoiceIds.length > 0) {
              await tx.invoice.updateMany({
                  where: { id: { in: invoiceIds } } as any,
                  data: { deletedAt: now } as any
              });

              // Mirror soft-delete to canonical headers for these invoices
              await (tx as any).canonicalInvoice.updateMany({
                where: { legacyInvoiceId: { in: invoiceIds } } as any,
                data: { deletedAt: now } as any,
              });

              // Handle XeroInvoices linked to these invoices
              // We need to fetch them first to get sourceReference
              const invoicesWithXero = files
                  .map(f => f.invoice)
                  .filter(inv => inv && inv.sourceType === InvoiceSourceType.XERO && inv.sourceReference);
              
              if (invoicesWithXero.length > 0) {
                  const xeroReferences = invoicesWithXero.map(inv => inv!.sourceReference as string);
                  
                   // Find affected XeroInvoice IDs so we can mirror soft-delete to canonical too.
                   const xeroRows = await tx.xeroInvoice.findMany({
                     where: {
                       xeroInvoiceId: { in: xeroReferences },
                       organisationId: organisationId
                     } as any,
                     select: { id: true },
                   });

                   await tx.xeroInvoice.updateMany({
                      where: {
                          xeroInvoiceId: { in: xeroReferences },
                          organisationId: organisationId
                      } as any,
                      data: { deletedAt: now } as any
                  });
                  console.log(`[InvoicePipeline] Soft deleted up to ${invoicesWithXero.length} linked XeroInvoices`);

                  if (xeroRows.length > 0) {
                    await (tx as any).canonicalInvoice.updateMany({
                      where: { legacyXeroInvoiceId: { in: xeroRows.map(r => r.id) } } as any,
                      data: { deletedAt: now } as any,
                    });
                  }
              }
          }
      });

      console.log(`[InvoicePipeline] Successfully soft-deleted ${files.length} files.`);
      return { deletedCount: files.length, deletedIds: foundFileIds };
  },

  async bulkApproveInvoices(ids: string[], organisationId: string) {
      console.log(`[InvoicePipeline] Request to bulk approve ${ids.length} items for org ${organisationId}`);

      // 1. Fetch InvoiceFiles with Invoices
      const files = await prisma.invoiceFile.findMany({
          where: { 
              id: { in: ids }, 
              organisationId, 
              deletedAt: null 
          } as any,
          include: { invoice: true }
      });

      // 2. Filter Valid (Must have an invoice to approve)
      const validFiles = files.filter(f => f.invoice);
      const invalidFiles = files.filter(f => !f.invoice);

      if (validFiles.length === 0) {
          return { success: [], failed: invalidFiles.map(f => ({ id: f.id, error: "No invoice found for file" })) };
      }

      const validFileIds = validFiles.map(f => f.id);
      const validInvoiceIds = validFiles.map(f => f.invoice!.id);

      console.log(`[InvoicePipeline] Bulk approving ${validFiles.length} files. Skipped ${invalidFiles.length} invalid.`);

      // 3. Perform Transaction
      await prisma.$transaction(async (tx) => {
          // Update Invoices -> isVerified = true
          await tx.invoice.updateMany({
              where: { id: { in: validInvoiceIds } } as any,
              data: { isVerified: true } as any
          });

          // Update InvoiceFiles -> reviewStatus = VERIFIED
          await tx.invoiceFile.updateMany({
              where: { id: { in: validFileIds } } as any,
              data: { reviewStatus: ReviewStatus.VERIFIED } as any
          });
      });

      console.log(`[InvoicePipeline] Successfully bulk approved ${validFiles.length} invoices.`);

      return {
          success: validFiles.map(f => f.id),
          failed: invalidFiles.map(f => ({ id: f.id, error: "No invoice found for file" }))
      };
  },

  async restoreInvoice(invoiceId: string, organisationId: string) {
      console.log(`[InvoicePipeline] Request to restore invoice ${invoiceId} for org ${organisationId}`);

      // 1. Fetch Invoice (including deleted)
      const invoice = await prisma.invoice.findFirst({
          where: { id: invoiceId, organisationId, deletedAt: { not: null } } as any,
          include: { invoiceFile: true }
      });

      if (!invoice) {
          throw new Error('Invoice not found or not deleted');
      }

      const invoiceFileId = invoice.invoiceFileId;
      console.log(`[InvoicePipeline] Restoring invoice ${invoiceId}. Linked File: ${invoiceFileId || 'None'}`);

      // 2. Perform Restore Transaction
      await prisma.$transaction(async (tx) => {
          // Restore Invoice
          await tx.invoice.update({
              where: { id: invoiceId },
              data: { deletedAt: null }
          });

          // Mirror restore to canonical header
          await (tx as any).canonicalInvoice.updateMany({
            where: { legacyInvoiceId: invoiceId } as any,
            data: { deletedAt: null } as any,
          });

          // Restore InvoiceFile if present
          if (invoiceFileId) {
             await tx.invoiceFile.update({
                 where: { id: invoiceFileId },
                 data: { deletedAt: null }
             });
          }

          // Restore XeroInvoice if linked
          if (invoice.sourceType === InvoiceSourceType.XERO && invoice.sourceReference) {
              const xeroInvoice = await tx.xeroInvoice.findFirst({
                  where: {
                      xeroInvoiceId: invoice.sourceReference,
                      organisationId: organisationId,
                      deletedAt: { not: null } // Only find deleted ones
                  }
              });

              if (xeroInvoice) {
                  console.log(`[InvoicePipeline] Restoring linked XeroInvoice ${xeroInvoice.id}`);
                  await tx.xeroInvoice.update({
                      where: { id: xeroInvoice.id },
                      data: { deletedAt: null }
                  });

                  await (tx as any).canonicalInvoice.updateMany({
                    where: { legacyXeroInvoiceId: xeroInvoice.id } as any,
                    data: { deletedAt: null } as any,
                  });
              }
          }
      });

      console.log(`[InvoicePipeline] Successfully restored invoice ${invoiceId}.`);
      return true;
  },

  async bulkRestoreInvoices(ids: string[], organisationId: string) {
      console.log(`[InvoicePipeline] Request to bulk restore ${ids.length} items for org ${organisationId}`);

      // 1. Fetch InvoiceFiles (primary entity in list) that are deleted
      const files = await prisma.invoiceFile.findMany({
          where: { 
              id: { in: ids }, 
              organisationId, 
              deletedAt: { not: null } 
          } as any,
          include: { invoice: true }
      });

      if (files.length === 0) {
          return { restoredCount: 0, message: "No matching deleted files found to restore" };
      }

      const foundFileIds = files.map(f => f.id);
      
      // Collect associated Invoice IDs
      const invoiceIds = files
          .map(f => f.invoice?.id)
          .filter((id): id is string => id !== undefined && id !== null);

      console.log(`[InvoicePipeline] Found ${files.length} files and ${invoiceIds.length} associated invoices to restore.`);

      // 2. Perform Restore Transaction
      await prisma.$transaction(async (tx) => {
          // Restore InvoiceFiles
          await tx.invoiceFile.updateMany({
              where: { id: { in: foundFileIds } } as any,
              data: { deletedAt: null } as any
          });

          // Restore Invoices
          if (invoiceIds.length > 0) {
              await tx.invoice.updateMany({
                  where: { id: { in: invoiceIds } } as any,
                  data: { deletedAt: null } as any
              });

              await (tx as any).canonicalInvoice.updateMany({
                where: { legacyInvoiceId: { in: invoiceIds } } as any,
                data: { deletedAt: null } as any,
              });

              // Handle XeroInvoices linked to these invoices
              const invoicesWithXero = files
                  .map(f => f.invoice)
                  .filter(inv => inv && inv.sourceType === InvoiceSourceType.XERO && inv.sourceReference);
              
              if (invoicesWithXero.length > 0) {
                  const xeroReferences = invoicesWithXero.map(inv => inv!.sourceReference as string);
                  
                   const xeroRows = await tx.xeroInvoice.findMany({
                     where: {
                       xeroInvoiceId: { in: xeroReferences },
                       organisationId: organisationId,
                       deletedAt: { not: null }
                     } as any,
                     select: { id: true },
                   });

                   await tx.xeroInvoice.updateMany({
                      where: {
                          xeroInvoiceId: { in: xeroReferences },
                          organisationId: organisationId,
                          deletedAt: { not: null }
                      } as any,
                      data: { deletedAt: null } as any
                  });
                  console.log(`[InvoicePipeline] Restored up to ${invoicesWithXero.length} linked XeroInvoices`);

                  if (xeroRows.length > 0) {
                    await (tx as any).canonicalInvoice.updateMany({
                      where: { legacyXeroInvoiceId: { in: xeroRows.map(r => r.id) } } as any,
                      data: { deletedAt: null } as any,
                    });
                  }
              }
          }
      });

      console.log(`[InvoicePipeline] Successfully restored ${files.length} files.`);
      return { restoredCount: files.length, restoredIds: foundFileIds };
  }
};

