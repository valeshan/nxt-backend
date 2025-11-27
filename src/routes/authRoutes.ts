import { FastifyInstance } from 'fastify';
import { authController } from '../controllers/authController';
import { LoginRequest, RegisterRequest, SelectOrganisationRequest, SelectLocationRequest, RefreshTokenRequest, RegisterOnboardRequestSchema } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';

export default async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Public Routes
  app.post('/register', {
    schema: {
      body: RegisterRequest,
    },
  }, authController.register);

  // New Registration with Onboarding Endpoint
  app.post('/register-onboard', {
    schema: {
      body: RegisterOnboardRequestSchema,
    }
  }, authController.registerOnboardHandler);

  app.post('/login', {
    schema: {
      body: LoginRequest,
    },
  }, authController.login);

  app.post('/refresh', {
    schema: {
      body: RefreshTokenRequest,
    },
  }, authController.refreshTokens);

  // Protected Routes
  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.post('/select-organisation', {
      schema: {
        body: SelectOrganisationRequest,
      },
    }, authController.selectOrganisation);

    typedApp.post('/select-location', {
      schema: {
        body: SelectLocationRequest,
      },
    }, authController.selectLocation);
  });
}
