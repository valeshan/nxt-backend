import z from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_VERIFY_SECRET: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(32), // Enforce some length for security
  PORT: z.coerce.number().default(4001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

