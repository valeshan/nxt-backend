import { describe, it, expect, vi } from 'vitest';
import fastify from 'fastify';
import authFromJwt from '../../../src/plugins/authFromJwt';

// Mock config to force development mode
vi.mock('../../../src/config/env', () => ({
  config: {
    NODE_ENV: 'development',
    JWT_VERIFY_SECRET: 'secret', // required by imports even if not used in dev path
  }
}));

describe('Auth Plugin (Development Mode)', () => {
  it('should return 401 if x-user-id is missing', async () => {
    const app = fastify();
    app.register(authFromJwt);
    app.get('/test', async () => 'ok');

    const res = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    expect(res.json().error.message).toBe('Missing x-user-id header in development mode');
  });

  it('should authenticate with x-user-id and x-org-id', async () => {
    const app = fastify();
    app.register(authFromJwt);
    app.get('/test', async (req) => {
       return { user: req.user };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        'x-user-id': 'u1',
        'x-org-id': 'o1'
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ userId: 'u1', orgId: 'o1', tokenType: 'access_token' });
  });

  it('should authenticate with only x-user-id', async () => {
    const app = fastify();
    app.register(authFromJwt);
    app.get('/test', async (req) => {
       return { user: req.user };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        'x-user-id': 'u1',
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ userId: 'u1', tokenType: 'access_token' });
  });
});

