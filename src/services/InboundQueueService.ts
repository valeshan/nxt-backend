import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { config } from '../config/env';
import { logger } from '../server'; // Assuming logger is available, or use console
import Redis from 'ioredis';

// Redis connection configuration for BullMQ
// BullMQ requires a connection object or ioredis instance.
// We'll create a standard config object based on env.
const redisConfig = config.REDIS_URL
  ? {
      // Parse REDIS_URL if needed, but BullMQ supports connection object
      url: config.REDIS_URL,
    }
  : {
      host: config.REDIS_HOST || 'localhost',
      port: config.REDIS_PORT || 6379,
      password: config.REDIS_PASSWORD,
    };

// Create a separate connection for the queue to avoid blocking
const connection = new Redis(config.REDIS_URL || {
    host: config.REDIS_HOST || 'localhost',
    port: config.REDIS_PORT || 6379,
    password: config.REDIS_PASSWORD,
}, {
    maxRetriesPerRequest: null, // Required by BullMQ
});

export const INBOUND_QUEUE_NAME = 'inbound-invoices';

export const inboundQueue = new Queue(INBOUND_QUEUE_NAME, {
  connection,
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
      connection,
      concurrency: 2, // Start with low concurrency
    }
  );

  worker.on('completed', (job) => {
     // console.log(`Job ${job.id} completed!`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
};
