-- CreateEnum
CREATE TYPE "CanonicalSource" AS ENUM ('OCR', 'XERO', 'MANUAL');

-- CreateEnum
CREATE TYPE "UnitCategory" AS ENUM ('WEIGHT', 'VOLUME', 'UNIT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('NONE', 'CREDITED', 'MODIFIED');

-- CreateEnum
CREATE TYPE "QualityStatus" AS ENUM ('OK', 'WARN');

-- CreateTable
CREATE TABLE "CanonicalInvoice" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supplierId" TEXT,
    "source" "CanonicalSource" NOT NULL,
    "legacyInvoiceId" TEXT,
    "legacyXeroInvoiceId" TEXT,
    "sourceInvoiceRef" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "currencyCode" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanonicalInvoiceLineItem" (
    "id" TEXT NOT NULL,
    "canonicalInvoiceId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supplierId" TEXT,
    "source" "CanonicalSource" NOT NULL,
    "sourceLineRef" TEXT NOT NULL,
    "normalizationVersion" TEXT NOT NULL,
    "rawDescription" TEXT NOT NULL,
    "normalizedDescription" TEXT NOT NULL,
    "productCode" TEXT,
    "quantity" DECIMAL(19,4),
    "unitLabel" TEXT,
    "unitCategory" "UnitCategory" NOT NULL,
    "unitPrice" DECIMAL(19,4),
    "lineTotal" DECIMAL(19,4),
    "taxAmount" DECIMAL(19,4),
    "currencyCode" TEXT,
    "adjustmentStatus" "AdjustmentStatus" NOT NULL DEFAULT 'NONE',
    "qualityStatus" "QualityStatus" NOT NULL DEFAULT 'OK',
    "confidenceScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalInvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalInvoice_legacyInvoiceId_key" ON "CanonicalInvoice"("legacyInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalInvoice_legacyXeroInvoiceId_key" ON "CanonicalInvoice"("legacyXeroInvoiceId");

-- CreateIndex
CREATE INDEX "CanonicalInvoice_organisationId_locationId_idx" ON "CanonicalInvoice"("organisationId", "locationId");

-- CreateIndex
CREATE INDEX "CanonicalInvoice_organisationId_locationId_supplierId_idx" ON "CanonicalInvoice"("organisationId", "locationId", "supplierId");

-- CreateIndex
CREATE INDEX "CanonicalInvoice_deletedAt_idx" ON "CanonicalInvoice"("deletedAt");

-- CreateIndex
CREATE INDEX "CanonicalInvoiceLineItem_canonicalInvoiceId_idx" ON "CanonicalInvoiceLineItem"("canonicalInvoiceId");

-- CreateIndex
CREATE INDEX "CanonicalInvoiceLineItem_organisationId_locationId_qualityS_idx" ON "CanonicalInvoiceLineItem"("organisationId", "locationId", "qualityStatus");

-- CreateIndex
CREATE INDEX "CanonicalLine_org_loc_supplier_qs_idx" ON "CanonicalInvoiceLineItem"("organisationId", "locationId", "supplierId", "qualityStatus");

-- CreateIndex
CREATE INDEX "CanonicalInvoiceLineItem_organisationId_locationId_unitCate_idx" ON "CanonicalInvoiceLineItem"("organisationId", "locationId", "unitCategory", "qualityStatus");

-- CreateIndex
CREATE INDEX "CanonicalInvoiceLineItem_organisationId_locationId_normaliz_idx" ON "CanonicalInvoiceLineItem"("organisationId", "locationId", "normalizationVersion");

-- CreateIndex
CREATE INDEX "CanonicalLine_grouping_idx" ON "CanonicalInvoiceLineItem"("organisationId", "locationId", "supplierId", "normalizedDescription", "unitCategory");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalInvoiceLineItem_canonicalInvoiceId_sourceLineRef_key" ON "CanonicalInvoiceLineItem"("canonicalInvoiceId", "sourceLineRef");

-- AddForeignKey
ALTER TABLE "CanonicalInvoice" ADD CONSTRAINT "CanonicalInvoice_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoice" ADD CONSTRAINT "CanonicalInvoice_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoice" ADD CONSTRAINT "CanonicalInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoice" ADD CONSTRAINT "CanonicalInvoice_legacyInvoiceId_fkey" FOREIGN KEY ("legacyInvoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoice" ADD CONSTRAINT "CanonicalInvoice_legacyXeroInvoiceId_fkey" FOREIGN KEY ("legacyXeroInvoiceId") REFERENCES "XeroInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoiceLineItem" ADD CONSTRAINT "CanonicalInvoiceLineItem_canonicalInvoiceId_fkey" FOREIGN KEY ("canonicalInvoiceId") REFERENCES "CanonicalInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoiceLineItem" ADD CONSTRAINT "CanonicalInvoiceLineItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoiceLineItem" ADD CONSTRAINT "CanonicalInvoiceLineItem_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalInvoiceLineItem" ADD CONSTRAINT "CanonicalInvoiceLineItem_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ProductStats_org_loc_hash_source_productId_key" RENAME TO "ProductStats_organisationId_locationId_accountCodesHash_sou_key";

