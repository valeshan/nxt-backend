import cron from 'node-cron';
import { cleanupStuckSyncs } from '../utils/cleanup';

export function initCronJobs() {
  console.log('[Cron] Initializing cron jobs...');

  // Run cleanup every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Cron] Running hourly cleanup for stuck syncs...');
    await cleanupStuckSyncs();
  });

  console.log('[Cron] Cleanup job scheduled (hourly).');
}




