import z from 'zod';

export const createConnectionRequestSchema = z.object({
  organisationId: z.string().min(1),
  xeroTenantId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(), // Expecting ISO datetime string
});

export const linkLocationsRequestSchema = z.object({
  organisationId: z.string().min(1),
  locationIds: z.array(z.string().min(1)).min(1),
});

export const listConnectionsQuerySchema = z.object({
  organisationId: z.string().min(1),
});

export const xeroAuthoriseCallbackRequestSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  scope: z.string().optional(),
});

export type CreateConnectionRequest = z.infer<typeof createConnectionRequestSchema>;
export type LinkLocationsRequest = z.infer<typeof linkLocationsRequestSchema>;
export type ListConnectionsQuery = z.infer<typeof listConnectionsQuerySchema>;
export type XeroAuthoriseCallbackRequest = z.infer<typeof xeroAuthoriseCallbackRequestSchema>;
