-- Production hardening indexes (non-destructive).
-- Note: Prisma Migrate in this environment is non-interactive; indexes are added via manual SQL migration.

-- InvoiceFile: support cron cleanup queries and org/location listing.
CREATE INDEX IF NOT EXISTS "InvoiceFile_processingStatus_updatedAt_idx"
ON "InvoiceFile" ("processingStatus", "updatedAt");

CREATE INDEX IF NOT EXISTS "InvoiceFile_organisationId_locationId_idx"
ON "InvoiceFile" ("organisationId", "locationId");

CREATE INDEX IF NOT EXISTS "InvoiceFile_uploadBatchId_idx"
ON "InvoiceFile" ("uploadBatchId");

-- Invoice: support invoice listing/filtering.
CREATE INDEX IF NOT EXISTS "Invoice_organisationId_locationId_date_idx"
ON "Invoice" ("organisationId", "locationId", "date");

CREATE INDEX IF NOT EXISTS "Invoice_supplierId_idx"
ON "Invoice" ("supplierId");

-- InvoiceLineItem: Postgres does NOT auto-index foreign keys; support joins and account code filtering.
CREATE INDEX IF NOT EXISTS "InvoiceLineItem_invoiceId_idx"
ON "InvoiceLineItem" ("invoiceId");

CREATE INDEX IF NOT EXISTS "InvoiceLineItem_accountCode_idx"
ON "InvoiceLineItem" ("accountCode");


