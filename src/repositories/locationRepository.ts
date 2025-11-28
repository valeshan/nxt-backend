import prisma from '../infrastructure/prismaClient';
import { Location, Prisma } from '@prisma/client';

export const locationRepository = {
  async createLocation(data: Prisma.LocationCreateInput): Promise<Location> {
    return prisma.location.create({ data });
  },

  async listForOrganisation(organisationId: string): Promise<Location[]> {
    return prisma.location.findMany({
      where: { organisationId },
    });
  },

  async findById(id: string): Promise<Location | null> {
    return prisma.location.findUnique({ where: { id } });
  },

  async update(id: string, data: Prisma.LocationUpdateInput): Promise<Location> {
    return prisma.location.update({ where: { id }, data });
  },

  async delete(id: string): Promise<void> {
    await prisma.location.delete({ where: { id } });
  },
};

