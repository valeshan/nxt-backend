import { FastifyRequest, FastifyReply } from 'fastify';
import { organisationService } from '../services/organisationService';
import { CreateOrganisationRequest } from '../dtos/authDtos';
import { z } from 'zod';

const manualOnboardSchema = z.object({
  venueName: z.string().min(1),
  onboardingSessionId: z.string().optional(),
});

export const organisationController = {
  async create(request: FastifyRequest<{ Body: z.infer<typeof CreateOrganisationRequest> }>, reply: FastifyReply) {
    const { name } = request.body;
    const userId = request.user.userId;
    const result = await organisationService.createOrganisation(userId, name);
    return reply.code(201).send(result);
  },

  async list(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.user.userId;
    const result = await organisationService.listForUser(userId);
    return reply.send(result);
  },

  async manualOnboard(request: FastifyRequest<{ Body: z.infer<typeof manualOnboardSchema> }>, reply: FastifyReply) {
    const { venueName, onboardingSessionId } = request.body;
    
    // No user ID check required for onboarding as it's public/pre-auth
    const result = await organisationService.manualOnboard(venueName, onboardingSessionId);
    return reply.code(201).send(result);
  }
};
