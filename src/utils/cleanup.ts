import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';
import { XeroSyncStatus } from '@prisma/client';

export async function cleanupStuckSyncs() {
  const timeoutMinutes = config.XERO_SYNC_TIMEOUT_MINUTES;
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  console.log(`[Cleanup] Checking for stuck syncs older than ${cutoff.toISOString()} (timeout: ${timeoutMinutes}m)`);

  try {
    const stuckSyncs = await prisma.xeroSyncRun.findMany({
      where: {
        status: XeroSyncStatus.IN_PROGRESS,
        updatedAt: {
          lt: cutoff,
        },
      },
      select: {
        id: true,
      },
    });

    if (stuckSyncs.length > 0) {
      const ids = stuckSyncs.map((s) => s.id);
      console.warn(`[Cleanup] Found ${stuckSyncs.length} stuck syncs. Marking as FAILED. IDs: ${ids.join(', ')}`);

      await prisma.xeroSyncRun.updateMany({
        where: {
          id: { in: ids },
        },
        data: {
          status: XeroSyncStatus.FAILED,
          errorMessage: 'System Timeout/Restart',
          finishedAt: new Date(),
          // NOTE: triggerType is preserved as per requirement
        },
      });
    } else {
      console.log('[Cleanup] No stuck syncs found.');
    }
  } catch (error) {
    console.error('[Cleanup] Failed to clean up stuck syncs:', error);
  }
}

