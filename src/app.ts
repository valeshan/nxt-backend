import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
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
import adminRoutes from './routes/adminRoutes';
import e2eRoutes from './routes/e2eRoutes';
import xeroWebhookRoutes from './controllers/xeroWebhookController'; // Assuming we'll create this
import webhookRoutes from './routes/webhookRoutes';
import settingsRoutes from './routes/settingsRoutes';
import feedbackRoutes from './routes/feedbackRoutes';
import inviteRoutes from './routes/inviteRoutes';
import billingRoutes from './routes/billingRoutes';
import { config } from './config/env';
import { getRedisClient, pingWithTimeout } from './infrastructure/redis';
import { runWithRequestContext, getRequestContext } from './infrastructure/requestContext';
import { randomUUID } from 'crypto';
import prisma from './infrastructure/prismaClient';
import { listHeartbeats } from './repositories/jobHeartbeatRepository';

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

    // If Redis is configured, use it for shared rate limiting across instances.
    if (config.REDIS_URL || config.REDIS_HOST) {
      rateLimitConfig.redis = getRedisClient();
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

  // Register CORS
  const corsAllowedHeaders = [
    'Content-Type',
    'Authorization',
    'x-xero-signature',
    'x-request-id',
  ];

  if (config.NODE_ENV !== 'production') {
    app.register(cors, {
      origin: ['http://localhost:3000'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: corsAllowedHeaders,
      credentials: false,
    });
  } else {
    app.register(cors, {
      origin: config.FRONTEND_URL ? [config.FRONTEND_URL] : false,
      allowedHeaders: corsAllowedHeaders,
      credentials: false,
    });
  }

  // Request correlation + summary log (best-effort, always-on)
  app.addHook('onRequest', (request, reply, done) => {
    const requestId = String(request.headers['x-request-id'] || randomUUID());
    // Echo request id for easier correlation across layers
    reply.header('x-request-id', requestId);

    runWithRequestContext(
      {
        requestId,
        method: request.method,
        route: request.url, // will be refined in preHandler once routerPath is known
        startAtMs: Date.now(),
      },
      () => done()
    );
  });

  // Enrich context once authContext exists and routerPath is resolved
  app.addHook('preHandler', (request, _reply, done) => {
    const ctx = getRequestContext();
    if (ctx) {
      ctx.route = (request as any).routerPath || request.url;
      const auth = (request as any).authContext;
      if (auth) {
        ctx.organisationId = auth.organisationId ?? undefined;
        ctx.locationId = auth.locationId ?? undefined;
      }
    }
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const ctx = getRequestContext();
    const durationMs = ctx ? Date.now() - ctx.startAtMs : undefined;

    // Always-on request summary log (no PII)
    request.log.info(
      {
        requestId: ctx?.requestId,
        method: request.method,
        route: ctx?.route || (request as any).routerPath || request.url,
        statusCode: reply.statusCode,
        durationMs,
        organisationId: ctx?.organisationId,
        locationId: ctx?.locationId,
      },
      'request.completed'
    );
    done();
  });

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
  app.register(inviteRoutes);
  
  app.register(xeroRoutes, { prefix: '/xero' });
  app.register(supplierRoutes, { prefix: '/suppliers' });
  app.register(supplierInsightsRoutes, { prefix: '/supplier-insights' });
  app.register(invoiceRoutes, { prefix: '/invoices' });
  app.register(diagnosticsRoutes, { prefix: '/diagnostics' });
  app.register(settingsRoutes, { prefix: '/settings' });
  app.register(feedbackRoutes, { prefix: '/feedback' });
  app.register(billingRoutes, { prefix: '/billing' });
  // Admin routes are safe-by-default:
  // - disabled unless ENABLE_ADMIN_ENDPOINTS=true
  // - require x-internal-api-key
  app.register(adminRoutes, { prefix: '/admin' });
  // E2E test routes (only available in non-production)
  app.register(e2eRoutes, { prefix: '/e2e' });
  
  // Register Webhook Routes
  // Note: These routes might need special handling for multipart/form-data which is handled by the controller
  app.register(webhookRoutes, { prefix: '/webhooks' });
  // Xero Webhook (signature-verified, needs raw body)
  // Primary registration happens inside xeroRoutes under /xero/webhook.
  // We add a single alias for /webhooks/xero/webhook to avoid duplicates.
  app.register(xeroWebhookRoutes, { prefix: '/webhooks/xero' });

  const isHealthTokenValid = (request: any): boolean => {
    // Token is only intended to protect internal diagnostics endpoints (e.g. /heartbeats).
    // Do NOT require it for platform liveness/readiness probes.
    if (!config.HEALTHCHECK_TOKEN) return true;
    const raw = request?.headers?.['x-health-check-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    return token === config.HEALTHCHECK_TOKEN;
  };
  
  // Register debug routes conditionally
  if (config.DEBUG_ROUTES_ENABLED === 'true') {
    app.register(debugRoutes);
  }

  // Health Check (liveness): always fast, no dependency checks.
  app.get('/health', async () => {
    const version =
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.GIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      'unknown';
    return { status: 'ok', version };
  });

  // Heartbeat diagnostics (requires token when configured)
  app.get('/heartbeats', async (request, reply) => {
    if (!isHealthTokenValid(request)) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid health-check token' } });
    }
    const env = config.APP_ENV || 'unknown';
    const rows = await listHeartbeats(env);
    const now = Date.now();
    const response = rows.map((r: any) => {
      const lastSuccess = r.lastSuccessAt ? new Date(r.lastSuccessAt).getTime() : null;
      const stale =
        typeof r.staleAfterSeconds === 'number' && lastSuccess
          ? now - lastSuccess > r.staleAfterSeconds * 1000
          : false;
      return {
        jobName: r.jobName,
        env: r.env,
        status: r.status,
        expectedIntervalSeconds: r.expectedIntervalSeconds,
        staleAfterSeconds: r.staleAfterSeconds,
        lastRunAt: r.lastRunAt,
        lastSuccessAt: r.lastSuccessAt,
        lastError: r.lastError,
        durationMs: r.durationMs,
        stale,
        recentRuns: r.recentRuns,
        updatedAt: r.updatedAt,
      };
    });
    return reply.send({ env, heartbeats: response });
  });

  // Readiness Check: DB + Redis, with strict timeouts and 503 on degraded.
  app.get('/ready', async (request, reply) => {
    const overallTimeoutMs = 2000;
    const perDepTimeoutMs = 1200;
    const retryAfterSeconds = 5;

    const startedAt = Date.now();

    const withTimeout = async <T>(label: string, p: Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> => {
      const t0 = Date.now();
      try {
        const value = await Promise.race([
          p,
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)),
        ]);
        return { ok: true, value, ms: Date.now() - t0 };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e), ms: Date.now() - t0 };
      }
    };

    const run = async () => {
      const dbCheck = withTimeout('db', prisma.$queryRaw`SELECT 1`, perDepTimeoutMs);

      // Redis check is required in production; optional in dev (if not configured, skip).
      const hasRedisConfig = Boolean(config.REDIS_URL || config.REDIS_HOST);
      const redisRequired = config.NODE_ENV === 'production';
      const redisCheck = hasRedisConfig
        ? withTimeout('redis', (async () => {
            const res = await pingWithTimeout(getRedisClient(), 1000, 0);
            if (!res.ok) throw new Error(res.error || 'redis ping failed');
            return true;
          })(), perDepTimeoutMs)
        : Promise.resolve({ ok: redisRequired ? false : true, error: redisRequired ? 'redis not configured' : undefined, ms: 0 } as any);

      const [db, redis] = await Promise.all([dbCheck, redisCheck]);

      const dbOk = db.ok;
      const redisOk = redis.ok;

      const ok = dbOk && (redisRequired ? redisOk : true);

      const version =
        process.env.RAILWAY_GIT_COMMIT_SHA ||
        process.env.GIT_SHA ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        'unknown';

      const body: any = {
        status: ok ? 'ok' : 'degraded',
        version,
        db: dbOk,
        redis: redisRequired ? redisOk : (hasRedisConfig ? redisOk : null),
        timingsMs: {
          db: db.ms,
          redis: redis.ms,
        },
        retryAfterSeconds: ok ? undefined : retryAfterSeconds,
      };

      if (!dbOk) body.dbError = (db as any).error;
      if (redisRequired && !redisOk) body.redisError = (redis as any).error;

      if (!ok) {
        reply.header('Cache-Control', 'no-store');
        reply.header('Retry-After', String(retryAfterSeconds));
        return reply.code(503).send(body);
      }

      return reply.send(body);
    };

    // Overall deadline: never let /ready hang
    const result = await Promise.race([
      run(),
      new Promise((resolve) => setTimeout(() => {
        const version =
          process.env.RAILWAY_GIT_COMMIT_SHA ||
          process.env.GIT_SHA ||
          process.env.VERCEL_GIT_COMMIT_SHA ||
          'unknown';
        reply.header('Cache-Control', 'no-store');
        reply.header('Retry-After', String(retryAfterSeconds));
        resolve(
          reply.code(503).send({
            status: 'degraded',
            version,
            db: false,
            redis: false,
            timingsMs: { total: Date.now() - startedAt },
            retryAfterSeconds,
            error: `overall timeout after ${overallTimeoutMs}ms`,
          })
        );
      }, overallTimeoutMs)),
    ]);

    return result as any;
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
