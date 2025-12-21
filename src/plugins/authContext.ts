import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { config } from '../config/env';

export type AuthContext = {
  userId: string;
  organisationId?: string | null;
  locationId?: string | null;
  tokenType: 'login' | 'organisation' | 'location';
  roles: string[];
};

const authContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('authContext', null);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // Legacy headers are not part of the BE2 auth model.
    // In dev, hard-fail fast if they are present to force cleanup.
    // In prod, ignore silently to avoid noisy logs and accidental coupling.
    if (config.NODE_ENV !== 'production') {
      const hasLegacy =
        Boolean(request.headers['x-user-id']) ||
        Boolean(request.headers['x-org-id']) ||
        Boolean(request.headers['x-location-id']);
      if (hasLegacy) {
        return reply.status(400).send({
          error: {
            code: 'LEGACY_AUTH_HEADERS_NOT_ALLOWED',
            message: 'Legacy auth headers (x-user-id/x-org-id/x-location-id) are not supported. Use Authorization: Bearer <token>.',
          },
        });
      }
    }

    const authHeader = request.headers.authorization;
    let token: string | undefined;

    // 1. Check Authorization header
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Missing or invalid Authorization header',
        },
      });
    }

    try {
      const payload = verifyToken(token);

      if (!payload.sub) {
        throw new Error('Missing sub in token');
      }

      const authContext: AuthContext = {
        userId: payload.sub,
        organisationId: payload.orgId || null,
        locationId: payload.locId || null,
        tokenType: payload.tokenType,
        roles: payload.roles || [],
      };

      request.authContext = authContext;
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

export default fp(authContextPlugin);
