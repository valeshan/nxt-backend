-- CreateEnum (only if it doesn't exist)
DO $$ BEGIN
    CREATE TYPE "VerificationSource" AS ENUM ('MANUAL', 'AUTO');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable InvoiceFile (add columns only if they don't exist)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'InvoiceFile' AND column_name = 'verificationSource') THEN
        ALTER TABLE "InvoiceFile" ADD COLUMN "verificationSource" "VerificationSource";
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'InvoiceFile' AND column_name = 'verifiedAt') THEN
        ALTER TABLE "InvoiceFile" ADD COLUMN "verifiedAt" TIMESTAMP(3);
    END IF;
END $$;

-- AlterTable Location (add column only if it doesn't exist)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Location' AND column_name = 'autoApproveCleanInvoices') THEN
        ALTER TABLE "Location" ADD COLUMN "autoApproveCleanInvoices" BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

-- CreateIndex (only if it doesn't exist)
CREATE INDEX IF NOT EXISTS "InvoiceFile_locationId_reviewStatus_idx" ON "InvoiceFile"("locationId", "reviewStatus");

