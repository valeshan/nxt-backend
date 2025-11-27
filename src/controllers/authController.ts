import { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../services/authService';
import { LoginRequest, RegisterRequest, SelectOrganisationRequest, SelectLocationRequest, RefreshTokenRequest, RegisterOnboardRequestSchema } from '../dtos/authDtos';
import { z } from 'zod';

export const authController = {
  async register(request: FastifyRequest<{ Body: z.infer<typeof RegisterRequest> }>, reply: FastifyReply) {
    const { email, password, firstName, lastName, confirmPassword } = request.body;
    
    if (password !== confirmPassword) {
        return reply.code(400).send({ message: 'Passwords do not match' });
    }

    const name = `${firstName} ${lastName}`;
    const user = await authService.registerUser(email, password, name);
    return reply.code(201).send(user);
  },

  async registerOnboardHandler(request: FastifyRequest<{ Body: z.infer<typeof RegisterOnboardRequestSchema> }>, reply: FastifyReply) {
    try {
      const result = await authService.registerOnboard(request.body);
      return reply.code(201).send(result);
    } catch (error: any) {
      if (error.statusCode) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  },

  async login(request: FastifyRequest<{ Body: z.infer<typeof LoginRequest> }>, reply: FastifyReply) {
    const { email, password } = request.body;
    const result = await authService.login(email, password);
    return reply.send(result);
  },

  async selectOrganisation(request: FastifyRequest<{ Body: z.infer<typeof SelectOrganisationRequest> }>, reply: FastifyReply) {
    const { organisationId } = request.body;
    const userId = request.authContext.userId; 
    const result = await authService.selectOrganisation(userId, organisationId);
    return reply.send(result);
  },

  async selectLocation(request: FastifyRequest<{ Body: z.infer<typeof SelectLocationRequest> }>, reply: FastifyReply) {
    const { locationId } = request.body;
    const userId = request.authContext.userId;
    const result = await authService.selectLocation(userId, locationId);
    return reply.send(result);
  },

  async refreshTokens(request: FastifyRequest<{ Body: z.infer<typeof RefreshTokenRequest> }>, reply: FastifyReply) {
    const { refresh_token } = request.body;
    const result = await authService.refreshTokens(refresh_token);
    return reply.send(result);
  }
};
