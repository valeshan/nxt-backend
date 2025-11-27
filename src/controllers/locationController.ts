import { FastifyRequest, FastifyReply } from 'fastify';
import { locationService } from '../services/locationService';
import { CreateLocationRequest } from '../dtos/authDtos';
import { z } from 'zod';

export const locationController = {
  async create(request: FastifyRequest<{ Params: { organisationId: string }, Body: z.infer<typeof CreateLocationRequest> }>, reply: FastifyReply) {
    const { name } = request.body;
    const { organisationId } = request.params;
    const userId = request.authContext.userId;
    const result = await locationService.createLocation(userId, organisationId, name);
    return reply.code(201).send(result);
  },

  async list(request: FastifyRequest<{ Params: { organisationId: string } }>, reply: FastifyReply) {
    const { organisationId } = request.params;
    const userId = request.authContext.userId;
    const result = await locationService.listForOrganisation(userId, organisationId);
    return reply.send(result);
  }
};
