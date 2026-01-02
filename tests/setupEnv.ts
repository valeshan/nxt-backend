import { randomBytes } from 'crypto';

// Vitest bootstraps before app/config imports.
// Ensure new required env var exists for Tier 2 JWT split.
if (!process.env.JWT_REFRESH_SECRET) {
  // IMPORTANT: keep this distinct from JWT_VERIFY_SECRET so tests catch accidental secret reuse.
  process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('base64');
}

// Avoid rate limiting interfering with automated tests.
// Rate limiting is validated via manual smoke tests instead.
if (!process.env.ENABLE_RATE_LIMIT) {
  process.env.ENABLE_RATE_LIMIT = 'false';
}

// Provide default Xero config for tests (tests don't need real Xero credentials)
if (!process.env.XERO_CLIENT_ID) {
  process.env.XERO_CLIENT_ID = 'test-client-id';
}

if (!process.env.XERO_REDIRECT_URI) {
  process.env.XERO_REDIRECT_URI = 'http://localhost:3000/xero/authorise';
}
