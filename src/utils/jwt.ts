import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export type AuthTokenType = 'login' | 'organisation' | 'location';

export interface TokenPayload {
  sub: string; // userId
  orgId?: string;
  locId?: string;
  tokenType: AuthTokenType;
  roles: string[];
  tokenVersion: number;
  // Standard JWT claims
  iat?: number;
  exp?: number;
}

// Access Token: 90 minutes - Authorization & frequent rotation
export const ACCESS_TOKEN_TTL_SECONDS = 5400;

// Refresh Token: 30 days - Maximum session inactivity window
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export function signAccessToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: string | number = ACCESS_TOKEN_TTL_SECONDS): string {
  return jwt.sign(payload as object, config.JWT_VERIFY_SECRET, { expiresIn: typeof expiresIn === 'number' ? expiresIn : parseInt(String(expiresIn)) });
}

export function signRefreshToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: string | number = REFRESH_TOKEN_TTL_SECONDS): string {
  return jwt.sign(payload as object, config.JWT_REFRESH_SECRET, { expiresIn: typeof expiresIn === 'number' ? expiresIn : parseInt(String(expiresIn)) });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.JWT_VERIFY_SECRET) as unknown as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, config.JWT_REFRESH_SECRET) as unknown as TokenPayload;
}
