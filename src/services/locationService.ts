import { locationRepository } from '../repositories/locationRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import prisma from '../infrastructure/prismaClient';
import { resolveOrganisationEntitlements } from './entitlements/resolveOrganisationEntitlements';

export const locationService = {
  async createLocation(userId: string, organisationId: string, name: string) {
    // Verify user is admin/owner of org
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw { statusCode: 403, message: 'Insufficient permissions' };
    }

    // Enforce plan/location limits
    const entitlements = await resolveOrganisationEntitlements(organisationId);
    if (entitlements.caps.locationLimit !== null) {
      const currentCount = await prisma.location.count({ where: { organisationId } });
      if (currentCount >= entitlements.caps.locationLimit) {
        throw {
          statusCode: 400,
          code: 'LOCATION_LIMIT_REACHED',
          message: `Location limit reached (${currentCount}/${entitlements.caps.locationLimit}). Upgrade your plan to add more locations.`,
        };
      }
    }

    const location = await locationRepository.createLocation({
      name,
      organisation: { connect: { id: organisationId } }
    });

    // New locations start with no integrations
    return {
      ...location,
      integrations: [] as Array<{ type: string; name: string; status: string }>,
    };
  },

  async getLocationIntegrations(locationIds: string[]) {
    if (!locationIds.length) return {};

    const xeroLinks = await prisma.xeroLocationLink.findMany({
      where: { locationId: { in: locationIds } },
      select: { locationId: true }
    });

    const map: Record<string, Array<{ type: string; name: string; status: string }>> = {};

    // Initialize empty arrays
    locationIds.forEach(id => { map[id] = []; });

    // Populate Xero links
    xeroLinks.forEach(link => {
      if (map[link.locationId]) {
        map[link.locationId].push({
          type: 'xero',
          name: 'Xero',
          status: 'connected'
        });
      }
    });

    return map;
  },

  async listForOrganisation(userId: string, organisationId: string) {
    // Check read access (member is enough)
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership) {
      throw { statusCode: 403, message: 'Not a member' };
    }

    // Location-level access (soft enforcement):
    // If user has any scoped rows, restrict to those; otherwise return all (legacy).
    const accessRows = await prisma.userLocationAccess.findMany({
      where: { userId, organisationId },
      select: { locationId: true },
    });

    const scopedLocationIds = accessRows.map((a) => a.locationId);
    const locations = scopedLocationIds.length > 0
      ? await locationRepository.listForOrganisation(organisationId).then((all) =>
          all.filter((loc) => scopedLocationIds.includes(loc.id))
        )
      : await locationRepository.listForOrganisation(organisationId);

    const locationIds = locations.map(l => l.id);
    const integrationsMap = await this.getLocationIntegrations(locationIds);

    return locations.map(loc => ({
      ...loc,
      forwardingStatus: loc.forwardingStatus, // Already on model
      integrations: integrationsMap[loc.id] || []
    }));
  },

  async updateLocation(userId: string, locationId: string, data: { name?: string; industry?: string | null; region?: string | null; autoApproveCleanInvoices?: boolean }) {
    const location = await locationRepository.findById(locationId);
    if (!location) throw { statusCode: 404, message: 'Location not found' };

    // Verify permissions for the organisation this location belongs to
    const membership = await userOrganisationRepository.findMembership(userId, location.organisationId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw { statusCode: 403, message: 'Insufficient permissions' };
    }

    // Enforce plan restrictions: Free plan cannot enable auto-approve
    if (data.autoApproveCleanInvoices === true) {
      const entitlements = await resolveOrganisationEntitlements(location.organisationId);
      if (entitlements.planKey === 'free') {
        throw {
          statusCode: 403,
          code: 'FEATURE_DISABLED',
          message: 'Auto-review is not available on the Free plan. Upgrade to Pro to enable it.',
        };
      }
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.industry !== undefined) updateData.industry = data.industry;
    if (data.region !== undefined) updateData.region = data.region ? data.region.trim() : null;
    if (data.autoApproveCleanInvoices !== undefined) updateData.autoApproveCleanInvoices = data.autoApproveCleanInvoices;

    return locationRepository.update(locationId, updateData);
  },

  async handleAutoApprovePrompt(
    userId: string, 
    locationId: string, 
    enable: boolean
  ) {
    const location = await locationRepository.findById(locationId);
    if (!location) throw { statusCode: 404, message: 'Location not found' };

    // Verify permissions
    const membership = await userOrganisationRepository.findMembership(userId, location.organisationId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw { statusCode: 403, message: 'Insufficient permissions' };
    }

    // Enforce plan restrictions: Free plan cannot enable auto-approve
    if (enable === true) {
      const entitlements = await resolveOrganisationEntitlements(location.organisationId);
      if (entitlements.planKey === 'free') {
        throw {
          statusCode: 403,
          code: 'FEATURE_DISABLED',
          message: 'Auto-review is not available on the Free plan. Upgrade to Pro to enable it.',
        };
      }
    }

    const updateData: any = {
      hasSeenAutoApprovePrompt: true,  // Always set to true
    };
    
    if (enable) {
      updateData.autoApproveCleanInvoices = true;
    } else {
      // "Keep off for now" - explicitly set to false
      updateData.autoApproveCleanInvoices = false;
    }

    const updated = await locationRepository.update(locationId, updateData);
    return {
      autoApproveCleanInvoices: updated.autoApproveCleanInvoices,
      hasSeenAutoApprovePrompt: updated.hasSeenAutoApprovePrompt,
    };
  },

  async deleteLocation(params: { userId: string; organisationId: string; locationId: string }) {
    const { userId, organisationId, locationId } = params;

    const location = await locationRepository.findById(locationId);
    if (!location) {
      throw { statusCode: 404, message: 'Location not found' };
    }

    if (location.organisationId !== organisationId) {
      throw { statusCode: 403, message: 'Forbidden' };
    }

    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership) {
      throw { statusCode: 403, message: 'Not a member' };
    }

    await locationRepository.delete(locationId);
  },

  /**
   * Fetch all locations across all organizations the user has access to.
   * Returns locations grouped by organization ID.
   */
  async listAllForUser(userId: string): Promise<Record<string, Array<{ id: string; name: string; organisationId: string; integrations: Array<{ type: string; name: string; status: string }> }>>> {
    // Get all user's memberships
    const memberships = await prisma.userOrganisation.findMany({
      where: { userId },
      select: { organisationId: true },
    });

    if (memberships.length === 0) {
      return {};
    }

    const orgIds = memberships.map((m) => m.organisationId);

    // Check for scoped location access
    const accessRows = await prisma.userLocationAccess.findMany({
      where: { userId, organisationId: { in: orgIds } },
      select: { locationId: true, organisationId: true },
    });

    // Group scoped locations by org
    const scopedByOrg: Record<string, string[]> = {};
    accessRows.forEach((a) => {
      if (!scopedByOrg[a.organisationId]) {
        scopedByOrg[a.organisationId] = [];
      }
      scopedByOrg[a.organisationId].push(a.locationId);
    });

    // Fetch all locations for the user's orgs
    const allLocations = await prisma.location.findMany({
      where: { organisationId: { in: orgIds } },
      select: { id: true, name: true, organisationId: true },
      orderBy: { name: 'asc' },
    });

    // Filter by scoped access (soft enforcement)
    const filteredLocations = allLocations.filter((loc) => {
      const scopedIds = scopedByOrg[loc.organisationId];
      // If user has scoped access for this org, only include those locations
      if (scopedIds && scopedIds.length > 0) {
        return scopedIds.includes(loc.id);
      }
      // Otherwise, include all locations for that org (legacy/full access)
      return true;
    });

    // Get integrations for all locations
    const locationIds = filteredLocations.map((l) => l.id);
    const integrationsMap = await this.getLocationIntegrations(locationIds);

    // Group by organisation
    const grouped: Record<string, Array<{ id: string; name: string; organisationId: string; integrations: Array<{ type: string; name: string; status: string }> }>> = {};
    filteredLocations.forEach((loc) => {
      if (!grouped[loc.organisationId]) {
        grouped[loc.organisationId] = [];
      }
      grouped[loc.organisationId].push({
        ...loc,
        integrations: integrationsMap[loc.id] || [],
      });
    });

    return grouped;
  },
};

