import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { feedbackController } from '../controllers/feedbackController';
import { FeedbackRequest } from '../dtos/feedbackDtos';
import authContextPlugin from '../plugins/authContext';

export default async function feedbackRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.post(
      '/',
      {
        schema: {
          body: FeedbackRequest,
        },
      },
      feedbackController.submitFeedback
    );
  });
}


