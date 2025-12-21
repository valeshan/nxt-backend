import { describe, it, expect } from 'vitest';
import { signAccessToken, signRefreshToken, verifyRefreshToken, verifyToken } from '../../../src/utils/jwt';
import jwt from 'jsonwebtoken';

describe('JWT Utils', () => {
  it('should sign and verify access token', () => {
    const payload = { sub: 'user1', tokenType: 'login' as const, roles: [], tokenVersion: 0 };
    const token = signAccessToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user1');
    expect(decoded.tokenType).toBe('login');
  });

  it('should sign and verify refresh token', () => {
    const payload = { sub: 'user1', tokenType: 'login' as const, roles: [], tokenVersion: 0 };
    const token = signRefreshToken(payload);
    const decoded = verifyRefreshToken(token);
    expect(decoded.sub).toBe('user1');
    expect(decoded.tokenType).toBe('login');
  });

  it('should fail for invalid signature', () => {
    const token = jwt.sign({ sub: 'user1' }, 'wrongsecret');
    expect(() => verifyToken(token)).toThrow();
  });
});
