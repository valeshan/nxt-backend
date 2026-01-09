import { PlanKey } from '../services/entitlements/types';
import { getStripeKeyMode } from '../services/stripe/stripeService';

export type BillingInterval = 'monthly' | 'annual';

export interface StripePriceMapping {
  planKey: PlanKey;
  interval: BillingInterval;
}

/**
 * Stripe Price ID → Internal Plan Mapping
 * 
 * This is the single source of truth for mapping Stripe prices to our plan system.
 * Used by webhook handlers to determine which plan a subscription corresponds to.
 */
const STRIPE_PRICE_MAP_TEST: Record<string, StripePriceMapping> = {
  // Pro (TEST)
  'price_1SnHnYBgfRwYQPYyRCIre9R0': { planKey: 'pro', interval: 'monthly' },
  'price_1SnHnYBgfRwYQPYyzwq2J8MI': { planKey: 'pro', interval: 'annual' },

  // Enterprise (TEST)
  'price_1SnI6YBgfRwYQPYydJqTGWL1': { planKey: 'enterprise', interval: 'monthly' },
  'price_1SnI6YBgfRwYQPYy0vLKuARb': { planKey: 'enterprise', interval: 'annual' },
};

const STRIPE_PRICE_MAP_LIVE: Record<string, StripePriceMapping> = {
  // Pro (LIVE)
  'price_1SnYvuBgqAKq7gmRcJ851wAS': { planKey: 'pro', interval: 'monthly' },
  'price_1SnYvuBgqAKq7gmREOfVZJf6': { planKey: 'pro', interval: 'annual' },

  // Enterprise (LIVE)
  'price_1SnYvqBgqAKq7gmR4Sklfdx0': { planKey: 'enterprise', interval: 'monthly' },
  'price_1SnYvqBgqAKq7gmR0xQCxC0X': { planKey: 'enterprise', interval: 'annual' },
};

/**
 * Reverse lookup: planKey + interval → priceId
 * 
 * Used by checkout endpoint to get the correct Stripe price for a given plan selection.
 */
const PLAN_TO_PRICE_TEST: Record<string, string> = {
  'pro:monthly': 'price_1SnHnYBgfRwYQPYyRCIre9R0',
  'pro:annual': 'price_1SnHnYBgfRwYQPYyzwq2J8MI',
  'enterprise:monthly': 'price_1SnI6YBgfRwYQPYydJqTGWL1',
  'enterprise:annual': 'price_1SnI6YBgfRwYQPYy0vLKuARb',
};

const PLAN_TO_PRICE_LIVE: Record<string, string> = {
  'pro:monthly': 'price_1SnYvuBgqAKq7gmRcJ851wAS',
  'pro:annual': 'price_1SnYvuBgqAKq7gmREOfVZJf6',
  'enterprise:monthly': 'price_1SnYvqBgqAKq7gmR4Sklfdx0',
  'enterprise:annual': 'price_1SnYvqBgqAKq7gmR0xQCxC0X',
};

function getActivePlanToPrice(): Record<string, string> {
  const mode = getStripeKeyMode();
  if (mode === 'live') return PLAN_TO_PRICE_LIVE;
  // Default to test to keep local/dev working when configured.
  return PLAN_TO_PRICE_TEST;
}

function getActivePriceMap(): Record<string, StripePriceMapping> {
  const mode = getStripeKeyMode();
  if (mode === 'live') return STRIPE_PRICE_MAP_LIVE;
  return STRIPE_PRICE_MAP_TEST;
}

/**
 * Get price ID for a plan + interval combination
 */
export function getPriceId(planKey: PlanKey, interval: BillingInterval): string | null {
  const key = `${planKey}:${interval}`;
  return getActivePlanToPrice()[key] ?? null;
}

/**
 * Get plan mapping from a Stripe price ID
 */
export function getPlanFromPriceId(priceId: string): StripePriceMapping | null {
  return getActivePriceMap()[priceId] ?? null;
}

/**
 * Valid plan keys that can be purchased (excludes 'free' and 'legacy')
 */
export const PURCHASABLE_PLANS: PlanKey[] = ['pro', 'enterprise'];

/**
 * Check if a plan key is purchasable
 */
export function isPurchasablePlan(planKey: string): planKey is PlanKey {
  return PURCHASABLE_PLANS.includes(planKey as PlanKey);
}

