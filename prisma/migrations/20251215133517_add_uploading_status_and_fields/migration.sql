-- AlterEnum
ALTER TYPE "ProcessingStatus" ADD VALUE 'UPLOADING';

-- AlterTable
ALTER TABLE "InvoiceFile" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "fileSizeBytes" INTEGER,
ADD COLUMN     "uploadBatchId" TEXT;
