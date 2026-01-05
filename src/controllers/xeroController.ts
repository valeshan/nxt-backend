import { FastifyRequest, FastifyReply } from 'fastify';
import { XeroService } from '../services/xeroService';
import { pusherService } from '../services/pusherService';
import { CreateConnectionRequest, LinkLocationsRequest, ListConnectionsQuery, XeroAuthoriseCallbackRequest, StartConnectRequest, CompleteConnectRequest } from '../dtos/xeroDtos';

import { XeroSyncService } from '../services/xeroSyncService';
import prisma from '../infrastructure/prismaClient';
import { XeroSyncScope, XeroSyncStatus, XeroSyncTriggerType } from '@prisma/client';

const xeroService = new XeroService();
const xeroSyncService = new XeroSyncService();

export class XeroController {
  private validateOrgAccess(request: FastifyRequest, targetOrgId: string) {
    const { organisationId, tokenType } = request.authContext;
    
    if (!organisationId) {
       const error: any = new Error('Organisation context required');
       error.statusCode = 403;
       throw error;
    }
    
    if (tokenType !== 'organisation' && tokenType !== 'location') {
       const error: any = new Error('Forbidden: Invalid token type');
       error.statusCode = 403;
       throw error;
    }

    if (organisationId !== targetOrgId) {
       const error: any = new Error('Token organisation mismatch');
       error.statusCode = 403;
       throw error;
    }
  }

  createConnectionHandler = async (
    request: FastifyRequest<{ Body: CreateConnectionRequest }>,
    reply: FastifyReply
  ) => {
    this.validateOrgAccess(request, request.body.organisationId);
    const userId = request.authContext.userId;
    const result = await xeroService.createConnection({
        ...request.body,
        userId
    });
    return reply.status(200).send(result);
  }

