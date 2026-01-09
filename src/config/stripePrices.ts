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
  // Pro Plan (LIVE)
  'price_1SnYvuBgqAKq7gmRcJ851wAS': { planKey: 'pro', interval: 'monthly' },
  'price_1SnYvuBgqAKq7gmREOfVZJf6': { planKey: 'pro', interval: 'annual' },
  
  // Enterprise Plan (LIVE)
  'price_1SnYvqBgqAKq7gmR4Sklfdx0': { planKey: 'enterprise', interval: 'monthly' },
  'price_1SnYvqBgqAKq7gmR0xQCxC0X': { planKey: 'enterprise', interval: 'annual' },
};

/**
 * Reverse lookup: planKey + interval → priceId
 * 
 * Used by checkout endpoint to get the correct Stripe price for a given plan selection.
 */
export const PLAN_TO_PRICE: Record<string, string> = {
  'pro:monthly': 'price_1SnYvuBgqAKq7gmRcJ851wAS',
  'pro:annual': 'price_1SnYvuBgqAKq7gmREOfVZJf6',
  'enterprise:monthly': 'price_1SnYvqBgqAKq7gmR4Sklfdx0',
  'enterprise:annual': 'price_1SnYvqBgqAKq7gmR0xQCxC0X',
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

