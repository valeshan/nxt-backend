-- Entitlements foundation: plan/billing fields, overrides, and indexes
-- This migration is multi-statement and wrapped in a single transaction.
-- This migration cannot partially apply silently.

BEGIN;

-- Step 1: Add columns without defaults (avoids race during backfill)
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "planKey" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "billingState" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMPTZ;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "currentPeriodEndsAt" TIMESTAMPTZ;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "graceEndsAt" TIMESTAMPTZ;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "entitlementOverrides" JSONB;

-- Step 2: Backfill existing rows to legacy (grandfathered) and billingState=free
UPDATE "Organisation"
SET "planKey" = 'legacy'
WHERE "planKey" IS NULL;

UPDATE "Organisation"
SET "billingState" = 'free'
WHERE "billingState" IS NULL;

-- Step 3: Add defaults and NOT NULL constraints for future inserts
ALTER TABLE "Organisation" ALTER COLUMN "planKey" SET DEFAULT 'free';
ALTER TABLE "Organisation" ALTER COLUMN "planKey" SET NOT NULL;

ALTER TABLE "Organisation" ALTER COLUMN "billingState" SET DEFAULT 'free';
ALTER TABLE "Organisation" ALTER COLUMN "billingState" SET NOT NULL;

-- Step 4: Indexes
CREATE INDEX IF NOT EXISTS "Organisation_planKey_idx" ON "Organisation" ("planKey");

COMMIT;

