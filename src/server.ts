import { buildApp } from './app';
import { config } from './config/env';
import { initSentry } from './config/sentry';
import { cleanupStuckSyncs } from './utils/cleanup';
import { initCronJobs } from './jobs/cron';
import prisma from './infrastructure/prismaClient';

// Initialize Sentry before anything else
initSentry();

const start = async () => {
  const app = buildApp();

  let isShuttingDown = false;

  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info(`Received ${signal}, starting graceful shutdown...`);

    const timeout = setTimeout(() => {
      app.log.error('Force shutdown due to timeout');
      process.exit(1);
    }, 10000);

    try {
      await app.close();
      await prisma.$disconnect();
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
    
    // Initialize Cron Jobs
    initCronJobs();

    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
