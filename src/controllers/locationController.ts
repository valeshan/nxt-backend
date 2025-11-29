import { FastifyRequest, FastifyReply } from 'fastify';
import { locationService } from '../services/locationService';
import { CreateLocationRequest } from '../dtos/authDtos';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

export const locationController = {
  async create(request: FastifyRequest<{ Body: z.infer<typeof CreateLocationRequest> }>, reply: FastifyReply) {
    const { name } = request.body;
    const userId = request.authContext.userId;
    const organisationId = request.authContext.organisationId;

    if (!organisationId) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Organisation context required' },
      } as any);
    }

    const result = await locationService.createLocation(userId, organisationId, name);
    return reply.code(201).send(result);
  },

  async list(request: FastifyRequest<{ Params: { organisationId: string } }>, reply: FastifyReply) {
    const { organisationId } = request.params;
    const userId = request.authContext.userId;
    const result = await locationService.listForOrganisation(userId, organisationId);
    return reply.send(result);
  },

  async listMine(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.authContext.userId;
    const organisationId = request.authContext.organisationId;
    
    if (!organisationId) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Organisation context required' },
      } as any);
    }

    const result = await locationService.listForOrganisation(userId, organisationId);
    return reply.send(result);
  },

  async update(request: FastifyRequest<{ Params: { id: string }, Body: { name: string } }>, reply: FastifyReply) {
    const { id } = request.params;
    const { name } = request.body;
    const userId = request.authContext.userId;
    const result = await locationService.updateLocation(userId, id, name);
    return reply.send(result);
  },

  async deleteLocationHandler(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) {
    const { id } = request.params;
    const { userId, organisationId } = request.authContext;

    if (!organisationId) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Organisation context required' },
      } as any);
    }

    try {
      await locationService.deleteLocation({
        userId,
        organisationId,
        locationId: id,
      });
      return reply.status(204).send();
    } catch (err: any) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        return reply.status(409).send({
          error: {
            code: 'LOCATION_HAS_DEPENDENCIES',
            message: 'Cannot delete location with active linked data.',
          },
        } as any);
      }
      throw err;
    }
  },
};
