/*
  Warnings:

  - A unique constraint covering the columns `[xeroTenantId]` on the table `XeroConnection` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "XeroSyncTriggerType" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "XeroSyncRun" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "LocationAccountConfig" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'COGS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationAccountConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LocationAccountConfig_organisationId_locationId_idx" ON "LocationAccountConfig"("organisationId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "LocationAccountConfig_locationId_accountCode_key" ON "LocationAccountConfig"("locationId", "accountCode");

-- CreateIndex
CREATE UNIQUE INDEX "XeroConnection_xeroTenantId_key" ON "XeroConnection"("xeroTenantId");

-- AddForeignKey
ALTER TABLE "LocationAccountConfig" ADD CONSTRAINT "LocationAccountConfig_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationAccountConfig" ADD CONSTRAINT "LocationAccountConfig_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
