-- Migration: Location-scoped access and invite locations
-- Notes:
-- - Wrapped in a single transaction.
-- - Uses presence checks to avoid failures on existing deployments.
-- - This migration cannot partially apply silently.

BEGIN;

-- Ensure pgcrypto for gen_random_uuid
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1) Add locationIds to OrganisationInvite
ALTER TABLE "OrganisationInvite"
ADD COLUMN IF NOT EXISTS "locationIds" TEXT[] NOT NULL DEFAULT '{}';

-- 2) UserLocationAccess table (TEXT PKs to match existing models)
CREATE TABLE IF NOT EXISTS "UserLocationAccess" (
  "id"             TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"         TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "locationId"     TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "UserLocationAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
  CONSTRAINT "UserLocationAccess_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation" ("id") ON DELETE CASCADE,
  CONSTRAINT "UserLocationAccess_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE CASCADE
);

-- 3) Indexes and uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS "UserLocationAccess_user_location_idx"
ON "UserLocationAccess" ("userId", "locationId");

CREATE INDEX IF NOT EXISTS "UserLocationAccess_org_user_idx"
ON "UserLocationAccess" ("organisationId", "userId");

COMMIT;

