import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';
import { emailForwardingController } from '../controllers/emailForwardingController';
import z from 'zod';

export default async function emailForwardingRoutes(fastify: FastifyInstance) {
  fastify.register(authContextPlugin);
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /locations/:locationId/forwarding-verification
  app.get('/locations/:locationId/forwarding-verification', {
    schema: {
      params: z.object({ locationId: z.string() }),
      response: {
        200: z.object({
          verification: z.object({
            id: z.string(),
            status: z.enum(['PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED']),
            verificationLink: z.string().nullable(),
            expiresAt: z.string(), // ISO string
            createdAt: z.string(), // ISO string
          }).nullable(),
          locationStatus: z.enum(['NOT_CONFIGURED', 'PENDING_VERIFICATION', 'VERIFIED']).nullable(),
        }),
      },
    },
  }, emailForwardingController.getVerificationStatus);

  // POST /locations/:locationId/forwarding-verification/confirm
  app.post('/locations/:locationId/forwarding-verification/confirm', {
    schema: {
      params: z.object({ locationId: z.string() }),
      response: {
        200: z.object({
          success: z.boolean(),
        }),
      },
    },
  }, emailForwardingController.confirmVerification);
}



