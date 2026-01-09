import { InviteRevokeReason, OrganisationInvite, OrganisationRole } from '@prisma/client';
import crypto from 'crypto';
import { inviteRepository } from '../repositories/inviteRepository';
import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';
import { buildInviteEmail } from './emailTemplates/inviteTemplates';
import { GmailSmtpProvider } from './emailProviders/gmailSmtpProvider';
import { resolveOrganisationEntitlements } from './entitlements/resolveOrganisationEntitlements';
import { getSeatUsage } from './entitlements/seatAccounting';

// Keep this aligned with the email copy ("Link expires in 48 hours.")
const INVITE_TTL_HOURS = 48;

const ROLE_RANK: Record<OrganisationRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

const emailProvider = new GmailSmtpProvider();

const generateToken = () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

const canInviteRole = (inviterRole: OrganisationRole, targetRole: OrganisationRole): boolean => {
  if (inviterRole === 'member') return false;
  if (targetRole === 'owner') return false;
  return ROLE_RANK[inviterRole] >= ROLE_RANK[targetRole];
};
const getDisplayName = (user: { firstName?: string | null; lastName?: string | null; name?: string | null; email: string }) => {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.name || user.email;
};

const ensureAdmin = async (userId: string, organisationId: string) => {
  const membership = await prisma.userOrganisation.findUnique({
    where: { userId_organisationId: { userId, organisationId } },
  });
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw { statusCode: 403, message: 'Insufficient permissions' };
  }
  return membership;
};

