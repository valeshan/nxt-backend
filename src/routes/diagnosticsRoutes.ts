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
          querystring: z.object({
            includeCanonicalParity: z.coerce.boolean().optional().default(false),
          }),
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
              }),
              canonical: z.object({
                enabledForOrg: z.boolean(),
                operational: z.object({
                  ok: z.boolean(),
                  error: z.string().nullable(),
                }),
                counts: z.object({
                  invoices: z.number(),
                  lines: z.number(),
                }),
                warnRate: z.number().nullable(),
                warnReasonsBreakdown: z
                  .object({
                    totalWarnLines: z.number(),
                    byReason: z.record(z.number()),
                  })
                  .nullable(),
                lastWriteAt: z.string().nullable(),
                lastInvoiceDate: z.string().nullable(),
                parity: z
                  .object({
                    ok: z.boolean(),
                    checkedAt: z.string(),
                    organisationId: z.string(),
                    locationId: z.string().nullable(),
                    report: z.unknown(),
                  })
                  .nullable(),
              }),
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





