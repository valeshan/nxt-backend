import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import * as Sentry from '@sentry/node';
import xeroRoutes from './routes/xeroRoutes';
import authRoutes from './routes/authRoutes';
import organisationRoutes from './routes/organisationRoutes';
import locationRoutes from './routes/locationRoutes';
import { config } from './config/env';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  // Setup Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register CORS
  if (config.NODE_ENV !== 'production') {
    app.register(cors, {
      origin: ['http://localhost:3000'],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-org-id'],
    });
  } else {
    app.register(cors, {
      origin: true, // TODO: Configure for production
    });
  }

  // Register Routes
  app.register(authRoutes, { prefix: '/auth' });
  app.register(organisationRoutes, { prefix: '/organisations' });
  // locationRoutes handles its own path prefix currently: /organisations/:organisationId/locations
  // so we register it at root or verify if we want to nest it.
  // Registering at root:
  app.register(locationRoutes); 
  
  app.register(xeroRoutes, { prefix: '/xero' });

  // Health Check
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    // Capture error in Sentry with context
    Sentry.withScope((scope) => {
      // Add request context
      scope.setContext('request', {
        method: request.method,
        url: request.url,
        headers: {
          'user-id': request.headers['x-user-id'],
          'org-id': request.headers['x-org-id'],
        },
      });

      // Add user context if available
      const userId = request.headers['x-user-id'];
      const orgId = request.headers['x-org-id'];
      if (userId) {
        scope.setUser({
          id: userId as string,
          organization_id: orgId as string,
        });
      }

      // Set tags
      scope.setTag('error_code', (error as any).code || 'INTERNAL_ERROR');
      scope.setTag('status_code', String(error.statusCode || 500));

      // Capture the error
      Sentry.captureException(error);
    });

    if (error.validation) {
       return reply.status(400).send({
         error: {
           code: 'VALIDATION_ERROR',
           message: 'Invalid request data',
           details: error.validation
         }
       });
    }

    // If the error was explicitly thrown with a status code (like 401/403 from our logic)
    if (reply.statusCode && reply.statusCode >= 400 && reply.statusCode < 500) {
        // If response is already sent or set, we might just return.
    }
    
    const statusCode = error.statusCode || 500;
    const code = (error as any).code || 'INTERNAL_ERROR';
    const message = error.message || 'Something went wrong';

    return reply.status(statusCode).send({
      error: {
        code,
        message,
      },
    });
  });

  return app;
}
