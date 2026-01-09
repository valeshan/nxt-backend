import { EntitlementFlags, OrganisationEntitlements } from '../services/entitlements/types';
import { resolveOrganisationEntitlements } from '../services/entitlements/resolveOrganisationEntitlements';

export async function requireFlag(
  organisationId: string, 
  flag: keyof EntitlementFlags,
  cache?: Map<string, OrganisationEntitlements>
): Promise<void> {
  const entitlements = await resolveOrganisationEntitlements(organisationId, { cache });
  if (!entitlements.flags[flag]) {
    throw { statusCode: 403, code: 'FEATURE_DISABLED', message: `Feature '${flag}' is not available on this plan` };
  }
}

// Error code + message mapping (avoids ugly "seatLimit limit reached")
const CAP_ERRORS: Record<'seatLimit' | 'locationLimit', { code: string; message: string }> = {
  seatLimit: { code: 'SEAT_LIMIT_REACHED', message: 'Seat limit reached' },
  locationLimit: { code: 'LOCATION_LIMIT_REACHED', message: 'Location limit reached' },
};

export async function requireCap(
  organisationId: string,
  cap: 'seatLimit' | 'locationLimit',
  currentUsage: number,
  cache?: Map<string, OrganisationEntitlements>
): Promise<void> {
  const entitlements = await resolveOrganisationEntitlements(organisationId, { cache });
  const limit = entitlements.caps[cap];
  
  // null = unlimited, skip check
  if (limit === null) return;
  
  if (currentUsage >= limit) {
    const { code, message } = CAP_ERRORS[cap];
    throw { statusCode: 400, code, message };
  }
}
