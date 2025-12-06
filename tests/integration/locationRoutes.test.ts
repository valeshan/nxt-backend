import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';
import { OrganisationRole } from '@prisma/client';

describe('Location Routes Integration', () => {
  let app: FastifyInstance;
  let authToken: string;
  let userId: string;
  let orgId: string;
  let locId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();

    // Setup User, Org, Location
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'loc-test@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        firstName: 'Test',
        lastName: 'User',
        acceptedTerms: true,
        acceptedPrivacy: true
      }
    });
    userId = registerRes.json().id;

    // Login to get token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'loc-test@example.com', password: 'password123' }
    });
    const loginToken = loginRes.json().access_token;

    // Create Org/Location (manual onboard)
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/organisations/onboard/manual',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { venueName: 'Test Location' }
    });
    const onboardData = onboardRes.json();
    orgId = onboardData.organisationId;
    locId = onboardData.locationId;

    // Select Org to get Org Token (which allows accessing location routes)
    const selectOrgRes = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { organisationId: orgId }
    });
    authToken = selectOrgRes.json().access_token;
  }, 30000);

  it('should return empty integrations for a location without links', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/organisations/${orgId}/locations`,
      headers: { Authorization: `Bearer ${authToken}` }
    });

    expect(res.statusCode).toBe(200);
    const locations = res.json();
    expect(locations).toHaveLength(1);
    expect(locations[0].id).toBe(locId);
    expect(locations[0].integrations).toEqual([]);
  });

  it('should return xero integration for a location with xero link', async () => {
    // Manually create Xero connection and link
    const connection = await prisma.xeroConnection.create({
      data: {
        userId,
        organisationId: orgId,
        xeroTenantId: 'tenant-123',
        tenantName: 'Xero Tenant',
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 10000)
      }
    });

    await prisma.xeroLocationLink.create({
      data: {
        xeroConnectionId: connection.id,
        organisationId: orgId,
        locationId: locId
      }
    });

    const res = await app.inject({
      method: 'GET',
      url: `/organisations/${orgId}/locations`,
      headers: { Authorization: `Bearer ${authToken}` }
    });

    expect(res.statusCode).toBe(200);
    const locations = res.json();
    expect(locations[0].integrations).toHaveLength(1);
    expect(locations[0].integrations[0]).toEqual({
      type: 'xero',
      name: 'Xero',
      status: 'connected'
    });
  });

  it('should update location platform label via PUT', async () => {
    const newName = 'Updated Label';
    const res = await app.inject({
      method: 'PUT',
      url: `/locations/${locId}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { name: newName }
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.name).toBe(newName);

    // Verify list reflects change
    const listRes = await app.inject({
      method: 'GET',
      url: `/organisations/${orgId}/locations`,
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const locations = listRes.json();
    expect(locations[0].name).toBe(newName);
  });
});

