import prisma from '../infrastructure/prismaClient';
import { XeroLocationLink } from '@prisma/client';

export class XeroLocationLinkRepository {
  async createLinks(xeroConnectionId: string, locationIds: string[]): Promise<XeroLocationLink[]> {
    // Create multiple links. 
    // We use createMany but Prisma createMany does not return the created records in all DBs (Postgres does supports it but Prisma only returns count).
    // The requirement says "Return created connection plus its location links".
    // We can iterate or use createMany and then fetch.
    // To handle duplicates gracefully (ignore them), we can use `skipDuplicates: true`.
    
    await prisma.xeroLocationLink.createMany({
      data: locationIds.map((locationId) => ({
        xeroConnectionId,
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
}

