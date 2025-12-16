-- CreateEnum
CREATE TYPE "OcrFailureCategory" AS ENUM ('LOW_IMAGE_QUALITY', 'BLURRY', 'GLARE_OR_SHADOW', 'LOW_RESOLUTION', 'ROTATION_OR_SKEW', 'CROPPED_OR_PARTIAL', 'DOCUMENT_TYPE_MISMATCH', 'NOT_A_DOCUMENT', 'PROVIDER_TIMEOUT', 'PROVIDER_ERROR', 'UNKNOWN');

-- AlterTable
ALTER TABLE "InvoiceFile" ADD COLUMN     "lastOcrAttemptAt" TIMESTAMP(3),
ADD COLUMN     "ocrAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ocrFailureCategory" "OcrFailureCategory",
ADD COLUMN     "ocrFailureDetail" TEXT,
ADD COLUMN     "preprocessingFlags" JSONB;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "sharedReportEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3);
