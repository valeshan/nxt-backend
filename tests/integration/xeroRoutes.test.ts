import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config/env';

describe('Xero Routes Integration', () => {
  let app: any;
  const token = jwt.sign({ sub: 'user_1', orgId: 'org_123' }, config.JWT_VERIFY_SECRET, { expiresIn: '1h' });

  beforeEach(async () => {
    await resetDb();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  describe('POST /xero/connections', () => {
    it('should create a connection successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/xero/connections',
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          organisationId: 'org_123',
          xeroTenantId: 'tenant_abc',
          accessToken: 'access_token_val',
          refreshToken: 'refresh_token_val',
          accessTokenExpiresAt: new Date().toISOString(),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.organisationId).toBe('org_123');
      expect(body.status).toBe('active');
      // Should not return raw tokens but encrypted ones are in DB. 
      // The repository create returns the Prisma object which includes them. 
      // Ideally we mask them in DTO but requirement didn't specify masking for now.
    });

    it('should fail with 400 on invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/xero/connections',
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          // missing fields
          organisationId: 'org_123',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /xero/connections/:connectionId/locations', () => {
    it('should link locations to a connection', async () => {
      // First create connection
      const createRes = await app.inject({
        method: 'POST',
        url: '/xero/connections',
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          organisationId: 'org_123',
          xeroTenantId: 'tenant_abc',
          accessToken: 'at',
          refreshToken: 'rt',
          accessTokenExpiresAt: new Date().toISOString(),
        },
      });
      const connectionId = createRes.json().id;

      // Link locations
      const linkRes = await app.inject({
        method: 'POST',
        url: `/xero/connections/${connectionId}/locations`,
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          organisationId: 'org_123',
          locationIds: ['loc_1', 'loc_2'],
        },
      });

      expect(linkRes.statusCode).toBe(200);
      const body = linkRes.json();
      expect(body.locationLinks).toHaveLength(2);
    });

    it('should return 403 on organisation mismatch', async () => {
       // First create connection for org_123
       const createRes = await app.inject({
        method: 'POST',
        url: '/xero/connections',
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          organisationId: 'org_123',
          xeroTenantId: 'tenant_abc',
          accessToken: 'at',
          refreshToken: 'rt',
          accessTokenExpiresAt: new Date().toISOString(),
        },
      });
      const connectionId = createRes.json().id;

      // Try to link with org_999
      const linkRes = await app.inject({
        method: 'POST',
        url: `/xero/connections/${connectionId}/locations`,
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          organisationId: 'org_999',
          locationIds: ['loc_1'],
        },
      });

      expect(linkRes.statusCode).toBe(403);
    });
  });

  describe('GET /xero/connections', () => {
    it('should return connections for organisation', async () => {
      // Create connection
      await app.inject({
        method: 'POST',
        url: '/xero/connections',
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          organisationId: 'org_123',
          xeroTenantId: 'tenant_abc',
          accessToken: 'at',
          refreshToken: 'rt',
          accessTokenExpiresAt: new Date().toISOString(),
        },
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/xero/connections?organisationId=org_123',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(1);
    });

    it('should return empty list for other organisation', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/xero/connections?organisationId=org_other',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(0);
    });
  });
});

