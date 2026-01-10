import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';

const stripeMock = {
  customers: {
    create: vi.fn().mockResolvedValue({ id: 'cus_test123' }),
  },
  subscriptions: {
    list: vi.fn().mockResolvedValue({ data: [] }),
  },
  promotionCodes: {
    list: vi.fn().mockResolvedValue({
      data: [{ id: 'promo_test123', code: 'EARLYPRO100', active: true }],
    }),
  },
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'cs_test123',
        url: 'https://checkout.stripe.com/test',
      }),
    },
  },
  billingPortal: {
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'bps_test123',
        url: 'https://billing.stripe.com/test',
      }),
    },
  },
};

// Mock the Stripe service
vi.mock('../../src/services/stripe/stripeService', () => ({
  getStripeClient: vi.fn(() => stripeMock),
  isStripeEnabled: vi.fn(() => true),
  getStripeKeyMode: vi.fn(() => 'test'),
  getFrontendUrl: vi.fn(() => 'http://localhost:3000'),
  getEnvironment: vi.fn(() => 'test'),
}));

describe('Billing Integration', () => {
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
    // Also clear BillingWebhookEvent
    await prisma.billingWebhookEvent.deleteMany();

    // 1. Register
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'billing-test@example.com',
        password: 'Password!23',
        confirmPassword: 'Password!23',
        firstName: 'Billing',
        lastName: 'Test',
        acceptedTerms: true,
        acceptedPrivacy: true,
      },
    });
    // User ID not needed for these billing tests; registration is just setup.

    // 2. Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'billing-test@example.com', password: 'Password!23' },
    });
    const loginToken = loginRes.json().access_token;

    // 3. Onboard (Create Org)
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/organisations/onboard/manual',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { venueName: 'Billing Test Org' },
    });
    orgId = onboardRes.json().organisationId;

    // 4. Select Org (Get Auth Token)
    const selectOrgRes = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { organisationId: orgId },
    });
    authToken = selectOrgRes.json().access_token;
  }, 30000);

  describe('POST /billing/checkout-session', () => {
    it('should create a checkout session for Pro plan', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'pro', interval: 'monthly' },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.url).toContain('stripe.com');
    });

    it('should create a checkout session for Enterprise plan with annual billing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'enterprise', interval: 'annual' },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.url).toBeDefined();
    });

    it('should apply annual trial semantics for intro offers (no discounts)', async () => {
      // We spy on the mocked Stripe checkout create to assert the session params.
      const createSpy = stripeMock.checkout.sessions.create;
      createSpy.mockClear();

      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'pro', interval: 'annual' },
      });

      expect(res.statusCode).toBe(200);
      expect(createSpy).toHaveBeenCalled();
      const params = createSpy.mock.calls[createSpy.mock.calls.length - 1][0];
      expect(params.discounts).toBeUndefined();
      expect(params.subscription_data?.trial_end).toBeTypeOf('number');
      expect(params.payment_method_collection).toBe('always');
    });

    it('should reject invalid plan key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'free', interval: 'monthly' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid interval', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'pro', interval: 'weekly' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        payload: { planKey: 'pro', interval: 'monthly' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should store stripeCustomerId on org after checkout session creation', async () => {
      await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'pro', interval: 'monthly' },
      });

      const org = await prisma.organisation.findUnique({
        where: { id: orgId },
        select: { stripeCustomerId: true },
      });

      expect(org?.stripeCustomerId).toBe('cus_test123');
    });
  });

  describe('POST /billing/portal-session', () => {
    it('should require existing Stripe customer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/portal-session',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('No billing account');
    });

    it('should create portal session when Stripe customer exists', async () => {
      // First, create a checkout session to set up customer
      await app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { Authorization: `Bearer ${authToken}` },
        payload: { planKey: 'pro', interval: 'monthly' },
      });

      // Now try portal session
      const res = await app.inject({
        method: 'POST',
        url: '/billing/portal-session',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.url).toContain('stripe.com');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/portal-session',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Entitlements with Stripe fields', () => {
    it('should return cancelAtPeriodEnd in entitlements', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/organisations/${orgId}/entitlements`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.billing.cancelAtPeriodEnd).toBe(false);
    });

    it('should return stripeSubscriptionStatus in entitlements', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/organisations/${orgId}/entitlements`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.billing).toHaveProperty('stripeSubscriptionStatus');
    });
  });

  describe('Billing state transitions', () => {
    it('should allow access during grace period when past_due', async () => {
      // Set org to past_due with grace period in future
      const graceEndsAt = new Date();
      graceEndsAt.setDate(graceEndsAt.getDate() + 3);

      await prisma.organisation.update({
        where: { id: orgId },
        data: {
          billingState: 'past_due',
          planKey: 'pro',
          graceEndsAt,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/organisations/${orgId}/entitlements`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      const data = res.json();
      expect(data.billing.state).toBe('past_due');
      expect(data.billing.accessState).toBe('active'); // Still active during grace
    });

    it('should downgrade access after grace period expires', async () => {
      // Set org to past_due with expired grace period
      const graceEndsAt = new Date();
      graceEndsAt.setDate(graceEndsAt.getDate() - 1); // Expired yesterday

      await prisma.organisation.update({
        where: { id: orgId },
        data: {
          billingState: 'past_due',
          planKey: 'pro',
          graceEndsAt,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/organisations/${orgId}/entitlements`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      const data = res.json();
      expect(data.billing.state).toBe('past_due');
      expect(data.billing.accessState).toBe('free'); // Downgraded after grace
    });

    it('should allow access until period end when canceled', async () => {
      // Set org to canceled with period end in future
      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() + 10);

      await prisma.organisation.update({
        where: { id: orgId },
        data: {
          billingState: 'canceled',
          planKey: 'pro',
          currentPeriodEndsAt: periodEnd,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/organisations/${orgId}/entitlements`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      const data = res.json();
      expect(data.billing.state).toBe('canceled');
      expect(data.billing.accessState).toBe('active'); // Still active until period end
    });

    it('should downgrade access after period end when canceled', async () => {
      // Set org to canceled with expired period end
      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() - 1); // Expired yesterday

      await prisma.organisation.update({
        where: { id: orgId },
        data: {
          billingState: 'canceled',
          planKey: 'pro',
          currentPeriodEndsAt: periodEnd,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/organisations/${orgId}/entitlements`,
        headers: { Authorization: `Bearer ${authToken}` },
      });

      const data = res.json();
      expect(data.billing.state).toBe('canceled');
      expect(data.billing.accessState).toBe('free'); // Downgraded after period end
    });
  });
});

