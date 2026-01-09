import Stripe from 'stripe';

/**
 * Stripe Service
 * 
 * Centralized Stripe client and helper functions.
 * All Stripe interactions go through this service.
 */

// Environment validation
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_BILLING_ENABLED = process.env.STRIPE_BILLING_ENABLED === 'true';

if (!STRIPE_SECRET_KEY && process.env.NODE_ENV === 'production') {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set - billing features disabled');
}

if (!STRIPE_WEBHOOK_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[Stripe] STRIPE_WEBHOOK_SECRET not set - webhook verification disabled');
}

/**
 * Stripe client instance
 * Lazily initialized to avoid errors when keys are not set
 */
let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!stripeClient) {
    if (!STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    stripeClient = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: '2025-12-15.clover',
      typescript: true,
    });
  }
  return stripeClient;
}

/**
 * Check if Stripe billing is enabled
 * Use this as a kill-switch to disable billing flows
 */
export function isStripeEnabled(): boolean {
  return STRIPE_BILLING_ENABLED && !!STRIPE_SECRET_KEY;
}

/**
 * Determine Stripe key mode from STRIPE_SECRET_KEY.
 * Stripe test and live environments are fully separated (objects/IDs do not overlap).
 */
export function getStripeKeyMode(): 'live' | 'test' | 'unknown' {
  if (!STRIPE_SECRET_KEY) return 'unknown';
  if (STRIPE_SECRET_KEY.startsWith('sk_live_')) return 'live';
  if (STRIPE_SECRET_KEY.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

export function isStripeLiveMode(): boolean {
  return getStripeKeyMode() === 'live';
}

/**
 * Get webhook secret for signature verification
 */
export function getWebhookSecret(): string {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return STRIPE_WEBHOOK_SECRET;
}

/**
 * Verify webhook signature and construct event
 */
export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Stripe.Event {
  const stripe = getStripeClient();
  const webhookSecret = getWebhookSecret();
  
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

/**
 * Frontend URL for success/cancel redirects
 * 
 * Priority:
 * 1. FRONTEND_URL env var (explicit override)
 * 2. APP_ENV-based detection:
 *    - development/local: http://localhost:3000
 *    - staging: https://staging.thenxt.ai
 *    - production: https://dashboard.thenxt.ai
 */
export function getFrontendUrl(): string {
  // Allow explicit override via env var
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL;
  }

  // Detect environment. NOTE: many hosts set NODE_ENV=production even for staging,
  // so prefer explicit envs that encode environment name.
  const env =
    process.env.APP_ENV ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    'development';
  
  switch (env) {
    case 'production':
      return 'https://dashboard.thenxt.ai';
    case 'staging':
    case 'preview':
      return 'https://staging.thenxt.ai';
    case 'development':
    case 'local':
    default:
      return 'http://localhost:3000';
  }
}

/**
 * Get current environment identifier for metadata
 */
export function getEnvironment(): string {
  return (
    process.env.APP_ENV ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    'development'
  );
}

// Re-export Stripe types for convenience
export { Stripe };

