import prisma from '../infrastructure/prismaClient';
import { ProcessingStatus } from '@prisma/client';
import { ocrService } from '../services/OcrService';

/**
 * Force-start OCR for a single InvoiceFile by ID.
 * Usage:
 *   FILE_ID=<uuid> npm run start:ocr
 * or
 *   npm run start:ocr -- <uuid>
 */
async function main() {
  const argId = process.argv[2];
  const envId = process.env.FILE_ID;
  const id = argId || envId;

  if (!id) {
    console.error('Usage: FILE_ID=<uuid> npm run start:ocr  OR  npm run start:ocr -- <uuid>');
    process.exit(1);
  }

  const file = await prisma.invoiceFile.findUnique({ where: { id } });
  if (!file || file.deletedAt) {
    console.error(`InvoiceFile ${id} not found or deleted`);
    process.exit(1);
  }

  if (!file.storageKey) {
    console.error(`InvoiceFile ${id} has no storageKey; cannot start OCR`);
    process.exit(1);
  }

  const nextAttempt = (file as any).ocrAttemptCount ? (file as any).ocrAttemptCount + 1 : 1;

  try {
    const jobId = await ocrService.startAnalysis(file.storageKey);
    const updated = await prisma.invoiceFile.update({
      where: { id },
      data: {
        processingStatus: ProcessingStatus.OCR_PROCESSING,
        ocrJobId: jobId,
        ocrAttemptCount: nextAttempt,
        failureReason: null,
        lastOcrAttemptAt: new Date(),
      },
    });

    console.log('OCR started:', {
      id: updated.id,
      processingStatus: updated.processingStatus,
      ocrJobId: updated.ocrJobId,
      ocrAttemptCount: updated.ocrAttemptCount,
    });
  } catch (err: any) {
    const msg = err?.message || 'unknown error';
    await prisma.invoiceFile.update({
      where: { id },
      data: {
        processingStatus: ProcessingStatus.OCR_FAILED,
        failureReason: `start:ocr failed: ${msg}`,
        ocrAttemptCount: nextAttempt,
        lastOcrAttemptAt: new Date(),
      },
    });
    console.error(`Failed to start OCR for ${id}:`, msg);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

