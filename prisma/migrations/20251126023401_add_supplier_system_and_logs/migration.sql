BEGIN;

-- CreateEnum
CREATE TYPE "SupplierSourceType" AS ENUM ('XERO', 'OCR', 'MANUAL', 'MERGED');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'PENDING_REVIEW');

-- CreateEnum
CREATE TYPE "SupplierSourceSystem" AS ENUM ('XERO', 'OCR', 'MANUAL');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "abn" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "country" TEXT,
    "city" TEXT,
    "sourceType" "SupplierSourceType" NOT NULL,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierSourceLink" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "sourceSystem" "SupplierSourceSystem" NOT NULL,
    "externalId" TEXT,
    "rawName" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierSourceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroInvoice" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "xeroInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "reference" TEXT,
    "type" TEXT,
    "status" TEXT,
    "date" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "total" DECIMAL(19,4),
    "subTotal" DECIMAL(19,4),
    "taxAmount" DECIMAL(19,4),
    "amountDue" DECIMAL(19,4),
    "amountPaid" DECIMAL(19,4),
    "currencyCode" TEXT,
    "updatedDateUTC" TIMESTAMP(3),
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroInvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(19,4),
    "unitAmount" DECIMAL(19,4),
    "lineAmount" DECIMAL(19,4),
    "taxAmount" DECIMAL(19,4),
    "itemCode" TEXT,
    "accountCode" TEXT,

    CONSTRAINT "XeroInvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XeroSyncLog" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "xeroConnectionId" TEXT NOT NULL,
    "lastModifiedDateProcessed" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "message" TEXT,

    CONSTRAINT "XeroSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_organisationId_idx" ON "Supplier"("organisationId");

-- CreateIndex
CREATE INDEX "Supplier_normalizedName_idx" ON "Supplier"("normalizedName");

-- CreateIndex
CREATE INDEX "SupplierSourceLink_organisationId_sourceSystem_externalId_idx" ON "SupplierSourceLink"("organisationId", "sourceSystem", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "XeroInvoice_xeroInvoiceId_key" ON "XeroInvoice"("xeroInvoiceId");

-- CreateIndex
CREATE INDEX "XeroInvoice_organisationId_idx" ON "XeroInvoice"("organisationId");

-- CreateIndex
CREATE INDEX "XeroInvoice_supplierId_idx" ON "XeroInvoice"("supplierId");

-- CreateIndex
CREATE INDEX "XeroInvoiceLineItem_invoiceId_idx" ON "XeroInvoiceLineItem"("invoiceId");

-- CreateIndex
CREATE INDEX "XeroSyncLog_organisationId_idx" ON "XeroSyncLog"("organisationId");

-- CreateIndex
CREATE INDEX "XeroSyncLog_xeroConnectionId_idx" ON "XeroSyncLog"("xeroConnectionId");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierSourceLink" ADD CONSTRAINT "SupplierSourceLink_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroInvoice" ADD CONSTRAINT "XeroInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroInvoice" ADD CONSTRAINT "XeroInvoice_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroInvoiceLineItem" ADD CONSTRAINT "XeroInvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "XeroInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
