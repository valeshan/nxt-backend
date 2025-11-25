import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';

describe('Auth Routes Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();
  });

  // Helper functions to mirror the client-side request pattern
  async function selectOrganisation(organisationId: string, accessToken: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { organisationId }
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function selectLocation(locationId: string, accessToken: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/select-location',
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { locationId }
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('should complete the full auth flow with manual onboarding', async () => {
    // 1. Register
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'test@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        firstName: 'Test',
        lastName: 'User',
        acceptedTerms: true,
        acceptedPrivacy: true
      }
    });
    expect(registerRes.statusCode).toBe(201);
    
    // 2. Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'test@example.com',
        password: 'password123'
      }
    });
    expect(loginRes.statusCode).toBe(200);
    const loginData = loginRes.json();
    const loginToken = loginData.access_token;

    // 3. Manual Onboard (instead of Create Organisation directly)
    const manualRes = await app.inject({
      method: 'POST',
      url: '/organisations/onboard/manual',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { venueName: 'My Cafe' }
    });
    expect(manualRes.statusCode).toBe(201);
    const manualData = manualRes.json();
    expect(manualData.organisationName).toBe('My Cafe');
    expect(manualData.locationName).toBe('My Cafe');
    
    const orgId = manualData.organisationId;
    const locId = manualData.locationId;

    // 4. Select Organisation
    const orgData = await selectOrganisation(orgId, loginToken);
    expect(orgData.locations).toBeDefined();
    const orgToken = orgData.access_token;

    // 5. Select Location
    const locData = await selectLocation(locId, orgToken);
    expect(locData.access_token).toBeDefined();
    
    // 6. Refresh
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: locData.refresh_token }
    });
    expect(refreshRes.statusCode).toBe(200);
  });
});
