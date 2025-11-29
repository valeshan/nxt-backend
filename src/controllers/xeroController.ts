import { FastifyRequest, FastifyReply } from 'fastify';
import { XeroService } from '../services/xeroService';
import { CreateConnectionRequest, LinkLocationsRequest, ListConnectionsQuery, XeroAuthoriseCallbackRequest, StartConnectRequest, CompleteConnectRequest } from '../dtos/xeroDtos';

import { XeroSyncService } from '../services/xeroSyncService';

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
        // Return 500 with specific error message to help debugging
        return reply.status(500).send({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: error.message || 'Failed to generate Xero auth URL',
                details: error.stack // CAUTION: Remove in production
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

     const result = await xeroService.completeConnect({
         code: request.body.code,
         state: request.body.state,
         organisationId,
         userId
     });
     
     // Trigger async backfill sync for the connection
     // We don't await this to keep the UI response fast
     // result.connectionId would be needed here? completeConnect returns linkedLocations but not explicit connectionId?
     // Let's check xeroService.completeConnect return type. 
     // It returns { success: true; tenantName: string; linkedLocations: any[] }.
     // linkedLocations are XeroLocationLink objects, which contain xeroConnectionId.
     
     if (result.linkedLocations && result.linkedLocations.length > 0) {
         const connectionId = result.linkedLocations[0].xeroConnectionId;
         console.log(`[XeroController] Triggering initial backfill sync for org ${organisationId} connection ${connectionId}`);
         xeroSyncService.syncInvoices(organisationId, connectionId)
            .then(() => console.log(`[XeroController] Initial sync completed for org ${organisationId}`))
            .catch(err => console.error(`[XeroController] Initial sync failed for org ${organisationId}`, err));
     }

     return reply.status(200).send(result);
  }
}
