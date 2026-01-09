import { organisationRepository } from '../repositories/organisationRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { locationRepository } from '../repositories/locationRepository';
import { onboardingSessionRepository } from '../repositories/onboardingSessionRepository';
import { OrganisationRole, OnboardingMode } from '@prisma/client';
import prisma from '../infrastructure/prismaClient';
import { EntitlementOverridesSchema } from './entitlements/types';

export const organisationService = {
  async createOrganisation(userId: string, name: string) {
    const org = await organisationRepository.createOrganisation({ name });
    await userOrganisationRepository.addUserToOrganisation(userId, org.id, OrganisationRole.owner);
    return org;
  },

  async createOrganisationWithFirstLocation(userId: string, name: string, locationName: string) {
    return prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({ data: { name } });
      await tx.userOrganisation.create({
        data: { userId, organisationId: org.id, role: OrganisationRole.owner },
      });
      const location = await tx.location.create({
        data: { name: locationName, organisationId: org.id },
      });
      return {
        organisationId: org.id,
        organisationName: org.name,
        locationId: location.id,
        locationName: location.name,
      };
    });
  },

  async listForUser(userId: string) {
    return organisationRepository.listForUser(userId);
  },

  async updatePlan(organisationId: string, planKey: string) {
    return organisationRepository.update(organisationId, { planKey });
  },

  async updateOverrides(organisationId: string, overrides: unknown) {
    // Validate overrides before saving
    const parsed = EntitlementOverridesSchema.parse(overrides);
    // Use validated and stripped data
    return organisationRepository.update(organisationId, { entitlementOverrides: parsed });
  },

  /**
   * @deprecated This method creates orphan records (org/location without user) and should NOT be used for signup.
   * For signup, use /auth/register-onboard which creates everything atomically in a transaction.
   * This method is kept for backward compatibility with existing tests only.
   */
  async manualOnboard(venueName: string, onboardingSessionId?: string, userId?: string) {
    // DEPRECATED: This creates orphan records. Use /auth/register-onboard instead.
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

    // Create Organisation (NO User yet) - ORPHAN RECORD
    const org = await organisationRepository.createOrganisation({ name: venueName });
    
    // Create Location - ORPHAN RECORD
    const location = await locationRepository.createLocation({
        organisation: { connect: { id: org.id } },
        name: venueName
    });

    // Attach to session
    await onboardingSessionRepository.attachOrganisationAndLocation(
      session.id,
      org.id,
      location.id
    );

    // If userId is provided, link them as Owner (supporting authenticated onboarding)
    if (userId) {
        await userOrganisationRepository.addUserToOrganisation(userId, org.id, OrganisationRole.owner);
    }

    return {
        onboardingSessionId: session.id,
        organisationId: org.id,
        locationId: location.id,
        organisationName: org.name,
        locationName: location.name
    };
  }
};
