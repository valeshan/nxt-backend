BEGIN;

ALTER TABLE "UserLocationAccess"
  ADD COLUMN IF NOT EXISTS "hasSeenRetroAutoApproveDiscovery" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "UserLocationAccess"
  ADD COLUMN IF NOT EXISTS "retroAutoApproveDiscoverySeenAt" TIMESTAMP(3);

COMMIT;


