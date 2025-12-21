import z from 'zod';
import dotenv from 'dotenv';

if (process.env.NODE_ENV === 'development') {
  dotenv.config({ path: '.env.local' });
} else {
  dotenv.config();
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Expected format for production (Railway Postgres):
  // postgresql://user:pass@host:port/db?connection_limit=5&pool_timeout=10
  // Notes:
  // - This configures Prisma's internal connection pool (not PgBouncer).
  // - Scaling: Total connections ~= (app instances + workers/job processes) x connection_limit < Railway limit (~97).
  JWT_VERIFY_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  PORT: z.coerce.number().default(4001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  XERO_REDIRECT_URI: z.string().optional(),
  XERO_WEBHOOK_SECRET: z.string().optional(), // Added XERO_WEBHOOK_SECRET
  APP_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional().default('https://app.thenxt.ai'),
  XERO_SYNC_TIMEOUT_MINUTES: z.coerce.number().default(60),
  
  // AWS Configuration
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  S3_INVOICE_BUCKET: z.string().optional().default('nxt-invoices-dev'),

  // Pusher Configuration
  PUSHER_APP_ID: z.string().optional(),
  PUSHER_KEY: z.string().optional(),
  PUSHER_SECRET: z.string().optional(),
  PUSHER_CLUSTER: z.string().optional().default('ap4'),
  
  // Feature Flags
  ENABLE_XERO_OCR: z.string().optional().default('false'),
  ENABLE_DIAGNOSTICS: z.string().optional().default('false'),

  // Infrastructure
  REDIS_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ENABLE_RATE_LIMIT: z.string().optional().default('true'),
  CRON_ENABLED: z.string().optional().default('true'),

  // Prisma slow query logging (backend)
  // - In production, we do NOT log SQL text or params; only duration + query hash.
  PRISMA_SLOW_QUERY_LOGGING: z.string().optional().default('true'),
  PRISMA_SLOW_MS: z.coerce.number().optional().default(800),

  // Email Configuration (Gmail SMTP)
  GMAIL_ALERTS_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  EMAIL_FROM_NAME: z.string().optional().default('the nxt alerts'),
  EMAIL_REPLY_TO: z.string().optional(),

  // Debug Routes
  DEBUG_ROUTE_SECRET: z.string().optional(),
  DEBUG_ROUTES_ENABLED: z.string().optional().default('false'),

  // Price Alert Configuration
  PRICE_ALERT_CRON_ENABLED: z.string().optional().default('false'),
  PRICE_ALERT_DEDUPE_DAYS: z.coerce.number().optional().default(14),
  PRICE_ALERT_RECENCY_DAYS: z.coerce.number().optional().default(14),

  // Mailgun Configuration (Inbound)
  MAILGUN_WEBHOOK_SIGNING_KEY: z.string().optional().default(''),
  MAILGUN_API_KEY: z.string().optional().default(''),
  MAILGUN_DOMAIN: z.string().optional().default('inbound.thenxt.ai'),
  MAILGUN_WEBHOOK_ENABLED: z.string().optional().default('true'),
  MAILGUN_PROCESSOR_ENABLED: z.string().optional().default('true'),
  MAILGUN_MAX_ATTACHMENTS: z.coerce.number().optional().default(10),
  MAILGUN_MAX_TOTAL_SIZE_MB: z.coerce.number().optional().default(40),

  // Redis Configuration (For Queues)
  // If REDIS_URL is provided, we can parse it, or use specific host/port
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().optional(),
  REDIS_PASSWORD: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

const baseConfig = parsed.data;

// Conditional validation:
// - In production, Redis is required (rate limiting + BullMQ + cron locks).
if (baseConfig.NODE_ENV === 'production' && !baseConfig.REDIS_URL) {
  console.error('❌ Invalid environment variables: REDIS_URL is required when NODE_ENV=production');
  process.exit(1);
}

export const config = baseConfig;
