import { FastifyInstance } from 'fastify';
import { webhookController } from '../controllers/webhookController';
import { stripeWebhookController } from '../controllers/stripeWebhookController';
import { config } from '../config/env';

export default async function webhookRoutes(fastify: FastifyInstance) {
  // Mailgun webhook (only register if enabled)
  if (config.MAILGUN_WEBHOOK_ENABLED === 'true') {
    fastify.post('/mailgun/inbound', webhookController.mailgunInbound);
  }

  // Stripe webhook (requires raw body for signature verification)
  // Note: rawBody plugin is registered globally with { global: false, runFirst: true }
  // so we need to enable it per-route via config
  fastify.post('/stripe', {
    config: {
      rawBody: true, // Enable raw body for this route
    },
  }, stripeWebhookController.handleWebhook);
}
