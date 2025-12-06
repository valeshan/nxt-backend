import cron from 'node-cron';
import { cleanupStuckSyncs } from '../utils/cleanup';
import { invoicePipelineService } from '../services/InvoicePipelineService';

export function initCronJobs() {
  console.log('[Cron] Initializing cron jobs...');

  // Run cleanup every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Cron] Running hourly cleanup for stuck syncs...');
    await cleanupStuckSyncs();
  });

  // Poll for OCR updates every 10 seconds
  cron.schedule('*/10 * * * * *', async () => {
    try {
      await invoicePipelineService.processPendingOcrJobs();
    } catch (err) {
      console.error('[Cron] processPendingOcrJobs failed', err);
    }
  });

  console.log('[Cron] Cleanup job scheduled (hourly).');
}




