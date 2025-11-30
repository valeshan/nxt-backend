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

// Access Token: 15 minutes - Authorization & frequent rotation
export const ACCESS_TOKEN_TTL_SECONDS = 900;

// Refresh Token: 30 days - Maximum session inactivity window
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export function signAccessToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: string | number = ACCESS_TOKEN_TTL_SECONDS): string {
  return jwt.sign(payload as object, config.JWT_VERIFY_SECRET, { expiresIn: typeof expiresIn === 'number' ? expiresIn : parseInt(String(expiresIn)) });
}

export function signRefreshToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: string | number = REFRESH_TOKEN_TTL_SECONDS): string {
  return jwt.sign(payload as object, config.JWT_VERIFY_SECRET, { expiresIn: typeof expiresIn === 'number' ? expiresIn : parseInt(String(expiresIn)) });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.JWT_VERIFY_SECRET) as TokenPayload;
}
