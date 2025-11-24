import prisma from '../infrastructure/prismaClient';
import { XeroConnection } from '@prisma/client';

export class XeroConnectionRepository {
  async createConnection(data: {
    organisationId: string;
    xeroTenantId: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    accessTokenExpiresAt: Date;
    status: string;
  }): Promise<XeroConnection> {
    return prisma.xeroConnection.create({
      data,
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

