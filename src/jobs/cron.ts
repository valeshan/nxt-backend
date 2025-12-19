import cron from 'node-cron';
import { cleanupStuckSyncs } from '../utils/cleanup';
import { invoicePipelineService } from '../services/InvoicePipelineService';
import { supplierInsightsService } from '../services/supplierInsightsService';
import { config } from '../config/env';

export function initCronJobs() {
  console.log('[Cron] Initializing cron jobs...');

  // Mutex guards to prevent overlapping runs
  let isProcessingPending = false;
  let isCleanupRunning = false;

  // Run cleanup every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Cron] Running hourly cleanup for stuck syncs...');
    await cleanupStuckSyncs();
  });

  // Poll for OCR updates every 10 seconds (user-facing latency)
  cron.schedule('*/10 * * * * *', async () => {
    if (isProcessingPending) return; // Skip if previous run still active
    isProcessingPending = true;
    try {
      await invoicePipelineService.processPendingOcrJobs();
    } catch (err) {
      console.error('[Cron] processPendingOcrJobs failed', err);
    } finally {
      isProcessingPending = false;
    }
  });

  // Cleanup orphaned files every 2 minutes (background maintenance)
  cron.schedule('*/2 * * * *', async () => {
    if (isCleanupRunning) return; // Skip if previous run still active
    isCleanupRunning = true;
    try {
      await invoicePipelineService.cleanupOrphanedOcrJobs();
    } catch (err) {
      console.error('[Cron] cleanupOrphanedOcrJobs failed', err);
    } finally {
      isCleanupRunning = false;
    }
  });

  // Price alert scan - daily at 6 AM (only if enabled)
  if (config.PRICE_ALERT_CRON_ENABLED === 'true') {
    cron.schedule('0 6 * * *', async () => {
      console.log('[Cron] Running daily price alert scan...');
      try {
        await supplierInsightsService.scanAndSendPriceIncreaseAlertsAllOrgs();
      } catch (err) {
        console.error('[Cron] Price alert scan failed', err);
      }
    });
    console.log('[Cron] Price alert scan scheduled (daily at 6 AM).');
  }

  console.log('[Cron] Cleanup job scheduled (hourly).');
}




