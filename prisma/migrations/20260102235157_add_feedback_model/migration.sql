/*
  Warnings:

  - A unique constraint covering the columns `[messageId]` on the table `InboundEmailEvent` will be added. If there are existing duplicate values, this will fail.
  - Made the column `messageId` on table `InboundEmailEvent` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "InboundEmailEvent_token_timestamp_key";

-- AlterTable
ALTER TABLE "InboundEmailEvent" ALTER COLUMN "messageId" SET NOT NULL;

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "userId" TEXT,
    "orgId" TEXT,
    "locationId" TEXT,
    "pageUrl" TEXT,
    "userAgent" TEXT,
    "screenWidth" INTEGER,
    "screenHeight" INTEGER,
    "environment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "emailStatus" TEXT,
    "emailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

-- CreateIndex
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");

-- CreateIndex
CREATE INDEX "Feedback_emailStatus_idx" ON "Feedback"("emailStatus");

-- CreateIndex
CREATE INDEX "InboundEmailEvent_token_timestamp_idx" ON "InboundEmailEvent"("token", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailEvent_messageId_key" ON "InboundEmailEvent"("messageId");
