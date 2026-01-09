import { EntitlementCaps, EntitlementFlags, PlanKey } from '../services/entitlements/types';

/**
 * PLAN FLAG PHILOSOPHY:
 * 
 * Flags represent "desired entitlements when feature ships".
 * - true = this tier WILL have this feature when we ship it
 * - false = this tier will NOT have this feature (upgrade required)
 * 
 * FEATURES_SHIPPED mask controls what's actually available today.
 * Final entitlement = planFlag && FEATURES_SHIPPED[flag]
 * 
 * Example: pro.smsAlerts=true but FEATURES_SHIPPED.smsAlerts=false
 * → Pro users don't have SMS alerts YET, but will when we ship it.
 */

interface PlanDefinition {
  caps: EntitlementCaps;
  flags: EntitlementFlags;
}

export const PLAN_CATALOG: Record<PlanKey, PlanDefinition> = {
  free: {
    caps: { seatLimit: 1, locationLimit: 1, inviteExpiryHours: 168 },
    flags: {
      canInviteUsers: false,
      locationScopedAccess: true,
      prioritySupport: false,
      smsAlerts: false,
      autoApproval: false,
    },
  },
  legacy: {
    // Grandfathered plan (no Stripe required). Product decision: 5 seats.
    caps: { seatLimit: 5, locationLimit: 5, inviteExpiryHours: 168 },
    flags: {
      canInviteUsers: true,
      locationScopedAccess: true,
      prioritySupport: false,
      smsAlerts: false,
      autoApproval: true,
    },
  },
  pro: {
    caps: { seatLimit: 5, locationLimit: 3, inviteExpiryHours: 168 },
    flags: {
      canInviteUsers: true,
      locationScopedAccess: true,
      prioritySupport: true,
      smsAlerts: true,
      autoApproval: true,
    },
  },
  enterprise: {
    caps: { seatLimit: 20, locationLimit: 10, inviteExpiryHours: 168 },
    flags: {
      canInviteUsers: true,
      locationScopedAccess: true,
      prioritySupport: true,
      smsAlerts: true,
      autoApproval: true,
    },
  },
};

// Features that are actually shipped and available
export const FEATURES_SHIPPED: Record<keyof EntitlementFlags, boolean> = {
  canInviteUsers: true,       // Shipped
  locationScopedAccess: true, // Shipped
  prioritySupport: false,     // Not shipped yet
  smsAlerts: false,           // Not shipped yet
  autoApproval: true,         // Shipped
};

// User-facing labels (hides internal keys like "legacy")
export const PLAN_LABELS: Record<PlanKey, string> = {
  free: 'Free',
  legacy: 'Free',        // Don't expose "legacy" to users
  pro: 'Pro',
  enterprise: 'Enterprise',
};

// Freeze catalog objects to prevent accidental mutation (dev/test safety)
if (process.env.NODE_ENV !== 'production') {
  Object.values(PLAN_CATALOG).forEach(plan => Object.freeze(plan));
  Object.freeze(PLAN_CATALOG);
  Object.freeze(FEATURES_SHIPPED);
}
