import prisma from '../infrastructure/prismaClient';
import { s3Service } from './S3Service';
import { ocrService } from './OcrService';
import { supplierResolutionService } from './SupplierResolutionService';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, SupplierSourceType, SupplierStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { MANUAL_COGS_ACCOUNT_CODE } from '../config/constants';

export class InvoiceFileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceFileNotFoundError';
  }
}

export const invoicePipelineService = {
  async submitForProcessing(
    fileStream: any, 
    metadata: { 
        organisationId: string; 
        locationId: string; 
        fileName: string; 
        mimeType: string; 
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
                sourceType: InvoiceSourceType.UPLOAD,
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
    const file = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFileId },
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
                 
                 // Resolve Supplier
                 const resolution = await supplierResolutionService.resolveSupplier(parsed.supplierName || '', file.organisationId);
                 
                 // Create OcrResult
                 await prisma.invoiceOcrResult.create({
                     data: {
                         invoiceFileId: file.id,
                         rawResultJson: result as any,
                         parsedJson: parsed as any
                     }
                 });

                 // Create Invoice
                 await prisma.invoice.create({
                     data: {
                         organisationId: file.organisationId,
                         locationId: file.locationId,
                         invoiceFileId: file.id,
                         supplierId: resolution?.supplier.id,
                         invoiceNumber: parsed.invoiceNumber,
                         date: parsed.date,
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
                  const updated = await prisma.invoiceFile.update({
                     where: { id: file.id },
                     data: { processingStatus: ProcessingStatus.OCR_FAILED }
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
            presignedUrl = await s3Service.getSignedUrl(file.storageKey);
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

      let targetSupplierId = data.supplierId;

      // 2. Resolve or Create Supplier if needed
      if (!targetSupplierId && data.supplierName) {
          const normalizedName = data.supplierName.toLowerCase().trim();
          
          // Check if exists
          const existingSupplier = await prisma.supplier.findFirst({
              where: {
                  organisationId: invoice.organisationId,
                  normalizedName
              }
          });

          if (existingSupplier) {
              targetSupplierId = existingSupplier.id;
          } else {
              // Create new supplier
              const newSupplier = await prisma.supplier.create({
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

      // 3. Update Invoice
      const updatedInvoice = await prisma.invoice.update({
          where: { id: invoiceId },
          data: {
              supplierId: targetSupplierId,
              total: data.total,
              isVerified: true,
          },
          include: { supplier: true, lineItems: true }
      });

      // 4. Update InvoiceFile
      if (invoice.invoiceFileId) {
          await prisma.invoiceFile.update({
              where: { id: invoice.invoiceFileId },
              data: { reviewStatus: ReviewStatus.VERIFIED }
          });
      }

      // 5. Create Alias if requested
      if (data.createAlias) {
          const aliasName = data.aliasName || data.supplierName; // Fallback to supplier name if alias name empty
          
          if (aliasName && targetSupplierId) {
            const normalized = aliasName.toLowerCase().trim();
            // Use upsert to avoid P2002 if alias exists
            await prisma.supplierAlias.upsert({
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
  },
  
  async listInvoices(locationId: string, page = 1, limit = 20) {
      const skip = (page - 1) * limit;
      const [items, count] = await Promise.all([
          prisma.invoiceFile.findMany({
              where: { locationId },
              include: { invoice: { include: { supplier: true } } },
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip
          }),
          prisma.invoiceFile.count({ where: { locationId } })
      ]);
      
      return {
          items,
          total: count,
          page,
          pages: Math.ceil(count / limit)
      };
  }
};

