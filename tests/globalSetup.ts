import { execSync } from 'node:child_process';
import dotenv from 'dotenv';

// Load .env.local for development, or .env.test for tests
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: '.env.local' });
  // Fallback to .env.test if .env.local doesn't exist
  if (!process.env.DATABASE_URL) {
    dotenv.config({ path: '.env.test' });
  }
}

function sanitizeDatabaseUrl(raw?: string): string {
  if (!raw) return '(missing DATABASE_URL)';
  try {
    // Handles URLs like: postgresql://user:pass@host:5432/db?schema=public
    const u = new URL(raw);
    const host = u.hostname || '(no-host)';
    const port = u.port ? `:${u.port}` : '';
    const db = u.pathname?.replace(/^\//, '') || '(no-db)';
    return `${u.protocol}//${host}${port}/${db}`;
  } catch {
    // For non-URL formats, avoid printing the raw string (could contain creds).
    return '(unparseable DATABASE_URL)';
  }
}

export default async function globalSetup() {
  // Guardrail: never allow accidental prod migrations from tests.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run Prisma migrations in production NODE_ENV');
  }

  // Validate DATABASE_URL is set
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for tests. Please set it in .env.local or .env.test'
    );
  }

  // Apply existing migrations to the current DATABASE_URL (non-interactive).
  // Note: tests use schema.dev.prisma so shadow DB is not used here.
  // eslint-disable-next-line no-console
  console.log(`[vitest.globalSetup] Applying prisma migrations to ${sanitizeDatabaseUrl(process.env.DATABASE_URL)}`);
  execSync('npx prisma migrate deploy --schema prisma/schema.dev.prisma', {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
}
