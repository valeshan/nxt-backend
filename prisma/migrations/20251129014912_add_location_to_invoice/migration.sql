-- AlterTable
ALTER TABLE "XeroInvoice" ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "xeroTenantId" TEXT;

-- CreateIndex
CREATE INDEX "XeroInvoice_organisationId_locationId_date_idx" ON "XeroInvoice"("organisationId", "locationId", "date");

-- AddForeignKey
ALTER TABLE "XeroInvoice" ADD CONSTRAINT "XeroInvoice_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
