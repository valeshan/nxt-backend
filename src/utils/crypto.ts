import crypto from 'node:crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';

// Key must be 32 bytes for aes-256-gcm.
// If the provided key is hex, we decode it. If it's just a string, we might need to hash it or ensure it's 32 bytes.
// For simplicity and security, we expect a 32-byte hex string or ensure we create a Buffer properly.
// Here we assume the env var is provided as a hex string of 32 bytes (64 hex chars) or just a raw string that we might need to treat carefully.
// Let's assume it's a 64-char hex string representing 32 bytes.
const getKey = () => {
  const key = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) {
    // If not hex or not 32 bytes, fallback/throw or handle.
    // If the user provides a plain string, we could hash it to get 32 bytes.
    // For robust implementation, let's hash whatever is provided to ensure 32 bytes.
    return crypto.createHash('sha256').update(config.TOKEN_ENCRYPTION_KEY).digest();
  }
  return key;
};

const KEY = getKey();

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  
  let encrypted = cipher.update(plain, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Format: iv:content:authTag
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

export function decryptToken(cipherText: string): string {
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  
  const [ivHex, encrypted, authTagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

