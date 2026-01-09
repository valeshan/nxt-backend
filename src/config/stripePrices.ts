import { PlanKey } from '../services/entitlements/types';

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
export const STRIPE_PRICE_MAP: Record<string, StripePriceMapping> = {
  // Pro Plan (prod_TknhRLoS2CPN4M)
  'price_1SnHnYBgfRwYQPYyRCIre9R0': { planKey: 'pro', interval: 'monthly' },
  'price_1SnHnYBgfRwYQPYyzwq2J8MI': { planKey: 'pro', interval: 'annual' },
  
  // Enterprise Plan (prod_TknhRLoS2CPN4M)
  'price_1SnI6YBgfRwYQPYydJqTGWL1': { planKey: 'enterprise', interval: 'monthly' },
  'price_1SnI6YBgfRwYQPYy0vLKuARb': { planKey: 'enterprise', interval: 'annual' },
};

/**
 * Reverse lookup: planKey + interval → priceId
 * 
 * Used by checkout endpoint to get the correct Stripe price for a given plan selection.
 */
export const PLAN_TO_PRICE: Record<string, string> = {
  'pro:monthly': 'price_1SnHnYBgfRwYQPYyRCIre9R0',
  'pro:annual': 'price_1SnHnYBgfRwYQPYyzwq2J8MI',
  'enterprise:monthly': 'price_1SnI6YBgfRwYQPYydJqTGWL1',
  'enterprise:annual': 'price_1SnI6YBgfRwYQPYy0vLKuARb',
};

/**
 * Get price ID for a plan + interval combination
 */
export function getPriceId(planKey: PlanKey, interval: BillingInterval): string | null {
  const key = `${planKey}:${interval}`;
  return PLAN_TO_PRICE[key] ?? null;
}

/**
 * Get plan mapping from a Stripe price ID
 */
export function getPlanFromPriceId(priceId: string): StripePriceMapping | null {
  return STRIPE_PRICE_MAP[priceId] ?? null;
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

