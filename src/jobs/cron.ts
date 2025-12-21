import cron, { type ScheduledTask } from 'node-cron';
import { cleanupStuckSyncs } from '../utils/cleanup';
import { invoicePipelineService } from '../services/InvoicePipelineService';
import { supplierInsightsService } from '../services/supplierInsightsService';
import { config } from '../config/env';
import { acquireLock, releaseLock } from '../infrastructure/redis';
import os from 'os';

export function initCronJobs() {
  console.log('[Cron] Initializing cron jobs...');

  // Mutex guards to prevent overlapping runs
  let isProcessingPending = false;
  let isCleanupRunning = false;

  const instanceId = process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_SERVICE_NAME || os.hostname();

  const schedules: ScheduledTask[] = [];

  const withRedisLock = async (jobName: string, ttlMs: number, fn: () => Promise<void>) => {
    const lockKey = `cron:${jobName}`;
    const lockValue = `${instanceId}:${Date.now()}`;

    const acquired = await acquireLock({ key: lockKey, value: lockValue, ttlMs }).catch(() => false);
    if (!acquired) {
      // Invariant: skip means skip.
      return;
    }

    const start = Date.now();
    try {
      await fn();
    } finally {
      const durationMs = Date.now() - start;
      // Best-effort release (if TTL expired, release will no-op)
      await releaseLock({ key: lockKey, value: lockValue }).catch(() => false);
      // Lightweight runtime signal for TTL tuning
      if (durationMs > 0) {
        console.log(`[Cron] job=${jobName} durationMs=${durationMs} instance=${instanceId}`);
      }
    }
  };

  // Run cleanup every hour
  schedules.push(
    cron.schedule('0 * * * *', async () => {
      await withRedisLock('cleanupStuckSyncs', 5 * 60 * 1000, async () => {
        console.log('[Cron] Running hourly cleanup for stuck syncs...');
        await cleanupStuckSyncs();
      });
    })
  );

  // Poll for OCR updates every 10 seconds (user-facing latency)
  schedules.push(
    cron.schedule('*/10 * * * * *', async () => {
    if (isProcessingPending) return; // Skip if previous run still active
    isProcessingPending = true;
    try {
      // TTL strategy: interval=10s, choose >= p95 runtime + buffer; conservative 60s.
      await withRedisLock('processPendingOcrJobs', 60_000, async () => {
        await invoicePipelineService.processPendingOcrJobs();
      });
    } catch (err) {
      console.error('[Cron] processPendingOcrJobs failed', err);
    } finally {
      isProcessingPending = false;
    }
    })
  );

  // Cleanup orphaned files every 2 minutes (background maintenance)
  schedules.push(
    cron.schedule('*/2 * * * *', async () => {
    if (isCleanupRunning) return; // Skip if previous run still active
    isCleanupRunning = true;
    try {
      // Interval=2m; TTL >= runtime + buffer; conservative 5m.
      await withRedisLock('cleanupOrphanedOcrJobs', 5 * 60_000, async () => {
        await invoicePipelineService.cleanupOrphanedOcrJobs();
      });
    } catch (err) {
      console.error('[Cron] cleanupOrphanedOcrJobs failed', err);
    } finally {
      isCleanupRunning = false;
    }
    })
  );

  // Price alert scan - daily at 6 AM (only if enabled)
  if (config.PRICE_ALERT_CRON_ENABLED === 'true') {
    schedules.push(
      cron.schedule('0 6 * * *', async () => {
        await withRedisLock('scanAndSendPriceIncreaseAlertsAllOrgs', 30 * 60_000, async () => {
          console.log('[Cron] Running daily price alert scan...');
          try {
            await supplierInsightsService.scanAndSendPriceIncreaseAlertsAllOrgs();
          } catch (err) {
            console.error('[Cron] Price alert scan failed', err);
          }
        });
      })
    );
    console.log('[Cron] Price alert scan scheduled (daily at 6 AM).');
  }

  // ProductStats refresh - nightly (prod only)
  if (config.NODE_ENV === 'production') {
    schedules.push(
      cron.schedule('30 2 * * *', async () => {
        await withRedisLock('refreshProductStatsNightly', 60 * 60_000, async () => {
          console.log('[Cron] Running nightly ProductStats refresh...');
          await supplierInsightsService.refreshProductStatsNightly();
        });
      })
    );
    console.log('[Cron] ProductStats refresh scheduled (daily at 2:30 AM).');
  }

  console.log('[Cron] Cleanup job scheduled (hourly).');

  return {
    stop: () => {
      for (const task of schedules) {
        try {
          task.stop();
        } catch {}
      }
    },
  };
}




