import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env';
import { getRedisClient } from '../infrastructure/redis';
import { enqueueCanonicalBackfill, enqueueProductStatsRefresh, getAdminJobStatus } from '../services/AdminProductStatsQueueService';
import { supplierInsightsService } from '../services/supplierInsightsService';
import { getRequestContext } from '../infrastructure/requestContext';
import { xeroLocationBackfillService } from '../services/xeroLocationBackfillService';
import prisma from '../infrastructure/prismaClient';

const refreshBodySchema = z.object({
  organisationId: z.string().min(1),
  locationId: z.string().min(1),
});

const canonicalParityBodySchema = z.object({
  organisationId: z.string().min(1),
  locationId: z.string().min(1),
});

const canonicalBackfillBodySchema = z.object({
  organisationId: z.string().min(1),
  locationId: z.string().min(1),
  source: z.enum(['OCR', 'XERO', 'ALL']).default('ALL'),
  limit: z.coerce.number().optional(),
});

const jobStatusQuerySchema = z.object({
  jobId: z.string().min(1),
});

const xeroLocationBackfillBodySchema = z.object({
  organisationId: z.string().min(1),
  connectionId: z.string().optional(),
  locationId: z.string().optional(),
  dryRun: z.boolean().default(true),
  batchSize: z.coerce.number().min(1).max(5000).default(1000),
  maxBatches: z.coerce.number().min(1).optional(),
});

const supplierInsightsDiagnosticsQuerySchema = z.object({
  organisationId: z.string().min(1),
  locationId: z.string().optional(),
});

function isAdminEnabled(): boolean {
  return (config.ENABLE_ADMIN_ENDPOINTS || 'false') === 'true';
}

