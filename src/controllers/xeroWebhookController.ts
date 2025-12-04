import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { XeroSyncService } from '../services/xeroSyncService';
import { pusherService } from '../services/pusherService';
import { verifyXeroWebhookSignature } from '../utils/xeroWebhook';
import { config } from '../config/env';
import prisma from '../infrastructure/prismaClient';
import { XeroSyncStatus, XeroSyncTriggerType, XeroSyncScope } from '@prisma/client';

const xeroSyncService = new XeroSyncService();

interface XeroWebhookBody {
  events: Array<{
    resourceUrl: string;
    resourceId: string;
    tenantId: string;
    tenantType: string;
    eventCategory: string;
    eventType: string;
    eventDateUtc: string;
  }>;
  firstEventSequence: number;
  lastEventSequence: number;
  entropy: string;
}

// Extend FastifyRequest to include rawBody from fastify-raw-body plugin
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
}

const xeroWebhookController: FastifyPluginAsync = async (fastify) => {
  fastify.post('/webhook', {
    config: {
      rawBody: true
    }
  }, async (request: FastifyRequest<{ Body: XeroWebhookBody }>, reply) => {
    const signature = request.headers['x-xero-signature'];
    const rawBody = request.rawBody;

    // 1. Security Check
    if (!rawBody || typeof signature !== 'string') {
      request.log.warn('[XeroWebhook] Missing body or signature');
      return reply.status(401).send();
    }

    // Verify Signature
    const isValid = verifyXeroWebhookSignature(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'), 
      signature, 
      config.XERO_WEBHOOK_SECRET || ''
    );

    if (!isValid) {
      request.log.warn('[XeroWebhook] Invalid signature');
      return reply.status(401).send();
    }

    // 2. Parse Body & Extract Tenants
    const body = request.body; // Parsed JSON by Fastify (assuming Content-Type is application/json)
    
    if (!body.events || !Array.isArray(body.events)) {
        return reply.status(200).send(); // Acknowledge but ignore malformed
    }

    const tenantIds = [...new Set(body.events.map(e => e.tenantId))];
    request.log.info(`[XeroWebhook] Received events for tenants: ${tenantIds.join(', ')}`);

    // 3. Process per Tenant (Fire-and-Forget)
    for (const tenantId of tenantIds) {
        // Find Connection
        const connection = await prisma.xeroConnection.findFirst({
            where: { xeroTenantId: tenantId }
        });

        if (!connection) {
            request.log.warn(`[XeroWebhook] No connection found for tenant ${tenantId}. Skipping.`);
            continue;
        }

        // Concurrency Check: Check for active runs
        // We do this check here to decide whether to queue a new run or ignore
        const activeRun = await prisma.xeroSyncRun.findFirst({
            where: {
                xeroConnectionId: connection.id,
                status: { in: [XeroSyncStatus.PENDING, XeroSyncStatus.IN_PROGRESS] }
            }
        });

        if (activeRun) {
            request.log.info(`[XeroWebhook] Sync already in progress for connection ${connection.id}. Ignoring webhook.`);
            // Do NOT create a new run.
            continue;
        }

        // Create PENDING Run
        const newRun = await prisma.xeroSyncRun.create({
            data: {
                organisationId: connection.organisationId,
                xeroConnectionId: connection.id,
                tenantId: connection.xeroTenantId,
                triggerType: XeroSyncTriggerType.WEBHOOK,
                scope: XeroSyncScope.INCREMENTAL,
                status: XeroSyncStatus.PENDING
            }
        });

        request.log.info(`[XeroWebhook] Queued sync run ${newRun.id} for connection ${connection.id}`);

        // Notify frontend via Pusher
        await pusherService.triggerEvent(
            pusherService.getOrgChannel(connection.organisationId),
            'xero-sync-started',
            {
                organisationId: connection.organisationId,
                runId: newRun.id,
                connectionId: connection.id,
                startedAt: new Date().toISOString()
            }
        );

        // Fire-and-Forget Sync
        void xeroSyncService.syncConnection({
            connectionId: connection.id,
            organisationId: connection.organisationId,
            scope: XeroSyncScope.INCREMENTAL,
            runId: newRun.id
        }).catch(async (err) => {
            request.log.error(`[XeroWebhook] Background sync failed for run ${newRun.id}`, err);
            const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
            
            await prisma.xeroSyncRun.update({
                where: { id: newRun.id },
                data: { 
                    status: XeroSyncStatus.FAILED, 
                    finishedAt: new Date(), 
                    errorMessage: message 
                }
            });
        });
    }

    return reply.status(200).send();
  });
};

export default xeroWebhookController;
