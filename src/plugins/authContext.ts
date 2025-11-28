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
    let token: string | undefined;

    // 1. Check Authorization header
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } 
    // 2. Check access_token cookie (if header missing)
    else if (request.cookies && request.cookies.access_token) {
      token = request.cookies.access_token;
    }

    if (!token) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Missing or invalid Authorization header/cookie',
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
