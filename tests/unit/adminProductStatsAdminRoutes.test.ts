import { describe, it, expect, beforeEach, vi } from 'vitest';
import fastify from 'fastify';

vi.mock('../../src/infrastructure/prismaClient', () => {
  return {
    default: {
      organisation: {
        findUnique: async ({ where }: any) => (where?.id ? { id: where.id } : null),
      },
      location: {
        findFirst: async ({ where }: any) => {
          if (where?.id && where?.organisationId) return { id: where.id };
          return null;
        },
      },
    },
  };
});

// Mock Redis cooldown behavior (1 OK then cooldown)
let setCalls = 0;
vi.mock('../../src/infrastructure/redis', () => {
  return {
    getRedisClient: () => ({
      set: async () => {
        setCalls += 1;
        return setCalls === 1 ? 'OK' : null;
      },
    }),
  };
});

vi.mock('../../src/services/AdminProductStatsQueueService', () => {
  return {
    enqueueProductStatsRefresh: async () => ({ jobId: 'job-123' }),
    getAdminJobStatus: async (jobId: string) => ({
      jobId,
      exists: true,
      name: 'product-stats-refresh',
      state: 'waiting',
      progress: { stage: 'queued', pct: 0 },
    }),
  };
});

describe('Admin ProductStats endpoints (safe-by-default)', () => {
  beforeEach(() => {
    setCalls = 0;
    process.env.ENABLE_ADMIN_ENDPOINTS = 'true';
    process.env.INTERNAL_ADMIN_API_KEY = 'test-admin-key';
    process.env.NODE_ENV = 'test';
    vi.resetModules();
  });

  async function build() {
    const app = fastify({ logger: false });
    const mod = await import('../../src/routes/adminRoutes');
    await app.register(mod.default, { prefix: '/admin' });
    await app.ready();
    return app;
  }

  it('requires internal api key', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/product-stats/refresh',
      payload: { organisationId: 'org', locationId: 'loc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 501 with stable code when admin endpoints are disabled', async () => {
    process.env.ENABLE_ADMIN_ENDPOINTS = 'false';
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/product-stats/refresh',
      headers: { 'x-internal-api-key': 'test-admin-key' },
      payload: { organisationId: 'org', locationId: 'loc' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error?.code).toBe('ADMIN_ENDPOINTS_DISABLED');
  });

  it('enqueues job and returns jobId', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/product-stats/refresh',
      headers: { 'x-internal-api-key': 'test-admin-key' },
      payload: { organisationId: 'org', locationId: 'loc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobId).toBe('job-123');
  });

  it('enforces per-location cooldown (1 per 10 minutes)', async () => {
    const app = await build();

    const first = await app.inject({
      method: 'POST',
      url: '/admin/product-stats/refresh',
      headers: { 'x-internal-api-key': 'test-admin-key' },
      payload: { organisationId: 'org', locationId: 'loc' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/admin/product-stats/refresh',
      headers: { 'x-internal-api-key': 'test-admin-key' },
      payload: { organisationId: 'org', locationId: 'loc' },
    });
    expect(second.statusCode).toBe(429);
  });

  it('returns job status from /admin/jobs/:jobId', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/jobs/job-123',
      headers: { 'x-internal-api-key': 'test-admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobId).toBe('job-123');
    expect(body.state).toBe('waiting');
  });
});

