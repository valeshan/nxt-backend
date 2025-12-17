import prisma from '../infrastructure/prismaClient';
import { s3Service } from './S3Service';
import { ocrService } from './OcrService';
import { supplierResolutionService } from './SupplierResolutionService';
import { imagePreprocessingService } from './ImagePreprocessingService';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, SupplierSourceType, SupplierStatus, OcrFailureCategory } from '@prisma/client';
import { randomUUID } from 'crypto';
import { MANUAL_COGS_ACCOUNT_CODE } from '../config/constants';

import { getProductKeyFromLineItem } from './helpers/productKey';

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
                      reviewStatus: updated.reviewStatus,
                      invoice: updated.invoice ?? null,
                      ocrFailureCategory: updated.ocrFailureCategory ?? null,
                      ocrFailureDetail: updated.ocrFailureDetail ?? null,
                  });
              }
          } catch (err) {
              console.error(`[InvoicePipeline] Error processing pending OCR job for file ${file.id}:`, err);
              // Continue to next file
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
        } as any
      });

      if (!file) {
        throw new Error(`InvoiceFile ${invoiceFileId} not found or not in valid status for OCR`);
      }

      if (!file.storageKey) {
        throw new Error(`InvoiceFile ${invoiceFileId} has no storageKey`);
      }

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
      await prisma.invoiceFile.update({
        where: { id: invoiceFileId },
        data: {
          ocrAttemptCount: attemptCount,
          lastOcrAttemptAt: new Date(),
          preprocessingFlags: preprocessingFlags,
          processingStatus: ProcessingStatus.OCR_PROCESSING,
        }
      });

      console.log(`[InvoicePipeline] Starting OCR attempt ${attemptCount} for ${invoiceFileId} using ${s3KeyToUse}`);
      const jobId = await ocrService.startAnalysis(s3KeyToUse);
      
      await prisma.invoiceFile.update({
        where: { id: invoiceFileId },
        data: {
          ocrJobId: jobId,
        }
      });
      
      console.log(`[InvoicePipeline] OCR started for ${invoiceFileId}, JobId: ${jobId}, Attempt: ${attemptCount}`);
    } catch (error: any) {
      console.error(`[InvoicePipeline] Failed to start OCR for ${invoiceFileId}:`, error);
      
      const failureReason = error.message || 'Failed to start OCR processing';
      const classification = classifyOcrFailure(error);
      
      await prisma.invoiceFile.update({
        where: { id: invoiceFileId },
        data: { 
          processingStatus: ProcessingStatus.OCR_FAILED,
          failureReason,
          ocrFailureCategory: classification.category,
          ocrFailureDetail: classification.detail,
        }
      }).catch((dbError) => {
        console.error(`[InvoicePipeline] Failed to update status for ${invoiceFileId}:`, dbError);
      });
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

                   const updated = await prisma.invoiceFile.update({
                     where: { id: file.id },
                     data: {
                       processingStatus: ProcessingStatus.OCR_FAILED,
                       ocrFailureCategory: classification.category,
                       ocrFailureDetail: classification.detail,
                       failureReason: `Early abort: ${classification.detail}`,
                       confidenceScore: confidenceScore,
                     },
                   });

                   return this.enrichStatus(updated);
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
                         // Ignore P2002 (Unique constraint) as it means it was created concurrently
                         if (e.code !== 'P2002') throw e;
                         console.log(`[InvoicePipeline] Invoice already exists for file ${file.id}, skipping creation.`);
                     }
                 }

                 // Determine Review Status
                 let reviewStatus = ReviewStatus.NEEDS_REVIEW;
                 if (parsed.confidenceScore >= 95) {
                     // reviewStatus = ReviewStatus.VERIFIED; 
                 }

                 // Update File Status and return FRESH enriched object
                 const updatedFile = await prisma.invoiceFile.update({
                     where: { id: file.id },
                     data: {
                         processingStatus: ProcessingStatus.OCR_COMPLETE,
                         reviewStatus: reviewStatus,
                         confidenceScore: parsed.confidenceScore,
                     },
                     include: { invoice: { include: { lineItems: true, supplier: true } }, ocrResult: true }
                 });
                 
                 return this.enrichStatus(updatedFile);

             } else if (result.JobStatus === 'FAILED') {
                  // Classify the failure
                  const classification = classifyOcrFailure(
                    { message: 'OCR job failed', code: 'JobFailed' },
                    undefined,
                    undefined
                  );

                  const updated = await prisma.invoiceFile.update({
                     where: { id: file.id },
                     data: { 
                       processingStatus: ProcessingStatus.OCR_FAILED,
                       ocrFailureCategory: classification.category,
                       ocrFailureDetail: classification.detail,
                       failureReason: `OCR job failed: ${classification.detail}`
                     }
                  });
                  // Return enriched status even on failure
                  return this.enrichStatus(updated);
             }
        } catch (e) {
            console.error(`Error polling job ${file.ocrJobId}`, e);
            // Fall through to return current status
        }
    }

    // Always return enriched status for any other state (PENDING, COMPLETE, VERIFIED, FAILED)
    return this.enrichStatus(file);
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
      return {
          ...file,
          presignedUrl,
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
        return null;
      }

      // Run everything in a transaction to ensure atomicity
      return await prisma.$transaction(async (tx) => {
          let targetSupplierId = data.supplierId;

          // 2. Resolve or Create Supplier if needed
          if (!targetSupplierId && data.supplierName) {
              const normalizedName = data.supplierName.toLowerCase().trim();
              
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
                  if (existingSupplier.status === SupplierStatus.PENDING_REVIEW) {
                      await tx.supplier.update({
                          where: { id: existingSupplier.id },
                          data: { status: SupplierStatus.ACTIVE }
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
                          status: SupplierStatus.ACTIVE
                      }
                  });
                  targetSupplierId = newSupplier.id;
                  console.log(`[InvoicePipeline] Created new supplier: ${newSupplier.name} (${newSupplier.id})`);
              }
          }

          // 3. Delete All Existing Line Items
          // We replace them entirely with the verified list to ensure source of truth
          console.log(`[InvoicePipeline] Clearing existing line items for invoice ${invoiceId}...`);
          await tx.invoiceLineItem.deleteMany({
              where: { invoiceId: invoiceId }
          });

          // 4. Create New Line Items (Normalized)
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

          // 5. Update Invoice Header
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

          // 6. Update InvoiceFile Status
          if (invoice.invoiceFileId) {
              await tx.invoiceFile.update({
                  where: { id: invoice.invoiceFileId },
                  data: { reviewStatus: ReviewStatus.VERIFIED }
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
          return updatedInvoice;
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
      }
  ) {
      const skip = (page - 1) * limit;
      
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
      if (filters?.startDate || filters?.endDate) {
          const dateFilter: any = {};
          if (filters.startDate) dateFilter.gte = new Date(filters.startDate);
          if (filters.endDate) dateFilter.lte = new Date(filters.endDate);

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
              take: limit,
              skip
          }),
          prisma.invoiceFile.count({ where })
      ]);
      
      // Check for items that need status updates (OCR_PROCESSING)
      // We actively poll them so the list reflects the real-time status from AWS
      const processingItems = items.filter(
          item => item.processingStatus === ProcessingStatus.OCR_PROCESSING && item.ocrJobId
      );

      if (processingItems.length > 0) {
          console.log(`[InvoicePipeline] List contains ${processingItems.length} processing items. Refreshing status...`);
          
          try {
              // Run pollProcessing for each in parallel
              // pollProcessing handles the DB update if status changed
              const updates = await Promise.allSettled(
                  processingItems.map(item => this.pollProcessing(item.id))
              );

              // Map updated items back into the list
              const updatedMap = new Map();
              updates.forEach((result, index) => {
                  if (result.status === 'fulfilled' && result.value) {
                      const originalId = processingItems[index].id;
                      updatedMap.set(originalId, result.value);
                  }
              });

              items = items.map(item => {
                  if (updatedMap.has(item.id)) {
                      // We merge the updated data. 
                      // Note: pollProcessing returns lineItems/ocrResult which aren't usually in list view,
                      // but it's fine to include them or we could strip them if payload size is a concern.
                      // For now, simply replacing is safest to get the new status/invoice data.
                      return updatedMap.get(item.id);
                  }
                  return item;
              });
          } catch (e) {
              console.error("[InvoicePipeline] Error refreshing item statuses in list", e);
              // Fallback to returning original items if update fails
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
          page,
          pages: Math.ceil(count / limit)
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
          // Soft delete Invoice
          await tx.invoice.update({
              where: { id: invoiceId } as any,
              data: { deletedAt: new Date() } as any
          });

          // Soft delete InvoiceFile if present
          if (invoiceFileId) {
             await tx.invoiceFile.update({
                 where: { id: invoiceFileId } as any,
                 data: { deletedAt: new Date() } as any
             });
          }

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
                      data: { deletedAt: new Date() } as any
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
          // Soft delete InvoiceFiles
          await tx.invoiceFile.updateMany({
              where: { id: { in: foundFileIds } } as any,
              data: { deletedAt: new Date() } as any
          });

          // Soft delete Invoices
          if (invoiceIds.length > 0) {
              await tx.invoice.updateMany({
                  where: { id: { in: invoiceIds } } as any,
                  data: { deletedAt: new Date() } as any
              });

              // Handle XeroInvoices linked to these invoices
              // We need to fetch them first to get sourceReference
              const invoicesWithXero = files
                  .map(f => f.invoice)
                  .filter(inv => inv && inv.sourceType === InvoiceSourceType.XERO && inv.sourceReference);
              
              if (invoicesWithXero.length > 0) {
                  const xeroReferences = invoicesWithXero.map(inv => inv!.sourceReference as string);
                  
                   await tx.xeroInvoice.updateMany({
                      where: {
                          xeroInvoiceId: { in: xeroReferences },
                          organisationId: organisationId
                      } as any,
                      data: { deletedAt: new Date() } as any
                  });
                  console.log(`[InvoicePipeline] Soft deleted up to ${invoicesWithXero.length} linked XeroInvoices`);
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

              // Handle XeroInvoices linked to these invoices
              const invoicesWithXero = files
                  .map(f => f.invoice)
                  .filter(inv => inv && inv.sourceType === InvoiceSourceType.XERO && inv.sourceReference);
              
              if (invoicesWithXero.length > 0) {
                  const xeroReferences = invoicesWithXero.map(inv => inv!.sourceReference as string);
                  
                   await tx.xeroInvoice.updateMany({
                      where: {
                          xeroInvoiceId: { in: xeroReferences },
                          organisationId: organisationId,
                          deletedAt: { not: null }
                      } as any,
                      data: { deletedAt: null } as any
                  });
                  console.log(`[InvoicePipeline] Restored up to ${invoicesWithXero.length} linked XeroInvoices`);
              }
          }
      });

      console.log(`[InvoicePipeline] Successfully restored ${files.length} files.`);
      return { restoredCount: files.length, restoredIds: foundFileIds };
  }
};

