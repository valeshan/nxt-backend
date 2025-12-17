import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { DiagnosticsController } from '../controllers/diagnosticsController';
import authContextPlugin from '../plugins/authContext';
import z from 'zod';

const diagnosticsController = new DiagnosticsController();

export default async function diagnosticsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.get(
      '/snapshot',
      {
        schema: {
          response: {
            200: z.object({
              meta: z.object({
                  serverTimeUtc: z.string(),
                  env: z.string(),
                  dbConnected: z.boolean()
              }),
              counts: z.object({
                  suppliers: z.object({ total: z.number(), pendingReview: z.number() }),
                  products: z.object({ total: z.number() }),
                  xeroInvoices: z.object({ total: z.number() }),
                  invoices: z.object({ total: z.number() }),
                  invoiceFiles: z.object({ total: z.number(), needsReview: z.number() })
              }),
              xero: z.object({
                  connection: z.object({
                      tenantName: z.string(),
                      lastSuccessfulSyncAt: z.string().nullable()
                  }).nullable(),
                  latestSyncRun: z.object({
                      status: z.string(),
                      startedAt: z.string(),
                      finishedAt: z.string().nullable(),
                      rowsProcessed: z.number().nullable(),
                      errorMessage: z.string().nullable()
                  }).nullable()
              })
            })
          }
        }
      },
      diagnosticsController.getSnapshot
    );

    typedApp.post(
      '/sync',
      {
        schema: {
          response: {
            202: z.object({
              id: z.string(),
              status: z.string(),
              triggerType: z.string(),
              scope: z.string(),
              startedAt: z.string()
            })
          }
        }
      },
      diagnosticsController.triggerSync
    );
  });
}





