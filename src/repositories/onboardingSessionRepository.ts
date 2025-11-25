import prisma from '../infrastructure/prismaClient';
import { OnboardingMode, OnboardingSession, Prisma } from '@prisma/client';

export const onboardingSessionRepository = {
  async createSession(mode: OnboardingMode): Promise<OnboardingSession> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1); // Expires in 1 day

    return prisma.onboardingSession.create({
      data: {
        mode,
        expiresAt,
      },
    });
  },

  async findById(id: string): Promise<OnboardingSession | null> {
    return prisma.onboardingSession.findUnique({
      where: { id },
    });
  },

  async attachOrganisationAndLocation(
    id: string,
    organisationId: string,
    locationId: string
  ): Promise<OnboardingSession> {
    return prisma.onboardingSession.update({
      where: { id },
      data: {
        organisationId,
        locationId,
      },
    });
  },

  async markCompleted(id: string): Promise<OnboardingSession> {
    return prisma.onboardingSession.update({
      where: { id },
      data: {
        completedAt: new Date(),
      },
    });
  },

  async updateEmail(id: string, email: string): Promise<OnboardingSession> {
    return prisma.onboardingSession.update({
      where: { id },
      data: {
        email,
      },
    });
  },
};
