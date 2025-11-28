import prisma from '../infrastructure/prismaClient';
import { Prisma, XeroConnection } from '@prisma/client';

// Define the return type with included relations using Prisma's generated types
export type XeroConnectionWithLocations = Prisma.XeroConnectionGetPayload<{
  include: { locationLinks: { include: { location: true } } }
}>;

export class XeroConnectionRepository {
  async createConnection(
    data: Prisma.XeroConnectionUncheckedCreateInput
  ): Promise<XeroConnection> {
    // Ensure tenantName is present
    if (!data.tenantName) {
        data.tenantName = 'Unknown';
    }
    
    const { organisationId, userId, ...rest } = data;
    
    const createData: any = {
        ...rest,
        organisation: {
            connect: { id: organisationId }
        }
    };

    if (userId) {
        createData.user = {
            connect: { id: userId }
        };
    }
    
    return prisma.xeroConnection.create({
         data: createData
    });
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

  async findById(id: string): Promise<XeroConnectionWithLocations | null> {
    return prisma.xeroConnection.findUnique({
      where: { id },
      include: { locationLinks: { include: { location: true } } },
    });
  }

  async findByOrganisation(organisationId: string): Promise<XeroConnectionWithLocations[]> {
    return prisma.xeroConnection.findMany({
      where: { organisationId },
      include: { locationLinks: { include: { location: true } } },
    });
  }
}
