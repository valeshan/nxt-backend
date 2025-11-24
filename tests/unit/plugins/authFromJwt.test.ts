import { describe, it, expect, vi } from 'vitest';
import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import authFromJwt from '../../../src/plugins/authFromJwt';
import jwt from 'jsonwebtoken';
import { config } from '../../../src/config/env';

describe('Auth Plugin', () => {
  it('should attach user to request on valid token', async () => {
    const app = fastify();
    app.register(authFromJwt);
    app.get('/test', async (req) => {
      return { user: req.user };
    });

    const token = jwt.sign({ sub: 'u1', orgId: 'o1' }, config.JWT_VERIFY_SECRET);

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { userId: 'u1', orgId: 'o1' } });
  });

  it('should return 401 on missing header', async () => {
    const app = fastify();
    app.register(authFromJwt);
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
    const app = fastify();
    app.register(authFromJwt);
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

