import prisma from '../infrastructure/prismaClient';
import { Organisation, Prisma, UserOrganisation } from '@prisma/client';

export const organisationRepository = {
  async createOrganisation(data: Prisma.OrganisationCreateInput): Promise<Organisation> {
    return prisma.organisation.create({ data });
  },

  async findById(id: string): Promise<Organisation | null> {
    return prisma.organisation.findUnique({ where: { id } });
  },

  async listForUser(userId: string): Promise<(UserOrganisation & { organisation: Organisation })[]> {
    return prisma.userOrganisation.findMany({
      where: { userId },
      include: { organisation: true },
    });
  },

  async update(id: string, data: Prisma.OrganisationUpdateInput): Promise<Organisation> {
    return prisma.organisation.update({ where: { id }, data });
  }
};

