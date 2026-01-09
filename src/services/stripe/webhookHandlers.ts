import prisma from '../../infrastructure/prismaClient';
import { getPlanFromPriceId } from '../../config/stripePrices';
import { getStripeClient } from './stripeService';

// Use 'any' types for Stripe objects since webhook payloads can vary by API version
// and we want to be resilient to type changes
/* eslint-disable @typescript-eslint/no-explicit-any */
type StripeSubscription = any;
type StripeCheckoutSession = any;
type StripeInvoice = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Grace period duration in days after payment failure
 */
const GRACE_PERIOD_DAYS = 7;

/**
 * Calculate grace end date (7 days from now)
 */
function calculateGraceEndDate(): Date {
  const graceEnd = new Date();
  graceEnd.setDate(graceEnd.getDate() + GRACE_PERIOD_DAYS);
  return graceEnd;
}

/**
 * Extract organisation ID from Stripe object metadata
 */
function getOrgIdFromMetadata(obj: { metadata?: Record<string, string> | null }): string | null {
  return obj.metadata?.organisationId ?? null;
}

/**
 * Resolve organisationId for a subscription event.
 * Prefer metadata (fast + explicit). Fallback to DB lookup by stripeSubscriptionId
 * because Stripe portal updates can sometimes omit metadata.
 */
async function resolveOrgIdForSubscription(subscription: StripeSubscription): Promise<string | null> {
  const fromMeta = getOrgIdFromMetadata(subscription);
  if (fromMeta) return fromMeta;

  const subscriptionId = subscription?.id ? String(subscription.id) : null;
  if (!subscriptionId) return null;

  const org = await prisma.organisation.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    select: { id: true },
  });

  return org?.id ?? null;
}

/**
 * Get current period end from subscription
 * Handles both old and new Stripe API versions where the field may be at
 * subscription level or item level
 */
function getCurrentPeriodEnd(subscription: StripeSubscription): Date | null {
  // Try subscription level first (older API versions)
  if (subscription.current_period_end && typeof subscription.current_period_end === 'number') {
    return new Date(subscription.current_period_end * 1000);
  }
  
  // Try item level (newer API versions like 2025-07-30.basil)
  const item = subscription.items?.data?.[0];
  if (item?.current_period_end && typeof item.current_period_end === 'number') {
    return new Date(item.current_period_end * 1000);
  }
  
  // Fallback: calculate from billing_cycle_anchor + 1 month if available
  if (subscription.billing_cycle_anchor && typeof subscription.billing_cycle_anchor === 'number') {
    const anchor = new Date(subscription.billing_cycle_anchor * 1000);
    anchor.setMonth(anchor.getMonth() + 1);
    return anchor;
  }
  
  return null;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // If month roll-over clipped the date (e.g., Jan 31 -> Mar 03), normalize to last day of previous month.
  if (d.getDate() < day) {
    d.setDate(0);
  }
  return d;
}

