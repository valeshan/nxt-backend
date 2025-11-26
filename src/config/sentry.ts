import * as Sentry from "@sentry/node";
import { config } from "./env";

export function initSentry() {
  Sentry.init({
    dsn: "https://67b023dc368d515487a8de5285e2c3d6@o4510427751448576.ingest.us.sentry.io/4510427755970560",
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: config.NODE_ENV === "development",

    environment: config.NODE_ENV,

    // Capture unhandled promise rejections
    captureUnhandledRejections: true,
  });
}

