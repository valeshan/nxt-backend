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

  async generateAuthUrl(userId: string): Promise<{ redirectUrl: string }> {
    // Stub implementation - integrate actual Xero SDK later
    const clientId = process.env.XERO_CLIENT_ID || 'stub_client_id';
    const redirectUri = process.env.XERO_REDIRECT_URI || 'http://localhost:3000/xero/callback';
    const scopes = 'offline_access accounting.settings.read accounting.transactions.read';
    
    // Ideally state should be random and stored associated with userId to verify on callback
    const state = `user_${userId}_${Date.now()}`; 
    
    const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    
    return { redirectUrl: url };
  }

  async processCallback(userId: string, code: string, state: string): Promise<any> {
    // Stub implementation - would normally exchange code for tokens
    
    // 1. Validate state (if stored)
    // 2. Exchange code for tokens via Xero API
    // 3. Fetch Tenants
    // 4. Create Organisation, Locations, UserOrganisation links
    
    // Mock Response structure matching spec
    return {
      organisationId: 'mock-org-uuid',
      organisationName: 'Mock Xero Organisation',
      locations: [
        { id: 'mock-loc-1', name: 'Main Branch' },
        { id: 'mock-loc-2', name: 'Downtown Kiosk' }
      ]
    };
  }
}
