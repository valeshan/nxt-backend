import { Queue, Worker, Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { getBullMqRedisClient } from '../infrastructure/redis';
import { supplierInsightsService } from './supplierInsightsService';

export const ADMIN_QUEUE_NAME = 'admin-jobs';

// Dedicated BullMQ connection (BullMQ requires maxRetriesPerRequest=null).
const connection = getBullMqRedisClient();

export type ProductStatsRefreshJobData = {
  organisationId: string;
  locationId: string;
  accountCodes?: string[];
  triggeredBy: 'internal_api_key';
  requestedAt: string; // ISO
  requestId?: string;
};

export const adminQueue = new Queue(ADMIN_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 2000,
    removeOnFail: 5000,
  },
});

export async function enqueueProductStatsRefresh(data: Omit<ProductStatsRefreshJobData, 'requestedAt'> & { requestedAt?: string }) {
  // Deterministic-ish jobId to dedupe retries/deploy races, but still allow re-enqueue after cooldown:
  // one job per (org,location) per 10-minute bucket.
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  const jobId = `productStatsRefresh:${data.organisationId}:${data.locationId}:${bucket}`;
  const job = await adminQueue.add(
    'product-stats-refresh',
    {
      ...data,
      requestedAt: data.requestedAt ?? new Date().toISOString(),
    },
    { jobId }
  );
  return { jobId: String(job.id) };
}

export type AdminJobStatus =
  | { jobId: string; exists: false }
  | {
      jobId: string;
      exists: true;
      name: string;
      state: string;
      progress: unknown;
      createdAt?: number;
      processedOn?: number;
      finishedOn?: number;
      failedReason?: string;
      returnvalue?: unknown;
    };

export async function getAdminJobStatus(jobId: string): Promise<AdminJobStatus> {
  const job = await adminQueue.getJob(jobId);
  if (!job) return { jobId, exists: false };

  const state = await job.getState();
  return {
    jobId,
    exists: true,
    name: job.name,
    state,
    progress: job.progress,
    createdAt: job.timestamp,
    processedOn: job.processedOn ?? undefined,
    finishedOn: job.finishedOn ?? undefined,
    failedReason: job.failedReason ?? undefined,
    returnvalue: (job as any).returnvalue,
  };
}

export function setupAdminWorker(logger: { info: (obj: any, msg?: string) => void; error: (obj: any, msg?: string) => void }) {
  const worker = new Worker(
    ADMIN_QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== 'product-stats-refresh') return;

      const startedAt = Date.now();
      const data = job.data as ProductStatsRefreshJobData;

      logger.info(
        {
          audit: true,
          event: 'admin.productStats.refresh.started',
          jobId: job.id,
          organisationId: data.organisationId,
          locationId: data.locationId,
          triggeredBy: data.triggeredBy,
          requestId: data.requestId,
        },
        'admin.job.started'
      );

      await job.updateProgress({ stage: 'refreshing', pct: 10 });
      const result = await supplierInsightsService.refreshProductStatsForLocation(
        data.organisationId,
        data.locationId,
        data.accountCodes
      );
      await job.updateProgress({ stage: 'done', pct: 100, count: result.count, statsAsOf: result.statsAsOf.toISOString() });

      const durationMs = Date.now() - startedAt;
      logger.info(
        {
          audit: true,
          event: 'admin.productStats.refresh.completed',
          jobId: job.id,
          organisationId: data.organisationId,
          locationId: data.locationId,
          triggeredBy: data.triggeredBy,
          requestId: data.requestId,
          durationMs,
          result: { count: result.count, statsAsOf: result.statsAsOf.toISOString(), accountCodesHash: result.accountCodesHash },
        },
        'admin.job.completed'
      );

      return { ok: true, ...result, durationMs };
    },
    { connection, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      {
        audit: true,
        event: 'admin.job.failed',
        jobId: job?.id,
        name: job?.name,
        err: { message: err.message },
      },
      'admin.job.failed'
    );
  });

  return worker;
}

export async function closeAdminQueue(): Promise<void> {
  await adminQueue.close();
}

