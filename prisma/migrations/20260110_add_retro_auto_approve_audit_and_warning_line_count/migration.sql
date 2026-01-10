BEGIN;

-- Add header-level warning summary (banner-safe queries)
ALTER TABLE "CanonicalInvoice"
  ADD COLUMN IF NOT EXISTS "warningLineCount" INTEGER NOT NULL DEFAULT 0;

-- Retro auto-approve batch (idempotency + summary)
CREATE TABLE IF NOT EXISTS "RetroAutoApproveBatch" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "dryRun" BOOLEAN NOT NULL DEFAULT false,
  "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "approvedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "approvedInvoiceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reasonsBreakdown" JSONB,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RetroAutoApproveBatch_pkey" PRIMARY KEY ("id")
);

-- Per-invoice audit events for retro auto-approval batches
CREATE TABLE IF NOT EXISTS "InvoiceAuditEvent" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "invoiceFileId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "triggeredByUserId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InvoiceAuditEvent_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "RetroAutoApproveBatch_org_loc_idempotencyKey_key"
  ON "RetroAutoApproveBatch"("organisationId", "locationId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "RetroAutoApproveBatch_org_loc_idx"
  ON "RetroAutoApproveBatch"("organisationId", "locationId");

CREATE INDEX IF NOT EXISTS "RetroAutoApproveBatch_idempotencyKey_idx"
  ON "RetroAutoApproveBatch"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "InvoiceAuditEvent_batchId_idx"
  ON "InvoiceAuditEvent"("batchId");

CREATE INDEX IF NOT EXISTS "InvoiceAuditEvent_org_loc_idx"
  ON "InvoiceAuditEvent"("organisationId", "locationId");

CREATE INDEX IF NOT EXISTS "InvoiceAuditEvent_invoiceId_idx"
  ON "InvoiceAuditEvent"("invoiceId");

-- Foreign keys
ALTER TABLE "RetroAutoApproveBatch"
  ADD CONSTRAINT "RetroAutoApproveBatch_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RetroAutoApproveBatch"
  ADD CONSTRAINT "RetroAutoApproveBatch_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RetroAutoApproveBatch"
  ADD CONSTRAINT "RetroAutoApproveBatch_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceAuditEvent"
  ADD CONSTRAINT "InvoiceAuditEvent_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceAuditEvent"
  ADD CONSTRAINT "InvoiceAuditEvent_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceAuditEvent"
  ADD CONSTRAINT "InvoiceAuditEvent_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceAuditEvent"
  ADD CONSTRAINT "InvoiceAuditEvent_invoiceFileId_fkey"
  FOREIGN KEY ("invoiceFileId") REFERENCES "InvoiceFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceAuditEvent"
  ADD CONSTRAINT "InvoiceAuditEvent_triggeredByUserId_fkey"
  FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceAuditEvent"
  ADD CONSTRAINT "InvoiceAuditEvent_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "RetroAutoApproveBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;


