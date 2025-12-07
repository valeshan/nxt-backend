import { FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../services/authService';
import { LoginRequest, RegisterRequest, SelectOrganisationRequest, SelectLocationRequest, RefreshTokenRequest, RegisterOnboardRequestSchema, UpdateProfileRequest, ChangePasswordRequest } from '../dtos/authDtos';
import { z } from 'zod';

export const authController = {
  async register(request: FastifyRequest<{ Body: z.infer<typeof RegisterRequest> }>, reply: FastifyReply) {
    const { email, password, firstName, lastName, confirmPassword } = request.body;
    
    if (password !== confirmPassword) {
        return reply.code(400).send({ message: 'Passwords do not match' });
    }

    const user = await authService.registerUser(email, password, firstName, lastName);
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

  async me(request: FastifyRequest, reply: FastifyReply) {
    const { userId, organisationId, locationId, tokenType } = request.authContext;
    console.log(`[AuthController] me called for userId: ${userId}`, {
      organisationId,
      locationId,
      tokenType,
    });
    const result = await authService.getMe(userId, {
      organisationId,
      locationId,
      tokenType,
    });
    return reply.send(result);
  },

  async updateProfile(request: FastifyRequest<{ Body: z.infer<typeof UpdateProfileRequest> }>, reply: FastifyReply) {
    const { firstName, lastName } = request.body;
    const userId = request.authContext.userId;
    const result = await authService.updateProfile(userId, { firstName, lastName });
    return reply.send(result);
  },

  async changePassword(request: FastifyRequest<{ Body: z.infer<typeof ChangePasswordRequest> }>, reply: FastifyReply) {
    const { oldPassword, newPassword } = request.body;
    const userId = request.authContext.userId;
    const result = await authService.changePassword(userId, oldPassword, newPassword);
    return reply.send(result);
  },

  async selectOrganisation(request: FastifyRequest<{ Body: z.infer<typeof SelectOrganisationRequest> }>, reply: FastifyReply) {
    const { organisationId } = request.body;
    const userId = request.authContext.userId; 
    console.log(`[AuthController] selectOrganisation called for user ${userId}, org ${organisationId}`);
    const result = await authService.selectOrganisation(userId, organisationId);
    console.log(`[AuthController] selectOrganisation result locations: ${result.locations?.length}`);
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
    try {
      const result = await authService.refreshTokens(refresh_token);
      return reply.send(result);
    } catch (error: any) {
      // Handle Database Instability
      if (error.code === 'P1001' || error.code === 'P1017') {
        request.log.error({
          msg: 'Database unavailable during token refresh',
          error: error.message,
          code: error.code
        });
        return reply.status(503).send({ 
          error: 'Database unavailable',
          message: 'Service temporarily unavailable during refresh.',
          code: error.code
        });
      }
      throw error;
    }
  }
};
