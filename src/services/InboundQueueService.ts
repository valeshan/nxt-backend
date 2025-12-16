import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { config } from '../config/env';
import Redis, { RedisOptions } from 'ioredis';

// Redis connection configuration for BullMQ
// We create a factory function or instance that handles the connection options correctly
const createRedisConnection = () => {
  const options: RedisOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
  };

  if (config.REDIS_URL) {
    return new Redis(config.REDIS_URL, options);
  } else {
    return new Redis({
      host: config.REDIS_HOST || 'localhost',
      port: config.REDIS_PORT || 6379,
      password: config.REDIS_PASSWORD,
      ...options
    });
  }
};

// Create a separate connection for the queue to avoid blocking
const connection = createRedisConnection();

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
