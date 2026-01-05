import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '../config/env';
import crypto from 'crypto';
import { getRequestContext } from './requestContext';

// Prevent multiple instances of Prisma Client in development
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const prisma =
  global.prisma ||
  new PrismaClient({
    log: [
      // Keep query events enabled so $on('query') works; control noise in listener.
      { emit: 'event', level: 'query' },
      'error',
      'warn',
    ],
  });

// Query logging:
// - Dev: log query text (truncated) + timing (never log params)
// - Prod: only log slow queries, without SQL text (hash only) to avoid leaking sensitive literals
(prisma as any).$on('query', (e: Prisma.QueryEvent) => {
  if (config.NODE_ENV === 'development') {
    console.log(`[PRISMA] ${e.duration}ms | ${e.query.slice(0, 200)}`);
    return;
  }

  const slowMs = Number(process.env.PRISMA_SLOW_MS || 800);
  const enabled = (process.env.PRISMA_SLOW_QUERY_LOGGING || 'true') === 'true';
  if (!enabled) return;

  if (e.duration > slowMs) {
    const ctx = getRequestContext();
    const qhash = crypto.createHash('sha256').update(e.query).digest('hex').slice(0, 12);
    // Prisma QueryEvent sometimes includes `target` depending on version.
    const target = (e as any).target ? ` | target=${String((e as any).target)}` : '';
    const req =
      ctx?.requestId ? ` | req=${ctx.requestId}` : '';
    const route =
      ctx?.route ? ` | route=${ctx.method} ${ctx.route}` : '';
    const tenant =
      ctx?.organisationId || ctx?.locationId
        ? ` | org=${ctx.organisationId ?? ''} loc=${ctx.locationId ?? ''}`.trim()
        : '';
    console.warn(`[PRISMA SLOW] ${e.duration}ms${target} | qhash=${qhash}${req}${route}${tenant}`);
  }
});

if (config.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export default prisma;