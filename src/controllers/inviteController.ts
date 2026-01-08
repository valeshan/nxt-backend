import { FastifyReply, FastifyRequest } from 'fastify';
import { inviteService } from '../services/inviteService';
import { AcceptInviteParams, CreateInviteRequest } from '../dtos/inviteDtos';
import { UpdateMemberLocationsRequest, UpdateMemberRoleRequest } from '../dtos/memberDtos';
import prisma from '../infrastructure/prismaClient';

export const inviteController = {
  async create(
    request: FastifyRequest<{ Params: { orgId: string }; Body: typeof CreateInviteRequest._type }>,
    reply: FastifyReply
  ) {
    const { orgId } = request.params;
    const { email, role, locationIds } = request.body;
    const { userId } = request.authContext;

    try {
      const { invite, rawToken } = await inviteService.createInvite({
        organisationId: orgId,
        email,
        role,
        createdByUserId: userId,
        locationIds,
      });
      return reply.code(201).send({ inviteId: invite.id, expiresAt: invite.expiresAt, token: rawToken });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({
        message: err?.message || 'Failed to create invite',
        code: err?.code,
        seat: err?.seat,
      });
    }
  },

  async list(request: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) {
    try {
      const invites = await inviteService.listInvites(request.params.orgId);
      return reply.send({ invites });
    } catch (err: any) {
      return reply.code(500).send({ message: err?.message || 'Failed to list invites' });
    }
  },

  async revoke(request: FastifyRequest<{ Params: { orgId: string; inviteId: string } }>, reply: FastifyReply) {
    const { orgId, inviteId } = request.params;
    try {
      const revoked = await inviteService.revokeInvite(inviteId, orgId, 'MANUAL');
      return reply.send({ revoked });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({ message: err?.message || 'Failed to revoke invite' });
    }
  },

  async resend(request: FastifyRequest<{ Params: { orgId: string; inviteId: string } }>, reply: FastifyReply) {
    const { orgId, inviteId } = request.params;
    const { userId } = request.authContext;
    try {
      const invite = await inviteService.resendInvite(inviteId, orgId, userId);
      return reply.send({ invite });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({ message: err?.message || 'Failed to resend invite' });
    }
  },

  async getMembers(request: FastifyRequest<{ Params: { orgId: string } }>, reply: FastifyReply) {
    const { orgId } = request.params;
    try {
      const [members, org, currentUser] = await Promise.all([
        prisma.userOrganisation.findMany({
          where: { organisationId: orgId },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                firstName: true,
                lastName: true,
                locationAccess: {
                  where: { organisationId: orgId },
                  select: { locationId: true, location: { select: { name: true } } },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.organisation.findUnique({ where: { id: orgId }, select: { seatLimit: true } }),
        prisma.userOrganisation.findUnique({
          where: { userId_organisationId: { userId: request.authContext.userId, organisationId: orgId } },
          select: { role: true },
        }),
      ]);

      const response = {
        members: members.map((m) => ({
          id: m.user.id,
          email: m.user.email,
          name: m.user.name || [m.user.firstName, m.user.lastName].filter(Boolean).join(' '),
          role: m.role,
          joinedAt: m.createdAt,
          locationIds: m.user.locationAccess?.map((l) => l.locationId) || [],
          locationNames: m.user.locationAccess?.map((l) => l.location?.name).filter(Boolean) || [],
        })),
        seatLimit: org?.seatLimit ?? 5,
        seatCount: members.length,
        currentUserRole: currentUser?.role,
      };

      return reply.send(response);
    } catch (err: any) {
      return reply.code(500).send({ message: err?.message || 'Failed to fetch members' });
    }
  },

  async getByToken(request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
    const { token } = request.params;
    try {
      const invite = await inviteService.getInviteByToken(token);
      if (!invite) {
        return reply.code(404).send({ message: 'Invite not found' });
      }

      const [org, userExists] = await Promise.all([
        prisma.organisation.findUnique({ where: { id: invite.organisationId }, select: { name: true } }),
        prisma.user.count({ where: { email: invite.email } }).then((c) => c > 0),
      ]);

      let locationNames: string[] | undefined;
      if (invite.locationIds && invite.locationIds.length > 0) {
        const locs = await prisma.location.findMany({
          where: { id: { in: invite.locationIds } },
          select: { name: true },
        });
        locationNames = locs.map((l) => l.name);
      }

      return reply.send({
        organisationId: invite.organisationId,
        organisationName: org?.name,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        acceptedAt: invite.acceptedAt,
        revokedAt: invite.revokedAt,
        revokedReason: invite.revokedReason,
        locationIds: invite.locationIds,
        locationNames,
        userExists,
      });
    } catch (err: any) {
      return reply.code(500).send({ message: err?.message || 'Failed to fetch invite' });
    }
  },

  async accept(request: FastifyRequest<{ Params: typeof AcceptInviteParams._type }>, reply: FastifyReply) {
    const { token } = request.params;
    const { userId } = request.authContext;

    try {
      const invite = await inviteService.acceptInvite(token, userId);
      return reply.send({
        organisationId: invite.organisationId,
        role: invite.role,
        acceptedAt: invite.acceptedAt,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({
        message: err?.message || 'Failed to accept invite',
        code: err?.code,
        seat: err?.seat,
      });
    }
  },

  async removeMember(request: FastifyRequest<{ Params: { orgId: string; userId: string } }>, reply: FastifyReply) {
    const { orgId, userId } = request.params;
    const actingUserId = request.authContext.userId;
    try {
      const result = await inviteService.removeMember({ organisationId: orgId, actingUserId, targetUserId: userId });
      return reply.send(result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({ message: err?.message || 'Failed to remove member' });
    }
  },

  async updateMemberLocations(
    request: FastifyRequest<{ Params: { orgId: string; userId: string }; Body: typeof UpdateMemberLocationsRequest._type }>,
    reply: FastifyReply
  ) {
    const { orgId, userId } = request.params;
    const actingUserId = request.authContext.userId;
    const { locationIds = [] } = request.body;
    try {
      const result = await inviteService.updateMemberLocations({
        organisationId: orgId,
        actingUserId,
        targetUserId: userId,
        locationIds,
      });
      return reply.send(result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({ message: err?.message || 'Failed to update member locations' });
    }
  },

  async updateMemberRole(
    request: FastifyRequest<{ Params: { orgId: string; userId: string }; Body: typeof UpdateMemberRoleRequest._type }>,
    reply: FastifyReply
  ) {
    const { orgId, userId } = request.params;
    const actingUserId = request.authContext.userId;
    const { role } = request.body;
    try {
      const result = await inviteService.updateMemberRole({
        organisationId: orgId,
        actingUserId,
        targetUserId: userId,
        role,
      });
      return reply.send(result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return reply.code(status).send({ message: err?.message || 'Failed to update member role' });
    }
  },
};

