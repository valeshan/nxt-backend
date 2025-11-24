import { XeroConnectionRepository } from '../repositories/xeroConnectionRepository';
import { XeroLocationLinkRepository } from '../repositories/xeroLocationLinkRepository';
import { encryptToken } from '../utils/crypto';
import { XeroConnection, XeroLocationLink } from '@prisma/client';

const connectionRepo = new XeroConnectionRepository();
const linkRepo = new XeroLocationLinkRepository();

export class XeroService {
  async createConnection(params: {
    organisationId: string;
    xeroTenantId: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string; // ISO string
  }): Promise<XeroConnection> {
    const accessTokenEncrypted = encryptToken(params.accessToken);
    const refreshTokenEncrypted = encryptToken(params.refreshToken);

    return connectionRepo.createConnection({
      organisationId: params.organisationId,
      xeroTenantId: params.xeroTenantId,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accessTokenExpiresAt: new Date(params.accessTokenExpiresAt),
      status: 'active',
    });
  }

  async linkLocations(params: {
    organisationId: string;
    connectionId: string;
    locationIds: string[];
  }): Promise<XeroConnection & { locationLinks: XeroLocationLink[] }> {
    const connection = await connectionRepo.findById(params.connectionId);
    if (!connection) {
      const error: any = new Error('Connection not found');
      error.code = 'NOT_FOUND';
      throw error;
    }

    if (connection.organisationId !== params.organisationId) {
      const error: any = new Error('Organisation mismatch');
      error.code = 'FORBIDDEN';
      throw error;
    }

    await linkRepo.createLinks(params.connectionId, params.locationIds);

    // Return updated connection with links
    const updatedConnection = await connectionRepo.findById(params.connectionId);
    if (!updatedConnection) {
       throw new Error('Connection lost after update');
    }
    // Type assertion as findById includes locationLinks
    return updatedConnection as XeroConnection & { locationLinks: XeroLocationLink[] };
  }

  async listConnectionsForOrganisation(organisationId: string): Promise<XeroConnection[]> {
    return connectionRepo.findByOrganisation(organisationId);
  }

  async refreshAccessToken(connectionId: string): Promise<void> {
    // TODO: Implement OAuth token rotation
    // 1. Load connection
    // 2. Decrypt refresh token
    // 3. Call Xero API to refresh
    // 4. Encrypt new tokens and update DB
    throw new Error('Not Implemented');
  }
}

