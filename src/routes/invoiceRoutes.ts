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
              total: z.number().optional(), // Should be number for JSON payload
              createAlias: z.boolean().optional(),
              aliasName: z.string().optional(),
          })
      }
  }, invoiceController.verify);

  // GET /invoices/locations/:locationId
  app.get('/locations/:locationId', {
      schema: {
          params: z.object({ locationId: z.string() }),
          querystring: z.object({
              page: z.coerce.number().default(1),
              limit: z.coerce.number().default(20)
          })
      }
  }, invoiceController.list);
}

