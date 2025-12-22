import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env';
import { getRedisClient } from '../infrastructure/redis';
import { enqueueProductStatsRefresh, getAdminJobStatus } from '../services/AdminProductStatsQueueService';
import { getRequestContext } from '../infrastructure/requestContext';
import prisma from '../infrastructure/prismaClient';

const refreshBodySchema = z.object({
  organisationId: z.string().min(1),
  locationId: z.string().min(1),
});

function isAdminEnabled(): boolean {
  return (config.ENABLE_ADMIN_ENDPOINTS || 'false') === 'true';
}

function replyAdminDisabled(reply: FastifyReply) {
  return reply.status(501).send({
    error: {
      code: 'ADMIN_ENDPOINTS_DISABLED',
      message: 'Admin endpoints are disabled',
    },
  });
}

function requireInternalApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = config.INTERNAL_ADMIN_API_KEY;
  const provided = String(req.headers['x-internal-api-key'] || '');

  if (!expected) {
    // If endpoints are enabled but no key is configured, fail closed.
    return reply.status(500).send({ error: { code: 'ADMIN_API_KEY_NOT_CONFIGURED', message: 'Admin API key not configured' } }) as any;
  }

  if (!provided || provided !== expected) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin API key' } }) as any;
  }

  return true;
}

async function enforceCooldownOrThrow(params: { organisationId: string; locationId: string }) {
  // 1 refresh per location per 10 minutes
  const ttlSeconds = 10 * 60;
  const key = `admin:productStatsRefresh:${params.organisationId}:${params.locationId}`;

  const redis = getRedisClient();
  // Fail closed for admin controls if Redis is unavailable
  const res = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return { ok: res === 'OK', retryAfterSeconds: ttlSeconds };
}

async function assertOrgAndLocationOrNotFound(params: { organisationId: string; locationId: string }): Promise<boolean> {
  // Do not leak details: if either is missing or mismatched, return false.
  const org = await prisma.organisation.findUnique({
    where: { id: params.organisationId },
    select: { id: true },
  });
  if (!org) return false;

  const loc = await prisma.location.findFirst({
    where: { id: params.locationId, organisationId: params.organisationId },
    select: { id: true },
  });
  if (!loc) return false;

  return true;
}

export default async function adminRoutes(app: FastifyInstance) {
  // POST /admin/product-stats/refresh
  app.post('/product-stats/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message || 'Invalid body' } });
    }

    const { organisationId, locationId } = parsed.data;

    const ctx = getRequestContext();
    const requestId = ctx?.requestId;

    // Existence + tenancy guard (do not enqueue junk)
    const ok = await assertOrgAndLocationOrNotFound({ organisationId, locationId }).catch(() => false);
    if (!ok) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    let cooldown;
    try {
      cooldown = await enforceCooldownOrThrow({ organisationId, locationId });
    } catch (e: any) {
      request.log.error({ msg: 'admin.productStats.refresh.redis_failed', err: e?.message });
      return reply.status(503).send({ error: { code: 'REDIS_UNAVAILABLE', message: 'Admin rate limiter unavailable' } });
    }

    if (!cooldown.ok) {
      reply.header('Retry-After', String(cooldown.retryAfterSeconds));
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Product stats refresh is on cooldown for this location' },
      });
    }

    const startedAt = Date.now();
    const { jobId } = await enqueueProductStatsRefresh({
      organisationId,
      locationId,
      triggeredBy: 'internal_api_key',
      requestId,
    });

    request.log.info(
      {
        audit: true,
        event: 'admin.productStats.refresh.enqueued',
        organisationId,
        locationId,
        triggeredBy: 'internal_api_key',
        requestId,
        durationMs: Date.now() - startedAt,
        jobId,
      },
      'admin.job.enqueued'
    );

    return reply.send({ jobId });
  });

  // GET /admin/jobs/:jobId
  app.get('/jobs/:jobId', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const jobId = String((request.params as any).jobId || '');
    if (!jobId) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'jobId is required' } });

    const status = await getAdminJobStatus(jobId);
    if (!status.exists) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
    }

    return reply.send(status);
  });
}


