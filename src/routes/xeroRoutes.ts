import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createConnectionRequestSchema, linkLocationsRequestSchema, listConnectionsQuerySchema, xeroAuthoriseCallbackRequestSchema, startConnectRequestSchema, completeConnectRequestSchema } from '../dtos/xeroDtos';
import { XeroController } from '../controllers/xeroController';
import xeroWebhookController from '../controllers/xeroWebhookController';
import z from 'zod';
import authContextPlugin from '../plugins/authContext';

const xeroController = new XeroController();

export default async function xeroRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Public Routes (Xero OAuth)
  app.get(
    '/authorise/start',
    {},
    xeroController.authoriseStartHandler
  );

  app.get(
    '/authorise',
    {
      schema: {
        querystring: xeroAuthoriseCallbackRequestSchema
      }
    },
    xeroController.authoriseCallbackHandler
  );

  // Register Webhook Controller (Public, validates signature)
  app.register(xeroWebhookController);

  // Protected Routes
  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.post(
      '/connections',
      {
        schema: {
          body: createConnectionRequestSchema,
        },
      },
      xeroController.createConnectionHandler
    );

    typedApp.post(
      '/connections/:connectionId/locations',
      {
        schema: {
          params: z.object({ connectionId: z.string() }),
          body: linkLocationsRequestSchema,
        },
      },
      xeroController.linkLocationsHandler
    );

    typedApp.get(
      '/connections',
      {
        schema: {
          querystring: listConnectionsQuerySchema,
        },
      },
      xeroController.listConnectionsHandler
    );

    typedApp.post(
      '/start-connect',
      {
        schema: {
          body: startConnectRequestSchema,
        },
      },
      xeroController.startConnectHandler
    );

    typedApp.post(
      '/complete-connect',
      {
        schema: {
          body: completeConnectRequestSchema,
        },
      },
      xeroController.completeConnectHandler
    );

    // Manual Sync Endpoint
    typedApp.post(
      '/connections/:connectionId/sync',
      {
        schema: {
          params: z.object({ connectionId: z.string() }),
          body: z.object({ scope: z.enum(['INCREMENTAL', 'FULL']).optional() })
        }
      },
      xeroController.syncConnectionHandler
    );

    // Disconnect Xero - delete all connections for the organisation
    // Frontend calls: DELETE /xero/organization/:organizationId
    typedApp.delete(
      '/organization/:organizationId',
      {
        schema: {
          params: z.object({ organizationId: z.string().uuid() }),
        },
      },
      xeroController.disconnectHandler
    );

    // Alternative: disconnect specific connection
    typedApp.delete(
      '/connections/:connectionId',
      {
        schema: {
          params: z.object({ connectionId: z.string().uuid() }),
        },
      },
      xeroController.disconnectHandler
    );
  });
}
