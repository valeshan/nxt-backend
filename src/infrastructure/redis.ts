import Redis, { RedisOptions } from 'ioredis';
import { config } from '../config/env';

let sharedClient: Redis | null = null;
let bullMqClient: Redis | null = null;

function buildRedisOptions(overrides?: RedisOptions): RedisOptions {
  return {
    // ioredis defaults are fine; override per-purpose as needed
    ...overrides,
  };
}

function createRedisClient(options?: RedisOptions): Redis {
  const opts = buildRedisOptions(options);

  if (config.REDIS_URL) {
    return new Redis(config.REDIS_URL, opts);
  }

  // Dev-friendly fallback (local redis)
  return new Redis({
    host: config.REDIS_HOST || 'localhost',
    port: config.REDIS_PORT || 6379,
    password: config.REDIS_PASSWORD,
    ...opts,
  });
}

/**
 * Shared Redis client for application concerns:
 * - rate limiting
 * - readiness checks
 * - cron distributed locks
 */
export function getRedisClient(): Redis {
  if (!sharedClient) {
    sharedClient = createRedisClient();
  }
  return sharedClient;
}

/**
 * Dedicated Redis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest=null.
 */
export function getBullMqRedisClient(): Redis {
  if (!bullMqClient) {
    bullMqClient = createRedisClient({ maxRetriesPerRequest: null });
  }
  return bullMqClient;
}

export async function pingWithTimeout(
  client: Redis,
  timeoutMs: number,
  retries: number
): Promise<{ ok: boolean; error?: string }> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await Promise.race([
        client.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`redis ping timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);

      if (result === 'PONG') return { ok: true };
      return { ok: false, error: `unexpected ping response: ${String(result)}` };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: (lastErr as Error)?.message || String(lastErr) };
}

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export async function acquireLock(params: {
  key: string;
  value: string;
  ttlMs: number;
  client?: Redis;
}): Promise<boolean> {
  const client = params.client ?? getRedisClient();
  const res = await client.set(params.key, params.value, 'PX', params.ttlMs, 'NX');
  return res === 'OK';
}

export async function releaseLock(params: {
  key: string;
  value: string;
  client?: Redis;
}): Promise<boolean> {
  const client = params.client ?? getRedisClient();
  const res = await client.eval(RELEASE_LOCK_LUA, 1, params.key, params.value);
  return Number(res) === 1;
}

export async function closeRedisClients(): Promise<void> {
  const toClose: Redis[] = [];
  if (sharedClient) toClose.push(sharedClient);
  if (bullMqClient && bullMqClient !== sharedClient) toClose.push(bullMqClient);

  sharedClient = null;
  bullMqClient = null;

  await Promise.allSettled(toClose.map((c) => c.quit()));
}



