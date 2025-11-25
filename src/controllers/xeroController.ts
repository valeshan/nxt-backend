import { FastifyRequest, FastifyReply } from 'fastify';
import { XeroService } from '../services/xeroService';
import { CreateConnectionRequest, LinkLocationsRequest, ListConnectionsQuery, XeroAuthoriseCallbackRequest } from '../dtos/xeroDtos';

const xeroService = new XeroService();

export class XeroController {
  private validateOrgAccess(request: FastifyRequest, targetOrgId: string) {
    const { orgId, tokenType } = request.user;
    const allowedTypes = ['access_token_company', 'access_token'];
    
    if (!orgId || !tokenType || !allowedTypes.includes(tokenType)) {
       const error: any = new Error('Organisation context required');
       error.statusCode = 403;
       throw error;
    }

    if (orgId !== targetOrgId) {
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
    const result = await xeroService.createConnection(request.body);
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
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const userId = request.user.userId;
    if (!userId) {
        return reply.status(401).send({ message: 'User context required' });
    }
    const result = await xeroService.generateAuthUrl(userId);
    return reply.status(200).send(result);
  }

  authoriseCallbackHandler = async (
    request: FastifyRequest<{ Body: XeroAuthoriseCallbackRequest }>,
    reply: FastifyReply
  ) => {
    const userId = request.user.userId;
    if (!userId) {
        return reply.status(401).send({ message: 'User context required' });
    }
    const result = await xeroService.processCallback(userId, request.body.code, request.body.state);
    return reply.status(200).send(result);
  }
}
