import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import * as Sentry from '@sentry/node';
import xeroRoutes from './routes/xeroRoutes';
import authRoutes from './routes/authRoutes';
import organisationRoutes from './routes/organisationRoutes';
import locationRoutes from './routes/locationRoutes';
import supplierRoutes from './routes/supplierRoutes';
import supplierInsightsRoutes from './routes/supplierInsightsRoutes';
import xeroWebhookRoutes from './controllers/xeroWebhookController'; // Assuming we'll create this
import { config } from './config/env';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  // Register raw body support (global: false so it only applies where requested)
  app.register(fastifyRawBody, {
    global: false,
    runFirst: true,
  });

  // Setup Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register Cookie Plugin
  app.register(cookie, {
    secret: config.JWT_VERIFY_SECRET, // Use a secret for signing cookies if needed
    parseOptions: {}
  });

  // Register CORS
  if (config.NODE_ENV !== 'production') {
    app.register(cors, {
      origin: ['http://localhost:3000'],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-org-id', 'x-location-id', 'x-xero-signature'],
      credentials: true, // Allow cookies
    });
  } else {
    app.register(cors, {
      origin: config.FRONTEND_URL ? [config.FRONTEND_URL] : false,
      credentials: true,
    });
  }

  // Register Routes
  // Ensure Auth Plugin is registered within routes (as per current pattern)
  
  app.register(authRoutes, { prefix: '/auth' });
  app.register(organisationRoutes, { prefix: '/organisations' });
  // locationRoutes handles its own path prefix currently: /organisations/:organisationId/locations
  // so we register it at root or verify if we want to nest it.
  // Registering at root:
  app.register(locationRoutes); 
  
  app.register(xeroRoutes, { prefix: '/xero' });
  app.register(supplierRoutes, { prefix: '/suppliers' });
  app.register(supplierInsightsRoutes, { prefix: '/supplier-insights' });

  // Health Check
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    // Capture error in Sentry with context
    Sentry.withScope((scope) => {
      const authContext = request.authContext;

      // Add request context
      scope.setContext('request', {
        method: request.method,
        url: request.url,
        headers: {
          // Keep for debug visibility
          'user-id': request.headers['x-user-id'],
          'org-id': request.headers['x-org-id'],
          'location-id': request.headers['x-location-id'],
        },
        authContext: authContext || 'Not present',
      });

      // Add user context if available from AuthContext (Single Source of Truth)
      if (authContext && authContext.userId) {
        scope.setUser({
          id: authContext.userId,
          organization_id: authContext.organisationId || undefined,
          username: `Token:${authContext.tokenType}`,
        });
      } else {
        // Fallback to headers ONLY for debug context, making it clear it's untrusted
        const userId = request.headers['x-user-id'];
        if (userId) {
           scope.setTag('user_id_header', String(userId));
        }
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
