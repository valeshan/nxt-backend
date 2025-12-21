import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import Redis from 'ioredis';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import * as Sentry from '@sentry/node';
import xeroRoutes from './routes/xeroRoutes';
import authRoutes from './routes/authRoutes';
import organisationRoutes from './routes/organisationRoutes';
import userRoutes from './routes/userRoutes';
import locationRoutes from './routes/locationRoutes';
import emailForwardingRoutes from './routes/emailForwardingRoutes';
import supplierRoutes from './routes/supplierRoutes';
import supplierInsightsRoutes from './routes/supplierInsightsRoutes';
import invoiceRoutes from './routes/invoiceRoutes';
import diagnosticsRoutes from './routes/diagnosticsRoutes';
import debugRoutes from './routes/debugRoutes';
import xeroWebhookRoutes from './controllers/xeroWebhookController'; // Assuming we'll create this
import webhookRoutes from './routes/webhookRoutes';
import { config } from './config/env';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // IMPORTANT: Trust proxy headers (X-Forwarded-For) so rate limiting works correctly
    // behind load balancers / reverse proxies (e.g., Railway, Cloudflare, Nginx).
    trustProxy: true,
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'body.password', 'body.token', 'body.accessToken', 'body.refreshToken'],
    },
  });

  // Security Headers
  app.register(helmet, {
    contentSecurityPolicy: config.NODE_ENV === 'production', // Enable CSP in production
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow resources to be requested from different origins (e.g. frontend)
  });

  // Rate Limiting
  if (config.ENABLE_RATE_LIMIT === 'true') {
    const rateLimitConfig: any = {
      max: 100,
      timeWindow: '1 minute',
    };

    if (config.REDIS_URL) {
      const client = new Redis(config.REDIS_URL);
      rateLimitConfig.redis = client;
    }

    app.register(rateLimit, rateLimitConfig);
  }

  // Compression
  app.register(compress, { global: true });

  // Register raw body support (global: false so it only applies where requested)
  app.register(fastifyRawBody, {
    global: false,
    runFirst: true,
  });

  // Register Multipart for file uploads
  app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20MB
      files: 10, // Allow up to 10 files
    },
    // Only allow PDF (checking mime type)
    // Note: fastify-multipart doesn't strictly enforce mime type in the config unless using attachFieldsToBody: true (which we might not want for streaming),
    // but we can check it in the handler. However, if we want to block it early, we can use the onFile handler or similar.
    // For now, we'll stick to limits here and validate mime type in the controller/service.
  });

  // Register Form Body parser for application/x-www-form-urlencoded
  app.register(formbody);

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
  app.register(userRoutes, { prefix: '/users' });
  // locationRoutes handles its own path prefix currently: /organisations/:organisationId/locations
  // so we register it at root or verify if we want to nest it.
  // Registering at root:
  app.register(locationRoutes); 
  app.register(emailForwardingRoutes);
  
  app.register(xeroRoutes, { prefix: '/xero' });
  app.register(supplierRoutes, { prefix: '/suppliers' });
  app.register(supplierInsightsRoutes, { prefix: '/supplier-insights' });
  app.register(invoiceRoutes, { prefix: '/invoices' });
  app.register(diagnosticsRoutes, { prefix: '/diagnostics' });
  
  // Register Webhook Routes
  // Note: These routes might need special handling for multipart/form-data which is handled by the controller
  app.register(webhookRoutes, { prefix: '/webhooks' });
  
  // Register debug routes conditionally
  if (config.DEBUG_ROUTES_ENABLED === 'true') {
    app.register(debugRoutes);
  }

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
