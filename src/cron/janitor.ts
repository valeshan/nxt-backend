import prisma from '../infrastructure/prismaClient';
import { ProcessingStatus } from '@prisma/client';
import { ocrService } from '../services/OcrService';

const STUCK_MINUTES = 10;
const MAX_RETRIES = 3;

function getOcrAttemptCount(file: unknown): number {
  if (!file || typeof file !== 'object') return 0;
  if (!('ocrAttemptCount' in file)) return 0;
  const value = (file as Record<string, unknown>).ocrAttemptCount;
  return typeof value === 'number' ? value : 0;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const value = (err as Record<string, unknown>).message;
    if (typeof value === 'string') return value;
  }
  return 'unknown';
}

export async function runJanitor() {
  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);

  const stuckFiles = await prisma.invoiceFile.findMany({
    where: {
      processingStatus: ProcessingStatus.OCR_PROCESSING,
      updatedAt: { lt: cutoff },
      deletedAt: null,
    },
  });

  // Detect PENDING_OCR older than cutoff (potentially stuck before OCR start)
  const pendingOcr = await prisma.invoiceFile.findMany({
    where: {
      processingStatus: ProcessingStatus.PENDING_OCR,
      updatedAt: { lt: cutoff },
      deletedAt: null,
    },
  });

  for (const file of stuckFiles) {
    const retryCount = getOcrAttemptCount(file);
    if (retryCount >= MAX_RETRIES) {
      await prisma.invoiceFile.update({
        where: { id: file.id },
        data: {
          processingStatus: ProcessingStatus.OCR_FAILED,
          failureReason: `Janitor: stuck > ${STUCK_MINUTES}m after ${retryCount} retries`,
          ocrAttemptCount: retryCount,
          lastOcrAttemptAt: new Date(),
        },
      });
      continue;
    }

    await prisma.invoiceFile.update({
      where: { id: file.id },
      data: {
        processingStatus: ProcessingStatus.OCR_FAILED,
        failureReason: `Janitor: stuck > ${STUCK_MINUTES}m, retry ${retryCount + 1}`,
        ocrAttemptCount: retryCount + 1,
        lastOcrAttemptAt: new Date(),
      },
    });
  }

  // Retry OCR_FAILED that have remaining attempts (requeue to PENDING_OCR)
  const retryableFailed = await prisma.invoiceFile.findMany({
    where: {
      processingStatus: ProcessingStatus.OCR_FAILED,
      updatedAt: { lt: cutoff },
      deletedAt: null,
      ocrAttemptCount: { lt: MAX_RETRIES },
    },
  });

  if (retryableFailed.length > 0) {
    await Promise.all(
      retryableFailed.map(async (file) => {
        const nextCount = getOcrAttemptCount(file) + 1;
        await prisma.invoiceFile.update({
          where: { id: file.id },
          data: {
            processingStatus: ProcessingStatus.PENDING_OCR,
            failureReason: `Janitor: retrying OCR (${nextCount}/${MAX_RETRIES})`,
            ocrAttemptCount: nextCount,
            ocrJobId: null,
            lastOcrAttemptAt: new Date(),
          },
        });
      })
    );
  }

  // For stale PENDING_OCR: attempt to start OCR directly (up to MAX_RETRIES)
  let startedPending = 0;
  let failedPending = 0;
  if (pendingOcr.length > 0) {
    for (const file of pendingOcr) {
      const retryCount = getOcrAttemptCount(file);
      const nextCount = retryCount + 1;
      if (nextCount > MAX_RETRIES) {
        await prisma.invoiceFile.update({
          where: { id: file.id },
          data: {
            processingStatus: ProcessingStatus.OCR_FAILED,
            failureReason: `Janitor: pending too long, max retries reached (${retryCount}/${MAX_RETRIES})`,
            ocrAttemptCount: retryCount,
            lastOcrAttemptAt: new Date(),
          },
        });
        failedPending++;
        continue;
      }

      try {
        const jobId = await ocrService.startAnalysis(file.storageKey);
        await prisma.invoiceFile.update({
          where: { id: file.id },
          data: {
            processingStatus: ProcessingStatus.OCR_PROCESSING,
            failureReason: null,
            ocrAttemptCount: nextCount,
            ocrJobId: jobId,
            lastOcrAttemptAt: new Date(),
          },
        });
        startedPending++;
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        await prisma.invoiceFile.update({
          where: { id: file.id },
          data: {
            processingStatus: ProcessingStatus.OCR_FAILED,
            failureReason: `Janitor: failed to start OCR (${nextCount}/${MAX_RETRIES}): ${message}`,
            ocrAttemptCount: nextCount,
            lastOcrAttemptAt: new Date(),
          },
        });
        failedPending++;
      }
    }
  }

  return {
    stuckFilesFound: stuckFiles.length,
    retryableFailedFound: retryableFailed.length,
    pendingOcrFound: pendingOcr.length,
    startedPending,
    failedPending,
  };
}

if (require.main === module) {
  runJanitor()
    .then((summary) => {
      console.log('[Janitor] Completed', summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Janitor] Failed', err);
      process.exit(1);
    });
}

