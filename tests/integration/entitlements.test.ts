import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';

describe('Entitlements Integration', () => {
  let app: FastifyInstance;
  let authToken: string;
  let orgId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();

    // 1. Register
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'entitlements-test@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        firstName: 'Test',
        lastName: 'User',
        acceptedTerms: true,
        acceptedPrivacy: true
      }
    });
    // User ID not needed for these entitlements tests; registration is just setup.

    // 2. Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'entitlements-test@example.com', password: 'password123' }
    });
    const loginToken = loginRes.json().access_token;

    // 3. Onboard (Create Org)
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/organisations/onboard/manual',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { venueName: 'Test Org' }
    });
    orgId = onboardRes.json().organisationId;

    // 4. Select Org (Get Auth Token)
    const selectOrgRes = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { organisationId: orgId }
    });
    authToken = selectOrgRes.json().access_token;
  }, 30000);

  it('should default to Free plan entitlements', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/organisations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${authToken}` }
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.planKey).toBe('free');
    expect(data.caps.seatLimit).toBe(1);
    expect(data.flags.canInviteUsers).toBe(false);
  });

  it('should allow admin to upgrade plan to Pro', async () => {
    // Upgrade to Pro
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}/plan`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { planKey: 'pro' }
    });
    expect(updateRes.statusCode).toBe(200);

    // Simulate Stripe-confirmed subscription (webhook-first gating):
    // planKey alone is not enough; accessPlanKey becomes paid only when billingState is active/trialing/past_due.
    await prisma.organisation.update({
      where: { id: orgId },
      data: { billingState: 'active', stripeSubscriptionStatus: 'active' },
    });

    // Verify entitlements
    const res = await app.inject({
      method: 'GET',
      url: `/organisations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = res.json();
    expect(data.planKey).toBe('pro');
    expect(data.caps.seatLimit).toBe(5);
    expect(data.flags.canInviteUsers).toBe(true);
  });

  it('should allow overrides to modify caps', async () => {
    // Override seat limit to 50
    const overrideRes = await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}/overrides`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { seatLimit: 50 }
    });
    expect(overrideRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/organisations/${orgId}/entitlements`,
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = res.json();
    expect(data.caps.seatLimit).toBe(50);
    // Should still be free plan base
    expect(data.planKey).toBe('free');
  });

  it('should enforce invite restrictions on Free plan', async () => {
    // Attempt to invite (should fail on Free because canInviteUsers=false)
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/organisations/${orgId}/invites`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { email: 'invitee@example.com', role: 'member' }
    });

    expect(inviteRes.statusCode).toBe(403);
    const inviteJson = inviteRes.json();
    expect(inviteJson.error?.code || inviteJson.code).toBe('INVITES_DISABLED');
  });

  it('should enforce seat limit on Legacy plan', async () => {
    // Switch to legacy (low limits but can invite)
    await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}/plan`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { planKey: 'legacy' }
    });

    // Override limit to 1 (current user takes 1 seat)
    await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}/overrides`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { seatLimit: 1 }
    });

    // Try to invite - should fail as seat limit reached (1/1)
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/organisations/${orgId}/invites`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { email: 'invitee@example.com', role: 'member' }
    });

    expect(inviteRes.statusCode).toBe(400);
    const inviteJson = inviteRes.json();
    expect(inviteJson.error?.code || inviteJson.code).toBe('SEAT_LIMIT_REACHED');
  });

  it('should enforce location limit', async () => {
    // Free plan has location limit 1. Current org has 1 location (from onboarding).
    
    // Attempt to create second location
    const locRes = await app.inject({
      method: 'POST',
      url: `/locations`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { name: 'Second Location' }
    });

    expect(locRes.statusCode).toBe(400);
    const locJson = locRes.json();
    expect(locJson.error?.code || locJson.code).toBe('LOCATION_LIMIT_REACHED');

    // Upgrade to Pro (limit 10)
    const upgradeRes = await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}/plan`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { planKey: 'pro' }
    });
    expect(upgradeRes.statusCode).toBe(200);

    // Simulate Stripe-confirmed subscription so paid caps apply.
    await prisma.organisation.update({
      where: { id: orgId },
      data: { billingState: 'active', stripeSubscriptionStatus: 'active' },
    });

    // Retry
    const locRes2 = await app.inject({
      method: 'POST',
      url: `/locations`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { name: 'Second Location' }
    });

    expect(locRes2.statusCode).toBe(201);
  });
});