function getFreeUntilFromSubscription(subscription: StripeSubscription): Date | null {
  // True Stripe trials
  if (typeof subscription?.trial_end === 'number') {
    const d = new Date(subscription.trial_end * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Discount semantics — Stripe has shipped both `discount` (singular) and `discounts` (list) shapes over time.
  const singularEnd = subscription?.discount?.end;
  if (typeof singularEnd === 'number') {
    const d = new Date(singularEnd * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const discountsList = subscription?.discounts?.data ?? subscription?.discounts;
  const first = Array.isArray(discountsList) ? discountsList[0] : null;
  const listEnd = first?.end;
  if (typeof listEnd === 'number') {
    const d = new Date(listEnd * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Handle checkout.session.completed
 * 
 * Called when a customer completes Stripe Checkout.
 * Sets up initial subscription fields.
 */
export async function handleCheckoutSessionCompleted(
  session: StripeCheckoutSession
): Promise<void> {
  const orgId = getOrgIdFromMetadata(session);
  if (!orgId) {
    console.warn('[Stripe Webhook] checkout.session.completed missing organisationId in metadata');
    return;
  }

  const subscriptionId = session.subscription as string | null;
  const customerId = session.customer as string | null;

  if (!subscriptionId || !customerId) {
    console.warn('[Stripe Webhook] checkout.session.completed missing subscription or customer');
    return;
  }

  // Store the Stripe IDs
  // Note: Full subscription details will come from customer.subscription.created event
  await prisma.organisation.update({
    where: { id: orgId },
    data: {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    },
  });

  // Best-effort: fetch the subscription so we can persist "free until" for discount-based intro offers.
  // This avoids UX gaps when Stripe doesn't send trial_end (promo codes keep status=active).
  try {
    const stripe = getStripeClient();
    const sub = await (stripe.subscriptions as any).retrieve(subscriptionId, { expand: ['discount', 'discounts'] });
    let freeUntil = getFreeUntilFromSubscription(sub);

    // If Stripe does not include a discount window, but we know this was an intro offer,
    // fall back to "3 months from start" for UX messaging.
    // (Only applied when introOfferCode is present to avoid guessing for non-offer subs.)
    if (!freeUntil) {
      const introOfferCode =
        sub?.metadata?.introOfferCode && typeof sub.metadata.introOfferCode === 'string'
          ? String(sub.metadata.introOfferCode)
          : null;

      if (introOfferCode) {
        const startSeconds =
          typeof sub?.start_date === 'number'
            ? sub.start_date
            : typeof sub?.current_period_start === 'number'
              ? sub.current_period_start
              : null;
        if (startSeconds) {
          const start = new Date(startSeconds * 1000);
          if (!Number.isNaN(start.getTime())) {
            freeUntil = addMonths(start, 3);
          }
        }
      }

      if (!freeUntil) {
        console.warn('[Stripe Webhook] checkout.session.completed could not derive freeUntil from subscription', {
          subscriptionId,
          hasTrialEnd: typeof sub?.trial_end === 'number',
          hasDiscount: !!sub?.discount,
          discountsCount: Array.isArray(sub?.discounts?.data)
            ? sub.discounts.data.length
            : Array.isArray(sub?.discounts)
              ? sub.discounts.length
              : null,
          hasIntroOfferCode: !!sub?.metadata?.introOfferCode,
        });
      }
    }

    if (freeUntil) {
      const org = await prisma.organisation.findUnique({
        where: { id: orgId },
        select: { trialEndsAt: true },
      });
      const shouldUpdate =
        !org?.trialEndsAt || (org.trialEndsAt.getTime() < freeUntil.getTime());
      if (shouldUpdate) {
        await prisma.organisation.update({
          where: { id: orgId },
          data: { trialEndsAt: freeUntil },
        });
      }
    }
  } catch (err) {
    console.warn('[Stripe Webhook] checkout.session.completed failed to retrieve subscription details', err);
  }

  console.log(`[Stripe Webhook] checkout.session.completed: org=${orgId}, subscription=${subscriptionId}`);
}

/**
 * Handle customer.subscription.created
 * 
 * Called when a subscription is first created.
 * Sets planKey, billing state, and period end.
 */
export async function handleSubscriptionCreated(
  subscription: StripeSubscription
): Promise<void> {
  const orgId = await resolveOrgIdForSubscription(subscription);
  if (!orgId) {
    console.warn('[Stripe Webhook] subscription.created could not resolve organisationId');
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  const planMapping = priceId ? getPlanFromPriceId(priceId) : null;
  const planKey = planMapping?.planKey ?? 'pro'; // Default to pro if unknown

  const status = subscription.status; // active, trialing, past_due, etc.
  const currentPeriodEnd = getCurrentPeriodEnd(subscription);
  let freeUntil = getFreeUntilFromSubscription(subscription);

  // If checkout applied an intro offer, we stamp it into subscription metadata.
  // We only burn the flag once a real subscription exists (avoids abandoned checkout burning the offer).
  const introOfferCode =
    subscription?.metadata?.introOfferCode && typeof subscription.metadata.introOfferCode === 'string'
      ? String(subscription.metadata.introOfferCode)
      : null;

  // Fallback: if we know it was an intro offer but Stripe didn't include a discount window,
  // treat it as "3 months free from start" for UX messaging.
  if (!freeUntil && introOfferCode) {
    const startSeconds =
      typeof subscription?.start_date === 'number'
        ? subscription.start_date
        : typeof subscription?.current_period_start === 'number'
          ? subscription.current_period_start
          : null;
    if (startSeconds) {
      const start = new Date(startSeconds * 1000);
      if (!Number.isNaN(start.getTime())) {
        freeUntil = addMonths(start, 3);
      }
    }
  }

  await prisma.organisation.update({
    where: { id: orgId },
    data: {
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId ?? null,
      stripeSubscriptionStatus: status,
      planKey: planKey,
      billingState: status === 'trialing' ? 'trialing' : 'active',
      currentPeriodEndsAt: currentPeriodEnd,
      trialEndsAt: freeUntil,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      graceEndsAt: null, // Clear any previous grace period
      ...(introOfferCode ? { hasUsedIntroOffer: true } : {}),
    },
  });

  console.log(`[Stripe Webhook] subscription.created: org=${orgId}, plan=${planKey}, status=${status}, periodEnd=${currentPeriodEnd?.toISOString()}`);
}

/**
 * Handle customer.subscription.updated
 * 
 * Called when subscription is modified (plan change, cancellation scheduled, etc.)
 * Updates planKey if price changed, and cancelAtPeriodEnd.
 */
export async function handleSubscriptionUpdated(
  subscription: StripeSubscription
): Promise<void> {
  const orgId = await resolveOrgIdForSubscription(subscription);
  if (!orgId) {
    console.warn('[Stripe Webhook] subscription.updated could not resolve organisationId');
    return;
  }

  // Guard against stacked subscriptions: do not let an "old" subscription overwrite the org.
  if (subscription?.id) {
    const org = await prisma.organisation.findUnique({
      where: { id: orgId },
      select: { stripeSubscriptionId: true },
    });
    if (org?.stripeSubscriptionId && org.stripeSubscriptionId !== String(subscription.id)) {
      console.warn(
        `[Stripe Webhook] subscription.updated ignored for non-current subscription. org=${orgId}, current=${org.stripeSubscriptionId}, got=${subscription.id}`
      );
      return;
    }
  }

  const priceId = subscription.items.data[0]?.price?.id;
  const planMapping = priceId ? getPlanFromPriceId(priceId) : null;
  const status = subscription.status;
  const currentPeriodEnd = getCurrentPeriodEnd(subscription);

  // Keep "free until" up to date for discount-based intro offers.
  let freeUntil = getFreeUntilFromSubscription(subscription);
  const introOfferCode =
    subscription?.metadata?.introOfferCode && typeof subscription.metadata.introOfferCode === 'string'
      ? String(subscription.metadata.introOfferCode)
      : null;
  if (!freeUntil && introOfferCode) {
    const startSeconds =
      typeof subscription?.start_date === 'number'
        ? subscription.start_date
        : typeof subscription?.current_period_start === 'number'
          ? subscription.current_period_start
          : null;
    if (startSeconds) {
      const start = new Date(startSeconds * 1000);
      if (!Number.isNaN(start.getTime())) {
        freeUntil = addMonths(start, 3);
      }
    }
  }

  // Stripe cancellation semantics:
  // - cancel_at_period_end=true => will cancel at the end of the current period (status often stays active)
  // - cancel_at=<timestamp>     => will cancel at a specific time (can also keep status active)
  // - status='canceled'         => already canceled
  const cancelAt =
    typeof subscription.cancel_at === 'number' ? new Date(subscription.cancel_at * 1000) : null;
  const isCancelScheduled =
    (subscription.cancel_at_period_end ?? false) ||
    (cancelAt ? cancelAt.getTime() > Date.now() : false);

  const updateData: Record<string, unknown> = {
    stripeSubscriptionStatus: status,
    currentPeriodEndsAt: currentPeriodEnd,
    // We use this flag as "will cancel" for UX.
    // (Stripe can schedule cancellation via cancel_at even when cancel_at_period_end is false.)
    cancelAtPeriodEnd: isCancelScheduled,
    ...(freeUntil ? { trialEndsAt: freeUntil } : {}),
  };

  // Update planKey if price changed
  if (planMapping) {
    updateData.planKey = planMapping.planKey;
    updateData.stripePriceId = priceId;
  }

  // Update billing state based on subscription status
  if (status === 'active') {
    updateData.billingState = 'active';
    updateData.graceEndsAt = null;
  } else if (status === 'trialing') {
    updateData.billingState = 'trialing';
  } else if (status === 'past_due') {
    updateData.billingState = 'past_due';
    // Grace period is set by invoice.payment_failed
  } else if (status === 'canceled') {
    /**
     * IMPORTANT:
     * Stripe Customer Portal "Cancel subscription" can either:
     * - cancel at period end (cancel_at_period_end=true, status often remains active until end), OR
     * - cancel immediately (cancel_at_period_end=false, status becomes canceled immediately)
     *
     * In both cases, we want the app to reflect cancellation correctly.
     */
    updateData.billingState = 'canceled';
    updateData.graceEndsAt = null;
  } else if (status === 'unpaid') {
    // Treat unpaid similarly to past_due (no new grace here; invoice.payment_failed sets grace)
    updateData.billingState = 'past_due';
  }

  await prisma.organisation.update({
    where: { id: orgId },
    data: updateData,
  });

  console.log(
    `[Stripe Webhook] subscription.updated: org=${orgId}, status=${status}, willCancel=${isCancelScheduled}, cancelAt=${cancelAt?.toISOString()}`
  );
}

/**
 * Handle customer.subscription.deleted
 * 
 * Called when subscription is fully canceled/deleted.
 * Sets billingState=canceled but KEEPS planKey unchanged.
 */
export async function handleSubscriptionDeleted(
  subscription: StripeSubscription
): Promise<void> {
  const orgId = await resolveOrgIdForSubscription(subscription);
  if (!orgId) {
    console.warn('[Stripe Webhook] subscription.deleted missing organisationId in metadata');
    return;
  }

  // Guard against stacked subscriptions: only clear the subscription if it's the current one.
  if (subscription?.id) {
    const org = await prisma.organisation.findUnique({
      where: { id: orgId },
      select: { stripeSubscriptionId: true },
    });
    if (org?.stripeSubscriptionId && org.stripeSubscriptionId !== String(subscription.id)) {
      console.warn(
        `[Stripe Webhook] subscription.deleted ignored for non-current subscription. org=${orgId}, current=${org.stripeSubscriptionId}, got=${subscription.id}`
      );
      return;
    }
  }

  // Store the period end so access continues until then
  const currentPeriodEnd = getCurrentPeriodEnd(subscription);

  await prisma.organisation.update({
    where: { id: orgId },
    data: {
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: 'canceled',
      billingState: 'canceled',
      currentPeriodEndsAt: currentPeriodEnd,
      cancelAtPeriodEnd: false,
      graceEndsAt: null,
      // IMPORTANT: Do NOT change planKey - preserves "what plan they chose" for analytics/winbacks
    },
  });

  console.log(`[Stripe Webhook] subscription.deleted: org=${orgId}, access until=${currentPeriodEnd?.toISOString()}`);
}

/**
 * Handle invoice.payment_succeeded
 * 
 * Called when a payment succeeds.
 * Sets billingState=active and clears grace period.
 */
export async function handleInvoicePaymentSucceeded(
  invoice: StripeInvoice
): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) {
    // One-time payment, not a subscription invoice
    return;
  }

  // Find org by subscription ID
  const org = await prisma.organisation.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
  });

  if (!org) {
    console.warn(`[Stripe Webhook] invoice.payment_succeeded: no org found for subscription=${subscriptionId}`);
    return;
  }

  await prisma.organisation.update({
    where: { id: org.id },
    data: {
      billingState: 'active',
      graceEndsAt: null,
    },
  });

  console.log(`[Stripe Webhook] invoice.payment_succeeded: org=${org.id}`);
}

/**
 * Handle invoice.payment_failed
 * 
 * Called when a payment fails.
 * Sets billingState=past_due and starts grace period.
 */
export async function handleInvoicePaymentFailed(
  invoice: StripeInvoice
): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) {
    return;
  }

  // Find org by subscription ID
  const org = await prisma.organisation.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
  });

  if (!org) {
    console.warn(`[Stripe Webhook] invoice.payment_failed: no org found for subscription=${subscriptionId}`);
    return;
  }

  const graceEndsAt = calculateGraceEndDate();

  await prisma.organisation.update({
    where: { id: org.id },
    data: {
      billingState: 'past_due',
      graceEndsAt: graceEndsAt,
    },
  });

  console.log(`[Stripe Webhook] invoice.payment_failed: org=${org.id}, grace until=${graceEndsAt.toISOString()}`);
}

