-- Add confidenceScore and textWarnReasons to InvoiceLineItem
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'InvoiceLineItem' AND column_name = 'confidenceScore') THEN
    ALTER TABLE "InvoiceLineItem" ADD COLUMN "confidenceScore" DOUBLE PRECISION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'InvoiceLineItem' AND column_name = 'textWarnReasons') THEN
    ALTER TABLE "InvoiceLineItem" ADD COLUMN "textWarnReasons" TEXT[] NOT NULL DEFAULT '{}';
  END IF;
END $$;

