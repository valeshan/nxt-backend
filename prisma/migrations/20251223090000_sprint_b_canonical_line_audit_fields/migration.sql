-- Sprint B: Canonical line auditability + WARN transparency
-- Add raw unit/quantity signals and persist warn reasons for explainability.

ALTER TABLE "CanonicalInvoiceLineItem"
  ADD COLUMN IF NOT EXISTS "rawQuantityText" TEXT,
  ADD COLUMN IF NOT EXISTS "rawUnitText" TEXT,
  ADD COLUMN IF NOT EXISTS "rawDeliveredText" TEXT,
  ADD COLUMN IF NOT EXISTS "rawSizeText" TEXT,
  ADD COLUMN IF NOT EXISTS "warnReasons" TEXT[] NOT NULL DEFAULT '{}';



