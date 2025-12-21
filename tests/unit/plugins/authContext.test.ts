import { describe, it, expect } from 'vitest';
import fastify from 'fastify';
import authContext from '../../../src/plugins/authContext';
import jwt from 'jsonwebtoken';
import { config } from '../../../src/config/env';

describe('Auth Context Plugin', () => {
  const createTestApp = async () => {
    const app = fastify();
    await app.register(authContext);
    return app;
  };

  it('should attach authContext to request on valid token', async () => {
    const app = await createTestApp();
    app.get('/test', async (req) => {
      return { authContext: req.authContext };
    });

    const payload = { 
      sub: 'u1', 
      orgId: 'o1', 
      tokenType: 'login', 
      roles: ['user'] 
    };
    const token = jwt.sign(payload, config.JWT_VERIFY_SECRET);

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authContext).toEqual({
      userId: 'u1',
      organisationId: 'o1',
      locationId: null,
      tokenType: 'login',
      roles: ['user']
    });
  });

  it('should return 401 on missing Authorization header', async () => {
    const app = await createTestApp();
    app.get('/test', async () => 'ok');

    const res = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid Authorization header' },
    });
  });

  it('should return 401 on invalid token', async () => {
    const app = await createTestApp();
    app.get('/test', async () => 'ok');

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        Authorization: 'Bearer invalid.token.here',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
    });
  });
});
