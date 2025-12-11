-- 1) Speed up verified manual Invoice aggregates per supplier
CREATE INDEX "idx_invoice_org_loc_verified_supplier_date"
ON "Invoice" ("organisationId", "locationId", "supplierId", "date")
WHERE "isVerified" = true AND "deletedAt" IS NULL;

-- 2) Speed up authorised/paid XeroInvoice aggregates per supplier
CREATE INDEX "idx_xero_invoice_org_loc_status_supplier_date"
ON "XeroInvoice" ("organisationId", "locationId", "status", "supplierId", "date")
WHERE "deletedAt" IS NULL;

-- 3) Speed up InvoiceFile OCR polling
CREATE INDEX "idx_invoicefile_processing_ocr_not_deleted"
ON "InvoiceFile" ("processingStatus", "ocrJobId")
WHERE "deletedAt" IS NULL;
