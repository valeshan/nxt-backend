import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createConnectionRequestSchema, linkLocationsRequestSchema, listConnectionsQuerySchema, xeroAuthoriseCallbackRequestSchema } from '../dtos/xeroDtos';
import { XeroController } from '../controllers/xeroController';
import z from 'zod';
import authFromJwt from '../plugins/authFromJwt';

const xeroController = new XeroController();

export default async function xeroRoutes(fastify: FastifyInstance) {
  // Register Auth Plugin for this scope
  fastify.register(authFromJwt);

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/connections',
    {
      schema: {
        body: createConnectionRequestSchema,
      },
    },
    xeroController.createConnectionHandler
  );

  app.post(
    '/connections/:connectionId/locations',
    {
      schema: {
        params: z.object({ connectionId: z.string() }),
        body: linkLocationsRequestSchema,
      },
    },
    xeroController.linkLocationsHandler
  );

  app.get(
    '/connections',
    {
      schema: {
        querystring: listConnectionsQuerySchema,
      },
    },
    xeroController.listConnectionsHandler
  );

  // New Xero Auth Flow
  app.post(
    '/authorise/start',
    {},
    xeroController.authoriseStartHandler
  );

  app.post(
    '/authorise',
    {
      schema: {
        body: xeroAuthoriseCallbackRequestSchema
      }
    },
    xeroController.authoriseCallbackHandler
  );
}
