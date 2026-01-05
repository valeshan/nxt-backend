import { Queue, Worker } from 'bullmq';
import { getBullMqRedisClient } from '../infrastructure/redis';

// Dedicated BullMQ connection (BullMQ requires maxRetriesPerRequest=null).
const connection = getBullMqRedisClient();

export const INBOUND_QUEUE_NAME = 'inbound-invoices';

export const inboundQueue = new Queue(INBOUND_QUEUE_NAME, {
  connection: connection as never, // Cast needed due to ioredis version mismatch with BullMQ's bundled ioredis
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s...
    },
    removeOnComplete: 1000, // Keep last 1000 completed jobs
    removeOnFail: 2000,     // Keep last 2000 failed jobs
  },
});

export const addInboundJob = async (eventId: string) => {
  return inboundQueue.add('process-inbound-email', { eventId });
};

import { inboundEmailService } from './InboundEmailService';

// We will export the worker setup function, to be called in app.ts
// This avoids circular dependencies or premature worker startup
export const setupInboundWorker = () => {
  const worker = new Worker(
    INBOUND_QUEUE_NAME,
    async (job) => {
      const { eventId } = job.data;
      if (!eventId) throw new Error('Job missing eventId');
      
      await inboundEmailService.fetchAndProcess(eventId);
    },
    {
      connection: connection as never, // Cast needed due to ioredis version mismatch with BullMQ's bundled ioredis
      concurrency: 2, // Start with low concurrency
    }
  );

  worker.on('completed', (_job) => {
     // console.log(`Job ${_job.id} completed!`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
};

export async function closeInboundQueue(): Promise<void> {
  await inboundQueue.close();
  // BullMQ shares the dedicated Redis connection managed by infrastructure/redis.ts.
}
