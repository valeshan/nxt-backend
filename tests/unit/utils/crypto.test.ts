import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../../../src/utils/crypto';

describe('Crypto Utils', () => {
  it('should encrypt and decrypt successfully', () => {
    const original = 'my-secret-token';
    const encrypted = encryptToken(original);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(original);
  });

  it('should produce different outputs for same input (random IV)', () => {
    const original = 'same-secret';
    const enc1 = encryptToken(original);
    const enc2 = encryptToken(original);
    expect(enc1).not.toBe(enc2);
    const dec1 = decryptToken(enc1);
    const dec2 = decryptToken(enc2);
    expect(dec1).toBe(original);
    expect(dec2).toBe(original);
  });

  it('should throw error on malformed token', () => {
    expect(() => decryptToken('invalid-format')).toThrow();
    expect(() => decryptToken('part1:part2')).toThrow(); // needs 3 parts
  });
});

