import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

// Augment FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      orgId?: string;
    };
  }
}

const authFromJwt: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // Skip auth for specific routes if needed (e.g. health), but here we apply to registered routes.
    // Ideally, we register this plugin on a scope or use verify where needed. 
    // The plan says "Register auth plugin on these routes" (xeroRoutes). 
    // But here we implement the logic. We can make it a decorator or a hook.
    // The plan says "Fastify plugin that Reads Authorization header...".
    // We'll implement it as a plugin that adds an 'onRequest' hook.
    // However, if we register it globally, it affects all routes.
    // The user said "Register auth plugin on these routes" in the routes section.
    // So this plugin will probably be registered in the scope of the xero routes.
    
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
      const payload = jwt.verify(token, config.JWT_VERIFY_SECRET) as jwt.JwtPayload;
      
      if (!payload.sub) {
         throw new Error('Missing sub in token');
      }

      request.user = {
        userId: payload.sub,
        orgId: payload.orgId,
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

