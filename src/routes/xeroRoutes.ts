import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createConnectionRequestSchema, linkLocationsRequestSchema, listConnectionsQuerySchema } from '../dtos/xeroDtos';
import { XeroController } from '../controllers/xeroController';
import z from 'zod';
import authFromJwt from '../plugins/authFromJwt';

const xeroController = new XeroController();

export default async function xeroRoutes(fastify: FastifyInstance) {
  // Register Auth Plugin for this scope
  fastify.register(authFromJwt);

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/xero/connections',
    {
      schema: {
        body: createConnectionRequestSchema,
      },
    },
    xeroController.createConnectionHandler
  );

  app.post(
    '/xero/connections/:connectionId/locations',
    {
      schema: {
        params: z.object({ connectionId: z.string() }),
        body: linkLocationsRequestSchema,
      },
    },
    xeroController.linkLocationsHandler
  );

  app.get(
    '/xero/connections',
    {
      schema: {
        querystring: listConnectionsQuerySchema,
      },
    },
    xeroController.listConnectionsHandler
  );
}

