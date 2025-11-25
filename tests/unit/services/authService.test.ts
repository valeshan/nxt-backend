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
    vi.spyOn(jwtUtils, 'verifyToken').mockReturnValue({ sub: 'u1', type: 'refresh_token_login' });
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'u1' } as any);

    const result = await authService.refreshTokens(token);

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
  });
});

