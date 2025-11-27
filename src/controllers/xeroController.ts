import { FastifyRequest, FastifyReply } from 'fastify';
import { XeroService } from '../services/xeroService';
import { CreateConnectionRequest, LinkLocationsRequest, ListConnectionsQuery, XeroAuthoriseCallbackRequest } from '../dtos/xeroDtos';

const xeroService = new XeroService();

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
    this.validateOrgAccess(request, request.query.organisationId);
    const result = await xeroService.listConnectionsForOrganisation(request.query.organisationId);
    return reply.status(200).send(result);
  }

  // New Xero Auth Flow Endpoints

  authoriseStartHandler = async (
    request: FastifyRequest<{ Querystring: { onboardingSessionId?: string } }>,
    reply: FastifyReply
  ) => {
    // Public route - no user context required
    const result = await xeroService.generateAuthUrl(request.query.onboardingSessionId);
    return reply.status(200).send(result);
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
}
