import { FastifyInstance } from 'fastify';
import { locationController } from '../controllers/locationController';
import { CreateLocationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authFromJwt from '../plugins/authFromJwt';
import z from 'zod';

export default async function locationRoutes(fastify: FastifyInstance) {
  fastify.register(authFromJwt);
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/organisations/:organisationId/locations', {
    schema: {
      params: z.object({ organisationId: z.string() }),
      body: CreateLocationRequest,
    },
  }, locationController.create);

  app.get('/organisations/:organisationId/locations', {
    schema: {
      params: z.object({ organisationId: z.string() }),
    },
  }, locationController.list);
}
