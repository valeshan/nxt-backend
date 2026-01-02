-- AlterTable: Add isIncludedInAnalytics column to InvoiceLineItem
DO $$ BEGIN
    ALTER TABLE "InvoiceLineItem" 
        ADD COLUMN IF NOT EXISTS "isIncludedInAnalytics" BOOLEAN NOT NULL DEFAULT true;
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- CreateIndex: Add index on isIncludedInAnalytics for analytics filtering
CREATE INDEX IF NOT EXISTS "InvoiceLineItem_isIncludedInAnalytics_idx" ON "InvoiceLineItem"("isIncludedInAnalytics");

