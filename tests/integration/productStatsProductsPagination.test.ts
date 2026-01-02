import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import prisma from '../../src/infrastructure/prismaClient';
import { signAccessToken } from '../../src/utils/jwt';
import { OrganisationRole } from '@prisma/client';

describe('Supplier Insights /products pagination uses ProductStats', () => {
  let app: any;

  const user = { id: 'user-a', email: 'a@test.com', name: 'User A' };
  const org = { id: 'org-a', name: 'Org A' };
  const loc = { id: 'loc-a', name: 'Loc A', organisationId: org.id };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();

    await prisma.user.create({
      data: { id: user.id, email: user.email, passwordHash: 'hash', name: user.name },
    });
    await prisma.organisation.create({ data: org });
    await prisma.location.create({ data: loc });
    await prisma.userOrganisation.create({
      data: { userId: user.id, organisationId: org.id, role: OrganisationRole.owner },
    });

    const statsAsOf = new Date('2025-12-21T00:00:00.000Z');
    const rows = Array.from({ length: 25 }).map((_, i) => ({
      organisationId: org.id,
      locationId: loc.id,
      accountCodesHash: 'all',
      source: 'XERO' as const,
      productId: `prod-${String(i + 1).padStart(2, '0')}`,
      productName: `Product ${String(i + 1).padStart(2, '0')}`,
      supplierName: `Supplier ${String((i % 3) + 1)}`,
      spend12m: i + 1,
      statsAsOf,
    }));

    await prisma.productStats.createMany({ data: rows as any });
  });

  function makeToken() {
    return signAccessToken({
      sub: user.id,
      orgId: org.id,
      locId: loc.id,
      tokenType: 'location',
      roles: ['owner'],
      tokenVersion: 0,
    });
  }

  it('returns DB-driven pagination metadata and statsAsOf', async () => {
    const token = makeToken();
    const res = await app.inject({
      method: 'GET',
      url: `/supplier-insights/products?page=2&pageSize=10&sortBy=productName&sortDirection=asc`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(10);
    expect(body.pagination.totalItems).toBe(25);
    expect(body.pagination.totalPages).toBe(3);
    expect(body.statsAsOf).toBe('2025-12-21T00:00:00.000Z');
  });
});



