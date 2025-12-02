import prisma from '../infrastructure/prismaClient';
import { s3Service } from './S3Service';
import { ocrService } from './OcrService';
import { supplierResolutionService } from './SupplierResolutionService';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

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
    const key = `invoices/${metadata.organisationId}/${randomUUID()}.pdf`;
    
    // 1. Upload to S3
    await s3Service.uploadFile(fileStream, key, metadata.mimeType);

    // 2. Create InvoiceFile
    const invoiceFile = await prisma.invoiceFile.create({
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

    // 3. Start OCR
    try {
        const jobId = await ocrService.startAnalysis(key);
        
        const updated = await prisma.invoiceFile.update({
            where: { id: invoiceFile.id },
            data: {
                ocrJobId: jobId,
                processingStatus: ProcessingStatus.OCR_PROCESSING
            }
        });
        return updated;
    } catch (error) {
        console.error('Failed to start OCR:', error);
        await prisma.invoiceFile.update({
            where: { id: invoiceFile.id },
            data: { processingStatus: ProcessingStatus.OCR_FAILED }
        });
        // We return the file with FAILED status rather than throwing, so the UI can show it
        return await prisma.invoiceFile.findUniqueOrThrow({ where: { id: invoiceFile.id } });
    }
  },

  async pollProcessing(invoiceFileId: string) {
    const file = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFileId },
        include: { invoice: { include: { lineItems: true, supplier: true } }, ocrResult: true }
    });

    if (!file) throw new Error('Invoice file not found');

    // If complete or failed, return status immediately
    if (file.processingStatus === ProcessingStatus.OCR_COMPLETE || file.processingStatus === ProcessingStatus.OCR_FAILED) {
         return this.enrichStatus(file);
    }

    if (file.processingStatus === ProcessingStatus.OCR_PROCESSING && file.ocrJobId) {
        const result = await ocrService.getAnalysisResults(file.ocrJobId);
        
        if (result.JobStatus === 'SUCCEEDED') {
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
                            productCode: item.productCode
                        }))
                    }
                }
            });

            // Determine Review Status
            let reviewStatus = ReviewStatus.NEEDS_REVIEW;
            // Simple rule: High confidence (>95) and valid total implies verified?
            // For now, let's require manual verification unless perfect confidence.
            // Plan says: VERIFIED if confidenceScore >= 0.95 and no validationErrors.
            if (parsed.confidenceScore >= 95) {
                // reviewStatus = ReviewStatus.VERIFIED; 
            }

            // Update File Status
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
             return this.enrichStatus(updated);
        }
    }

    return this.enrichStatus(file);
  },

  async enrichStatus(file: any) {
      // Generate presigned URL
      let presignedUrl: string | null = null;
      if (file.storageKey) {
          try {
            presignedUrl = await s3Service.getSignedUrl(file.storageKey);
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
      total?: number; 
      createAlias?: boolean;
      aliasName?: string;
  }) {
      return await prisma.$transaction(async (tx) => {
          const invoice = await tx.invoice.findUnique({
              where: { id: invoiceId },
              include: { invoiceFile: true }
          });
          
          if (!invoice) throw new Error('Invoice not found');

          // Update Invoice
          const updatedInvoice = await tx.invoice.update({
              where: { id: invoiceId },
              data: {
                  supplierId: data.supplierId,
                  total: data.total,
                  isVerified: true,
              },
              include: { supplier: true, lineItems: true }
          });

          // Update InvoiceFile
          if (invoice.invoiceFileId) {
              await tx.invoiceFile.update({
                  where: { id: invoice.invoiceFileId },
                  data: { reviewStatus: ReviewStatus.VERIFIED }
              });
          }

          // Create Alias if requested
          if (data.createAlias && data.aliasName && data.supplierId) {
              // We use the service but we can't use it inside tx unless we pass tx to it.
              // Or we just use tx here directly.
              const normalized = data.aliasName.toLowerCase().trim();
              await tx.supplierAlias.upsert({
                where: {
                    organisationId_normalisedAliasName: {
                        organisationId: invoice.organisationId,
                        normalisedAliasName: normalized
                    }
                },
                update: { supplierId: data.supplierId },
                create: {
                    organisationId: invoice.organisationId,
                    supplierId: data.supplierId,
                    aliasName: data.aliasName,
                    normalisedAliasName: normalized
                }
            });
          }

          return updatedInvoice;
      });
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

