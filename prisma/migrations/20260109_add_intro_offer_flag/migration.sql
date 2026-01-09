-- Add intro-offer consumption flag to Organisation
-- Single-statement migration (atomic in Postgres).
ALTER TABLE "Organisation"
ADD COLUMN IF NOT EXISTS "hasUsedIntroOffer" BOOLEAN NOT NULL DEFAULT false;