  linkLocationsHandler = async (
    request: FastifyRequest<{ Params: { connectionId: string }; Body: LinkLocationsRequest }>,
    reply: FastifyReply
  ) => {
    this.validateOrgAccess(request, request.body.organisationId);
    try {
      const result = await xeroService.linkLocations({
        organisationId: request.body.organisationId,
        connectionId: request.params.connectionId,
        locationIds: request.body.locationIds,
      });
      return reply.status(200).send(result);
    } catch (error: any) {
      if (error.code === 'FORBIDDEN') {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: error.message } });
      }
      if (error.code === 'NOT_FOUND') {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: error.message } });
      }
      throw error;
    }
  }

  listConnectionsHandler = async (
    request: FastifyRequest<{ Querystring: ListConnectionsQuery }>,
    reply: FastifyReply
  ) => {
    // organisationId is no longer in query, get from auth context
    const { organisationId } = request.authContext;
    
    if (!organisationId) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Organisation context required' } });
    }

    // No need to validate against query param anymore
    const result = await xeroService.listConnectionsForOrganisation(organisationId);
    return reply.status(200).send(result);
  }

  // New Xero Auth Flow Endpoints

  authoriseStartHandler = async (
    request: FastifyRequest<{ Querystring: { onboardingSessionId?: string } }>,
    reply: FastifyReply
  ) => {
    // Public route - no user context required
    try {
        const result = await xeroService.generateAuthUrl(request.query.onboardingSessionId);
        return reply.status(200).send(result);
    } catch (error: any) {
        request.log.error(error);
        // Return 500 without exposing internal details (stack traces, etc.)
        return reply.status(500).send({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Failed to generate Xero auth URL'
            }
        });
    }
  }

  authoriseCallbackHandler = async (
    request: FastifyRequest<{ Querystring: XeroAuthoriseCallbackRequest }>,
    reply: FastifyReply
  ) => {
    // Public route - no user context required
    // NOTE: For signup flow, this endpoint should NOT be used.
    // The frontend should extract code/state and pass them directly to /auth/register-onboard.
    // This endpoint is reserved for future "re-link Xero" flows for existing users.
    try {
      const result = await xeroService.processCallback(request.query.code, request.query.state);
      return reply.status(200).send(result);
    } catch (error: any) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_USAGE',
          message: error.message || 'This endpoint is not used for signup. Use /auth/register-onboard with xeroCode and xeroState instead.',
        },
      });
    }
  }

  startConnectHandler = async (
    request: FastifyRequest<{ Body: StartConnectRequest }>,
    reply: FastifyReply
  ) => {
    const { organisationId, userId } = request.authContext;
    if (!organisationId) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Organisation context required' } });
    }
    
    const result = await xeroService.startConnect({
        userId,
        organisationId,
        locationIds: request.body.locationIds
    });
    
    return reply.status(200).send(result);
  }

  completeConnectHandler = async (
    request: FastifyRequest<{ Body: CompleteConnectRequest }>,
    reply: FastifyReply
  ) => {
     const { organisationId, userId } = request.authContext;
     if (!organisationId) {
         return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Organisation context required' } });
     }

     try {
       const result = await xeroService.completeConnect({
           code: request.body.code,
           state: request.body.state,
           organisationId,
           userId
       });
       
       // Trigger async backfill sync for the connection
       // We don't await this to keep the UI response fast
       if (result.linkedLocations && result.linkedLocations.length > 0) {
           const connectionId = result.linkedLocations[0].xeroConnectionId;
           console.log(`[XeroController] Triggering initial backfill sync for org ${organisationId} connection ${connectionId}`);
           // Using syncConnection instead of deprecated syncInvoices
           // Defaulting to INCREMENTAL which upgrades to FULL if needed
           xeroSyncService.syncConnection({
               connectionId, 
               organisationId, 
               scope: XeroSyncScope.INCREMENTAL // Will upgrade to FULL if never synced
           }).catch(err => console.error(`[XeroController] Initial sync failed for org ${organisationId}`, err));
       }

       return reply.status(200).send(result);
     } catch (err: any) {
       request.log.error({ err }, '[Xero] complete-connect failed');
       const msg = err?.message || 'Failed to connect Xero';
       const isBadRequest =
         msg === 'Invalid session' || msg === 'Session expired' || msg === 'Organisation mismatch';

       // Helpful hinting for the most common production misconfigurations.
       const lower = String(msg).toLowerCase();
       const hint =
         lower.includes('redirect') || lower.includes('redirect_uri') || lower.includes('invalid redirect')
           ? 'Check that backend APP_URL matches your dashboard origin and that the Xero app redirect URI includes https://dashboard.thenxt.ai/xero/callback.'
           : lower.includes('client credentials') || lower.includes('credentials')
             ? 'Check XERO_CLIENT_ID and XERO_CLIENT_SECRET are set in the backend runtime environment.'
             : lower.includes('invalid_grant')
               ? 'Xero returned invalid_grant. This is usually caused by redirect URI mismatch or a reused/expired code. Try reconnecting; if it persists, verify APP_URL and Xero redirect URI settings.'
               : undefined;

       // Request id for support/debug correlation (the BE sets x-request-id header)
       const requestId =
         (reply.getHeader('x-request-id') as string | undefined) ||
         (request.headers['x-request-id'] as string | undefined) ||
         (request as any).id;

       return reply.status(isBadRequest ? 400 : 502).send({
         error: {
           code: 'XERO_CONNECT_FAILED',
           message: msg,
           hint,
           requestId,
         },
       });
     }
  }

  /**
   * Disconnect a Xero integration for the current organisation.
   * This removes the connection and all location links.
   * Synced invoice data is preserved (soft-delete) for historical reference.
   * 
   * Supports two URL patterns:
   * - DELETE /xero/organization/:organizationId (frontend legacy)
   * - DELETE /xero/connections/:connectionId (specific connection)
   */
  disconnectHandler = async (
    request: FastifyRequest<{ Params: { connectionId?: string; organizationId?: string } }>,
    reply: FastifyReply
  ) => {
    const { organisationId: authOrgId } = request.authContext;
    if (!authOrgId) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Organisation context required' } });
    }

    // If organizationId is in params (from /organization/:organizationId route), validate it matches auth context
    const targetOrgId = request.params.organizationId;
    if (targetOrgId && targetOrgId !== authOrgId) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Cannot disconnect Xero for another organisation' } });
    }

    try {
      const result = await xeroService.disconnect({
        organisationId: authOrgId,
        connectionId: request.params.connectionId, // Optional: specific connection
      });

      return reply.status(200).send(result);
    } catch (err: any) {
      request.log.error({ err }, '[Xero] disconnect failed');
      
      if (err.message === 'Connection not found') {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'No Xero connection found for this organisation' },
        });
      }

      return reply.status(500).send({
        error: { code: 'DISCONNECT_FAILED', message: err.message || 'Failed to disconnect Xero' },
      });
    }
  };

  syncConnectionHandler = async (
    request: FastifyRequest<{ Params: { connectionId: string }; Body: { scope?: string; triggerSource?: string } }>,
    reply: FastifyReply
  ) => {
    const { organisationId } = request.authContext;
    if (!organisationId) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Organisation context required' } });
    }

    const { connectionId } = request.params;

    // 1. Validate Connection ownership
    const connection = await prisma.xeroConnection.findUnique({
        where: { id: connectionId }
    });

    if (!connection || connection.organisationId !== organisationId) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Connection not found' } });
    }

    // 2. Concurrency Check
    const activeRun = await prisma.xeroSyncRun.findFirst({
        where: {
            xeroConnectionId: connectionId,
            status: { in: [XeroSyncStatus.PENDING, XeroSyncStatus.IN_PROGRESS] }
        }
    });

    if (activeRun) {
        return reply.status(409).send({ 
            error: { 
                code: 'SYNC_IN_PROGRESS', 
                message: 'Sync already in progress for this connection' 
            } 
        });
    }

    // 3. Map Scope & Trigger
    let scope: XeroSyncScope = XeroSyncScope.INCREMENTAL;
    if (request.body.scope === 'FULL') {
        scope = XeroSyncScope.FULL;
    }

    let triggerType: XeroSyncTriggerType = XeroSyncTriggerType.MANUAL;
    if (request.body.triggerSource === 'SYSTEM') {
        triggerType = XeroSyncTriggerType.SYSTEM;
    }

    // 4. Create PENDING Run
    const newRun = await prisma.xeroSyncRun.create({
        data: {
            organisationId: connection.organisationId,
            xeroConnectionId: connection.id,
            tenantId: connection.xeroTenantId,
            triggerType: triggerType,
            scope: scope,
            status: XeroSyncStatus.PENDING
        }
    });

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

    // 5. Fire-and-Forget Call
    const channel = pusherService.getOrgChannel(connection.organisationId);
    console.log(`[XeroController] Triggering manual sync for Connection=${connectionId}, Org=${connection.organisationId}, Channel=${channel}`);

    void xeroSyncService.syncConnection({
        connectionId,
        organisationId,
        scope,
        runId: newRun.id,
        triggerType
    }).catch(async (err) => {
        console.error(`[XeroController] Manual sync failed for run ${newRun.id}`, err);
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

    // 6. Return 202 Accepted
    return reply.status(202).send({
        id: newRun.id,
        status: newRun.status,
        triggerType: newRun.triggerType,
        scope: newRun.scope,
        startedAt: newRun.startedAt
    });
  }
}
