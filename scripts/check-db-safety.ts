/**
 * Database Safety Check Script
 *
 * Validates environment configuration to prevent accidental production database
 * operations. This script should be run before any risky DB operations.
 *
 * Usage: npm run check:db-safety
 */

// Load dotenv in non-production environments
if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
}

// Read environment variables safely with defaults
const nodeEnv = process.env.NODE_ENV || 'development';
const databaseUrl = process.env.DATABASE_URL || '';
const shadowUrl = process.env.SHADOW_DATABASE_URL || '';

/**
 * Check if a URL looks like a local development database
 */
const isLocalLike = (url: string): boolean => {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.includes('localhost') ||
    lowerUrl.includes('127.0.0.1') ||
    lowerUrl.includes('@postgres') || // docker service name
    lowerUrl.includes('postgres://postgres:')
  );
};

/**
 * Check if a URL looks like a hosted/production database
 */
const isHostedLike = (url: string): boolean => {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.includes('railway') ||
    lowerUrl.includes('aws') ||
    lowerUrl.includes('rds.') ||
    lowerUrl.includes('render.com') ||
    lowerUrl.includes('heroku') ||
    lowerUrl.includes('supabase')
  );
};

// Safety check 1: Production + Shadow DB (forbidden)
if (nodeEnv === 'production' && shadowUrl.trim() !== '') {
  console.error('❌ [check-db-safety] FAILED: Safety violation detected');
  console.error('');
  console.error('  What was detected:');
  console.error('    SHADOW_DATABASE_URL is set in production environment.');
  console.error('');
  console.error('  Why this is dangerous:');
  console.error(
    '    This enables migrate dev/reset commands against production by mistake.'
  );
  console.error('    Production should NEVER have SHADOW_DATABASE_URL set.');
  console.error('');
  console.error('  Action required:');
  console.error('    Remove SHADOW_DATABASE_URL from your production environment variables.');
  process.exit(1);
}

// Safety check 2: Production + Local-looking DB URL (suspicious)
if (nodeEnv === 'production' && isLocalLike(databaseUrl)) {
  console.error('❌ [check-db-safety] FAILED: Safety violation detected');
  console.error('');
  console.error('  What was detected:');
  console.error(
    '    DATABASE_URL looks like a local Docker or localhost DB while NODE_ENV=production.'
  );
  console.error('');
  console.error('  Why this is dangerous:');
  console.error('    This is likely misconfigured. Production should point to a hosted database.');
  console.error('');
  console.error('  Action required:');
  console.error('    Verify your DATABASE_URL points to the correct production database.');
  process.exit(1);
}

// Safety check 3: Non-production + Hosted-looking URL (suspicious)
if (nodeEnv !== 'production' && isHostedLike(databaseUrl)) {
  console.error('❌ [check-db-safety] FAILED: Safety violation detected');
  console.error('');
  console.error('  What was detected:');
  console.error(
    '    Non-production NODE_ENV but DATABASE_URL looks like a hosted/production DB.'
  );
  console.error('');
  console.error('  Why this is dangerous:');
  console.error(
    '    This might point to a real production DB from local/staging environment.'
  );
  console.error('    Accidental operations could affect production data.');
  console.error('');
  console.error('  Action required:');
  console.error('    Verify your DATABASE_URL is correct for your current environment.');
  process.exit(1);
}

// All checks passed
console.log('✅ [check-db-safety] All safety checks passed');
console.log('');
console.log('  Configuration summary:');
console.log(`    NODE_ENV = ${nodeEnv}`);
console.log(
  `    DATABASE_URL = ${databaseUrl ? (isLocalLike(databaseUrl) ? 'local/dev' : isHostedLike(databaseUrl) ? 'hosted/prod-like' : 'generic') : 'not set'}`
);
console.log(
  `    SHADOW_DATABASE_URL = ${shadowUrl ? 'set (dev-only, as expected)' : 'not set (correct for production)'}`
);
console.log('');
console.log('  Safe to proceed with database operations.');
process.exit(0);

