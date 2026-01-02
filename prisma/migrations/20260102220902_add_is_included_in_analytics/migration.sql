BEGIN;

-- AlterTable: Add missing columns to InvoiceLineItem
ALTER TABLE "InvoiceLineItem" 
    ADD COLUMN IF NOT EXISTS "isIncludedInAnalytics" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'OCR',
    ADD COLUMN IF NOT EXISTS "sourceKey" TEXT;

-- CreateIndex: Add index on isIncludedInAnalytics for analytics filtering
CREATE INDEX IF NOT EXISTS "InvoiceLineItem_isIncludedInAnalytics_idx" ON "InvoiceLineItem"("isIncludedInAnalytics");

-- CreateUniqueConstraint: Add unique constraint on (invoiceId, sourceKey) if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'InvoiceLineItem_invoiceId_sourceKey_key'
    ) THEN
        ALTER TABLE "InvoiceLineItem" 
        ADD CONSTRAINT "InvoiceLineItem_invoiceId_sourceKey_key" 
        UNIQUE ("invoiceId", "sourceKey");
    END IF;
END $$;

COMMIT;

