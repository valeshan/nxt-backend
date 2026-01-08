import { z } from 'zod';
import { OrganisationRole } from '@prisma/client';

export const CreateInviteRequest = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrganisationRole).optional().default(OrganisationRole.member),
  locationIds: z.array(z.string().uuid()).optional().default([]),
});

export const RevokeInviteParams = z.object({
  inviteId: z.string().uuid(),
  organisationId: z.string().uuid(),
});

export const ResendInviteParams = RevokeInviteParams;

export const AcceptInviteParams = z.object({
  token: z.string().min(1),
});