export const inviteService = {
  async createInvite(params: {
    organisationId: string;
    email: string;
    role: OrganisationRole;
    createdByUserId: string;
    locationIds?: string[];
  }): Promise<{ invite: OrganisationInvite; rawToken: string }> {
    const { organisationId, email, role, createdByUserId } = params;
    const locationIds = params.locationIds || [];

    // Validate inviter role and membership
    const inviterMembership = await prisma.userOrganisation.findUnique({
      where: {
        userId_organisationId: {
          userId: createdByUserId,
          organisationId,
        },
      },
    });
    if (!inviterMembership) {
      throw { statusCode: 403, message: 'Not a member of this organisation' };
    }
    if (!canInviteRole(inviterMembership.role, role)) {
      throw { statusCode: 403, message: 'Insufficient role to invite this role' };
    }

    // Resolve entitlements and enforce plan flag
    const entitlements = await resolveOrganisationEntitlements(organisationId);

    if (!entitlements.flags.canInviteUsers) {
      throw {
        statusCode: 403,
        code: 'INVITES_DISABLED',
        message: 'Invites are not available on this plan',
      };
    }

    // Seat reservation check: members + pending invites
    const seatUsage = await getSeatUsage(organisationId);
    if (seatUsage.seatReservedCount >= entitlements.caps.seatLimit) {
      throw {
        statusCode: 400,
        code: 'SEAT_LIMIT_REACHED',
        message: `Seat limit reached (${seatUsage.seatReservedCount}/${entitlements.caps.seatLimit}). Revoke a pending invite or remove a member to free a seat.`,
        seat: {
          used: seatUsage.seatReservedCount,
          accepted: seatUsage.seatCount,
          pending: seatUsage.pendingInvites,
          limit: entitlements.caps.seatLimit,
        },
      };
    }

    // Prevent pending duplicates (friendly error; unique index is authoritative)
    const duplicate = await inviteRepository.findPendingDuplicate(organisationId, email);
    if (duplicate) {
      throw { statusCode: 400, message: 'An invite for this email is already pending' };
    }

    // Validate locationIds belong to org (best effort)
    if (locationIds.length > 0) {
      const validLocations = await prisma.location.findMany({
        where: { id: { in: locationIds }, organisationId },
        select: { id: true },
      });
      if (validLocations.length !== locationIds.length) {
        throw { statusCode: 400, message: 'One or more locations are invalid for this organisation' };
      }
    }

    const { raw, hash } = generateToken();
    const ttlHours = entitlements.caps.inviteExpiryHours ?? INVITE_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const invite = await inviteRepository.createInvite({
      organisationId,
      email,
      role,
      tokenHash: hash,
      expiresAt,
      createdByUserId,
      locationIds,
    });

    // Fetch names for nicer email template
    const [org, inviter] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: organisationId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: createdByUserId }, select: { firstName: true, lastName: true, name: true, email: true } }),
    ]);

    // Resolve location names if scoped
    const locationNames =
      locationIds.length > 0
        ? await prisma.location.findMany({
            where: { id: { in: locationIds } },
            select: { name: true },
          }).then((rows) => rows.map((r) => r.name))
        : [];

    await emailProvider.sendEmail(
      buildInviteEmail({
        toEmail: email,
        organisationId,
        organisationName: org?.name,
        inviterName: inviter ? getDisplayName(inviter) : undefined,
        locationNames,
        token: raw,
        inviterUserId: createdByUserId,
        role,
        frontendUrl: process.env.NODE_ENV === 'production'
          ? (config.FRONTEND_URL || config.APP_URL || 'https://dashboard.thenxt.ai')
          : 'http://localhost:3000',
      })
    );

    return { invite, rawToken: raw };
  },

  async listInvites(organisationId: string) {
    return inviteRepository.listInvites(organisationId);
  },

  async removeMember(params: { organisationId: string; actingUserId: string; targetUserId: string }) {
    const { organisationId, actingUserId, targetUserId } = params;
    await ensureAdmin(actingUserId, organisationId);

    const targetMembership = await prisma.userOrganisation.findUnique({
      where: { userId_organisationId: { userId: targetUserId, organisationId } },
    });

    if (!targetMembership) {
      throw { statusCode: 404, message: 'Member not found' };
    }

    if (targetMembership.role === 'owner') {
      throw { statusCode: 400, message: 'Cannot remove an owner' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.userLocationAccess.deleteMany({
        where: { userId: targetUserId, organisationId },
      });
      await tx.userOrganisation.delete({
        where: { userId_organisationId: { userId: targetUserId, organisationId } },
      });
    });

    const entitlements = await resolveOrganisationEntitlements(organisationId);
    const seatUsage = await getSeatUsage(organisationId);
    return { seatCount: seatUsage.seatCount, seatLimit: entitlements.caps.seatLimit };
  },

  async updateMemberLocations(params: { organisationId: string; actingUserId: string; targetUserId: string; locationIds: string[] }) {
    const { organisationId, actingUserId, targetUserId, locationIds } = params;
    await ensureAdmin(actingUserId, organisationId);

    const targetMembership = await prisma.userOrganisation.findUnique({
      where: { userId_organisationId: { userId: targetUserId, organisationId } },
    });
    if (!targetMembership) {
      throw { statusCode: 404, message: 'Member not found' };
    }
    if (targetMembership.role === 'owner') {
      throw { statusCode: 400, message: 'Cannot restrict an owner' };
    }

    // Validate locations belong to org
    if (locationIds.length > 0) {
      const valid = await prisma.location.count({
        where: { id: { in: locationIds }, organisationId },
      });
      if (valid !== locationIds.length) {
        throw { statusCode: 400, message: 'One or more locations are invalid for this organisation' };
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.userLocationAccess.deleteMany({ where: { userId: targetUserId, organisationId } });
      if (locationIds.length > 0) {
        await tx.userLocationAccess.createMany({
          data: locationIds.map((locId) => ({
            userId: targetUserId,
            organisationId,
            locationId: locId,
          })),
        });
      }
    });

    return { locationIds };
  },

  async updateMemberRole(params: { organisationId: string; actingUserId: string; targetUserId: string; role: OrganisationRole }) {
    const { organisationId, actingUserId, targetUserId, role } = params;
    await ensureAdmin(actingUserId, organisationId);

    if (actingUserId === targetUserId) {
      throw { statusCode: 400, message: 'You cannot change your own role' };
    }

    if (role === 'owner') {
      throw { statusCode: 400, message: 'Cannot assign owner role' };
    }

    const targetMembership = await prisma.userOrganisation.findUnique({
      where: { userId_organisationId: { userId: targetUserId, organisationId } },
    });
    if (!targetMembership) {
      throw { statusCode: 404, message: 'Member not found' };
    }
    if (targetMembership.role === 'owner') {
      throw { statusCode: 400, message: 'Cannot modify an owner' };
    }

    const updated = await prisma.userOrganisation.update({
      where: { userId_organisationId: { userId: targetUserId, organisationId } },
      data: { role },
    });

    return { role: updated.role };
  },

  async revokeInvite(inviteId: string, organisationId: string, reason: InviteRevokeReason = 'MANUAL') {
    const revoked = await inviteRepository.revokeInvite(inviteId, organisationId, reason);
    if (!revoked) {
      throw { statusCode: 404, message: 'Invite not found or already used' };
    }
    return revoked;
  },

  async resendInvite(inviteId: string, organisationId: string, resendByUserId: string) {
    return prisma.$transaction(async (tx) => {
      const oldInvite = await tx.organisationInvite.findFirst({
        where: { id: inviteId, organisationId, acceptedAt: null, revokedAt: null },
      });

      if (!oldInvite) {
        throw { statusCode: 404, message: 'Invite not found or already used/revoked' };
      }

      // Revoke old first (avoid partial unique conflict)
      await tx.organisationInvite.update({
        where: { id: oldInvite.id },
        data: {
          revokedAt: new Date(),
          revokedReason: 'RESEND',
        },
      });

      const { raw, hash } = generateToken();
      const newInvite = await tx.organisationInvite.create({
        data: {
          organisationId: oldInvite.organisationId,
          email: oldInvite.email,
          role: oldInvite.role,
          tokenHash: hash,
          locationIds: oldInvite.locationIds || [],
          expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000),
          createdByUserId: resendByUserId,
        },
      });

      await tx.organisationInvite.update({
        where: { id: oldInvite.id },
        data: { replacedByInviteId: newInvite.id },
      });

      const [org, inviter] = await Promise.all([
        tx.organisation.findUnique({ where: { id: newInvite.organisationId }, select: { name: true } }),
        tx.user.findUnique({ where: { id: resendByUserId }, select: { firstName: true, lastName: true, name: true, email: true } }),
      ]);

      const locationNames =
        (newInvite.locationIds || []).length > 0
          ? await tx.location.findMany({
              where: { id: { in: newInvite.locationIds || [] } },
              select: { name: true },
            }).then((rows) => rows.map((r) => r.name))
          : [];

      await emailProvider.sendEmail(
        buildInviteEmail({
          toEmail: newInvite.email,
          organisationId: newInvite.organisationId,
          organisationName: org?.name,
          inviterName: inviter ? getDisplayName(inviter) : undefined,
          locationNames,
          token: raw,
          inviterUserId: resendByUserId,
          role: newInvite.role,
          frontendUrl: process.env.NODE_ENV === 'production'
            ? (config.FRONTEND_URL || config.APP_URL || 'https://dashboard.thenxt.ai')
            : 'http://localhost:3000',
        })
      );

      return newInvite;
    });
  },

  async getInviteByToken(rawToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    return inviteRepository.findByTokenHash(tokenHash);
  },

  async acceptInvite(rawToken: string, userId: string) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    return prisma.$transaction(async (tx) => {
      // Fetch invite by token (scoped via global uniqueness)
      const invite = await tx.organisationInvite.findFirst({
        where: {
          tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (!invite) {
        throw { statusCode: 404, message: 'Invite not found, already used, revoked, or expired' };
      }

      const orgId = invite.organisationId;

      // Resolve entitlements inside tx; treat seatLimit as immutable for this call
      const entitlementsForOrg = await resolveOrganisationEntitlements(orgId, { client: tx });
      const seatLimit = entitlementsForOrg.caps.seatLimit;

      // Prevent duplicate membership
      const existing = await tx.userOrganisation.findUnique({
        where: {
          userId_organisationId: {
            userId,
            organisationId: orgId,
          },
        },
      });
      if (existing) {
        throw { statusCode: 400, message: 'Already a member of this organisation' };
      }

      // Atomic claim
      const claimed = await tx.organisationInvite.updateMany({
        where: {
          id: invite.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
      });

      if (claimed.count === 0) {
        throw { statusCode: 409, message: 'Invite was claimed or revoked by another request' };
      }

      // Seat check inside tx using latest seat count
      const seatCount = await tx.userOrganisation.count({ where: { organisationId: orgId } });
      if (seatCount >= seatLimit) {
        throw {
          statusCode: 400,
          code: 'SEAT_LIMIT_REACHED',
          message: 'This workspace is at capacity. Ask an admin to free a seat, or try again later.',
          seat: { current: seatCount, limit: seatLimit },
        };
      }

      // Ensure org membership exists
      await tx.userOrganisation.upsert({
        where: {
          userId_organisationId: {
            userId,
            organisationId: orgId,
          },
        },
        create: {
          userId,
          organisationId: orgId,
          role: invite.role,
        },
        update: {},
      });

      // Create location access rows if provided (respect legacy: if none, full access)
      if (invite.locationIds && invite.locationIds.length > 0) {
        await tx.userLocationAccess.createMany({
          data: invite.locationIds.map((locId) => ({
            userId,
            organisationId: orgId,
            locationId: locId,
          })),
          skipDuplicates: true,
        });
      }

      return invite;
    });
  },
};

