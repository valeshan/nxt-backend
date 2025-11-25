import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { TokenType } from '../utils/jwt';

// Augment FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      orgId?: string;
      locationId?: string;
      tokenType?: TokenType;
    };
  }
}

const authFromJwt: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const authHeader = request.headers.authorization;

    // Dev Mode Bypass
    if (config.NODE_ENV === 'development' && !authHeader) {
      const userId = request.headers['x-user-id'];
      const orgId = request.headers['x-org-id'];
      // We can also support x-loc-id if needed, but prompt only mentioned x-user and x-org for bypass
      
      if (!userId) {
        return reply.status(401).send({
          error: { code: 'UNAUTHENTICATED', message: 'Missing x-user-id header in development mode' },
        });
      }

      request.user = {
        userId: String(userId),
        orgId: orgId ? String(orgId) : undefined,
        tokenType: 'access_token', // Mock type
      };
      return;
    }

    // Standard JWT Auth
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Missing or invalid Authorization header',
        },
      });
    }

    const token = authHeader.split(' ')[1];

    try {
      const payload = jwt.verify(token, config.JWT_VERIFY_SECRET) as jwt.JwtPayload & { orgId?: string; locId?: string; type?: TokenType };

      if (!payload.sub) {
        throw new Error('Missing sub in token');
      }

      const type = payload.type;
      
      // Reject refresh tokens
      if (type && type.startsWith('refresh_token')) {
         return reply.status(401).send({
          error: {
            code: 'INVALID_TOKEN',
            message: 'Refresh tokens cannot be used for access',
          },
        });
      }

      // Validate type is one of allowed access types if 'type' field exists
      // Legacy tokens might not have type? Assuming new system always has type.
      const allowedTypes = ['access_token_login', 'access_token_company', 'access_token'];
      if (type && !allowedTypes.includes(type)) {
         return reply.status(401).send({
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid token type',
          },
        });
      }

      request.user = {
        userId: payload.sub,
        orgId: payload.orgId,
        locationId: payload.locId,
        tokenType: type,
      };
    } catch (err) {
      return reply.status(401).send({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        },
      });
    }
  });
};

export default fp(authFromJwt);
