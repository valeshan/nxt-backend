-- CreateEnum (only if it doesn't exist)
DO $$ BEGIN
    CREATE TYPE "SupplierMatchType" AS ENUM ('ALIAS', 'EXACT', 'FUZZY', 'MANUAL', 'CREATED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only if column doesn't exist)
DO $$ BEGIN
    ALTER TABLE "InvoiceFile" ADD COLUMN "testOverridesJson" JSONB;
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- AlterTable (only if columns don't exist)
DO $$ BEGIN
    ALTER TABLE "Invoice" 
        ADD COLUMN IF NOT EXISTS "supplierMatchType" "SupplierMatchType",
        ADD COLUMN IF NOT EXISTS "matchedAliasKey" TEXT,
        ADD COLUMN IF NOT EXISTS "matchedAliasRaw" TEXT;
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

