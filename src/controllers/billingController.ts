import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../infrastructure/prismaClient';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { 
  getStripeClient, 
  isStripeEnabled, 
  getFrontendUrl, 
  getEnvironment 
} from '../services/stripe/stripeService';
import { getPriceId, isPurchasablePlan, BillingInterval } from '../config/stripePrices';
import { PlanKey } from '../services/entitlements/types';
import { PLAN_CATALOG, PLAN_LABELS } from '../config/plans';
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
} from '../services/stripe/webhookHandlers';
import {
  INTRO_OFFER_CODE_BY_PLAN,
  isIntroOfferEligible,
  getIntroOfferCouponId,
  computeAnnualTrialEndFromNow,
} from '../config/stripeIntroOffer';

// Request schemas
const checkoutSessionSchema = z.object({
  planKey: z.enum(['pro', 'enterprise']),
  interval: z.enum(['monthly', 'annual']),
  successPath: z.string().optional(),
  cancelPath: z.string().optional(),
});

type CheckoutSessionRequest = z.infer<typeof checkoutSessionSchema>;
type PortalFlow = 'manage' | 'switch_plan';

/**
 * Billing Controller
 * 
 * Handles Stripe checkout and portal session creation.
 * All billing operations must go through backend (never frontend).
 */
export const billingController = {
  /**
   * GET /billing/plans
   *
   * Returns the canonical plan catalog for UI display (caps + labels).
   * This prevents FE/BE plan drift.
   */
  async getPlans(_request: FastifyRequest, reply: FastifyReply) {
    const plans = (['free', 'pro', 'enterprise'] as PlanKey[]).map((planKey) => ({
      id: planKey,
      name: PLAN_LABELS[planKey] ?? planKey,
      caps: PLAN_CATALOG[planKey].caps,
    }));

    return reply.send({ plans });
  },

  /**
   * POST /billing/checkout-session
   * 
   * Creates a Stripe Checkout session for upgrading to a paid plan.
   * - Validates user is org owner/admin
   * - Creates Stripe customer if not exists (stores immediately for idempotency)
   * - Returns checkout URL
   */
  async createCheckoutSession(
    request: FastifyRequest<{ Body: CheckoutSessionRequest }>,
    reply: FastifyReply
  ) {
    try {
      // Kill switch check
      if (!isStripeEnabled()) {
        return reply.code(503).send({
          message: 'Billing is temporarily unavailable. Please try again later.',
        });
      }

      const { planKey, interval, successPath, cancelPath } = request.body;
      const userId = request.authContext.userId;
      const orgId = request.authContext.organisationId;

      if (!orgId) {
        return reply.code(400).send({ message: 'Organisation context required' });
      }

      // Validate plan is purchasable
      if (!isPurchasablePlan(planKey)) {
        return reply.code(400).send({ message: 'Invalid plan selected' });
      }

      // Check user has owner/admin role
      const membership = await userOrganisationRepository.findMembership(userId, orgId);
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return reply.code(403).send({
          message: 'Only organisation owners and admins can manage billing',
        });
      }

      // Get price ID for the plan + interval
      const priceId = getPriceId(planKey as PlanKey, interval as BillingInterval);
      if (!priceId) {
        return reply.code(400).send({ message: 'Invalid plan configuration' });
      }

      // Get org and user details
      const [org, user] = await Promise.all([
        prisma.organisation.findUnique({ where: { id: orgId } }),
        prisma.user.findUnique({ where: { id: userId } }),
      ]);

      if (!org || !user) {
        return reply.code(404).send({ message: 'Organisation or user not found' });
      }

      const stripe = getStripeClient();

      // Find or create Stripe customer (store immediately for idempotency)
      let customerId = org.stripeCustomerId;

      if (!customerId) {
        // Create new Stripe customer
        const customer = await stripe.customers.create({
          email: user.email,
          name: org.name,
          metadata: {
            organisationId: org.id,
            userId: userId,
          },
        });

        customerId = customer.id;

        // Store immediately before creating checkout session
        // This prevents ghost customers and ensures idempotency
        await prisma.organisation.update({
          where: { id: orgId },
          data: { stripeCustomerId: customerId },
        });
      }

      /**
       * IMPORTANT: Prevent subscription stacking.
       *
       * Stripe Checkout in `mode=subscription` creates a NEW subscription each time.
       * If the customer already has an active/trialing/past_due/unpaid subscription,
       * we route them to the Stripe Customer Portal to manage plan changes instead.
       *
       * This keeps billing state webhook-first while avoiding multiple concurrent subs.
       */
      if (customerId) {
        const existingSubs = await stripe.subscriptions.list({
          customer: customerId,
          status: 'all',
          limit: 10,
        });

        const hasExistingSubscription = existingSubs.data.some((s) =>
          ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status)
        );

        if (hasExistingSubscription) {
          const frontendUrl = getFrontendUrl();
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${frontendUrl}/store-settings?tab=billing`,
          });
          if (!portalSession?.url) {
            return reply.code(500).send({ message: 'Billing portal URL missing' });
          }
          return reply.send({ url: portalSession.url });
        }
      }

      // Validate optional return paths (must be relative and known-safe)
      const isSafePath = (p: string) =>
        p.startsWith('/') && !p.startsWith('//') && !p.includes('http');
      const safeSuccessPath = successPath && isSafePath(successPath) ? successPath : '/store-settings';
      const safeCancelPath =
        cancelPath && isSafePath(cancelPath) ? cancelPath : '/subscription-plans?canceled=true';

      // Intro offer (monthly: discount semantics, annual: trial semantics) for new orgs during signup window.
      // Apply server-side; "burn" it only once subscription is created (via webhook).
      let discounts: Array<{ coupon: string }> | undefined;
      let introOfferCode: string | null = null;
      const offerCodeForPlan = INTRO_OFFER_CODE_BY_PLAN[planKey as PlanKey] ?? null;
      let annualTrialEndUnix: number | null = null;

      if (
        offerCodeForPlan &&
        isIntroOfferEligible({
          createdAt: org.createdAt,
          stripeSubscriptionId: org.stripeSubscriptionId ?? null,
          hasUsedIntroOffer: org.hasUsedIntroOffer ?? false,
        })
      ) {
        if (interval === 'annual') {
          // Trial semantics: charge $0 now, first annual invoice after 3 months.
          annualTrialEndUnix = computeAnnualTrialEndFromNow();
          introOfferCode = offerCodeForPlan;
          request.log.info(
            { orgId, planKey, interval, trialEndsAt: annualTrialEndUnix, offerCodeForPlan },
            '[Billing] Applying intro offer as annual trial'
          );
        } else {
          // Monthly discount semantics: 100% off for 3 months.
          const couponId = getIntroOfferCouponId(planKey as PlanKey, interval as any);
          if (couponId) {
            discounts = [{ coupon: couponId }];
            introOfferCode = offerCodeForPlan;
            request.log.info(
              { orgId, planKey, interval, couponId, offerCodeForPlan },
              '[Billing] Applying intro offer coupon'
            );
          } else {
            request.log.warn(
              { orgId, planKey, interval, offerCodeForPlan },
              '[Billing] Intro offer coupon not configured for this plan/interval; continuing without discount'
            );
          }
        }
      }

      // Create checkout session
      const frontendUrl = getFrontendUrl();
      const sessionParams: Record<string, unknown> = {
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        discounts,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: `${frontendUrl}${safeSuccessPath}${
          safeSuccessPath.includes('?') ? '&' : '?'
        }billing_success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl}${safeCancelPath}${
          safeCancelPath.includes('?') ? '&' : '?'
        }billing_cancelled=true`,
        metadata: {
          organisationId: orgId,
          userId: userId,
          planKey: planKey,
          ...(introOfferCode ? { introOfferCode } : {}),
          env: getEnvironment(),
        },
        subscription_data: {
          metadata: {
            organisationId: orgId,
            userId: userId,
            planKey: planKey,
            ...(introOfferCode ? { introOfferCode } : {}),
            env: getEnvironment(),
          },
        },
      };

      // Annual trial semantics: set a trial_end and require a payment method up-front.
      // This ensures users are not blocked at trial end and aligns with "3 months free then billed annually."
      if (annualTrialEndUnix) {
        (sessionParams as any).payment_method_collection = 'always';
        (sessionParams as any).subscription_data = {
          ...(sessionParams as any).subscription_data,
          trial_end: annualTrialEndUnix,
          trial_settings: {
            end_behavior: {
              missing_payment_method: 'cancel',
            },
          },
        };
      }

      // Stripe restriction: you may only specify ONE of `allow_promotion_codes` OR `discounts`.
      // If we auto-apply a promotion via `discounts`, we must not allow manual promo entry on the same session.
      if (!discounts && !annualTrialEndUnix) {
        (sessionParams as any).allow_promotion_codes = true;
      }

      const session = await stripe.checkout.sessions.create(sessionParams as any);

      if (!session?.url) {
        return reply.code(500).send({ message: 'Checkout session URL missing' });
      }

      return reply.send({ url: session.url });
    } catch (err) {
      request.log.error({ err }, '[Billing] Failed to create checkout session');
      const isProd = (process.env.APP_ENV || process.env.NODE_ENV) === 'production';
      const message =
        !isProd && err instanceof Error && err.message
          ? `Failed to create checkout session: ${err.message}`
          : 'Failed to create checkout session';
      return reply.code(500).send({ message });
    }
  },

  /**
   * POST /billing/portal-session
   * 
   * Creates a Stripe Customer Portal session for managing billing.
   * - Validates user is org owner/admin
   * - Requires existing stripeCustomerId
   * - Returns portal URL
   */
  async createPortalSession(
    request: FastifyRequest<{ Body?: { flow?: PortalFlow } }>,
    reply: FastifyReply
  ) {
    // Kill switch check
    if (!isStripeEnabled()) {
      return reply.code(503).send({ 
        message: 'Billing is temporarily unavailable. Please try again later.' 
      });
    }

    const userId = request.authContext.userId;
    const orgId = request.authContext.organisationId;

    if (!orgId) {
      return reply.code(400).send({ message: 'Organisation context required' });
    }

    // Check user has owner/admin role
    const membership = await userOrganisationRepository.findMembership(userId, orgId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return reply.code(403).send({ 
        message: 'Only organisation owners and admins can manage billing' 
      });
    }

    // Get org
    const org = await prisma.organisation.findUnique({ where: { id: orgId } });
    if (!org) {
      return reply.code(404).send({ message: 'Organisation not found' });
    }

    // Require existing Stripe customer
    if (!org.stripeCustomerId) {
      return reply.code(400).send({ 
        message: 'No billing account found. Please upgrade first.' 
      });
    }

    const stripe = getStripeClient();
    const frontendUrl = getFrontendUrl();

    const flow: PortalFlow = request.body?.flow ?? 'manage';

    // Create portal session
    // - manage: portal home (billing details + invoices)
    // - switch_plan: start in subscription change flow (if supported by Stripe config + active subscription)
    let session: { url: string };
    if (flow === 'switch_plan') {
      if (!org.stripeSubscriptionId) {
        return reply.code(400).send({
          message: 'No active subscription to switch. Please resubscribe first.',
        });
      }

      try {
        // Some Stripe SDK versions may not have flow_data types yet; use a cast to avoid build-time issues.
        session = await (stripe.billingPortal.sessions.create as any)({
          customer: org.stripeCustomerId,
          return_url: `${frontendUrl}/store-settings?tab=billing&billing_portal_return=true`,
          flow_data: {
            type: 'subscription_update',
            subscription: org.stripeSubscriptionId,
          },
        });
      } catch (err) {
        // Fallback: if Stripe doesn't support starting in this flow, open portal home.
        request.log.warn({ err }, '[Billing] Portal switch_plan flow not supported; falling back to manage');
        session = await stripe.billingPortal.sessions.create({
          customer: org.stripeCustomerId,
          return_url: `${frontendUrl}/store-settings?tab=billing&billing_portal_return=true`,
        });
      }
    } else {
      session = await stripe.billingPortal.sessions.create({
        customer: org.stripeCustomerId,
        return_url: `${frontendUrl}/store-settings?tab=billing&billing_portal_return=true`,
      });
    }

    return reply.send({ url: session.url });
  },

  /**
   * POST /billing/verify-checkout
   *
   * Finalize billing after returning from Stripe Checkout.
   * This is a resilience path for cases where webhooks are delayed/misconfigured in the current environment.
   *
   * Security:
   * - Requires authenticated org context (from JWT)
   * - Requires checkout session metadata to match { organisationId, userId }
   */
  async verifyCheckout(
    request: FastifyRequest<{ Body: { sessionId: string } }>,
    reply: FastifyReply
  ) {
    try {
      if (!isStripeEnabled()) {
        return reply.code(503).send({
          message: 'Billing is temporarily unavailable. Please try again later.',
        });
      }

      const userId = request.authContext.userId;
      const orgId = request.authContext.organisationId;
      const sessionId = request.body?.sessionId ? String(request.body.sessionId) : '';

      if (!orgId) {
        return reply.code(400).send({ message: 'Organisation context required' });
      }
      if (!sessionId) {
        return reply.code(400).send({ message: 'sessionId is required' });
      }

      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId as any, {
        expand: ['subscription', 'customer'],
      } as any);

      const metaOrgId = session?.metadata?.organisationId ? String(session.metadata.organisationId) : null;
      const metaUserId = session?.metadata?.userId ? String(session.metadata.userId) : null;

      if (metaOrgId && metaOrgId !== String(orgId)) {
        return reply.code(403).send({ message: 'Checkout session does not belong to this organisation' });
      }
      if (metaUserId && metaUserId !== String(userId)) {
        return reply.code(403).send({ message: 'Checkout session does not belong to this user' });
      }

      // Stripe: for subscription mode, session.status becomes "complete".
      const status = (session as any)?.status ? String((session as any).status) : null;
      const mode = (session as any)?.mode ? String((session as any).mode) : null;

      if (mode !== 'subscription') {
        return reply.code(400).send({ message: 'Invalid checkout session mode' });
      }
      if (status && status !== 'complete') {
        return reply.code(409).send({ message: 'Checkout session is not complete yet' });
      }

      // Apply the same state mutations as webhooks (idempotent updates).
      await handleCheckoutSessionCompleted(session as any);

      const subscriptionObj = (session as any)?.subscription;
      const subscription =
        subscriptionObj && typeof subscriptionObj === 'object'
          ? subscriptionObj
          : subscriptionObj
            ? await (stripe.subscriptions as any).retrieve(String(subscriptionObj))
            : null;
      if (!subscription) {
        return reply.code(400).send({ message: 'Subscription missing on checkout session' });
      }

      await handleSubscriptionCreated(subscription as any);

      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, '[Billing] Failed to verify checkout session');
      const isProd = (process.env.APP_ENV || process.env.NODE_ENV) === 'production';
      const message =
        !isProd && err instanceof Error && err.message
          ? `Failed to verify checkout: ${err.message}`
          : 'Failed to verify checkout';
      return reply.code(500).send({ message });
    }
  },

  /**
   * POST /billing/sync-portal
   *
   * Resilience path: after returning from Stripe Customer Portal, fetch the current subscription
   * directly from Stripe and apply the same mutations as the webhook handler.
   *
   * This avoids relying on webhook timing for plan changes to reflect in the UI.
   */
  async syncPortal(
    request: FastifyRequest<{ Body?: { reason?: string } | null }>,
    reply: FastifyReply
  ) {
    try {
      if (!isStripeEnabled()) {
        return reply.code(503).send({
          message: 'Billing is temporarily unavailable. Please try again later.',
        });
      }

      const orgId = request.authContext.organisationId;
      if (!orgId) {
        return reply.code(400).send({ message: 'Organisation context required' });
      }

      const org = await prisma.organisation.findUnique({
        where: { id: orgId },
        select: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
        },
      });
      if (!org) {
        return reply.code(404).send({ message: 'Organisation not found' } as any);
      }
      if (!org.stripeCustomerId) {
        return reply.code(400).send({ message: 'No billing account found' });
      }
      if (!org.stripeSubscriptionId) {
        return reply.code(400).send({ message: 'No active subscription to sync' });
      }

      const stripe = getStripeClient();
      const subscription = await (stripe.subscriptions as any).retrieve(String(org.stripeSubscriptionId), {
        expand: ['items.data.price'],
      });

      await handleSubscriptionUpdated(subscription as any);

      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, '[Billing] Failed to sync portal subscription');
      const isProd = (process.env.APP_ENV || process.env.NODE_ENV) === 'production';
      const message =
        !isProd && err instanceof Error && err.message
          ? `Failed to sync portal: ${err.message}`
          : 'Failed to sync portal';
      return reply.code(500).send({ message });
    }
  },
};

