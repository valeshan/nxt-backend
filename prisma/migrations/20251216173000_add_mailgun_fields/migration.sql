-- CreateEnum
CREATE TYPE "InboundEmailStatus" AS ENUM ('PENDING_FETCH', 'QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED_SIGNATURE', 'FAILED_ROUTING', 'FAILED_FETCH', 'FAILED_PROCESSING');

-- CreateEnum
CREATE TYPE "InboundAttachmentStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'UPLOADING', 'OCR_STARTED', 'SKIPPED_TYPE', 'SKIPPED_SIZE', 'FAILED');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "mailgunAlias" TEXT;

-- CreateTable
CREATE TABLE "InboundEmailEvent" (
    "id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientAlias" TEXT,
    "sender" TEXT,
    "subject" TEXT,
    "messageId" TEXT,
    "timestamp" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "InboundEmailStatus" NOT NULL DEFAULT 'PENDING_FETCH',
    "failureReason" TEXT,
    "organisationId" TEXT,
    "locationId" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundEmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundAttachment" (
    "id" TEXT NOT NULL,
    "inboundEmailEventId" TEXT NOT NULL,
    "invoiceFileId" TEXT,
    "filename" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "status" "InboundAttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundEmailEvent_status_createdAt_idx" ON "InboundEmailEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InboundEmailEvent_recipient_idx" ON "InboundEmailEvent"("recipient");

-- CreateIndex
CREATE INDEX "InboundEmailEvent_recipientAlias_idx" ON "InboundEmailEvent"("recipientAlias");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmailEvent_token_timestamp_key" ON "InboundEmailEvent"("token", "timestamp");

-- CreateIndex
CREATE INDEX "InboundAttachment_inboundEmailEventId_idx" ON "InboundAttachment"("inboundEmailEventId");

-- CreateIndex
CREATE INDEX "InboundAttachment_status_createdAt_idx" ON "InboundAttachment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Location_mailgunAlias_key" ON "Location"("mailgunAlias");

-- AddForeignKey
ALTER TABLE "InboundAttachment" ADD CONSTRAINT "InboundAttachment_inboundEmailEventId_fkey" FOREIGN KEY ("inboundEmailEventId") REFERENCES "InboundEmailEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

