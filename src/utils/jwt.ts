import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export type AuthTokenType = 'login' | 'organisation' | 'location';

export interface TokenPayload {
  sub: string; // userId
  orgId?: string;
  locId?: string;
  tokenType: AuthTokenType;
  roles: string[];
  // Standard JWT claims
  iat?: number;
  exp?: number;
}

export function signAccessToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: string | number = '15m'): string {
  return jwt.sign(payload, config.JWT_VERIFY_SECRET, { expiresIn });
}

export function signRefreshToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: string | number = '7d'): string {
  return jwt.sign(payload, config.JWT_VERIFY_SECRET, { expiresIn });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.JWT_VERIFY_SECRET) as TokenPayload;
}
