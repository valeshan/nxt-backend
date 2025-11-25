import prisma from '../infrastructure/prismaClient';
import { Prisma, XeroConnection } from '@prisma/client';

export class XeroConnectionRepository {
  async createConnection(
    data: Prisma.XeroConnectionUncheckedCreateInput
  ): Promise<XeroConnection> {
    return prisma.xeroConnection.create({ data });
  }

  async updateConnection(
    id: string,
    data: Prisma.XeroConnectionUncheckedUpdateInput
  ): Promise<XeroConnection> {
    return prisma.xeroConnection.update({
      where: { id },
      data,
    });
  }

  async findByOrganisationAndTenant(
    organisationId: string,
    xeroTenantId: string
  ): Promise<XeroConnection | null> {
    return prisma.xeroConnection.findFirst({
      where: { organisationId, xeroTenantId },
    });
  }

  async findById(id: string): Promise<XeroConnection | null> {
    return prisma.xeroConnection.findUnique({
      where: { id },
      include: { locationLinks: true },
    });
  }

  async findByOrganisation(organisationId: string): Promise<XeroConnection[]> {
    return prisma.xeroConnection.findMany({
      where: { organisationId },
      include: { locationLinks: true },
    });
  }
}

