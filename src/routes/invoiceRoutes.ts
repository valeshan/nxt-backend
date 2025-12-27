import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { invoiceController } from '../controllers/invoiceController';
import authContextPlugin from '../plugins/authContext';
import z from 'zod';

export default async function invoiceRoutes(fastify: FastifyInstance) {
  fastify.register(authContextPlugin);
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /invoices/locations/:locationId/upload
  app.post('/locations/:locationId/upload', {
      schema: {
          params: z.object({ locationId: z.string() }),
          // Response schema can be added for documentation
      }
  }, invoiceController.upload);

  // GET /invoices/:id/status
  app.get('/:id/status', {
      schema: {
          params: z.object({ id: z.string() }),
      }
  }, invoiceController.getStatus);

  // PATCH /invoices/:id/verify
  app.patch('/:id/verify', {
      schema: {
          params: z.object({ id: z.string() }),
          body: z.object({
              supplierId: z.string().optional(),
              supplierName: z.string().optional(),
              total: z.number().optional(), // Should be number for JSON payload
              createAlias: z.boolean().optional(),
              aliasName: z.string().optional(),
              selectedLineItemIds: z.array(z.string()).optional(),
              date: z.string().optional(),
              items: z.array(z.object({
                  id: z.string(),
                  description: z.string().optional(),
                  quantity: z.number().optional(),
                  lineTotal: z.number().optional(),
                  productCode: z.string().nullable().optional()
              })).optional(),
              hasManuallyAddedItems: z.boolean().optional(),
              approveTerms: z.boolean().optional(),
              approvedPhrases: z.array(z.string()).optional()
          }),
          response: {
              200: z.object({
                  invoice: z.any(), // Invoice type
                  invoiceFile: z.object({
                      id: z.string(),
                      reviewStatus: z.string(),
                      verificationSource: z.string().nullable(),
                      locationId: z.string(),
                  }).nullable(),
                  location: z.object({
                      autoApproveCleanInvoices: z.boolean(),
                      hasSeenAutoApprovePrompt: z.boolean(),
                  }).nullable(),
              }),
          },
      }
  }, invoiceController.verify);

  // GET /invoices/locations/:locationId
  app.get('/locations/:locationId', {
      schema: {
          params: z.object({ locationId: z.string() }),
          querystring: z.object({
              page: z.coerce.number().default(1),
              limit: z.coerce.number().default(20),
              search: z.string().optional(),
              sourceType: z.string().optional(),
              startDate: z.string().optional(),
              endDate: z.string().optional(),
              status: z.enum(['ALL', 'REVIEWED', 'PENDING', 'DELETED']).optional(),
              // Realtime-first: list is cheap by default. When true, backend may refresh a capped number of OCR jobs.
              refreshProcessing: z.coerce.boolean().optional().default(false),
          })
      }
  }, invoiceController.list);

  // POST /invoices/ocr-status/batch (fallback refresh, capped)
  app.post('/ocr-status/batch', {
      schema: {
          body: z.object({
              invoiceFileIds: z.array(z.string()).max(20),
          }),
      },
  }, invoiceController.batchRefreshOcrStatus);

  // DELETE /invoices/:id
  app.delete('/:id', {
      schema: {
          params: z.object({ id: z.string() })
      }
  }, invoiceController.delete);

  // POST /invoices/bulk-delete
  app.post('/bulk-delete', {
      schema: {
          body: z.object({
              ids: z.array(z.string())
          })
      }
  }, invoiceController.bulkDelete);

  // POST /invoices/bulk-approve
  app.post('/bulk-approve', {
      schema: {
          body: z.object({
              ids: z.array(z.string())
          })
      }
  }, invoiceController.bulkApprove);

  // POST /invoices/:id/restore
  app.post('/:id/restore', {
      schema: {
          params: z.object({ id: z.string() })
      }
  }, invoiceController.restore);

  // POST /invoices/bulk-restore
  app.post('/bulk-restore', {
      schema: {
          body: z.object({
              ids: z.array(z.string())
          })
      }
  }, invoiceController.bulkRestore);

  // POST /invoices/upload-session
  app.post('/upload-session', {
      config: {
          rateLimit: {
              max: 10,
              timeWindow: '1 minute',
          },
      },
      schema: {
          body: z.object({
              organisationId: z.string(),
              locationId: z.string().optional(),
              files: z.array(z.object({
                  filename: z.string(),
                  mimeType: z.string(),
                  sizeBytes: z.number()
              }))
          })
      }
  }, invoiceController.uploadSession);

  // POST /invoices/:id/complete
  app.post('/:id/complete', {
      schema: {
          params: z.object({ id: z.string() })
      }
  }, invoiceController.complete);

  // POST /invoices/:id/retry-ocr
  app.post('/:id/retry-ocr', {
      schema: {
          params: z.object({ id: z.string() })
      }
  }, invoiceController.retryOcr);

  // POST /invoices/:id/replace
  app.post('/:id/replace', {
      schema: {
          params: z.object({ id: z.string() })
      }
  }, invoiceController.replaceFile);

  // POST /invoices/:id/manual-entry
  app.post('/:id/manual-entry', {
      schema: {
          params: z.object({ id: z.string() })
      }
  }, invoiceController.createManualEntry);
}

