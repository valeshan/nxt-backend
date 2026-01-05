import prisma from '../infrastructure/prismaClient';
import { ProcessingStatus } from '@prisma/client';

/**
 * Requeue a single InvoiceFile by ID:
 * - Sets processingStatus to PENDING_OCR
 * - Resets ocrAttemptCount to 0
 * - Clears failureReason and ocrJobId
 * Usage:
 *   FILE_ID=<uuid> npm run requeue:file
 * or
 *   npm run requeue:file -- <uuid>
 */
async function main() {
  const argId = process.argv[2];
  const envId = process.env.FILE_ID;
  const id = argId || envId;

  if (!id) {
    console.error('Usage: FILE_ID=<uuid> npm run requeue:file  OR  npm run requeue:file -- <uuid>');
    process.exit(1);
  }

  const file = await prisma.invoiceFile.findUnique({ where: { id } });
  if (!file) {
    console.error(`InvoiceFile ${id} not found`);
    process.exit(1);
  }

  const updated = await prisma.invoiceFile.update({
    where: { id },
    data: {
      processingStatus: ProcessingStatus.PENDING_OCR,
      ocrAttemptCount: 0,
      failureReason: null,
      ocrJobId: null,
      lastOcrAttemptAt: new Date(),
    },
  });

  console.log('Requeued InvoiceFile:', {
    id: updated.id,
    processingStatus: updated.processingStatus,
    ocrAttemptCount: updated.ocrAttemptCount,
    failureReason: updated.failureReason,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

