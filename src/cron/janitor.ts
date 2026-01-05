import prisma from '../infrastructure/prismaClient';
import { ProcessingStatus } from '@prisma/client';
import { ocrService } from '../services/OcrService';

const agentFetch = (globalThis as any).fetch;

const STUCK_MINUTES = 10;
const MAX_RETRIES = 3;

export async function runJanitor() {
  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);

  // #region agent log
  agentFetch?.('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'debug-session',
      runId: 'janitor-stuck',
      hypothesisId: 'J1',
      location: 'janitor.ts:start',
      message: 'janitor run start',
      data: {
        cutoff: cutoff.toISOString(),
        stuckMinutes: STUCK_MINUTES,
        maxRetries: MAX_RETRIES,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

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

  // #region agent log
  agentFetch?.('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'debug-session',
      runId: 'janitor-stuck',
      hypothesisId: 'J2',
      location: 'janitor.ts:found',
      message: 'janitor found stuck files',
      data: {
        count: stuckFiles.length,
        sample: stuckFiles.slice(0, 20).map((f) => ({
          id: f.id,
          updatedAt: f.updatedAt,
          ocrAttemptCount: (f as any).ocrAttemptCount ?? 0,
        })),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  // #region agent log
  agentFetch?.('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'debug-session',
      runId: 'janitor-stuck',
      hypothesisId: 'J4',
      location: 'janitor.ts:pending_found',
      message: 'janitor found pending_ocr files',
      data: {
        count: pendingOcr.length,
        sample: pendingOcr.slice(0, 20).map((f) => ({
          id: f.id,
          updatedAt: f.updatedAt,
          ocrAttemptCount: (f as any).ocrAttemptCount ?? 0,
        })),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  for (const file of stuckFiles) {
    const retryCount = (file as any).ocrAttemptCount || 0;
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
        const nextCount = ((file as any).ocrAttemptCount || 0) + 1;
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
      const retryCount = (file as any).ocrAttemptCount || 0;
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
      } catch (err: any) {
        await prisma.invoiceFile.update({
          where: { id: file.id },
          data: {
            processingStatus: ProcessingStatus.OCR_FAILED,
            failureReason: `Janitor: failed to start OCR (${nextCount}/${MAX_RETRIES}): ${err?.message ?? 'unknown'}`,
            ocrAttemptCount: nextCount,
            lastOcrAttemptAt: new Date(),
          },
        });
        failedPending++;
      }
    }
  }

  // #region agent log
  agentFetch?.('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'debug-session',
      runId: 'janitor-stuck',
      hypothesisId: 'J3',
      location: 'janitor.ts:complete',
      message: 'janitor run complete',
      data: { processed: stuckFiles.length, retriedFailed: retryableFailed.length, startedPending, failedPending },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

if (require.main === module) {
  runJanitor()
    .then(() => {
      console.log('[Janitor] Completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Janitor] Failed', err);
      process.exit(1);
    });
}

