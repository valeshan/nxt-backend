import { FastifyInstance } from 'fastify';
import { authController } from '../controllers/authController';
import { LoginRequest, RegisterRequest, SelectOrganisationRequest, SelectLocationRequest, RefreshTokenRequest, RegisterOnboardRequestSchema, UpdateProfileRequest, ChangePasswordRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';

export default async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Public Routes
  app.post('/register', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: RegisterRequest,
    },
  }, authController.register);

  // New Registration with Onboarding Endpoint
  app.post('/register-onboard', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: RegisterOnboardRequestSchema,
    }
  }, authController.registerOnboardHandler);

  app.post('/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: LoginRequest,
    },
  }, authController.login);

  app.post('/refresh', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: RefreshTokenRequest,
    },
  }, authController.refreshTokens);

  // Protected Routes
  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.get('/me', authController.me);

    typedApp.put('/me', {
      schema: {
        body: UpdateProfileRequest,
      },
    }, authController.updateProfile);

    typedApp.post('/change-password', {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
        },
      },
      schema: {
        body: ChangePasswordRequest,
      },
    }, authController.changePassword);

    typedApp.post('/logout', {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    }, authController.logout);

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
