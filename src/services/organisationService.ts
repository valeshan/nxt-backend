import { organisationRepository } from '../repositories/organisationRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { locationRepository } from '../repositories/locationRepository';
import { onboardingSessionRepository } from '../repositories/onboardingSessionRepository';
import { OrganisationRole, OnboardingMode } from '@prisma/client';

export const organisationService = {
  async createOrganisation(userId: string, name: string) {
    const org = await organisationRepository.createOrganisation({ name });
    await userOrganisationRepository.addUserToOrganisation(userId, org.id, OrganisationRole.owner);
    return org;
  },

  async listForUser(userId: string) {
    return organisationRepository.listForUser(userId);
  },

  async manualOnboard(venueName: string, onboardingSessionId?: string) {
    // Ensure session exists or create one
    let session;
    if (onboardingSessionId) {
      session = await onboardingSessionRepository.findById(onboardingSessionId);
      if (!session || session.completedAt || session.expiresAt < new Date()) {
        throw new Error('Invalid or expired onboarding session');
      }
    } else {
      session = await onboardingSessionRepository.createSession(OnboardingMode.manual);
    }

    // Create Organisation (NO User yet)
    const org = await organisationRepository.createOrganisation({ name: venueName });
    
    // Create Location
    const location = await locationRepository.createLocation({
        organisationId: org.id,
        name: venueName
    });

    // Attach to session
    await onboardingSessionRepository.attachOrganisationAndLocation(
      session.id,
      org.id,
      location.id
    );

    return {
        onboardingSessionId: session.id,
        organisationId: org.id,
        locationId: location.id,
        organisationName: org.name,
        locationName: location.name
    };
  }
};
