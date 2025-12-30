import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';
import prisma from '../infrastructure/prismaClient';

export default async function userRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);

    protectedApp.post('/me/onboarding-complete', async (request, reply) => {
      const { userId } = request.authContext;

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { onboardingCompletedAt: new Date() },
        select: { onboardingCompletedAt: true }
      });

      return { 
        success: true, 
        onboardingCompletedAt: updatedUser.onboardingCompletedAt?.toISOString() || null
      };
    });
  });
}





