-- Add confidenceScore and textWarnReasons to InvoiceLineItem
ALTER TABLE "InvoiceLineItem" 
    ADD COLUMN IF NOT EXISTS "confidenceScore" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "textWarnReasons" TEXT[] NOT NULL DEFAULT '{}';



