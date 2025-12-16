import { FastifyInstance } from 'fastify';
import { webhookController } from '../controllers/webhookController';
import { config } from '../config/env';

export default async function webhookRoutes(fastify: FastifyInstance) {
  // Only register if enabled
  if (config.MAILGUN_WEBHOOK_ENABLED === 'true') {
    fastify.post('/mailgun/inbound', webhookController.mailgunInbound);
  }
}
