import prisma from '../infrastructure/prismaClient';
import { UserOrganisation, OrganisationRole } from '@prisma/client';

export const userOrganisationRepository = {
  async addUserToOrganisation(userId: string, organisationId: string, role: OrganisationRole): Promise<UserOrganisation> {
    return prisma.userOrganisation.create({
      data: {
        userId,
        organisationId,
        role,
      },
    });
  },

  async findMembership(userId: string, organisationId: string): Promise<UserOrganisation | null> {
    return prisma.userOrganisation.findUnique({
      where: {
        userId_organisationId: {
          userId,
          organisationId,
        },
      },
    });
  },

  async listUserOrganisations(userId: string): Promise<UserOrganisation[]> {
    return prisma.userOrganisation.findMany({
      where: { userId },
    });
  }
};

