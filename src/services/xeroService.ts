import { XeroConnectionRepository } from '../repositories/xeroConnectionRepository';
import { XeroLocationLinkRepository } from '../repositories/xeroLocationLinkRepository';
import { encryptToken, decryptToken } from '../utils/crypto';
import { XeroConnection, XeroLocationLink, OnboardingMode, Prisma } from '@prisma/client';
import { onboardingSessionRepository } from '../repositories/onboardingSessionRepository';
import { organisationRepository } from '../repositories/organisationRepository';
import { locationRepository } from '../repositories/locationRepository';
import { XeroClient } from 'xero-node';
import { config } from '../config/env';
import prisma from '../infrastructure/prismaClient';
import { XeroConnectionDto } from '../dtos/xeroDtos';

const connectionRepo = new XeroConnectionRepository();
const linkRepo = new XeroLocationLinkRepository();

export class XeroService {
  async createConnection(params: {
    organisationId: string;
    userId: string;
    xeroTenantId: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string; // ISO string
  }): Promise<XeroConnection> {
    // Encrypt tokens before storing (field names are accessToken/refreshToken, but values are encrypted)
    const accessTokenEncrypted = encryptToken(params.accessToken);
    const refreshTokenEncrypted = encryptToken(params.refreshToken);

    return connectionRepo.createConnection({
      organisationId: params.organisationId,
      userId: params.userId, // Pass userId
      xeroTenantId: params.xeroTenantId,
      accessToken: accessTokenEncrypted, // Field name is accessToken, value is encrypted
      refreshToken: refreshTokenEncrypted, // Field name is refreshToken, value is encrypted
      expiresAt: new Date(params.accessTokenExpiresAt),
      // Note: status field was removed from schema
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

    await linkRepo.createLinks(params.connectionId, params.organisationId, params.locationIds);

    // Return updated connection with links
    const updatedConnection = await connectionRepo.findById(params.connectionId);
    if (!updatedConnection) {
       throw new Error('Connection lost after update');
    }
    // Type assertion as findById includes locationLinks
    // Using any to bypass the strict XeroConnectionWithLocations type for this method temporarily, or update return type
    return updatedConnection as any;
  }

  async listConnectionsForOrganisation(organisationId: string): Promise<XeroConnectionDto[]> {
    const connections = await connectionRepo.findByOrganisation(organisationId);
    
    return connections.map(conn => ({
      id: conn.id,
      tenantName: conn.tenantName,
      expiresAt: conn.expiresAt ? conn.expiresAt.toISOString() : null,
      linkedLocations: conn.locationLinks
        .filter(link => link.location != null)
        .map(link => ({
          id: link.location.id,
          name: link.location.name
        })),
      // Map new fields for UI status display
      lastSuccessfulSyncAt: conn.lastSuccessfulSyncAt ? conn.lastSuccessfulSyncAt.toISOString() : null,
      syncRuns: conn.syncRuns.map(run => ({
          id: run.id,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
          errorMessage: run.errorMessage
      }))
    }));
  }

  /**
   * Retrieve a XeroConnection with a valid access token.
   * Automatically refreshes the token if it is expired or about to expire (within 5 minutes).
   * Returns the connection with DECRYPTED tokens ready for use.
   */
  async getValidConnection(connectionId: string): Promise<XeroConnection> {
    const connection = await connectionRepo.findById(connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Check if token is expired or expiring soon (buffer 5 minutes)
    const now = new Date();
    const expiresAt = new Date(connection.expiresAt);
    const bufferMs = 5 * 60 * 1000; // 5 minutes

    if (now.getTime() + bufferMs >= expiresAt.getTime()) {
      console.log(`[XeroService] Token for connection ${connectionId} is expired or expiring soon. Refreshing...`);
      try {
        await this.refreshAccessToken(connectionId);
      } catch (error) {
        console.error(`[XeroService] Failed to refresh token for connection ${connectionId}`, error);
        throw error; // Propagate error so caller knows connection is invalid
      }
      
      // Re-fetch the updated connection
      const updatedConnection = await connectionRepo.findById(connectionId);
      if (!updatedConnection) {
         throw new Error('Connection lost after refresh');
      }
      
      // Decrypt tokens for usage
      updatedConnection.accessToken = decryptToken(updatedConnection.accessToken);
      updatedConnection.refreshToken = decryptToken(updatedConnection.refreshToken);
      
      return updatedConnection;
    }

    // Decrypt tokens for usage
    connection.accessToken = decryptToken(connection.accessToken);
    connection.refreshToken = decryptToken(connection.refreshToken);

    return connection;
  }

  async refreshAccessToken(connectionId: string): Promise<void> {
    const connection = await connectionRepo.findById(connectionId);
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Decrypt refresh token
    const refreshToken = decryptToken(connection.refreshToken);

    const clientId = config.XERO_CLIENT_ID || process.env.XERO_CLIENT_ID;
    const clientSecret = config.XERO_CLIENT_SECRET || process.env.XERO_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        throw new Error('Xero credentials missing');
    }

    const xero = new XeroClient({
      clientId,
      clientSecret,
      grantType: 'refresh_token',
    });

    // Xero Node SDK refreshWithRefreshToken
    let tokenSet = await xero.refreshWithRefreshToken(clientId, clientSecret, refreshToken);
    
    // Handle token set response structure variations
    const newAccessToken = tokenSet.access_token || tokenSet.accessToken || (tokenSet as any)?.body?.access_token;
    const newRefreshToken = tokenSet.refresh_token || tokenSet.refreshToken || (tokenSet as any)?.body?.refresh_token;
    
    if (!newAccessToken || !newRefreshToken) {
      throw new Error('Failed to refresh token: missing tokens in response');
    }

    const newAccessTokenEncrypted = encryptToken(newAccessToken);
    const newRefreshTokenEncrypted = encryptToken(newRefreshToken);
    
    // Calculate expiresAt
    const expiresAtValue = tokenSet.expires_at || tokenSet.expiresAt || (tokenSet as any)?.body?.expires_at;
    const expiresAt = expiresAtValue 
      ? new Date(typeof expiresAtValue === 'number' ? expiresAtValue * 1000 : expiresAtValue)
      : new Date(Date.now() + 30 * 60 * 1000); // Default 30 mins

    await connectionRepo.updateConnection(connectionId, {
      accessToken: newAccessTokenEncrypted,
      refreshToken: newRefreshTokenEncrypted,
      expiresAt: expiresAt,
    });
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

    const clientId = config.XERO_CLIENT_ID;
    const clientSecret = config.XERO_CLIENT_SECRET;
    const redirectUri = config.XERO_REDIRECT_URI || '';

    if (!clientId || !redirectUri) {
      throw new Error('Missing Xero configuration: CLIENT_ID or REDIRECT_URI');
    }

    const scopes = 'offline_access accounting.settings.read accounting.transactions.read accounting.attachments.read';
    
    // Store session ID in state to verify on callback
    // Format: onboard_<sessionId>_<timestamp>
    const state = `onboard_${onboardingSessionId}_${Date.now()}`; 
    
    const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    
    return { redirectUrl: url };
  }

  /**
   * Exchange OAuth code with Xero API and return tenant metadata.
   * Does NOT create any DB records - this is done atomically in registerOnboard.
   */
  async exchangeCodeAndPrepareOrgForOnboard(params: {
    xeroCode: string;
    xeroState: string;
  }): Promise<{
    tenantId: string;
    tenantName: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }> {
    console.log('[XeroService] Starting OAuth exchange', { 
      hasCode: !!params.xeroCode, 
      hasState: !!params.xeroState,
      codeLength: params.xeroCode?.length 
    });

    const clientId = config.XERO_CLIENT_ID || process.env.XERO_CLIENT_ID;
    const clientSecret = config.XERO_CLIENT_SECRET || process.env.XERO_CLIENT_SECRET;
    const redirectUri = config.XERO_REDIRECT_URI || process.env.XERO_REDIRECT_URI || 'http://localhost:3000/xero/authorise';

    console.log('[XeroService] Xero config check', { 
      hasClientId: !!clientId, 
      hasClientSecret: !!clientSecret,
      redirectUri 
    });

    if (!clientId || !clientSecret) {
      console.error('[XeroService] Missing Xero credentials');
      throw new Error('Xero client credentials not configured');
    }

    try {
      // The xero-node SDK's apiCallback method requires the state to be set in the config
      // because it uses this.config.state for CSRF validation in the openid-client library
      // Since we're building the auth URL manually, we need to set the state here
      const xero = new XeroClient({
        clientId,
        clientSecret,
        redirectUris: [redirectUri],
        scopes: 'offline_access accounting.settings.read accounting.transactions.read'.split(' '),
        state: params.xeroState, // Set the state for validation
      });

      console.log('[XeroService] Calling apiCallback with code and state');
      // Exchange code for tokens
      // The xero-node SDK's apiCallback expects:
      // 1. The callback URL with code and state as query params
      // 2. The state must be set in the XeroClient config (which we do above)
      // The SDK will validate that the state in the URL matches this.config.state
      const callbackUrl = `${redirectUri || ''}?code=${encodeURIComponent(params.xeroCode)}&state=${encodeURIComponent(params.xeroState)}`;
      console.log('[XeroService] Callback URL', { 
        callbackUrl: callbackUrl.substring(0, 200),
        codeLength: params.xeroCode.length,
        stateLength: params.xeroState.length,
        redirectUri,
        stateInConfig: !!xero.config?.state,
      });
      
      // Call apiCallback with the full callback URL
      // The SDK will extract code and state from the URL and validate the state matches config.state
      let tokenSet = await xero.apiCallback(callbackUrl);
      console.log('[XeroService] apiCallback succeeded', { 
        hasResult: !!tokenSet,
        resultType: typeof tokenSet,
        tokenSetKeys: tokenSet ? Object.keys(tokenSet) : [],
      });
      
      // If tokenSet is still not available, try getting it from the client
      if (!tokenSet) {
        console.log('[XeroService] TokenSet not in result, trying to get from client');
        // The client might have the tokenSet stored internally after apiCallback
        tokenSet = (xero as any).tokenSet || (xero as any).token_set || await xero.readTokenSet();
        console.log('[XeroService] TokenSet from client/readTokenSet', { 
          hasTokenSet: !!tokenSet,
          tokenSetKeys: tokenSet ? Object.keys(tokenSet) : [],
        });
      }
      
      if (!tokenSet) {
        console.error('[XeroService] TokenSet is null/undefined from all sources');
        throw new Error('Failed to obtain tokens from Xero: tokenSet is null');
      }

      // The xero-node SDK returns tokenSet with different property names
      // Try multiple possible property names
      const accessToken = tokenSet.access_token || tokenSet.accessToken || (tokenSet as any)?.body?.access_token;
      const refreshToken = tokenSet.refresh_token || tokenSet.refreshToken || (tokenSet as any)?.body?.refresh_token;
      const expiresAtValue = tokenSet.expires_at || tokenSet.expiresAt || (tokenSet as any)?.body?.expires_at;

      console.log('[XeroService] Extracted tokens', {
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
        expiresAtValue,
        tokenSetKeys: Object.keys(tokenSet),
        tokenSetSample: JSON.stringify(tokenSet, null, 2).substring(0, 1000),
      });

      if (!accessToken || !refreshToken) {
        console.error('[XeroService] Missing tokens in tokenSet', { 
          tokenSetStructure: JSON.stringify(tokenSet, null, 2).substring(0, 500) 
        });
        throw new Error(`Access token is undefined! TokenSet keys: ${JSON.stringify(Object.keys(tokenSet || {}))}, Full structure: ${JSON.stringify(tokenSet).substring(0, 200)}`);
      }

      // Ensure tokenSet is set on client before accessing tenants
      try {
        await xero.setTokenSet(tokenSet);
        console.log('[XeroService] TokenSet set on client');
      } catch (setError: any) {
        console.warn('[XeroService] Failed to set tokenSet on client (may already be set)', { error: setError.message });
      }

      console.log('[XeroService] Fetching tenants');
      // Get tenant information
      const tenants = await xero.updateTenants();
      
      console.log('[XeroService] Tenants received', { 
        tenantCount: tenants?.length || 0,
        tenants: tenants?.map(t => ({ id: t.tenantId, name: t.tenantName }))
      });

      if (!tenants || tenants.length === 0) {
        console.error('[XeroService] No tenants found');
        throw new Error('No Xero tenants found');
      }

      // Use the first tenant (user selects during OAuth)
      const tenant = tenants[0];
      const tenantId = tenant.tenantId;
      const tenantName = tenant.tenantName || 'Xero Organisation';

      // Calculate expiration (Xero tokens typically expire in 30 minutes)
      const expiresAt = expiresAtValue 
        ? new Date(typeof expiresAtValue === 'number' ? expiresAtValue * 1000 : expiresAtValue)
        : new Date(Date.now() + 30 * 60 * 1000);

      console.log('[XeroService] OAuth exchange successful', {
        tenantId,
        tenantName,
        expiresAt: expiresAt.toISOString(),
      });

      return {
        tenantId,
        tenantName,
        accessToken,
        refreshToken,
        expiresAt,
      };
    } catch (error: any) {
      console.error('[XeroService] OAuth exchange error', {
        error: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw new Error(`Xero OAuth exchange failed: ${error.message}`);
    }
  }

  /**
   * Persist XeroConnection and XeroLocationLink inside a Prisma transaction.
   * This method should be called from within prisma.$transaction().
   */
  async persistXeroConnectionForOrg(params: {
    tx: Prisma.TransactionClient;
    userId: string;
    organisationId: string;
    locationId: string;
    tenantId: string;
    tenantName: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    xeroCode?: string;  // OAuth code used (for audit/debugging)
    xeroState?: string; // OAuth state used (for audit/debugging)
  }): Promise<{ connectionId: string; linkId: string }> {
    // Encrypt tokens before storing
    const accessTokenEncrypted = encryptToken(params.accessToken);
    const refreshTokenEncrypted = encryptToken(params.refreshToken);

    // Create XeroConnection
    const connection = await params.tx.xeroConnection.create({
      data: {
        userId: params.userId,
        organisationId: params.organisationId,
        xeroTenantId: params.tenantId,
        tenantName: params.tenantName,
        accessToken: accessTokenEncrypted,
        refreshToken: refreshTokenEncrypted,
        expiresAt: params.expiresAt,
        xeroCode: params.xeroCode,   // Store for audit/debugging
        xeroState: params.xeroState, // Store for audit/debugging
      },
    });

    // Create XeroLocationLink
    const link = await params.tx.xeroLocationLink.create({
      data: {
        xeroConnectionId: connection.id,
        organisationId: params.organisationId,
        locationId: params.locationId,
      },
    });

    return {
      connectionId: connection.id,
      linkId: link.id,
    };
  }

  /**
   * Test Xero API connection by fetching organisation details.
   * This verifies that the access token is valid and the connection works.
   */
  async testXeroConnection(params: {
    accessToken: string;
    refreshToken: string;
    tenantId: string;
  }): Promise<void> {
    const clientId = config.XERO_CLIENT_ID || process.env.XERO_CLIENT_ID;
    const clientSecret = config.XERO_CLIENT_SECRET || process.env.XERO_CLIENT_SECRET;
    const redirectUri = config.XERO_REDIRECT_URI || process.env.XERO_REDIRECT_URI || 'http://localhost:3000/xero/authorise';

    if (!clientId || !clientSecret) {
      console.error('[XeroService] Test API: Missing Xero credentials');
      throw new Error('Xero client credentials not configured');
    }

    try {
      console.log('[XeroService] Test API Request: Starting', {
        tenantId: params.tenantId,
        endpoint: 'GET /api.xro/2.0/Organisation',
        timestamp: new Date().toISOString(),
      });

      // Create XeroClient and set token
      const xero = new XeroClient({
        clientId: clientId || '',
        clientSecret: clientSecret || '',
        redirectUris: [redirectUri],
        scopes: 'offline_access accounting.settings.read accounting.transactions.read accounting.attachments.read'.split(' '),
      });

      // Create token set from the access token
      const tokenSet = {
        access_token: params.accessToken,
        refresh_token: params.refreshToken,
        token_type: 'Bearer',
      };

      await xero.setTokenSet(tokenSet);
      console.log('[XeroService] Test API Request: Token set on client', {
        hasAccessToken: !!params.accessToken,
        hasRefreshToken: !!params.refreshToken,
        tenantId: params.tenantId,
      });

      // Make API call to get organisation details
      console.log('[XeroService] Test API Request: Calling getOrganisations', {
        tenantId: params.tenantId,
        method: 'GET',
        url: '/api.xro/2.0/Organisation',
      });

      const organisations = await xero.accountingApi.getOrganisations(params.tenantId);
      
      console.log('[XeroService] Test API Response: Success', {
        statusCode: 200,
        tenantId: params.tenantId,
        organisationCount: organisations?.body?.organisations?.length || 0,
        organisationData: organisations?.body?.organisations?.[0] ? {
          organisationID: organisations.body.organisations[0].organisationID,
          name: organisations.body.organisations[0].name,
          legalName: organisations.body.organisations[0].legalName,
          organisationType: organisations.body.organisations[0].organisationType,
          baseCurrency: organisations.body.organisations[0].baseCurrency,
        } : null,
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      console.error('[XeroService] Test API Response: Error', {
        statusCode: error.statusCode || 'N/A',
        error: error.message,
        errorName: error.name,
        tenantId: params.tenantId,
        endpoint: 'GET /api.xro/2.0/Organisation',
        errorStack: error.stack?.substring(0, 500),
        timestamp: new Date().toISOString(),
      });
      // Don't throw - we want to log the error but not fail the signup
      throw error;
    }
  }

  /**
   * Process Xero OAuth callback.
   * NOTE: This method does NOT create org/user/location records to prevent orphan records.
   * For signup flow, use exchangeCodeAndPrepareOrgForOnboard + registerOnboard instead.
   * This method is reserved for future "re-link Xero" flows for existing users.
   */
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

    // For signup flow, do NOT create orphan records here.
    // The frontend should pass code/state directly to /auth/register-onboard
    // which will handle everything atomically.
    // This method is reserved for future re-link flows.
    throw new Error('processCallback should not be used for signup. Use /auth/register-onboard with xeroCode and xeroState instead.');
  }

  async startConnect(params: {
    userId: string;
    organisationId: string;
    locationIds: string[];
  }): Promise<{ redirectUrl: string }> {
    const session = await prisma.xeroAuthSession.create({
      data: {
        userId: params.userId,
        organisationId: params.organisationId,
        locationIds: params.locationIds,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    const clientId = config.XERO_CLIENT_ID || process.env.XERO_CLIENT_ID;
    const appUrlRaw = process.env.APP_URL || config.FRONTEND_URL;

    if (!clientId) {
      throw new Error('Xero client id not configured');
    }
    if (!appUrlRaw) {
      throw new Error('APP_URL / FRONTEND_URL not configured');
    }

    // Normalize trailing slash to avoid double-slash redirects
    const appUrl = appUrlRaw.replace(/\/$/, '');
    const redirectUri = `${appUrl}/xero/callback`;
    const scopes = 'offline_access accounting.settings.read accounting.transactions.read accounting.attachments.read';
    const state = session.id;

    const url = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;

    return { redirectUrl: url };
  }

  async completeConnect(params: {
    code: string;
    state: string;
    organisationId: string;
    userId: string;
  }): Promise<{ success: true; tenantName: string; linkedLocations: any[] }> {
    const session = await prisma.xeroAuthSession.findUnique({
      where: { id: params.state },
    });

    if (!session) throw new Error('Invalid session');
    if (session.expiresAt < new Date()) {
        await prisma.xeroAuthSession.delete({ where: { id: session.id } }).catch(() => {});
        throw new Error('Session expired');
    }
    if (session.organisationId !== params.organisationId) throw new Error('Organisation mismatch');

    try {
      const clientId = config.XERO_CLIENT_ID || process.env.XERO_CLIENT_ID;
      const clientSecret = config.XERO_CLIENT_SECRET || process.env.XERO_CLIENT_SECRET;
      const appUrlRaw = process.env.APP_URL || config.FRONTEND_URL;

      if (!clientId || !clientSecret) {
        throw new Error('Xero client credentials not configured');
      }
      if (!appUrlRaw) {
        throw new Error('APP_URL / FRONTEND_URL not configured');
      }

      const appUrl = appUrlRaw.replace(/\/$/, '');
      const redirectUri = `${appUrl}/xero/callback`;

      // Debug-friendly (no secrets): helps diagnose prod config mismatches.
      console.log('[XeroService] completeConnect config', {
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
        appUrl,
        redirectUri,
        hasCode: !!params.code,
        codeLength: params.code?.length,
        hasState: !!params.state,
        stateLength: params.state?.length,
      });

      const xero = new XeroClient({
        clientId,
        clientSecret,
        redirectUris: [redirectUri],
        scopes: 'offline_access accounting.settings.read accounting.transactions.read accounting.attachments.read'.split(' '),
        state: params.state,
      });

      // IMPORTANT: encode code/state; OAuth codes can contain characters that break query parsing otherwise
      const callbackUrl = `${redirectUri}?code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(params.state)}`;
      const tokenSet = await xero.apiCallback(callbackUrl);
      
      if (!tokenSet || !tokenSet.access_token || !tokenSet.refresh_token) {
           throw new Error('Failed to receive tokens');
      }

      await xero.updateTenants();
      const tenants = xero.tenants;
      if (!tenants || tenants.length === 0) throw new Error('No tenants found');
      const tenant = tenants[0];

      const accessTokenEncrypted = encryptToken(tokenSet.access_token);
      const refreshTokenEncrypted = encryptToken(tokenSet.refresh_token);
      const expiresAtValue = tokenSet.expires_at || (tokenSet as any).expiresAt;
      const expiresAt = expiresAtValue 
        ? new Date(typeof expiresAtValue === 'number' ? expiresAtValue * 1000 : expiresAtValue)
        : new Date(Date.now() + 30 * 60 * 1000);

      // Upsert XeroConnection
      // NOTE: xeroTenantId has a UNIQUE constraint globally, so we must check by tenantId alone first.
      const existingConnection = await prisma.xeroConnection.findUnique({
        where: { xeroTenantId: tenant.tenantId },
      });

      let connection;
      if (existingConnection) {
        // If the connection belongs to a DIFFERENT organisation, we need to decide:
        // Option A: Error out (strict: one Xero tenant = one org)
        // Option B: Transfer ownership to the new org (flexible: user can re-link)
        // We'll go with Option B for better UX – user might be re-linking or changed orgs.
        if (existingConnection.organisationId !== params.organisationId) {
          console.log(
            `[XeroService] Transferring Xero connection ${existingConnection.id} from org ${existingConnection.organisationId} to ${params.organisationId}`
          );
        }

        connection = await prisma.xeroConnection.update({
          where: { id: existingConnection.id },
          data: {
            // Update org ownership in case it changed
            organisationId: params.organisationId,
            userId: params.userId,
            tenantName: tenant.tenantName || 'Xero Organisation',
            accessToken: accessTokenEncrypted,
            refreshToken: refreshTokenEncrypted,
            expiresAt: expiresAt,
            xeroCode: params.code,
            xeroState: params.state,
          },
        });
      } else {
        connection = await prisma.xeroConnection.create({
          data: {
            organisationId: params.organisationId,
            userId: params.userId,
            xeroTenantId: tenant.tenantId,
            tenantName: tenant.tenantName || 'Xero Organisation',
            accessToken: accessTokenEncrypted,
            refreshToken: refreshTokenEncrypted,
            expiresAt: expiresAt,
            xeroCode: params.code,
            xeroState: params.state,
          },
        });
      }

      // Upsert XeroLocationLinks
      const linkedLocations = [];
      for (const locationId of session.locationIds) {
           const existingLink = await prisma.xeroLocationLink.findFirst({
               where: {
                   xeroConnectionId: connection.id,
                   locationId: locationId,
               }
           });
           
           if (!existingLink) {
               const link = await prisma.xeroLocationLink.create({
                   data: {
                       xeroConnectionId: connection.id,
                       organisationId: params.organisationId,
                       locationId: locationId,
                   },
                   include: { location: true }
               });
               linkedLocations.push(link);
           } else {
               // Fetch existing link with location included for consistency
               const link = await prisma.xeroLocationLink.findUnique({
                   where: { id: existingLink.id },
                   include: { location: true }
               });
               linkedLocations.push(link);
           }
      }

      return { success: true, tenantName: tenant.tenantName || '', linkedLocations };

    } catch (error) {
        // Preserve as much context as possible for controller-level error shaping.
        console.error('[XeroService] completeConnect failed', {
          message: (error as any)?.message,
          name: (error as any)?.name,
          stack: (error as any)?.stack,
          // xero-node/openid-client often attach response details
          status: (error as any)?.response?.status,
          statusCode: (error as any)?.statusCode,
          data: (error as any)?.response?.data,
          body: (error as any)?.body,
        });
        throw error;
    } finally {
      await prisma.xeroAuthSession.delete({ where: { id: session.id } }).catch(() => {});
    }
  }
}
