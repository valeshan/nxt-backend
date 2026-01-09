import { z } from 'zod';

export type PlanKey = 'free' | 'legacy' | 'pro' | 'enterprise';

// BillingState = what Stripe reports (will grow: incomplete, unpaid, etc.)
export type BillingState = 'free' | 'trialing' | 'active' | 'past_due' | 'canceled';

// AccessState = what gating logic uses (derived from BillingState + grace period)
export type AccessState = 'free' | 'trialing' | 'active';

export interface EntitlementCaps {
  seatLimit: number;
  locationLimit: number | null; // null = unlimited
  inviteExpiryHours: number;
}

export interface EntitlementFlags {
  canInviteUsers: boolean;
  locationScopedAccess: boolean;
  prioritySupport: boolean;
  smsAlerts: boolean;
  autoApproval: boolean;
}

export interface BillingInfo {
  state: BillingState; // Raw billing state from DB/Stripe
  accessState: AccessState; // Derived state for gating (after grace period logic)
  isActiveForGating: boolean; // accessState !== 'free' (helper to avoid scattered comparisons)
  isBillableActive: boolean; // true if should be billed (for Stripe later)
  hasSubscriptionForPortal: boolean; // true if Stripe Portal can modify an existing subscription
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  graceEndsAt: Date | null;
  // Stripe-specific fields
  cancelAtPeriodEnd: boolean; // True if subscription is set to cancel at period end
  stripeSubscriptionStatus: string | null; // Raw Stripe status for debugging/support
}

export interface EntitlementUsage {
  seatCount: number; // Active members
  pendingInvites: number; // Active pending invites
  seatReservedCount: number; // seatCount + pendingInvites (single source of truth)
  locationCount: number;
}

export interface OrganisationEntitlements {
  // planKey = the plan the organisation chose (analytics / winbacks)
  planKey: PlanKey;
  // accessPlanKey = the plan that should be enforced for caps/flags right now
  // (derived from billing.accessState; e.g. canceled immediate => free)
  accessPlanKey: PlanKey;
  caps: EntitlementCaps;
  flags: EntitlementFlags;
  billing: BillingInfo;
}

export interface EntitlementsWithUsage extends OrganisationEntitlements {
  usage: EntitlementUsage;
}

// Schema for runtime validation
// .strip() removes unknown keys from output (Zod default keeps them)
export const EntitlementOverridesSchema = z
  .object({
    // Cap overrides
    seatLimit: z.number().int().positive().optional(),
    locationLimit: z.number().int().positive().nullable().optional(),
    // Future boolean add-ons (same JSONB, no new migrations)
    smsAlerts: z.boolean().optional(),
    autoApproval: z.boolean().optional(),
  })
  .strip(); // Removes unknown keys from parsed output

/**
 * OVERRIDE APPLICATION ORDER (in resolver):
 *
 * CAPS:
 * 1. Start with plan catalog caps (seatLimit, locationLimit, inviteExpiryHours)
 * 2. Apply cap overrides from JSONB (seatLimit, locationLimit)
 *
 * FLAGS:
 * 1. Start with plan catalog flags (canInviteUsers, smsAlerts, etc.)
 * 2. Apply boolean overrides from JSONB to FLAGS (not caps!)
 * 3. Apply FEATURES_SHIPPED mask LAST: finalFlag = flag && FEATURES_SHIPPED[flag]
 *
 * IMPORTANT: Never mutate the catalog object - always create new objects.
 * This means: override.smsAlerts=true still can't bypass FEATURES_SHIPPED.smsAlerts=false
 * You can "sell" an add-on before shipping by setting override, but it won't activate until shipped.
 */
export type EntitlementOverrides = z.infer<typeof EntitlementOverridesSchema>;

