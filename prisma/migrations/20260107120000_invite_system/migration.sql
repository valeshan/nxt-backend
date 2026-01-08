-- Migration: Invite system + seat limits
-- Notes:
-- - Multi-statement migration wrapped in a single transaction (BEGIN/COMMIT).
-- - Uses presence checks to avoid duplicate-type failures.
-- - This migration cannot partially apply silently.

BEGIN;

-- Ensure pgcrypto for gen_random_uuid
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1) Enum for revoke reasons
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'InviteRevokeReason' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE "InviteRevokeReason" AS ENUM ('MANUAL', 'RESEND', 'EXPIRED');
  END IF;
END
$$;

ALTER TABLE "Organisation"
ADD COLUMN IF NOT EXISTS "seatLimit" INTEGER NOT NULL DEFAULT 5;

-- 3) OrganisationInvite table
CREATE TABLE IF NOT EXISTS "OrganisationInvite" (
    "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "organisationId"      TEXT NOT NULL,
    "email"               TEXT NOT NULL,
    "role"                "OrganisationRole" NOT NULL DEFAULT 'member',
    "tokenHash"           TEXT NOT NULL UNIQUE,
    "expiresAt"           TIMESTAMPTZ NOT NULL,
    "acceptedAt"          TIMESTAMPTZ,
    "revokedAt"           TIMESTAMPTZ,
    "revokedReason"       "InviteRevokeReason",
    "replacedByInviteId"  TEXT,
    "createdByUserId"     TEXT NOT NULL,
    "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "OrganisationInvite_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation" ("id") ON DELETE CASCADE,
    CONSTRAINT "OrganisationInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT,
    CONSTRAINT "OrganisationInvite_replacedByInviteId_fkey" FOREIGN KEY ("replacedByInviteId") REFERENCES "OrganisationInvite" ("id") ON DELETE SET NULL
);

-- 4) Secondary indexes
CREATE INDEX IF NOT EXISTS "OrganisationInvite_organisationId_idx" ON "OrganisationInvite" ("organisationId");
CREATE INDEX IF NOT EXISTS "OrganisationInvite_org_email_idx" ON "OrganisationInvite" ("organisationId", "email");
CREATE INDEX IF NOT EXISTS "OrganisationInvite_expiresAt_idx" ON "OrganisationInvite" ("expiresAt");
CREATE INDEX IF NOT EXISTS "OrganisationInvite_replacedByInviteId_idx" ON "OrganisationInvite" ("replacedByInviteId");

-- 5) Partial unique index: one pending invite per email per org
CREATE UNIQUE INDEX IF NOT EXISTS "OrganisationInvite_org_email_pending_idx"
ON "OrganisationInvite" ("organisationId", "email")
WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

COMMIT;

