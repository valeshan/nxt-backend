import { ProcessingStatus, ReviewStatus, SupplierStatus, VerificationSource } from '@prisma/client';

/**
 * Confidence threshold for auto-approval eligibility.
 * Invoices with confidenceScore >= this value are considered high-confidence.
 *
 * NOTE: confidenceScore is stored as a PERCENT in this codebase (0-100), not 0-1.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 90;

export type AutoApprovalReasonCode =
  | 'FEATURE_DISABLED'
  | 'ALREADY_VERIFIED'
  | 'NOT_REVIEWABLE'
  | 'NOT_OCR_COMPLETE'
  | 'HAS_MANUAL_EDITS'
  | 'HAS_VALIDATION_ERRORS'
  | 'NO_SUPPLIER'
  | 'SUPPLIER_NOT_ACTIVE'
  | 'NO_QUALITY_DATA'
  | 'HAS_WARNING_LINES'
  | 'LOW_CONFIDENCE'
  | 'MISSING_TOTAL'
  | 'NEGATIVE_TOTAL'
  | 'MISSING_INVOICE_DATE';

export type AutoApprovalDecision =
  | { ok: true }
  | { ok: false; reasonCode: AutoApprovalReasonCode };

export type AutoApprovalRequirements = {
  minConfidenceScorePercent: number;
  requiresOcrComplete: boolean;
  requiresNeedsReview: boolean;
  requiresSupplierActive: boolean;
  requiresNoWarningLines: boolean;
  requiresNoValidationErrors: boolean;
  requiresInvoiceDate: boolean;
  requiresNonNegativeTotal: boolean;
};

export function getAutoApprovalRequirements(): AutoApprovalRequirements {
  return {
    minConfidenceScorePercent: HIGH_CONFIDENCE_THRESHOLD,
    requiresOcrComplete: true,
    requiresNeedsReview: true,
    requiresSupplierActive: true,
    requiresNoWarningLines: true,
    requiresNoValidationErrors: true,
    requiresInvoiceDate: true,
    requiresNonNegativeTotal: true,
  };
}

export function hasValidationErrors(value: unknown): boolean {
  // Matches Postgres JSON cases:
  // - DB NULL -> value is null/undefined
  // - JSON null -> value is null
  // - empty array -> []
  if (value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

export function isInvoiceAutoApprovable(params: {
  locationAutoApproveEnabled: boolean;
  invoiceFile: {
    reviewStatus: ReviewStatus;
    processingStatus: ProcessingStatus;
    confidenceScore: number | null;
    validationErrors?: unknown;
    verificationSource?: VerificationSource | null;
  };
  invoice: {
    total: any;
    date: Date | null;
    supplier?: { status: SupplierStatus } | null;
  };
  canonical?: { warningLineCount: number | null } | null;
}): AutoApprovalDecision {
  const { locationAutoApproveEnabled, invoiceFile, invoice, canonical } = params;

  // 1) Location feature flag must be enabled
  if (!locationAutoApproveEnabled) {
    return { ok: false, reasonCode: 'FEATURE_DISABLED' };
  }

  // 2) Must be in reviewable state (idempotent guard)
  if (invoiceFile.reviewStatus === ReviewStatus.VERIFIED) {
    return { ok: false, reasonCode: 'ALREADY_VERIFIED' };
  }
  if (invoiceFile.reviewStatus !== ReviewStatus.NEEDS_REVIEW) {
    return { ok: false, reasonCode: 'NOT_REVIEWABLE' };
  }

  // 3) Manual edits block auto-approval (manual always wins)
  if (invoiceFile.processingStatus === ProcessingStatus.MANUALLY_UPDATED) {
    return { ok: false, reasonCode: 'HAS_MANUAL_EDITS' };
  }

  // 4) Must be OCR_COMPLETE
  if (invoiceFile.processingStatus !== ProcessingStatus.OCR_COMPLETE) {
    return { ok: false, reasonCode: 'NOT_OCR_COMPLETE' };
  }

  // 5) Validation errors must be empty/null
  if (hasValidationErrors(invoiceFile.validationErrors)) {
    return { ok: false, reasonCode: 'HAS_VALIDATION_ERRORS' };
  }

  // 6) Supplier must exist and be ACTIVE (prevents "Trojan Horse" attacks)
  if (!invoice.supplier) {
    return { ok: false, reasonCode: 'NO_SUPPLIER' };
  }
  if (invoice.supplier.status !== SupplierStatus.ACTIVE) {
    return { ok: false, reasonCode: 'SUPPLIER_NOT_ACTIVE' };
  }

  // 7) Must have canonical header quality data and be warning-free
  if (!canonical) {
    return { ok: false, reasonCode: 'NO_QUALITY_DATA' };
  }
  if ((canonical.warningLineCount ?? 0) > 0) {
    return { ok: false, reasonCode: 'HAS_WARNING_LINES' };
  }

  // 8) Confidence threshold check
  const confidence = invoiceFile.confidenceScore ?? 0;
  if (confidence < HIGH_CONFIDENCE_THRESHOLD) {
    return { ok: false, reasonCode: 'LOW_CONFIDENCE' };
  }

  // 9) Invoice date required (safer than approving undated invoices)
  if (!invoice.date) {
    return { ok: false, reasonCode: 'MISSING_INVOICE_DATE' };
  }

  // 10) Total required and non-negative (credit notes blocked until invoiceType exists)
  if (invoice.total === null || invoice.total === undefined) {
    return { ok: false, reasonCode: 'MISSING_TOTAL' };
  }
  const total = invoice.total?.toNumber?.() ?? Number(invoice.total);
  if (!Number.isFinite(total)) {
    return { ok: false, reasonCode: 'MISSING_TOTAL' };
  }
  if (total < 0) {
    return { ok: false, reasonCode: 'NEGATIVE_TOTAL' };
  }

  return { ok: true };
}


