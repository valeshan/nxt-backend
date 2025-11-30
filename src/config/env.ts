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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
