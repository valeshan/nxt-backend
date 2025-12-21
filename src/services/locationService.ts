import { locationRepository } from '../repositories/locationRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import prisma from '../infrastructure/prismaClient';

export const locationService = {
  async createLocation(userId: string, organisationId: string, name: string) {
    // Verify user is admin/owner of org
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw { statusCode: 403, message: 'Insufficient permissions' };
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

    const locations = await locationRepository.listForOrganisation(organisationId);
    const locationIds = locations.map(l => l.id);
    const integrationsMap = await this.getLocationIntegrations(locationIds);

    return locations.map(loc => ({
      ...loc,
      forwardingStatus: loc.forwardingStatus, // Already on model
      integrations: integrationsMap[loc.id] || []
    }));
  },

  async updateLocation(userId: string, locationId: string, data: { name?: string; industry?: string | null; region?: string | null }) {
    const location = await locationRepository.findById(locationId);
    if (!location) throw { statusCode: 404, message: 'Location not found' };

    // Verify permissions for the organisation this location belongs to
    const membership = await userOrganisationRepository.findMembership(userId, location.organisationId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw { statusCode: 403, message: 'Insufficient permissions' };
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.industry !== undefined) updateData.industry = data.industry;
    if (data.region !== undefined) updateData.region = data.region ? data.region.trim() : null;

    return locationRepository.update(locationId, updateData);
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
  }
};

