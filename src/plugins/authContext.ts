import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { verifyToken } from '../utils/jwt';

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
    const authHeader = request.headers.authorization;

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
