import prisma from '../infrastructure/prismaClient';
import { Prisma, XeroLocationLink } from '@prisma/client';

export class XeroLocationLinkRepository {
  async createLinks(
    xeroConnectionId: string,
    organisationId: string,
    locationIds: string[]
  ): Promise<XeroLocationLink[]> {
    // Check input
    if (!locationIds || !Array.isArray(locationIds)) {
        console.warn('[XeroLocationLinkRepository] createLinks called with invalid locationIds:', locationIds);
        return [];
    }

    // Create multiple links. 
    // We use createMany but Prisma createMany does not return the created records in all DBs (Postgres does supports it but Prisma only returns count).
    // The requirement says "Return created connection plus its location links".
    // We can iterate or use createMany and then fetch.
    // To handle duplicates gracefully (ignore them), we can use `skipDuplicates: true`.
    
    await prisma.xeroLocationLink.createMany({
      data: locationIds.map((locationId) => ({
        xeroConnectionId,
        organisationId,
        locationId,
      })),
      skipDuplicates: true,
    });

    return prisma.xeroLocationLink.findMany({
      where: {
        xeroConnectionId,
        locationId: { in: locationIds },
      },
    });
  }

  async findByConnection(xeroConnectionId: string): Promise<XeroLocationLink[]> {
    return prisma.xeroLocationLink.findMany({
      where: { xeroConnectionId },
    });
  }

  async createLink(
    data: Prisma.XeroLocationLinkUncheckedCreateInput
  ): Promise<XeroLocationLink> {
    return prisma.xeroLocationLink.create({ data });
  }
}

