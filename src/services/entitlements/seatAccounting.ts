import { PrismaClient, Prisma } from '@prisma/client';
import prisma from '../../infrastructure/prismaClient';

// Robust typing that survives refactors to prisma client wrapper
type Db = PrismaClient | Prisma.TransactionClient;

export async function getSeatUsage(
  organisationId: string,
  client: Db = prisma // Accept optional client for tx reuse
): Promise<{
  seatCount: number;
  pendingInvites: number;
  seatReservedCount: number;
}> {
  const [seatCount, pendingInvites] = await Promise.all([
    client.userOrganisation.count({ where: { organisationId } }),
    client.organisationInvite.count({
      where: {
        organisationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);
  return { seatCount, pendingInvites, seatReservedCount: seatCount + pendingInvites };
}

