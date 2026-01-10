import { FastifyRequest, FastifyReply } from 'fastify';
import { invoicePipelineService } from '../services/InvoicePipelineService';
import { s3Service } from '../services/S3Service';
import prisma from '../infrastructure/prismaClient';
import { ProcessingStatus, InvoiceSourceType, ReviewStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import path from 'path';
import { getInvoiceFileIfOwned, getInvoiceIfOwned, getLocationIfOwned, validateLocationScope } from '../utils/authorization';
import { getRedisClient } from '../infrastructure/redis';
import { config } from '../config/env';
import { getRetroAutoApprovableSummary, markRetroAutoApproveDiscoverySeen, runRetroAutoApprove } from '../services/autoApproval/retroAutoApproveService';

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

    // Extract test override header for E2E determinism (only in test environment)
    let testOverridesJson: any = null;
    const testOcrSupplierName = req.headers['x-test-ocr-supplier-name'];
    if ((process.env.NODE_ENV === 'test' || process.env.E2E === 'true') && testOcrSupplierName) {
        if (typeof testOcrSupplierName === 'string') {
            testOverridesJson = { ocrSupplierName: testOcrSupplierName };
            req.log.info({ msg: 'Test OCR override applied', ocrSupplierName: testOcrSupplierName });
        }
    }

    try {
        const result = await invoicePipelineService.submitForProcessing(data.file, {
            organisationId: auth.organisationId,
            locationId,
            fileName: data.filename,
            mimeType: data.mimetype,
            testOverridesJson,
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
     const auth = req.authContext;
     
     if (!auth?.organisationId) {
       return reply.status(401).send({ error: 'Unauthorized' });
     }
     
     const file = await getInvoiceFileIfOwned(id, auth.organisationId);
     if (!file) {
       return reply.status(404).send({ error: 'Invoice file not found' });
     }
     
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
      const auth = req.authContext;
      
      if (!auth?.organisationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      
      // Verify invoice belongs to org before processing (shared helper for consistency)
      const invoice = await getInvoiceIfOwned(id, auth.organisationId);
      if (!invoice) {
        return reply.status(404).send({ error: 'Invoice not found' });
      }
      
      // Extract all relevant fields from body
      const { 
        supplierId, 
        supplierName, 
        total, 
        createAlias, 
        aliasName, 
        selectedLineItemIds, 
        date, 
        items, 
        hasManuallyAddedItems,
        approveTerms,
        approvedPhrases
      } = req.body as any;
      
      if (selectedLineItemIds !== undefined && !Array.isArray(selectedLineItemIds)) {
          return reply.status(400).send({ error: 'selectedLineItemIds must be an array of strings' });
      }

      if (items !== undefined && !Array.isArray(items)) {
          return reply.status(400).send({ error: 'items must be an array of objects' });
      }

      if (approvedPhrases !== undefined && !Array.isArray(approvedPhrases)) {
          return reply.status(400).send({ error: 'approvedPhrases must be an array of strings' });
      }

      if (approveTerms !== undefined && typeof approveTerms !== 'boolean') {
          return reply.status(400).send({ error: 'approveTerms must be a boolean' });
      }

      // Log invoice verification request without sensitive payload data
      req.log.info({ 
        msg: 'Verify invoice requested',
        invoiceId: id,
        hasSupplierId: !!supplierId,
        hasSupplierName: !!supplierName,
        hasTotal: !!total,
        hasDate: !!date,
        itemsCount: items?.length,
        selectedLineItemIdsCount: selectedLineItemIds?.length,
        hasManuallyAddedItems,
        approveTerms,
        approvedPhrasesCount: approvedPhrases?.length
      });

      req.log.info({ approveTerms, approvedPhrasesCount: approvedPhrases?.length });

      try {
          const result = await invoicePipelineService.verifyInvoice(id, {
              supplierId,
              supplierName,
              total,
              createAlias,
              aliasName,
              selectedLineItemIds,
              date,
              items,
              hasManuallyAddedItems,
              approveTerms,
              approvedPhrases
          });
          
          if (!result) {
            req.log.warn({ msg: 'Invoice not found during verify', invoiceId: id });
            return reply.status(404).send({ error: 'Invoice not found' });
          }

          return result;
      } catch (e: any) {
          // Standardize error handling: use statusCode and code, not message strings
          const statusCode = e.statusCode || 500;
          const errorCode = e.code || 'INTERNAL_ERROR';
          const errorMessage = e.message || 'An error occurred while verifying the invoice';
          
          // Handle specific error codes
          if (errorCode === 'INVALID_SUPPLIER_ID') {
              return reply.status(400).send({ 
                  error: {
                      code: 'INVALID_SUPPLIER_ID',
                      message: errorMessage
                  }
              });
          }
          
          // Handle 404 errors (Invoice not found)
          if (statusCode === 404 || errorCode === 'INVOICE_NOT_FOUND') {
              return reply.status(404).send({ 
                  error: {
                      code: 'INVOICE_NOT_FOUND',
                      message: errorMessage
                  }
              });
          }
          
          // Handle 400 errors (validation errors)
          if (statusCode === 400) {
              return reply.status(400).send({ 
                  error: {
                      code: errorCode,
                      message: errorMessage
                  }
              });
          }
          
          // Re-throw for global error handler to process
          throw e;
      }
  },

  async revert(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const auth = req.authContext;
      
      if (!auth?.organisationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      
      // Verify invoice belongs to org before processing
      const invoice = await getInvoiceIfOwned(id, auth.organisationId);
      if (!invoice) {
        return reply.status(404).send({ error: 'Invoice not found' });
      }

      req.log.info({ 
        msg: 'Revert invoice verification requested',
        invoiceId: id,
        params: req.params
      });

      try {
          const result = await invoicePipelineService.revertVerification(
              id, 
              auth.organisationId
          );
          
          if (!result) {
            req.log.warn({ msg: 'Invoice not found during revert', invoiceId: id });
            return reply.status(404).send({ error: 'Invoice not found' });
          }

          return result;
      } catch (e: any) {
          req.log.error({ error: e }, 'Revert verification failed');
          
          const statusCode = e.statusCode || 500;
          const errorMessage = e.message || 'An error occurred while reverting the invoice';
          
          if (statusCode === 404 || errorMessage.includes('not found')) {
              return reply.status(404).send({ error: errorMessage });
          }
          
          if (statusCode === 400 || errorMessage.includes('not verified')) {
              return reply.status(400).send({ error: errorMessage });
          }
          
          return reply.status(500).send({ error: 'Internal server error' });
      }
  },

  async list(req: FastifyRequest, reply: FastifyReply) {
      const { locationId } = req.params as { locationId: string };
      const { page, limit, search, sourceType, startDate, endDate, status, refreshProcessing } = req.query as { 
          page?: number, 
          limit?: number,
          search?: string,
          sourceType?: string,
          startDate?: string,
          endDate?: string,
          status?: 'ALL' | 'REVIEWED' | 'PENDING' | 'DELETED',
          refreshProcessing?: boolean,
      };
      const auth = req.authContext;
      
      if (!auth?.organisationId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      
      // Validate location belongs to org
      const location = await getLocationIfOwned(locationId, auth.organisationId);
      if (!location) {
        return reply.status(404).send({ error: 'Location not found' });
      }
      
      // If token is location-scoped, validate it matches
      if (!validateLocationScope(locationId, auth)) {
        return reply.status(404).send({ error: 'Location not found' });
      }
      
      try {
          const result = await invoicePipelineService.listInvoices(locationId, page, limit, {
              search,
              sourceType,
              startDate,
              endDate,
              status,
              refreshProcessing,
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

  async batchRefreshOcrStatus(req: FastifyRequest, reply: FastifyReply) {
      const auth = req.authContext;
      const { invoiceFileIds } = req.body as { invoiceFileIds: string[] };

      if (!auth?.organisationId) {
          return reply.status(401).send({ error: 'Unauthorized' });
      }

      // Enforce location context (this endpoint is intended for list UI in a location)
      if (auth.tokenType !== 'location' || !auth.locationId) {
          return reply.status(403).send({ error: 'Location context required' });
      }

      if (!Array.isArray(invoiceFileIds) || invoiceFileIds.length === 0) {
          return reply.status(400).send({ error: 'invoiceFileIds must be a non-empty array' });
      }

      if (invoiceFileIds.length > 20) {
          return reply.status(400).send({ error: 'invoiceFileIds must have at most 20 items' });
      }

      // Light rate limit: 30/min per org + location
      if (config.NODE_ENV === 'production') {
          try {
              const redis = getRedisClient();
              const minute = Math.floor(Date.now() / 60_000);
              const key = `rl:ocrBatch:${auth.organisationId}:${auth.locationId}:${minute}`;
              const count = await redis.incr(key);
              if (count === 1) {
                  await redis.expire(key, 120);
              }
              if (count > 30) {
                  reply.header('Retry-After', '60');
                  return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many refresh requests. Please try again shortly.' } });
              }
          } catch (e) {
              // Best-effort: do not block if Redis is temporarily unavailable
          }
      }

      // Fetch minimal state for ownership + status gating
      const files = await prisma.invoiceFile.findMany({
          where: {
              id: { in: invoiceFileIds },
              organisationId: auth.organisationId,
              locationId: auth.locationId,
              deletedAt: null,
          } as any,
          select: {
              id: true,
              processingStatus: true,
              ocrJobId: true,
              updatedAt: true,
              reviewStatus: true,
              ocrFailureCategory: true,
              ocrFailureDetail: true,
          },
      });

      const fileMap = new Map(files.map(f => [f.id, f]));

      const results: Array<any> = [];

      // Process with small bounded concurrency to avoid OCR provider spikes.
      const toProcess = invoiceFileIds;
      const concurrency = 5;
      for (let i = 0; i < toProcess.length; i += concurrency) {
          const chunk = toProcess.slice(i, i + concurrency);
          const settled = await Promise.allSettled(chunk.map(async (invoiceFileId) => {
              const file = fileMap.get(invoiceFileId);
              if (!file) {
                  return { invoiceFileId, polled: false, action: 'skipped_not_found' };
              }

              if (file.processingStatus !== ProcessingStatus.OCR_PROCESSING || !file.ocrJobId) {
                  return { invoiceFileId, polled: false, action: 'skipped_not_processing', status: file.processingStatus, updatedAt: file.updatedAt };
              }

              const updated = await invoicePipelineService.pollProcessing(invoiceFileId);
              return {
                  invoiceFileId,
                  polled: true,
                  action: 'checked',
                  status: updated.processingStatus,
                  updatedAt: updated.updatedAt,
                  reviewStatus: updated.reviewStatus,
                  invoice: updated.invoice ?? null,
                  ocrFailureCategory: updated.ocrFailureCategory ?? null,
                  ocrFailureDetail: updated.ocrFailureDetail ?? null,
              };
          }));

          for (let idx = 0; idx < settled.length; idx++) {
              const invoiceFileId = chunk[idx];
              const s = settled[idx];
              if (s.status === 'fulfilled') {
                  results.push(s.value);
              } else {
                  results.push({ invoiceFileId, polled: false, action: 'error', error: 'Refresh failed' });
              }
          }
      }

      return reply.send({ results });
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
  },

  async getReviewCount(req: FastifyRequest, reply: FastifyReply) {
    const { locationId } = req.params as { locationId: string };
    const auth = req.authContext;
    
    if (!auth?.organisationId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    
    // Validate location belongs to org
    const location = await getLocationIfOwned(locationId, auth.organisationId);
    if (!location) {
      return reply.status(404).send({ error: 'Location not found' });
    }
    
    // If token is location-scoped, validate it matches
    if (!validateLocationScope(locationId, auth)) {
      return reply.status(404).send({ error: 'Location not found' });
    }
    
    try {
      const count = await prisma.invoiceFile.count({
        where: {
          locationId,
          organisationId: auth.organisationId,
          reviewStatus: ReviewStatus.NEEDS_REVIEW,
          deletedAt: null,
        } as any,
      });
      
      return reply.status(200).send({ count });
    } catch (error: any) {
      req.log.error({
        msg: 'Get review count failed',
        locationId,
        organisationId: auth?.organisationId,
        error: error.message,
      });
      return reply.status(500).send({ error: 'Failed to get review count' });
    }
  },

  async getRetroAutoApproveSummary(req: FastifyRequest, reply: FastifyReply) {
      const auth = req.authContext;
      if (!auth?.organisationId) {
          return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } });
      }
      if (auth.tokenType !== 'location' || !auth.locationId) {
          return reply.status(403).send({ error: { code: 'LOCATION_CONTEXT_REQUIRED', message: 'Location context required' } });
      }

      const result = await getRetroAutoApprovableSummary({
          organisationId: auth.organisationId,
          locationId: auth.locationId,
          userId: auth.userId,
      });

      return reply.status(200).send(result);
  },

  async runRetroAutoApprove(req: FastifyRequest, reply: FastifyReply) {
      const auth = req.authContext;
      if (!auth?.organisationId) {
          return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } });
      }
      if (auth.tokenType !== 'location' || !auth.locationId) {
          return reply.status(403).send({ error: { code: 'LOCATION_CONTEXT_REQUIRED', message: 'Location context required' } });
      }

      const { dryRun, idempotencyKey } = req.body as { dryRun?: boolean; idempotencyKey?: string };

      try {
          const result = await runRetroAutoApprove({
              organisationId: auth.organisationId,
              locationId: auth.locationId,
              userId: auth.userId,
              dryRun,
              idempotencyKey,
          });
          return reply.status(200).send(result);
      } catch (e: any) {
          if (e?.statusCode === 403 && e?.code === 'FEATURE_DISABLED') {
              return reply.status(403).send({ error: { code: 'FEATURE_DISABLED', upgradeTarget: e.upgradeTarget ?? null, message: e.message } });
          }
          if (e?.statusCode === 409 && e?.code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST') {
              return reply.status(409).send({ error: { code: e.code, message: 'Idempotency key was reused with a different request' } });
          }
          throw e;
      }
  },

  async markRetroAutoApproveDiscoverySeen(req: FastifyRequest, reply: FastifyReply) {
      const auth = req.authContext;
      if (!auth?.organisationId) {
          return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } });
      }
      if (auth.tokenType !== 'location' || !auth.locationId) {
          return reply.status(403).send({ error: { code: 'LOCATION_CONTEXT_REQUIRED', message: 'Location context required' } });
      }

      const result = await markRetroAutoApproveDiscoverySeen({
          organisationId: auth.organisationId,
          locationId: auth.locationId,
          userId: auth.userId,
      });

      return reply.status(200).send(result);
  },
};

