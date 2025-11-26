import { buildApp } from './app';
import { config } from './config/env';
import { initSentry } from './config/sentry';

// Initialize Sentry before anything else
initSentry();

const start = async () => {
  const app = buildApp();

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

