import { FastifyInstance } from 'fastify';
import { organisationController } from '../controllers/organisationController';
import { CreateOrganisationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authFromJwt from '../plugins/authFromJwt';
import { z } from 'zod';

const manualOnboardRequest = z.object({
  venueName: z.string().min(1),
  onboardingSessionId: z.string().optional(),
});

export default async function organisationRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Public Routes
  app.post('/onboard/manual', {
    schema: {
        body: manualOnboardRequest
    }
  }, organisationController.manualOnboard);

  // Protected Routes
  app.register(async (protectedApp) => {
    protectedApp.register(authFromJwt);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.post('/', {
      schema: {
        body: CreateOrganisationRequest,
      },
    }, organisationController.create);

    typedApp.get('/', organisationController.list);
  });
}
