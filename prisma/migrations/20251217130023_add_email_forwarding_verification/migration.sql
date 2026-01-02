-- CreateEnum
CREATE TYPE "EmailForwardingVerificationStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LocationForwardingStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING_VERIFICATION', 'VERIFIED');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "forwardingStatus" "LocationForwardingStatus" DEFAULT 'NOT_CONFIGURED',
ADD COLUMN     "forwardingVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailForwardingVerification" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "recipientAlias" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GMAIL',
    "status" "EmailForwardingVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verificationLink" TEXT,
    "sender" TEXT,
    "subject" TEXT,
    "emailMessageId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailForwardingVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailForwardingVerification_locationId_status_idx" ON "EmailForwardingVerification"("locationId", "status");

-- CreateIndex
CREATE INDEX "EmailForwardingVerification_organisationId_idx" ON "EmailForwardingVerification"("organisationId");

-- CreateIndex
CREATE INDEX "EmailForwardingVerification_expiresAt_idx" ON "EmailForwardingVerification"("expiresAt");

-- AddForeignKey
ALTER TABLE "EmailForwardingVerification" ADD CONSTRAINT "EmailForwardingVerification_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailForwardingVerification" ADD CONSTRAINT "EmailForwardingVerification_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;





