import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../../infrastructure/prismaClient';
import { PLAN_CATALOG, FEATURES_SHIPPED } from '../../config/plans';
import {
  AccessState,
  BillingInfo,
  EntitlementFlags,
  EntitlementOverrides,
  EntitlementOverridesSchema,
  EntitlementCaps,
  OrganisationEntitlements,
  PlanKey,
  BillingState,
} from './types';

type Db = PrismaClient | Prisma.TransactionClient;

type ResolveOptions = {
  cache?: Map<string, OrganisationEntitlements>;
  client?: Db;
};

type OrgRow = {
  id: string;
  planKey: string | null;
  billingState: string | null;
  seatLimit: number | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  graceEndsAt: Date | null;
  entitlementOverrides: Prisma.JsonValue | null;
  // Stripe billing fields
  stripeSubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionStatus: string | null;
};

function computeBillingInfo(org: OrgRow): BillingInfo {
  const state = (org.billingState as BillingState | null) ?? 'free';
  const now = new Date();

  // Derive accessState for gating (separate from raw billing state)
  let accessState: AccessState;
  
  if (state === 'past_due' && org.graceEndsAt) {
    // Past due: access during grace period only
    accessState = now < org.graceEndsAt ? 'active' : 'free';
  } else if (state === 'canceled') {
    // Canceled: access until period end, then free
    // This handles "cancel at period end" subscriptions gracefully
    if (org.currentPeriodEndsAt && now < org.currentPeriodEndsAt) {
      accessState = 'active';
    } else {
      accessState = 'free';
    }
  } else if (state === 'active' || state === 'trialing') {
    accessState = state;
  } else {
    accessState = 'free';
  }

  // Boolean helpers
  const isActiveForGating = accessState !== 'free';
  const isBillableActive = ['active', 'trialing', 'past_due'].includes(state);
  const hasSubscriptionForPortal =
    !!org.stripeSubscriptionId &&
    !!org.stripeSubscriptionStatus &&
    ['active', 'trialing', 'past_due', 'unpaid'].includes(org.stripeSubscriptionStatus);

  return {
    state,
    accessState,
    isActiveForGating,
    isBillableActive,
    hasSubscriptionForPortal,
    trialEndsAt: org.trialEndsAt,
    currentPeriodEndsAt: org.currentPeriodEndsAt,
    graceEndsAt: org.graceEndsAt,
    cancelAtPeriodEnd: org.cancelAtPeriodEnd,
    stripeSubscriptionStatus: org.stripeSubscriptionStatus,
  };
}

function applyCapOverrides(
  planCaps: EntitlementCaps,
  overrides: EntitlementOverrides,
  orgSeatLimit: number | null,
  planKey: string
) {
  // Only fallback to org.seatLimit if plan is 'legacy' (grandfathered)
  // This prevents default seatLimit (5) from overriding upgraded plans (e.g. Pro=25)
  const legacySeatLimit = planKey === 'legacy' ? orgSeatLimit : null;

  return {
    seatLimit: overrides.seatLimit ?? legacySeatLimit ?? planCaps.seatLimit,
    locationLimit: overrides.locationLimit ?? planCaps.locationLimit,
    inviteExpiryHours: planCaps.inviteExpiryHours,
  };
}

function applyFlagOverrides(planFlags: EntitlementFlags, overrides: EntitlementOverrides) {
  const merged: EntitlementFlags = { ...planFlags };

  // Apply boolean overrides to flags (never mutate planFlags)
  if (overrides.smsAlerts !== undefined) merged.smsAlerts = overrides.smsAlerts;
  if (overrides.autoApproval !== undefined) merged.autoApproval = overrides.autoApproval;

  // Apply shipped mask last
  const finalFlags = Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, value && FEATURES_SHIPPED[key as keyof EntitlementFlags]])
  ) as EntitlementFlags;

  return finalFlags;
}

async function loadOrganisation(organisationId: string, client: Db): Promise<OrgRow> {
  const org = await client.organisation.findUnique({
    where: { id: organisationId },
    select: {
      id: true,
      planKey: true,
      billingState: true,
      seatLimit: true,
      trialEndsAt: true,
      currentPeriodEndsAt: true,
      graceEndsAt: true,
      entitlementOverrides: true,
      // Stripe billing fields
      stripeSubscriptionId: true,
      cancelAtPeriodEnd: true,
      stripeSubscriptionStatus: true,
    },
  });

  if (!org) {
    throw { statusCode: 404, message: 'Organisation not found' };
  }

  return org;
}

export async function resolveOrganisationEntitlements(
  organisationId: string,
  options?: ResolveOptions
): Promise<OrganisationEntitlements> {
  // Request-scope cache
  if (options?.cache?.has(organisationId)) {
    return options.cache.get(organisationId)!;
  }

  const client = options?.client ?? prisma;
  const org = await loadOrganisation(organisationId, client);

  const planKey = (org.planKey as PlanKey | null) ?? 'free';

  // Parse overrides safely
  const parseResult = EntitlementOverridesSchema.safeParse(org.entitlementOverrides ?? {});
  let overrides: EntitlementOverrides = {};
  if (!parseResult.success) {
    // Log warning, but do not fail the request
    console.warn(`Invalid entitlementOverrides for org ${org.id}:`, parseResult.error.flatten());
  } else {
    overrides = parseResult.data;
  }

  // Billing info + derived access state
  const billing = computeBillingInfo(org);

  // Access plan: if the org is not active for gating, they should behave as Free,
  // but we still keep planKey unchanged for analytics.
  // Legacy is grandfathered (no Stripe required) so it must always receive legacy caps/flags.
  const accessPlanKey: PlanKey =
    planKey === 'legacy' ? 'legacy' : (billing.isActiveForGating ? planKey : 'free');
  const plan = PLAN_CATALOG[accessPlanKey] ?? PLAN_CATALOG['free'];

  // Caps: plan defaults -> JSONB overrides -> seatLimit legacy fallback -> shipped mask (not needed for caps)
  const caps = applyCapOverrides(plan.caps, overrides, org.seatLimit, accessPlanKey);

  // Flags: plan defaults -> boolean overrides -> shipped mask
  const flags = applyFlagOverrides(plan.flags, overrides);

  const entitlements: OrganisationEntitlements = {
    planKey,
    accessPlanKey,
    caps,
    flags,
    billing,
  };

  options?.cache?.set(organisationId, entitlements);
  return entitlements;
}

