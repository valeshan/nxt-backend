import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';

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
  }, 30000);

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

  async function registerAndLogin(email: string, password = 'password123') {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email,
        password,
        confirmPassword: password,
        firstName: 'Test',
        lastName: 'User',
        acceptedTerms: true,
        acceptedPrivacy: true,
      },
    });
    expect(registerRes.statusCode).toBe(201);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginData = loginRes.json() as any;
    return {
      accessToken: loginData.access_token as string,
      refreshToken: loginData.refresh_token as string,
      userId: loginData.user_id as string,
    };
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
  }, 15000);

  it('logout invalidates refresh token immediately', async () => {
    const { accessToken, refreshToken } = await registerAndLogin('logout@test.com');

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(logoutRes.statusCode).toBe(200);

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('logout revokes refresh even if access token still valid', async () => {
    const { accessToken, refreshToken } = await registerAndLogin('logout2@test.com');

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Access tokens are not revoked server-side; they remain valid until expiry.
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('password change invalidates refresh token', async () => {
    const { accessToken, refreshToken } = await registerAndLogin('pwchange@test.com', 'oldpassword123');

    const changeRes = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { oldPassword: 'oldpassword123', newPassword: 'newpassword123', confirmPassword: 'newpassword123' },
    });
    expect(changeRes.statusCode).toBe(200);

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('refresh should not increment tokenVersion (DB assertion)', async () => {
    const { refreshToken, userId } = await registerAndLogin('refresh-version@test.com');

    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    expect(before).toBeTruthy();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);

    const after = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    expect(after).toBeTruthy();
    expect(after!.tokenVersion).toBe(before!.tokenVersion);
  });

  it('refresh does not revoke itself (can refresh twice)', async () => {
    const { refreshToken } = await registerAndLogin('refresh-twice@test.com');

    const r1 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const r1Body = r1.json() as any;

    const r2 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: r1Body.refresh_token },
    });
    expect(r2.statusCode).toBe(200);
  });
});
