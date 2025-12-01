/*
  Warnings:

  - You are about to drop the `XeroSyncLog` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "XeroSyncTriggerType" AS ENUM ('MANUAL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "XeroSyncScope" AS ENUM ('INCREMENTAL', 'FULL');

-- CreateEnum
CREATE TYPE "XeroSyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "firstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastName" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "XeroConnection" ADD COLUMN     "lastSuccessfulSyncAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "XeroInvoiceLineItem" ADD COLUMN     "accountName" TEXT;

-- DropTable
DROP TABLE "XeroSyncLog";

-- CreateTable
CREATE TABLE "XeroSyncRun" (
    "id" TEXT NOT NULL,
    "xeroConnectionId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "tenantId" TEXT,
    "triggerType" "XeroSyncTriggerType" NOT NULL,
    "scope" "XeroSyncScope" NOT NULL,
    "status" "XeroSyncStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "rowsProcessed" INTEGER,

    CONSTRAINT "XeroSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "XeroSyncRun_xeroConnectionId_status_startedAt_idx" ON "XeroSyncRun"("xeroConnectionId", "status", "startedAt");

-- AddForeignKey
ALTER TABLE "XeroSyncRun" ADD CONSTRAINT "XeroSyncRun_xeroConnectionId_fkey" FOREIGN KEY ("xeroConnectionId") REFERENCES "XeroConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XeroSyncRun" ADD CONSTRAINT "XeroSyncRun_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
