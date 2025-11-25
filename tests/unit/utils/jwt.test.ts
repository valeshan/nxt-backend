import { describe, it, expect } from 'vitest';
import { signAccessToken, signRefreshToken, verifyToken } from '../../../src/utils/jwt';
import { config } from '../../../src/config/env';
import jwt from 'jsonwebtoken';

describe('JWT Utils', () => {
  it('should sign and verify access token', () => {
    const payload = { sub: 'user1', type: 'access_token_login' as const };
    const token = signAccessToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user1');
    expect(decoded.type).toBe('access_token_login');
  });

  it('should sign and verify refresh token', () => {
    const payload = { sub: 'user1', type: 'refresh_token_login' as const };
    const token = signRefreshToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user1');
    expect(decoded.type).toBe('refresh_token_login');
  });

  it('should fail for invalid signature', () => {
    const token = jwt.sign({ sub: 'user1' }, 'wrongsecret');
    expect(() => verifyToken(token)).toThrow();
  });
});

