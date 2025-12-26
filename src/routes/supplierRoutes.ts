import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SupplierController } from '../controllers/supplierController';
import authContextPlugin from '../plugins/authContext';
import z from 'zod';

const supplierController = new SupplierController();

export default async function supplierRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.register(async (protectedApp) => {
      protectedApp.register(authContextPlugin);
      const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

      typedApp.post(
        '/',
        {
          schema: {
            body: z.object({
              name: z.string().min(1),
            }),
            response: {
              200: z.object({
                id: z.string(),
                organisationId: z.string(),
                name: z.string(),
                normalizedName: z.string(),
                sourceType: z.string(),
                status: z.string(),
                createdAt: z.string(),
                updatedAt: z.string(),
              }),
            },
          },
        },
        supplierController.createSupplier
      );

      typedApp.get(
        '/',
        {
          schema: {
            querystring: z.object({
              page: z.coerce.number().optional().default(1),
              limit: z.coerce.number().optional().default(50),
              search: z.string().optional(),
              activityStatus: z.enum(['current', 'all']).optional(),
              accountCodes: z.union([z.string(), z.array(z.string())]).optional(),
            }),
          },
        },
        supplierController.listSuppliers
      );

      typedApp.get(
        '/accounts',
        {
            schema: {
                response: {
                    200: z.array(z.object({
                        code: z.string(),
                        name: z.string().nullable(),
                        isCogs: z.boolean()
                    }))
                }
            }
        },
        supplierController.listAccounts
      );

      typedApp.post(
        '/accounts',
        {
            schema: {
                body: z.object({
                    accountCodes: z.array(z.string())
                }),
                response: {
                    200: z.object({
                        success: z.boolean(),
                        count: z.number()
                    })
                }
            }
        },
        supplierController.saveAccountConfig
      );

      typedApp.get(
        '/:id',
        {
          schema: {
            params: z.object({
              id: z.string(),
            }),
          },
        },
        supplierController.getSupplier
      );

      typedApp.get(
        '/:id/metrics',
        {
          schema: {
            params: z.object({
              id: z.string(),
            }),
          },
        },
        supplierController.getSupplierMetrics
      );

      typedApp.get(
        '/:id/products',
        {
          schema: {
            params: z.object({
              id: z.string(),
            }),
          },
        },
        supplierController.getSupplierProducts
      );

      typedApp.get(
        '/:id/products/:productId',
        {
          schema: {
            params: z.object({
              id: z.string(),
              productId: z.string(),
            }),
          },
        },
        supplierController.getProductDetails
      );
  });
}
