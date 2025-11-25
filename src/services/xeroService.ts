import { XeroConnectionRepository } from '../repositories/xeroConnectionRepository';
import { XeroLocationLinkRepository } from '../repositories/xeroLocationLinkRepository';
import { encryptToken } from '../utils/crypto';
import { XeroConnection, XeroLocationLink, OnboardingMode } from '@prisma/client';
import { onboardingSessionRepository } from '../repositories/onboardingSessionRepository';
import { organisationRepository } from '../repositories/organisationRepository';
import { locationRepository } from '../repositories/locationRepository';

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

  async generateAuthUrl(onboardingSessionId?: string): Promise<{ redirectUrl: string }> {
    // Check session if provided
    if (onboardingSessionId) {
        const session = await onboardingSessionRepository.findById(onboardingSessionId);
        if (!session || session.completedAt || session.expiresAt < new Date()) {
            throw new Error('Invalid or expired onboarding session');
        }
    } else {
        // Create new session
        const session = await onboardingSessionRepository.createSession(OnboardingMode.xero);
        onboardingSessionId = session.id;
    }

    const clientId = process.env.XERO_CLIENT_ID || 'stub_client_id';
    // Prioritize env var, fallback to frontend URL
    const redirectUri = process.env.XERO_REDIRECT_URI || 'http://localhost:3000/xero/authorise';
    const scopes = 'offline_access accounting.settings.read accounting.transactions.read';
    
    // Store session ID in state to verify on callback
    // Format: onboard_<sessionId>_<timestamp>
    const state = `onboard_${onboardingSessionId}_${Date.now()}`; 
    
    const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    
    return { redirectUrl: url };
  }

  async processCallback(code: string, state: string): Promise<any> {
    // Extract session ID from state
    // Expected format: onboard_<sessionId>_<timestamp>
    const parts = state.split('_');
    if (parts.length < 3 || parts[0] !== 'onboard') {
        throw new Error('Invalid state parameter');
    }
    const onboardingSessionId = parts[1];

    const session = await onboardingSessionRepository.findById(onboardingSessionId);
    if (!session || session.mode !== OnboardingMode.xero || session.completedAt || session.expiresAt < new Date()) {
        throw new Error('Invalid or expired onboarding session');
    }

    // TODO: Exchange code for tokens via Xero API
    // For now, we stub the Xero API calls and creation of org/locations
    
    // Stub: Create Organisation and Locations directly linked to session (no user yet)
    // In reality, we would fetch org details from Xero
    const mockOrgName = 'Xero Imported Org';
    const org = await organisationRepository.createOrganisation({ name: mockOrgName });
    
    // Stub: Create locations found in Xero
    const loc1 = await locationRepository.createLocation({ organisationId: org.id, name: 'Main Branch' });
    const loc2 = await locationRepository.createLocation({ organisationId: org.id, name: 'Second Branch' });

    // Attach to session
    await onboardingSessionRepository.attachOrganisationAndLocation(
        session.id,
        org.id,
        loc1.id // Defaulting to first location
    );
    
    return {
      onboardingSessionId: session.id,
      organisationId: org.id,
      organisationName: org.name,
      locations: [
        { id: loc1.id, name: loc1.name },
        { id: loc2.id, name: loc2.name }
      ]
    };
  }
}
