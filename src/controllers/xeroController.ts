import { FastifyRequest, FastifyReply } from 'fastify';
import { XeroService } from '../services/xeroService';
import { CreateConnectionRequest, LinkLocationsRequest, ListConnectionsQuery } from '../dtos/xeroDtos';

const xeroService = new XeroService();

export class XeroController {
  async createConnectionHandler(
    request: FastifyRequest<{ Body: CreateConnectionRequest }>,
    reply: FastifyReply
  ) {
    const result = await xeroService.createConnection(request.body);
    return reply.status(200).send(result);
  }

  async linkLocationsHandler(
    request: FastifyRequest<{ Params: { connectionId: string }; Body: LinkLocationsRequest }>,
    reply: FastifyReply
  ) {
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

  async listConnectionsHandler(
    request: FastifyRequest<{ Querystring: ListConnectionsQuery }>,
    reply: FastifyReply
  ) {
    const result = await xeroService.listConnectionsForOrganisation(request.query.organisationId);
    return reply.status(200).send(result);
  }
}

