import { PlanKey } from '../services/entitlements/types';

/**
 * Intro offer (discount semantics) for new organisations during signup.
 *
 * IMPORTANT:
 * - We apply discount server-side (never from the frontend).
 * - We only mark it as "used" via webhook after subscription is created (avoids burning on abandoned checkout).
 */

export const INTRO_OFFER_WINDOW_HOURS = 24;

// NOTE on "3 months free" across monthly vs annual:
// - Monthly subscriptions: discount semantics (100% off for 3 months, repeating)
// - Annual subscriptions: trial semantics (3-month trial; first annual invoice is charged after trial ends)
export type BillingInterval = 'monthly' | 'annual';

export const INTRO_OFFER_CODE_BY_PLAN: Partial<Record<PlanKey, string>> = {
  pro: 'EARLYPRO100',
  enterprise: 'EARLYPROMO100',
};

export const INTRO_OFFER_COUPON_ID_BY_PLAN_AND_INTERVAL: Partial<
  Record<PlanKey, Partial<Record<BillingInterval, string>>>
> = {
  // Live-mode coupons (monthly only):
  // - Pro monthly: 100% off repeating 3 months
  // - Pro annual: trial semantics (no coupon)
  pro: {
    monthly: '3cGcyPif',
  },
  // - Enterprise monthly: 100% off repeating 3 months
  // - Enterprise annual: trial semantics (no coupon)
  enterprise: {
    monthly: 'buclDIGA',
  },
};

export const INTRO_OFFER_ANNUAL_TRIAL_MONTHS = 3;

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) {
    d.setDate(0);
  }
  return d;
}

export function computeAnnualTrialEndFromNow(): number {
  const end = addMonths(new Date(), INTRO_OFFER_ANNUAL_TRIAL_MONTHS);
  // Stripe expects unix seconds
  return Math.floor(end.getTime() / 1000);
}

export function isIntroOfferEligible(org: {
  createdAt: Date;
  stripeSubscriptionId: string | null;
  hasUsedIntroOffer: boolean | null;
}): boolean {
  if (org.hasUsedIntroOffer) return false;
  if (org.stripeSubscriptionId) return false;
  const ageMs = Date.now() - new Date(org.createdAt).getTime();
  return ageMs >= 0 && ageMs <= INTRO_OFFER_WINDOW_HOURS * 60 * 60 * 1000;
}

/**
 * Prefer coupons (stable semantics) over promotion codes for auto-applied intro offers.
 * Promotion codes can unintentionally give a full free year when applied to annual invoices.
 */
export function getIntroOfferCouponId(
  planKey: PlanKey,
  interval: BillingInterval
): string | null {
  return INTRO_OFFER_COUPON_ID_BY_PLAN_AND_INTERVAL?.[planKey]?.[interval] ?? null;
}


