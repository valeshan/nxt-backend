import * as Sentry from "@sentry/node";
import { config } from "./env";

export function initSentry() {
  // Only initialize Sentry if DSN is provided
  if (!config.SENTRY_DSN) {
    console.warn('[Sentry] SENTRY_DSN not configured, skipping Sentry initialization');
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    // Default to false for privacy/compliance. Set SENTRY_SEND_DEFAULT_PII=true explicitly if needed.
    sendDefaultPii: config.SENTRY_SEND_DEFAULT_PII === 'true',

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: config.NODE_ENV === "development",

    environment: config.NODE_ENV,
  });
}
