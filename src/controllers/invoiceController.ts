import { FastifyRequest, FastifyReply } from 'fastify';
import { invoicePipelineService } from '../services/InvoicePipelineService';
import { s3Service } from '../services/S3Service';
import prisma from '../infrastructure/prismaClient';
import { ProcessingStatus, InvoiceSourceType, ReviewStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import path from 'path';

export const invoiceController = {
  async upload(req: FastifyRequest, reply: FastifyReply) {
    const { locationId } = req.params as { locationId: string };
    const auth = req.authContext;
    
    if (!auth || !auth.organisationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Basic access check: verify location belongs to org or user has access
    // Assuming auth middleware handles org scope.
    
    const data = await req.file();
    if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Log incoming file metadata
    req.log.info({
        msg: 'Incoming invoice upload',
        fileName: data.filename,
        mimeType: data.mimetype,
        locationId,
        organisationId: auth.organisationId,
        fileStreamReadable: data.file?.readable
    });
    
    // Additional validation
    if (data.mimetype !== 'application/pdf') {
        return reply.status(400).send({ error: 'Only PDF files up to 10MB are supported' });
    }

    try {
        const result = await invoicePipelineService.submitForProcessing(data.file, {
            organisationId: auth.organisationId,
            locationId,
            fileName: data.filename,
            mimeType: data.mimetype,
        });
        return reply.status(202).send(result);
    } catch (e: any) {
        req.log.error({
            msg: 'Upload processing failed',
            error: e.name,
            message: e.message,
            stack: e.stack,
            stage: e.stage || 'unknown',
            awsCode: e.awsCode
        });
        return reply.status(500).send({ error: 'Upload processing failed' });
    }
  },

  async getStatus(req: FastifyRequest, reply: FastifyReply) {
     const { id } = req.params as { id: string };
     
     try {
         const result = await invoicePipelineService.pollProcessing(id);
         return result;
     } catch (e: any) {
         if (e.name === 'InvoiceFileNotFoundError' || e.message === 'Invoice file not found') {
             return reply.status(404).send({ error: 'Invoice file not found' });
         }
         throw e;
     }
  },

  async verify(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      // Extract all relevant fields from body
      const { supplierId, supplierName, total, createAlias, aliasName, selectedLineItemIds, date, items } = req.body as any;
      
      if (selectedLineItemIds !== undefined && !Array.isArray(selectedLineItemIds)) {
          return reply.status(400).send({ error: 'selectedLineItemIds must be an array of strings' });
      }

      if (items !== undefined && !Array.isArray(items)) {
          return reply.status(400).send({ error: 'items must be an array of objects' });
      }

      req.log.info({ 
        msg: 'Verify invoice requested',
        invoiceId: id,
        params: req.params,
        body: req.body 
      });

      try {
          const result = await invoicePipelineService.verifyInvoice(id, {
              supplierId,
              supplierName,
              total,
              createAlias,
              aliasName,
              selectedLineItemIds,
              date,
              items
          });
          
          if (!result) {
            req.log.warn({ msg: 'Invoice not found during verify', invoiceId: id });
            return reply.status(404).send({ error: 'Invoice not found' });
          }

          return result;
      } catch (e: any) {
          // Pass through specific error messages if possible
          if (e.message === 'Invoice not found') {
             return reply.status(404).send({ error: 'Invoice not found' });
          }
          // Handle the validation error we added
          if (e.message === "Supplier is required (either supplierId or supplierName)" || 
              e.message === "At least one line item must be selected" ||
              e.message.startsWith("Invalid line items")) {
              return reply.status(400).send({ error: e.message });
          }
          throw e;
      }
  },

  async list(req: FastifyRequest, reply: FastifyReply) {
      const { locationId } = req.params as { locationId: string };
      const { page, limit, search, sourceType, startDate, endDate, status } = req.query as { 
          page?: number, 
          limit?: number,
          search?: string,
          sourceType?: string,
          startDate?: string,
          endDate?: string,
          status?: 'ALL' | 'REVIEWED' | 'PENDING' | 'DELETED'
      };
      const auth = req.authContext;
      
      try {
          const result = await invoicePipelineService.listInvoices(locationId, page, limit, {
              search,
              sourceType,
              startDate,
              endDate,
              status
          });
          return result;
      } catch (error: any) {
          req.log.error({
              msg: 'List invoices failed',
              locationId,
              organisationId: auth?.organisationId,
              error: error.message,
              code: error.code,
              stack: error.stack
          });

          // Check for Prisma/Database connectivity errors
          // P1001: Can't reach database server
          // P1017: Server has closed the connection
          if (error.code === 'P1001' || error.code === 'P1017') {
              return reply.status(503).send({ 
                  error: 'Database unavailable',
                  message: 'The system is currently experiencing high load or connectivity issues. Please try again in a few moments.',
                  code: error.code
              });
          }

          return reply.status(500).send({ 
              error: 'Internal Server Error',
              message: 'Failed to retrieve invoices'
          });
      }
  },

  async delete(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
          await invoicePipelineService.deleteInvoice(id, auth.organisationId);
          return reply.status(200).send({ success: true });
      } catch (e: any) {
          req.log.error({
              msg: 'Delete invoice failed',
              invoiceId: id,
              error: e.message
          });

          if (e.message === 'Invoice not found or access denied') {
              return reply.status(404).send({ error: e.message });
          }
          
          return reply.status(500).send({ error: 'Failed to delete invoice' });
      }
  },

  async bulkDelete(req: FastifyRequest, reply: FastifyReply) {
      const { ids } = req.body as { ids: string[] };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (!Array.isArray(ids) || ids.length === 0) {
          return reply.status(400).send({ error: 'ids must be a non-empty array of strings' });
      }

      try {
          const result = await invoicePipelineService.bulkDeleteInvoices(ids, auth.organisationId);
          return reply.status(200).send(result);
      } catch (e: any) {
          req.log.error({
              msg: 'Bulk delete failed',
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to process bulk delete' });
      }
  },

  async bulkApprove(req: FastifyRequest, reply: FastifyReply) {
      const { ids } = req.body as { ids: string[] };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (!Array.isArray(ids) || ids.length === 0) {
          return reply.status(400).send({ error: 'ids must be a non-empty array of strings' });
      }

      try {
          const result = await invoicePipelineService.bulkApproveInvoices(ids, auth.organisationId);
          return reply.status(200).send(result);
      } catch (e: any) {
          req.log.error({
              msg: 'Bulk approve failed',
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to process bulk approve' });
      }
  },

  async restore(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
          await invoicePipelineService.restoreInvoice(id, auth.organisationId);
          return reply.status(200).send({ success: true });
      } catch (e: any) {
          req.log.error({
              msg: 'Restore invoice failed',
              invoiceId: id,
              error: e.message
          });

          if (e.message === 'Invoice not found or not deleted') {
              return reply.status(404).send({ error: e.message });
          }
          
          return reply.status(500).send({ error: 'Failed to restore invoice' });
      }
  },

  async bulkRestore(req: FastifyRequest, reply: FastifyReply) {
      const { ids } = req.body as { ids: string[] };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (!Array.isArray(ids) || ids.length === 0) {
          return reply.status(400).send({ error: 'ids must be a non-empty array of strings' });
      }

      try {
          const result = await invoicePipelineService.bulkRestoreInvoices(ids, auth.organisationId);
          return reply.status(200).send(result);
      } catch (e: any) {
          req.log.error({
              msg: 'Bulk restore failed',
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to process bulk restore' });
      }
  },

  async uploadSession(req: FastifyRequest, reply: FastifyReply) {
      const auth = req.authContext;
      
      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { organisationId, locationId, files } = req.body as {
          organisationId: string;
          locationId?: string;
          files: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
      };

      // Validate organisationId matches auth
      if (organisationId !== auth.organisationId) {
          return reply.status(403).send({ error: 'Organisation ID mismatch' });
      }

      // Validate files array
      if (!Array.isArray(files) || files.length === 0) {
          return reply.status(400).send({ error: 'files must be a non-empty array' });
      }

      if (files.length > 25) {
          return reply.status(400).send({ error: 'Maximum 25 files per batch' });
      }

      // Allowed MIME types
      const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
      const maxFileSize = 20 * 1024 * 1024; // 20MB

      // Validate each file
      for (const file of files) {
          if (!allowedMimeTypes.includes(file.mimeType)) {
              return reply.status(400).send({ 
                  error: `File type ${file.mimeType} not supported. Allowed types: PDF, JPEG, PNG` 
              });
          }

          if (file.sizeBytes > maxFileSize) {
              return reply.status(400).send({ 
                  error: `File ${file.filename} exceeds maximum size of 20MB` 
              });
          }
      }

      try {
          const uploadBatchId = randomUUID();
          const finalLocationId = locationId || auth.locationId;

          if (!finalLocationId) {
              return reply.status(400).send({ error: 'locationId is required' });
          }

          const uploads = [];

          for (const file of files) {
              // Sanitize filename: strip path separators and normalize
              const sanitizedFilename = path.basename(file.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
              const fileId = randomUUID();
              const storageKey = `invoices/${organisationId}/${fileId}-${sanitizedFilename}`;

              // Create InvoiceFile record with UPLOADING status
              const invoiceFile = await prisma.invoiceFile.create({
                  data: {
                      id: fileId,
                      organisationId,
                      locationId: finalLocationId,
                      sourceType: InvoiceSourceType.UPLOAD,
                      storageKey,
                      fileName: file.filename,
                      mimeType: file.mimeType,
                      processingStatus: ProcessingStatus.UPLOADING,
                      reviewStatus: ReviewStatus.NONE,
                      uploadBatchId,
                      fileSizeBytes: file.sizeBytes,
                  }
              });

              // Generate presigned upload URL
              const presignedUrl = await s3Service.getSignedUploadUrl(storageKey, file.mimeType);

              uploads.push({
                  invoiceFileId: invoiceFile.id,
                  presignedUrl,
                  storageKey
              });
          }

          // Log batch creation
          console.log(`[INVOICE_UPLOAD] batch=${uploadBatchId} files=${files.length} org=${organisationId}`);

          return reply.status(200).send({
              uploadBatchId,
              uploads
          });
      } catch (e: any) {
          req.log.error({
              msg: 'Upload session creation failed',
              error: e.message,
              stack: e.stack
          });
          return reply.status(500).send({ error: 'Failed to create upload session' });
      }
  },

  async complete(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
          // Find the file and verify it exists, is UPLOADING, and belongs to the org
          const file = await prisma.invoiceFile.findFirst({
              where: {
                  id,
                  organisationId: auth.organisationId,
                  processingStatus: ProcessingStatus.UPLOADING,
                  deletedAt: null
              } as any
          });

          if (!file) {
              return reply.status(400).send({ 
                  error: 'File not found, not in UPLOADING status, or access denied' 
              });
          }

          if (!file.storageKey) {
              return reply.status(400).send({ error: 'File has no storage key' });
          }

          // Update status to PENDING_OCR
          await prisma.invoiceFile.update({
              where: { id },
              data: {
                  processingStatus: ProcessingStatus.PENDING_OCR
              }
          });

          // Trigger OCR processing (fire-and-forget)
          invoicePipelineService.startOcrProcessing(id).catch((error) => {
              req.log.error({
                  msg: 'Failed to start OCR processing after upload complete',
                  invoiceFileId: id,
                  error: error.message
              });
          });

          return reply.status(200).send({ success: true });
      } catch (e: any) {
          req.log.error({
              msg: 'Complete upload failed',
              invoiceFileId: id,
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to complete upload' });
      }
  },

  async retryOcr(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
          const file = await prisma.invoiceFile.findFirst({
              where: {
                  id,
                  organisationId: auth.organisationId,
                  processingStatus: ProcessingStatus.OCR_FAILED,
                  deletedAt: null
              } as any
          });

          if (!file) {
              return reply.status(404).send({ error: 'File not found or not in failed status' });
          }

          // Check if max attempts reached
          if ((file.ocrAttemptCount || 0) >= 3) {
              return reply.status(400).send({ error: 'Maximum OCR attempts (3) already reached' });
          }

          // Reset status to PENDING_OCR and trigger retry
          await prisma.invoiceFile.update({
              where: { id },
              data: {
                  processingStatus: ProcessingStatus.PENDING_OCR,
                  ocrFailureCategory: null,
                  ocrFailureDetail: null,
                  failureReason: null,
              }
          });

          // Trigger OCR processing (fire-and-forget)
          invoicePipelineService.startOcrProcessing(id).catch((error) => {
              req.log.error({
                  msg: 'Failed to retry OCR processing',
                  invoiceFileId: id,
                  error: error.message
              });
          });

          return reply.status(200).send({ success: true, message: 'OCR retry initiated' });
      } catch (e: any) {
          req.log.error({
              msg: 'Retry OCR failed',
              invoiceFileId: id,
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to retry OCR' });
      }
  },

  async replaceFile(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      const data = await req.file();
      if (!data) {
          return reply.status(400).send({ error: 'No file uploaded' });
      }

      try {
          const file = await prisma.invoiceFile.findFirst({
              where: {
                  id,
                  organisationId: auth.organisationId,
                  deletedAt: null
              } as any
          });

          if (!file) {
              return reply.status(404).send({ error: 'File not found' });
          }

          // Upload new file to S3 (replace the storage key or create new one)
          const newKey = `invoices/${auth.organisationId}/${randomUUID()}.${data.filename.split('.').pop()}`;
          await s3Service.uploadFile(data.file, newKey, data.mimetype);

          // Update InvoiceFile with new file and reset OCR state
          await prisma.invoiceFile.update({
              where: { id },
              data: {
                  storageKey: newKey,
                  fileName: data.filename,
                  mimeType: data.mimetype,
                  fileSizeBytes: data.file?.readable ? undefined : undefined, // Would need to calculate from stream
                  processingStatus: ProcessingStatus.PENDING_OCR,
                  ocrAttemptCount: 0,
                  ocrFailureCategory: null,
                  ocrFailureDetail: null,
                  failureReason: null,
                  lastOcrAttemptAt: null,
                  preprocessingFlags: Prisma.DbNull,
                  ocrJobId: null,
                  confidenceScore: null,
              }
          });

          // Trigger OCR processing
          invoicePipelineService.startOcrProcessing(id).catch((error) => {
              req.log.error({
                  msg: 'Failed to start OCR after file replace',
                  invoiceFileId: id,
                  error: error.message
              });
          });

          return reply.status(200).send({ success: true, message: 'File replaced and OCR initiated' });
      } catch (e: any) {
          req.log.error({
              msg: 'Replace file failed',
              invoiceFileId: id,
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to replace file' });
      }
  },

  async createManualEntry(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;

      if (!auth || !auth.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      try {
          const file = await prisma.invoiceFile.findFirst({
              where: {
                  id,
                  organisationId: auth.organisationId,
                  processingStatus: ProcessingStatus.OCR_FAILED,
                  deletedAt: null
              } as any,
              include: { invoice: true }
          });

          if (!file) {
              return reply.status(404).send({ error: 'File not found or not in failed status' });
          }

          // Create a draft invoice linked to the failed file
          let invoice;
          if (file.invoice) {
              // Invoice already exists, return it
              invoice = file.invoice;
          } else {
              invoice = await prisma.invoice.create({
                  data: {
                      organisationId: file.organisationId,
                      locationId: file.locationId,
                      invoiceFileId: file.id,
                      sourceType: file.sourceType,
                      isVerified: false,
                  }
              });
          }

          return reply.status(200).send({ 
              success: true, 
              invoiceId: invoice.id,
              message: 'Draft invoice created for manual entry' 
          });
      } catch (e: any) {
          req.log.error({
              msg: 'Create manual entry failed',
              invoiceFileId: id,
              error: e.message
          });
          return reply.status(500).send({ error: 'Failed to create manual entry' });
      }
  }
};

