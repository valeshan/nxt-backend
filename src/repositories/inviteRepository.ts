import { OrganisationInvite, OrganisationRole, InviteRevokeReason } from '@prisma/client';
import prisma from '../infrastructure/prismaClient';

export type InviteWithOrg = OrganisationInvite & { organisationId: string };

export const inviteRepository = {
  async createInvite(params: {
    organisationId: string;
    email: string;
    role: OrganisationRole;
    tokenHash: string;
    expiresAt: Date;
    createdByUserId: string;
    locationIds?: string[];
  }): Promise<OrganisationInvite> {
    return prisma.organisationInvite.create({
      data: {
        organisationId: params.organisationId,
        email: params.email,
        role: params.role,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        createdByUserId: params.createdByUserId,
        locationIds: params.locationIds || [],
      },
    });
  },

  async listInvites(organisationId: string): Promise<OrganisationInvite[]> {
    return prisma.organisationInvite.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
    });
  },

  async revokeInvite(inviteId: string, organisationId: string, reason: InviteRevokeReason = 'MANUAL'): Promise<OrganisationInvite | null> {
    return prisma.organisationInvite.updateMany({
      where: {
        id: inviteId,
        organisationId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedReason: reason,
      },
    }).then(async (result) => {
      if (result.count === 0) return null;
      return prisma.organisationInvite.findUnique({ where: { id: inviteId } });
    });
  },

  async findByTokenHash(tokenHash: string): Promise<OrganisationInvite | null> {
    return prisma.organisationInvite.findFirst({
      where: { tokenHash },
    });
  },

  async findPendingDuplicate(organisationId: string, email: string): Promise<OrganisationInvite | null> {
    return prisma.organisationInvite.findFirst({
      where: {
        organisationId,
        email,
        acceptedAt: null,
        revokedAt: null,
      },
    });
  },
};

