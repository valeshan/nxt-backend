import z from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_VERIFY_SECRET: z.string().min(1),
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

  // Infrastructure
  REDIS_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
