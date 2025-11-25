import { organisationRepository } from '../repositories/organisationRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { locationRepository } from '../repositories/locationRepository';
import { OrganisationRole } from '@prisma/client';

export const organisationService = {
  async createOrganisation(userId: string, name: string) {
    const org = await organisationRepository.createOrganisation({ name });
    await userOrganisationRepository.addUserToOrganisation(userId, org.id, OrganisationRole.owner);
    return org;
  },

  async listForUser(userId: string) {
    return organisationRepository.listForUser(userId);
  },

  async manualOnboard(userId: string, venueName: string) {
    const org = await organisationRepository.createOrganisation({ name: venueName });
    await userOrganisationRepository.addUserToOrganisation(userId, org.id, OrganisationRole.owner);
    
    const location = await locationRepository.createLocation({
        organisationId: org.id,
        name: venueName
    });

    return {
        organisationId: org.id,
        locationId: location.id,
        organisationName: org.name,
        locationName: location.name
    };
  }
};