function canBypassAdminCooldown(req: FastifyRequest): boolean {
  // Explicitly gated:
  // - must be enabled via env
  // - must be non-production
  // - must be explicitly requested via header (prevents accidental bypass)
  if ((config.ADMIN_BYPASS_RATE_LIMIT || 'false') !== 'true') return false;
  if (config.NODE_ENV === 'production') return false;
  const v = String(req.headers['x-admin-bypass-rate-limit'] || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
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
      cooldown = canBypassAdminCooldown(request) ? { ok: true, retryAfterSeconds: 0 } : await enforceCooldownOrThrow({ organisationId, locationId });
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

  // POST /admin/canonical/parity
  // Computes a small parity checklist between legacy and canonical aggregates for an org+location.
  app.post('/canonical/parity', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const parsed = canonicalParityBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message || 'Invalid body' } });
    }

    const { organisationId, locationId } = parsed.data;

    const ok = await assertOrgAndLocationOrNotFound({ organisationId, locationId }).catch(() => false);
    if (!ok) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    const report = await supplierInsightsService.getCanonicalParityChecklist(organisationId, locationId);
    return reply.send({ report });
  });

  // POST /admin/canonical/backfill
  // Enqueue a safe incremental backfill job that writes canonical rows for a specific org+location.
  app.post('/canonical/backfill', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const parsed = canonicalBackfillBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message || 'Invalid body' } });
    }

    const { organisationId, locationId, source, limit } = parsed.data;

    const ok = await assertOrgAndLocationOrNotFound({ organisationId, locationId }).catch(() => false);
    if (!ok) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    // Cooldown: 1 backfill per location per 10 minutes
    let cooldown;
    try {
      const ttlSeconds = 10 * 60;
      const key = `admin:canonicalBackfill:${organisationId}:${locationId}`;
      if (canBypassAdminCooldown(request)) {
        cooldown = { ok: true, retryAfterSeconds: 0 };
      } else {
        const redis = getRedisClient();
        const res = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
        cooldown = { ok: res === 'OK', retryAfterSeconds: ttlSeconds };
      }
    } catch (e: any) {
      request.log.error({ msg: 'admin.canonical.backfill.redis_failed', err: e?.message });
      return reply.status(503).send({ error: { code: 'REDIS_UNAVAILABLE', message: 'Admin rate limiter unavailable' } });
    }

    if (!cooldown.ok) {
      reply.header('Retry-After', String(cooldown.retryAfterSeconds));
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Canonical backfill is on cooldown for this location' },
      });
    }

    const ctx = getRequestContext();
    const requestId = ctx?.requestId;
    const { jobId } = await enqueueCanonicalBackfill({
      organisationId,
      locationId,
      source,
      limit,
      triggeredBy: 'internal_api_key',
      requestId,
    });

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

  // GET /admin/jobs?jobId=...
  // Workaround: some routers/proxies reject certain percent-encoded characters in path params (e.g. %7C),
  // causing Fastify to treat the route as missing. Query params are more robust for these IDs.
  app.get('/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const parsed = jobStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message || 'Invalid query' } });
    }

    const rawJobId = parsed.data.jobId;
    // Allow callers to pass an already-encoded jobId (best-effort decode).
    let jobId = rawJobId;
    try {
      jobId = decodeURIComponent(rawJobId);
    } catch {
      // ignore
    }

    const status = await getAdminJobStatus(jobId);
    if (!status.exists) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
    }

    return reply.send(status);
  });

  // POST /admin/xero-location/backfill
  // Backfill locationId for historical Xero invoices based on connection ↔ location mapping
  app.post('/xero-location/backfill', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const parsed = xeroLocationBackfillBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message || 'Invalid body' } });
    }

    const { organisationId, connectionId, locationId, dryRun, batchSize, maxBatches } = parsed.data;

    // Verify org exists
    const org = await prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true },
    });
    if (!org) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Organisation not found' } });
    }

    try {
      const result = await xeroLocationBackfillService.backfillLocationIds({
        organisationId,
        connectionId,
        locationId,
        dryRun,
        batchSize,
        maxBatches,
      });

      request.log.info(
        {
          audit: true,
          event: 'admin.xeroLocation.backfill.completed',
          organisationId,
          connectionId,
          locationId,
          dryRun,
          result,
        },
        'admin.xeroLocation.backfill.completed'
      );

      return reply.send(result);
    } catch (error: any) {
      request.log.error(
        {
          audit: true,
          event: 'admin.xeroLocation.backfill.failed',
          organisationId,
          connectionId,
          locationId,
          error: error.message,
        },
        'admin.xeroLocation.backfill.failed'
      );
      return reply.status(500).send({
        error: { code: 'BACKFILL_FAILED', message: error.message || 'Backfill failed' },
      });
    }
  });

  // GET /admin/supplier-insights/diagnostics
  // Diagnostic endpoint to check Supplier Insights data consistency
  app.get('/supplier-insights/diagnostics', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminEnabled()) return replyAdminDisabled(reply);
    if (!requireInternalApiKey(request, reply)) return;

    const parsed = supplierInsightsDiagnosticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message || 'Invalid query' } });
    }

    const { organisationId, locationId } = parsed.data;

    // Verify org exists
    const org = await prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true },
    });
    if (!org) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Organisation not found' } });
    }

    try {
      // Count Xero invoices
      const xeroInvoiceWhere: any = {
        organisationId,
        deletedAt: null,
        status: { in: ['AUTHORISED', 'PAID'] },
      };

      if (locationId) {
        xeroInvoiceWhere.locationId = locationId;
      }

      const [totalXeroInvoices, xeroInvoicesByLocation, xeroInvoicesNullLocation, productStatsCounts] = await Promise.all([
        // Total invoices (matching Supplier Insights filters)
        prisma.xeroInvoice.count({
          where: xeroInvoiceWhere,
        }),
        // Count by location
        prisma.xeroInvoice.groupBy({
          by: ['locationId'],
          where: {
            organisationId,
            deletedAt: null,
            status: { in: ['AUTHORISED', 'PAID'] },
          },
          _count: true,
        }),
        // Count with NULL locationId
        prisma.xeroInvoice.count({
          where: {
            organisationId,
            deletedAt: null,
            status: { in: ['AUTHORISED', 'PAID'] },
            locationId: null,
          },
        }),
        // ProductStats counts (if locationId provided)
        locationId
          ? (prisma as any).productStats.groupBy({
              by: ['accountCodesHash'],
              where: {
                organisationId,
                locationId,
              },
              _count: true,
            })
          : Promise.resolve([]),
      ]);

      // Get ProductStats statsAsOf for the location (if provided)
      let productStatsAsOf: string | null = null;
      if (locationId) {
        const latestStats = await (prisma as any).productStats.findFirst({
          where: {
            organisationId,
            locationId,
          },
          orderBy: {
            statsAsOf: 'desc',
          },
          select: {
            statsAsOf: true,
          },
        });
        productStatsAsOf = latestStats?.statsAsOf?.toISOString() || null;
      }

      // Get connection ↔ location mapping status
      const connections = await prisma.xeroConnection.findMany({
        where: { organisationId },
        include: {
          locationLinks: {
            include: {
              location: {
                select: { id: true, name: true },
              },
            },
          },
        },
      });

      const connectionMappingStatus = connections.map(conn => ({
        connectionId: conn.id,
        tenantId: conn.xeroTenantId,
        tenantName: conn.tenantName,
        locationLinkCount: conn.locationLinks.length,
        locations: conn.locationLinks.map(link => ({
          locationId: link.locationId,
          locationName: link.location.name,
        })),
        isValid: conn.locationLinks.length === 1, // Exactly 1 link = valid mapping
      }));

      const diagnostics = {
        organisationId,
        locationId: locationId || null,
        xeroInvoices: {
          total: totalXeroInvoices,
          byLocation: xeroInvoicesByLocation.map((item: any) => ({
            locationId: item.locationId,
            count: item._count,
          })),
          nullLocationCount: xeroInvoicesNullLocation,
        },
        productStats: locationId
          ? {
              locationId,
              statsAsOf: productStatsAsOf,
              byAccountCodesHash: productStatsCounts.map((item: any) => ({
                accountCodesHash: item.accountCodesHash,
                count: item._count,
              })),
            }
          : null,
        connectionMappings: connectionMappingStatus,
        summary: {
          totalConnections: connections.length,
          validMappings: connectionMappingStatus.filter(c => c.isValid).length,
          invalidMappings: connectionMappingStatus.filter(c => !c.isValid).length,
          invoicesNeedingBackfill: xeroInvoicesNullLocation,
        },
      };

      return reply.send(diagnostics);
    } catch (error: any) {
      request.log.error(
        {
          audit: true,
          event: 'admin.supplierInsights.diagnostics.failed',
          organisationId,
          locationId,
          error: error.message,
        },
        'admin.supplierInsights.diagnostics.failed'
      );
      return reply.status(500).send({
        error: { code: 'DIAGNOSTICS_FAILED', message: error.message || 'Diagnostics failed' },
      });
    }
  });
}


