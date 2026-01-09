import { FastifyInstance } from 'fastify';
import { organisationController } from '../controllers/organisationController';
import { CreateOrganisationRequest, CreateOrganisationWithLocationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';
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
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.post('/', {
      schema: {
        body: CreateOrganisationRequest,
      },
    }, organisationController.create);

    typedApp.post('/with-location', {
      schema: {
        body: CreateOrganisationWithLocationRequest,
      },
    }, organisationController.createWithLocation);

    typedApp.get('/', organisationController.list);

    typedApp.get('/:orgId/entitlements', {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
      },
    }, organisationController.entitlements);

    typedApp.patch('/:orgId/plan', {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({ planKey: z.string() })
      }
    }, organisationController.updatePlan);

    typedApp.patch('/:orgId/overrides', {
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.record(z.any())
      }
    }, organisationController.updateOverrides);
  });
}
