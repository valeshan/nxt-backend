BEGIN;

-- CreateEnum (only if it doesn't exist)
DO $$ BEGIN
    CREATE TYPE "VerificationSource" AS ENUM ('MANUAL', 'AUTO');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable InvoiceFile (add columns only if they don't exist)
ALTER TABLE "InvoiceFile" 
    ADD COLUMN IF NOT EXISTS "verificationSource" "VerificationSource",
    ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);

-- AlterTable Location (add column only if it doesn't exist)
ALTER TABLE "Location" 
    ADD COLUMN IF NOT EXISTS "autoApproveCleanInvoices" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex (only if it doesn't exist)
CREATE INDEX IF NOT EXISTS "InvoiceFile_locationId_reviewStatus_idx" ON "InvoiceFile"("locationId", "reviewStatus");

COMMIT;

