import { FastifyRequest, FastifyReply } from 'fastify';
import { organisationService } from '../services/organisationService';
import { CreateOrganisationRequest } from '../dtos/authDtos';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

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
    
    // Check if user is authenticated (optional) to link them
    let userId: string | undefined;
    
    // Try to extract user from request.user (if plugin ran) or manually verify token (optional auth)
    if (request.user && (request.user as any).userId) {
        userId = (request.user as any).userId;
    } else {
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const token = authHeader.split(' ')[1];
                const payload = jwt.verify(token, config.JWT_VERIFY_SECRET) as any;
                if (payload && payload.sub) {
                    userId = payload.sub;
                }
            } catch (e) {
                // Ignore invalid token for optional auth
            }
        }
    }

    const result = await organisationService.manualOnboard(venueName, onboardingSessionId, userId);
    return reply.code(201).send(result);
  }
};
