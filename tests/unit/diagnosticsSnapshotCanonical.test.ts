import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/supplierInsightsService', () => {
  return {
    supplierInsightsService: {
      getCanonicalParityChecklist: async () => ({
        ok: true,
        checks: [],
        totals: { legacySpend90d: 0, canonicalSpend90d: 0, deltaPct: 0 },
      }),
    },
  };
});

vi.mock('../../src/infrastructure/prismaClient', () => {
  return {
    default: {
      $queryRaw: async () => [],
      supplier: {
        count: async () => 2,
      },
      product: {
        count: async () => 3,
      },
      xeroInvoice: {
        count: async () => 4,
      },
      invoice: {
        count: async () => 5,
      },
      invoiceFile: {
        count: async ({ where }: any) => {
          if (where?.reviewStatus === 'NEEDS_REVIEW') return 1;
          return 6;
        },
      },
      xeroConnection: {
        findFirst: async () => null,
      },
      xeroSyncRun: {
        findFirst: async () => null,
      },
      canonicalInvoice: {
        count: async () => 7,
        aggregate: async () => ({
          _max: {
            updatedAt: new Date('2025-01-01T00:00:00.000Z'),
            date: new Date('2024-12-31T00:00:00.000Z'),
          },
        }),
      },
      canonicalInvoiceLineItem: {
        count: async ({ where }: any) => {
          if (where?.qualityStatus === 'OK') return 90;
          if (where?.qualityStatus === 'WARN') return 10;
          return 100;
        },
      },
    },
  };
});

describe('GET /diagnostics/snapshot (canonical)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_DIAGNOSTICS = 'true';
    process.env.USE_CANONICAL_LINES = 'true';
    process.env.CANONICAL_LINES_ORG_ALLOWLIST = '';
    vi.resetModules();
  });

  function makeReplyCapture() {
    const reply: any = {};
    reply.status = vi.fn(() => reply);
    reply.send = vi.fn(() => reply);
    return reply as any;
  }

  it('returns canonical diagnostics (no parity)', async () => {
    const { DiagnosticsController } = await import('../../src/controllers/diagnosticsController.js');
    const controller = new DiagnosticsController();

    const reply = makeReplyCapture();
    const request: any = {
      authContext: {
        userId: 'user',
        organisationId: 'org-1',
        locationId: null,
        tokenType: 'organisation',
        roles: ['owner'],
      },
      query: { includeCanonicalParity: false },
    };

    await controller.getSnapshot(request, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    const body = reply.send.mock.calls[0][0];
    expect(body.canonical.enabledForOrg).toBe(true);
    expect(body.canonical.operational.ok).toBe(true);
    expect(body.canonical.counts).toEqual({ invoices: 7, lines: 100 });
    expect(body.canonical.warnRate).toBeCloseTo(0.1, 6);
    expect(body.canonical.lastWriteAt).toBe('2025-01-01T00:00:00.000Z');
    expect(body.canonical.parity).toBe(null);
  });

  it('when parity requested without location token, returns a clear error report', async () => {
    const { DiagnosticsController } = await import('../../src/controllers/diagnosticsController.js');
    const controller = new DiagnosticsController();

    const reply = makeReplyCapture();
    const request: any = {
      authContext: {
        userId: 'user',
        organisationId: 'org-1',
        locationId: null,
        tokenType: 'organisation',
        roles: ['owner'],
      },
      query: { includeCanonicalParity: true },
    };

    await controller.getSnapshot(request, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    const body = reply.send.mock.calls[0][0];
    expect(body.canonical.parity.ok).toBe(false);
    expect(body.canonical.parity.organisationId).toBe('org-1');
    expect(body.canonical.parity.locationId).toBe(null);
    expect(body.canonical.parity.report?.error).toMatch(/location-context token/i);
  });

  it('when parity requested with location token, includes ids in payload', async () => {
    const { DiagnosticsController } = await import('../../src/controllers/diagnosticsController.js');
    const controller = new DiagnosticsController();

    const reply = makeReplyCapture();
    const request: any = {
      authContext: {
        userId: 'user',
        organisationId: 'org-1',
        locationId: 'loc-1',
        tokenType: 'location',
        roles: ['owner'],
      },
      query: { includeCanonicalParity: true },
    };

    await controller.getSnapshot(request, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    const body = reply.send.mock.calls[0][0];
    expect(body.canonical.parity.ok).toBe(true);
    expect(body.canonical.parity.organisationId).toBe('org-1');
    expect(body.canonical.parity.locationId).toBe('loc-1');
  });
});


