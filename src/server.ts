import { buildApp } from './app';
import { config } from './config/env';
import { initSentry } from './config/sentry';
import { cleanupStuckSyncs } from './utils/cleanup';
import { initCronJobs } from './jobs/cron';
import prisma from './infrastructure/prismaClient';
import { closeInboundQueue, setupInboundWorker } from './services/InboundQueueService';
import { closeRedisClients, getRedisClient, pingWithTimeout } from './infrastructure/redis';
import os from 'os';

// Initialize Sentry before anything else
initSentry();

const start = async () => {
  const app = buildApp();

  let isShuttingDown = false;
  const instanceId = process.env.RAILWAY_REPLICA_ID || process.env.RAILWAY_SERVICE_NAME || os.hostname();

  let cronHandle: { stop: () => void } | null = null;
  let inboundWorker: ReturnType<typeof setupInboundWorker> | null = null;

  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info(`Received ${signal}, starting graceful shutdown...`);

    const timeout = setTimeout(() => {
      app.log.error('Force shutdown due to timeout');
      process.exit(1);
    }, 10000);

    try {
      // Stop cron schedules first to prevent new work starting mid-shutdown
      try {
        cronHandle?.stop();
      } catch {}

      // Close BullMQ worker/queue
      try {
        await inboundWorker?.close();
      } catch {}
      try {
        await closeInboundQueue();
      } catch {}

      await app.close();
      await prisma.$disconnect();
      await closeRedisClients();
      clearTimeout(timeout);
      app.log.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  try {
    // Run startup cleanup (Force reset all IN_PROGRESS)
    await cleanupStuckSyncs({ startup: true });

    // In production, verify Redis connectivity BEFORE binding the HTTP listener.
    // (Fail-fast, but with short timeout and one retry for cold-start networking blips.)
    if (config.NODE_ENV === 'production') {
      const client = getRedisClient();
      const result = await pingWithTimeout(client, 1000, 1);
      if (!result.ok) {
        throw new Error(`Redis connectivity check failed: ${result.error}`);
      }
    }
    
    // Initialize Cron Jobs
    if (config.CRON_ENABLED === 'true') {
      app.log.info(`CRON_ENABLED=true instance=${instanceId}`);
      cronHandle = initCronJobs();
    } else {
      app.log.info(`CRON_ENABLED=false instance=${instanceId}`);
    }

    // Initialize Mailgun Inbound Worker
    if (config.MAILGUN_PROCESSOR_ENABLED === 'true') {
      inboundWorker = setupInboundWorker();
      console.log(`Mailgun Inbound Worker started instance=${instanceId}`);
    }

    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
