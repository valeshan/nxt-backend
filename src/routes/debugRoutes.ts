import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { supplierInsightsService } from '../services/supplierInsightsService';
import * as Sentry from '@sentry/node';

export default async function debugRoutes(fastify: FastifyInstance) {
  // Only register routes if enabled
  if (config.DEBUG_ROUTES_ENABLED !== 'true') {
    return;
  }

  const requireSecret = async (request: any, reply: any) => {
    const secret = request.headers['x-debug-secret'];
    if (!secret || secret !== config.DEBUG_ROUTE_SECRET) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing debug secret',
        },
      });
    }
  };

  fastify.post('/debug/alerts/scan-org', {
    preHandler: [requireSecret],
  }, async (request, reply) => {
    const { organisationId } = request.body as { organisationId: string };

    if (!organisationId) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'organisationId is required',
        },
      });
    }

    try {
      await supplierInsightsService.scanAndSendPriceIncreaseAlertsForOrg(organisationId);
      return reply.send({
        success: true,
        message: `Scan completed for organisation ${organisationId}`,
      });
    } catch (error: any) {
      console.error('[DebugRoute] Error scanning alerts:', error);
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Failed to scan alerts',
        },
      });
    }
  });

  fastify.post('/debug/alerts/scan-all', {
    preHandler: [requireSecret],
  }, async (request, reply) => {
    try {
      await supplierInsightsService.scanAndSendPriceIncreaseAlertsAllOrgs();
      return reply.send({
        success: true,
        message: 'Scan completed for all organisations',
      });
    } catch (error: any) {
      console.error('[DebugRoute] Error scanning all alerts:', error);
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Failed to scan alerts',
        },
      });
    }
  });

  // Sentry test endpoint - triggers a test error to verify Sentry is working
  fastify.post('/debug/sentry/test', {
    preHandler: [requireSecret],
  }, async (request, reply) => {
    const { message } = request.body as { message?: string };
    const testMessage = message || 'Test error from debug route';
    
    try {
      // Capture a test exception
      const testError = new Error(testMessage);
      Sentry.captureException(testError);
      
      // Also capture a test message
      Sentry.captureMessage(`[DEBUG] Sentry test: ${testMessage}`, 'info');
      
      // Flush to ensure events are sent
      await Sentry.flush(2000);
      
      return reply.send({
        success: true,
        message: 'Sentry test events sent. Check your Sentry dashboard.',
        sentryDsnConfigured: !!config.SENTRY_DSN,
      });
    } catch (error: any) {
      console.error('[DebugRoute] Sentry test error:', error);
      return reply.status(500).send({
        error: {
          code: 'SENTRY_TEST_FAILED',
          message: error.message || 'Failed to send Sentry test',
        },
      });
    }
  });
}

