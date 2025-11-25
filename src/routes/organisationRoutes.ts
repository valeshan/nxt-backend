import { FastifyInstance } from 'fastify';
import { organisationController } from '../controllers/organisationController';
import { CreateOrganisationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authFromJwt from '../plugins/authFromJwt';
import { z } from 'zod';

const manualOnboardRequest = z.object({
  venueName: z.string().min(1),
});

export default async function organisationRoutes(fastify: FastifyInstance) {
  fastify.register(authFromJwt);
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/', {
    schema: {
      body: CreateOrganisationRequest,
    },
  }, organisationController.create);

  app.get('/', organisationController.list);

  // Manual Onboarding Endpoint
  app.post('/onboard/manual', {
    schema: {
        body: manualOnboardRequest
    }
  }, organisationController.manualOnboard);
}
