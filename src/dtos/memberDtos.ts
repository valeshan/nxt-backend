import { z } from 'zod';

export const UpdateMemberLocationsRequest = z.object({
  locationIds: z.array(z.string().uuid()).optional().default([]),
});

export type UpdateMemberLocationsBody = z.infer<typeof UpdateMemberLocationsRequest>;

export const UpdateMemberRoleRequest = z.object({
  role: z.enum(['admin', 'member']),
});

export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleRequest>;

