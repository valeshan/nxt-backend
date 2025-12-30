import { AuthContext } from '../plugins/authContext';

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext;
  }
}











