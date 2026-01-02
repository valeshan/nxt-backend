BEGIN;

-- CreateEnum (only if it doesn't exist)
DO $$ BEGIN
    CREATE TYPE "SupplierMatchType" AS ENUM ('ALIAS', 'EXACT', 'FUZZY', 'MANUAL', 'CREATED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only if column doesn't exist)
ALTER TABLE "InvoiceFile" 
    ADD COLUMN IF NOT EXISTS "testOverridesJson" JSONB;

-- AlterTable (only if columns don't exist)
ALTER TABLE "Invoice" 
    ADD COLUMN IF NOT EXISTS "supplierMatchType" "SupplierMatchType",
    ADD COLUMN IF NOT EXISTS "matchedAliasKey" TEXT,
    ADD COLUMN IF NOT EXISTS "matchedAliasRaw" TEXT;

COMMIT;

