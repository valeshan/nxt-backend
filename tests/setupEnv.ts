import { randomBytes } from 'crypto';

// Vitest bootstraps before app/config imports.
// Ensure new required env var exists for Tier 2 JWT split.
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET =
    process.env.JWT_VERIFY_SECRET || randomBytes(48).toString('base64');
}

