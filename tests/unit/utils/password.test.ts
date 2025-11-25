import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/utils/password';

describe('Password Utils', () => {
  it('should hash and verify password', async () => {
    const pass = 'secret123';
    const hash = await hashPassword(pass);
    expect(hash).not.toBe(pass);
    
    const valid = await verifyPassword(pass, hash);
    expect(valid).toBe(true);

    const invalid = await verifyPassword('wrong', hash);
    expect(invalid).toBe(false);
  });
});

