-- CreateEnum
CREATE TYPE "InvoiceSourceType" AS ENUM ('UPLOAD', 'XERO', 'EMAIL');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING_OCR', 'OCR_PROCESSING', 'OCR_COMPLETE', 'OCR_FAILED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NONE', 'NEEDS_REVIEW', 'VERIFIED');

-- CreateTable
CREATE TABLE "SupplierAlias" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "aliasName" TEXT NOT NULL,
    "normalisedAliasName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceFile" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "sourceType" "InvoiceSourceType" NOT NULL,
    "sourceReference" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "processingStatus" "ProcessingStatus" NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'NONE',
    "confidenceScore" DOUBLE PRECISION,
    "validationErrors" JSONB,
    "ocrJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceOcrResult" (
    "id" TEXT NOT NULL,
    "invoiceFileId" TEXT NOT NULL,
    "rawResultJson" JSONB NOT NULL,
    "parsedJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceOcrResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "invoiceFileId" TEXT,
    "supplierId" TEXT,
    "invoiceNumber" TEXT,
    "date" TIMESTAMP(3),
    "total" DECIMAL(19,4),
    "tax" DECIMAL(19,4),
    "subtotal" DECIMAL(19,4),
    "sourceType" "InvoiceSourceType" NOT NULL,
    "sourceReference" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "productCode" TEXT,
    "quantity" DECIMAL(19,4),
    "unitPrice" DECIMAL(19,4),
    "lineTotal" DECIMAL(19,4),
    "accountCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAlias_organisationId_normalisedAliasName_key" ON "SupplierAlias"("organisationId", "normalisedAliasName");

-- CreateIndex
CREATE INDEX "SupplierAlias_organisationId_idx" ON "SupplierAlias"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceOcrResult_invoiceFileId_key" ON "InvoiceOcrResult"("invoiceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceFileId_key" ON "Invoice"("invoiceFileId");

-- AddForeignKey
ALTER TABLE "SupplierAlias" ADD CONSTRAINT "SupplierAlias_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAlias" ADD CONSTRAINT "SupplierAlias_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceOcrResult" ADD CONSTRAINT "InvoiceOcrResult_invoiceFileId_fkey" FOREIGN KEY ("invoiceFileId") REFERENCES "InvoiceFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_invoiceFileId_fkey" FOREIGN KEY ("invoiceFileId") REFERENCES "InvoiceFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


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
