import { locationRepository } from '../repositories/locationRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';

export const locationService = {
  async createLocation(userId: string, organisationId: string, name: string) {
    // Verify user is admin/owner of org
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      throw { statusCode: 403, message: 'Insufficient permissions' };
    }

    return locationRepository.createLocation({
      name,
      organisation: { connect: { id: organisationId } }
    });
  },

  async listForOrganisation(userId: string, organisationId: string) {
    // Check read access (member is enough)
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership) {
      throw { statusCode: 403, message: 'Not a member' };
    }

    return locationRepository.listForOrganisation(organisationId);
  }
};

