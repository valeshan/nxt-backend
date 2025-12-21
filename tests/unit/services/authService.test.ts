import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authService } from '../../../src/services/authService';
import { userRepository } from '../../../src/repositories/userRepository';
import { userOrganisationRepository } from '../../../src/repositories/userOrganisationRepository';
import { locationRepository } from '../../../src/repositories/locationRepository';
import { userSettingsRepository } from '../../../src/repositories/userSettingsRepository';
import { organisationRepository } from '../../../src/repositories/organisationRepository';
import { hashPassword } from '../../../src/utils/password';
import * as jwtUtils from '../../../src/utils/jwt';

vi.mock('../../../src/repositories/userRepository');
vi.mock('../../../src/repositories/userOrganisationRepository');
vi.mock('../../../src/repositories/locationRepository');
vi.mock('../../../src/repositories/userSettingsRepository');
vi.mock('../../../src/repositories/organisationRepository');

describe('Auth Service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('login should return tokens on success', async () => {
    const mockUser = { id: 'u1', email: 'test@test.com', passwordHash: await hashPassword('pass') };
    vi.mocked(userRepository.findByEmail).mockResolvedValue(mockUser as any);
    vi.mocked(organisationRepository.listForUser).mockResolvedValue([]);

    const result = await authService.login('test@test.com', 'pass');

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(result.user_id).toBe('u1');
  });

  it('login should fail with invalid password', async () => {
    const mockUser = { id: 'u1', email: 'test@test.com', passwordHash: await hashPassword('pass') };
    vi.mocked(userRepository.findByEmail).mockResolvedValue(mockUser as any);

    await expect(authService.login('test@test.com', 'wrong')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refreshTokens should rotate tokens correctly', async () => {
    const token = 'valid_refresh_token';
    // Update mock to include tokenType: 'login'
    vi.spyOn(jwtUtils, 'verifyRefreshToken').mockReturnValue({ 
        sub: 'u1', 
        tokenType: 'login', // Changed from type: 'refresh_token_login'
        roles: [],
        tokenVersion: 0,
    } as any);
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'u1', tokenVersion: 0 } as any);

    const result = await authService.refreshTokens(token);

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
  });

  it('refreshTokens should reject when tokenVersion mismatches (revoked)', async () => {
    const token = 'revoked_refresh_token';
    vi.spyOn(jwtUtils, 'verifyRefreshToken').mockReturnValue({
      sub: 'u1',
      tokenType: 'login',
      roles: [],
      tokenVersion: 0,
    } as any);
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'u1', tokenVersion: 1 } as any);

    await expect(authService.refreshTokens(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refreshTokens should not increment tokenVersion (should re-issue with same version)', async () => {
    const token = 'valid_refresh_token';
    vi.spyOn(jwtUtils, 'verifyRefreshToken').mockReturnValue({
      sub: 'u1',
      tokenType: 'login',
      roles: [],
      tokenVersion: 7,
    } as any);
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'u1', tokenVersion: 7 } as any);

    const signAccessSpy = vi.spyOn(jwtUtils, 'signAccessToken').mockReturnValue('new_access_token' as any);
    const signRefreshSpy = vi.spyOn(jwtUtils, 'signRefreshToken').mockReturnValue('new_refresh_token' as any);

    const result = await authService.refreshTokens(token);
    expect(result.access_token).toBe('new_access_token');
    expect(result.refresh_token).toBe('new_refresh_token');

    expect(signAccessSpy).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1', tokenVersion: 7 }));
    expect(signRefreshSpy).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1', tokenVersion: 7 }));
  });
});
