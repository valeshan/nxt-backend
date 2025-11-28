import { FastifyInstance } from 'fastify';
import { locationController } from '../controllers/locationController';
import { CreateLocationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';
import z from 'zod';

export default async function locationRoutes(fastify: FastifyInstance) {
  fastify.register(authContextPlugin);
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/locations', {
    schema: {
      // No URL params – organisation is derived from auth context
      body: CreateLocationRequest,
      response: {
        201: z.object({
          id: z.string(),
          name: z.string(),
          organisationId: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          integrations: z.array(z.object({
            type: z.string(),
            name: z.string(),
            status: z.string(),
          })),
        }),
      },
    },
  }, locationController.create);

  app.get('/organisations/:organisationId/locations', {
    schema: {
      params: z.object({ organisationId: z.string() }),
      response: {
        200: z.array(z.object({
          id: z.string(),
          name: z.string(),
          organisationId: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          integrations: z.array(z.object({
            type: z.string(),
            name: z.string(),
            status: z.string()
          }))
        }))
      }
    },
  }, locationController.list);

  app.put('/locations/:id', {
    schema: {
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string().min(1) }),
    },
  }, locationController.update);

  app.delete('/locations/:id', {
    schema: {
      params: z.object({ id: z.string() }),
    },
  }, locationController.deleteLocationHandler);
}
