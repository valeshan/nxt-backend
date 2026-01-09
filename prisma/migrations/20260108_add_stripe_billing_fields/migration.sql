-- Stripe Billing Integration: Add Stripe fields to Organisation + BillingWebhookEvent table
-- This migration is multi-statement and wrapped in a single transaction.
-- This migration cannot partially apply silently.

BEGIN;

-- Step 1: Add Stripe billing columns to Organisation
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "stripePriceId" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "stripeSubscriptionStatus" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "cancelAtPeriodEnd" BOOLEAN DEFAULT false;

-- Step 2: Set default for cancelAtPeriodEnd on existing rows
UPDATE "Organisation"
SET "cancelAtPeriodEnd" = false
WHERE "cancelAtPeriodEnd" IS NULL;

-- Step 3: Make cancelAtPeriodEnd NOT NULL after backfill
ALTER TABLE "Organisation" ALTER COLUMN "cancelAtPeriodEnd" SET NOT NULL;

-- Step 4: Create BillingWebhookEvent table for idempotency
CREATE TABLE IF NOT EXISTS "BillingWebhookEvent" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "organisationId" TEXT,
  "processedAt" TIMESTAMPTZ,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- Step 5: Create indexes for BillingWebhookEvent
CREATE INDEX IF NOT EXISTS "BillingWebhookEvent_eventType_createdAt_idx" ON "BillingWebhookEvent"("eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "BillingWebhookEvent_organisationId_idx" ON "BillingWebhookEvent"("organisationId");

-- Step 6: Optional index on stripeCustomerId for lookups
CREATE INDEX IF NOT EXISTS "Organisation_stripeCustomerId_idx" ON "Organisation"("stripeCustomerId");

COMMIT;

