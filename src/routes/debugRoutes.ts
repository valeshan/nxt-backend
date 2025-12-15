import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { supplierInsightsService } from '../services/supplierInsightsService';

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
}

