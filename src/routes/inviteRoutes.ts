import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import authContextPlugin from '../plugins/authContext';
import { inviteController } from '../controllers/inviteController';
import { AcceptInviteParams, CreateInviteRequest } from '../dtos/inviteDtos';
import { UpdateMemberLocationsRequest, UpdateMemberRoleRequest } from '../dtos/memberDtos';

export default async function inviteRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Public routes
  app.get('/invites/:token', {
    schema: {
      params: AcceptInviteParams,
    },
  }, inviteController.getByToken);

  // Authenticated accept route (global path)
  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typed = protectedApp.withTypeProvider<ZodTypeProvider>();

    typed.post('/invites/:token/accept', {
      schema: {
        params: AcceptInviteParams,
      },
    }, inviteController.accept);
  });

  // Org-scoped protected routes
  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typed = protectedApp.withTypeProvider<ZodTypeProvider>();

    const orgParams = z.object({ orgId: z.string().uuid() });
    const inviteIdParams = orgParams.extend({ inviteId: z.string().uuid() });
    const memberIdParams = orgParams.extend({ userId: z.string().uuid() });

    typed.post('/organisations/:orgId/invites', {
      schema: {
        params: orgParams,
        body: CreateInviteRequest,
      },
    }, inviteController.create);

    typed.get('/organisations/:orgId/invites', {
      schema: {
        params: orgParams,
      },
    }, inviteController.list);

    typed.delete('/organisations/:orgId/invites/:inviteId', {
      schema: {
        params: inviteIdParams,
      },
    }, inviteController.revoke);

    typed.post('/organisations/:orgId/invites/:inviteId/resend', {
      schema: {
        params: inviteIdParams,
      },
    }, inviteController.resend);

    typed.get('/organisations/:orgId/members', {
      schema: {
        params: orgParams,
      },
    }, inviteController.getMembers);

    typed.delete('/organisations/:orgId/members/:userId', {
      schema: {
        params: memberIdParams,
      },
    }, inviteController.removeMember);

    typed.patch('/organisations/:orgId/members/:userId/locations', {
      schema: {
        params: memberIdParams,
        body: UpdateMemberLocationsRequest,
      },
    }, inviteController.updateMemberLocations);

    typed.patch('/organisations/:orgId/members/:userId/role', {
      schema: {
        params: memberIdParams,
        body: UpdateMemberRoleRequest,
      },
    }, inviteController.updateMemberRole);
  });
}

