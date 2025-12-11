-- 1) Force isVerified = FALSE if the file is NOT VERIFIED
UPDATE "Invoice" i
SET "isVerified" = false
FROM "InvoiceFile" f
WHERE i."invoiceFileId" = f.id
  AND f."reviewStatus" != 'VERIFIED'
  AND i."isVerified" = true
  AND i."deletedAt" IS NULL
  AND f."deletedAt" IS NULL;

-- 2) Force isVerified = TRUE if the file IS VERIFIED
UPDATE "Invoice" i
SET "isVerified" = true
FROM "InvoiceFile" f
WHERE i."invoiceFileId" = f.id
  AND f."reviewStatus" = 'VERIFIED'
  AND i."isVerified" = false
  AND i."deletedAt" IS NULL
  AND f."deletedAt" IS NULL;

