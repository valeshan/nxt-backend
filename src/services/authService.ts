import { userRepository } from '../repositories/userRepository';
import { userSettingsRepository } from '../repositories/userSettingsRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { organisationRepository } from '../repositories/organisationRepository';
import { locationRepository } from '../repositories/locationRepository';
import { onboardingSessionRepository } from '../repositories/onboardingSessionRepository';
import { hashPassword, verifyPassword } from '../utils/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken, verifyToken, AuthTokenType, ACCESS_TOKEN_TTL_SECONDS, TokenPayload } from '../utils/jwt';
import { Prisma, OrganisationRole, XeroSyncScope } from '@prisma/client';
import { RegisterOnboardRequestSchema } from '../dtos/authDtos';
import { z } from 'zod';
import { XeroService } from './xeroService';
import { XeroSyncService } from './xeroSyncService';
import prisma from '../infrastructure/prismaClient';
import { locationService } from './locationService';

type RegisterOnboardInput = z.infer<typeof RegisterOnboardRequestSchema>;

const xeroService = new XeroService();
const xeroSyncService = new XeroSyncService();

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***'; // fallback
  if (local.length <= 1) return `*@${domain}`;
  if (local.length === 2) return `${local[0]}*@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

export const authService = {
  async registerUser(email: string, password: string, firstName: string, lastName: string) {
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      throw { statusCode: 409, message: 'User already exists' };
    }

    const passwordHash = await hashPassword(password);
    const user = await userRepository.createUser({
      email,
      passwordHash,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
    });

    // Use upsert to avoid race conditions if multiple requests try to create settings
    await userSettingsRepository.upsertForUser(user.id, {});

    // Return user without sensitive data
    const { passwordHash: _, ...userSafe } = user;
    return userSafe;
  },

  async getMe(userId: string, context?: { organisationId?: string | null; locationId?: string | null; tokenType?: AuthTokenType }) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'authService.ts:54',message:'getMe entry',data:{userId,hasContext:!!context,organisationId:context?.organisationId,locationId:context?.locationId,tokenType:context?.tokenType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
    // #endregion
    const user = await userRepository.findById(userId);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'authService.ts:56',message:'After findById',data:{userFound:!!user,userEmail:user?.email},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
    // #endregion
    if (!user) {
      console.error(`[AuthService] getMe: User not found for id ${userId}`);
      throw { statusCode: 404, message: 'User not found' };
    }

    // Get organisations
    const memberships = await organisationRepository.listForUser(user.id);
    console.log(`[AuthService] getMe: User ${user.email} has ${memberships.length} memberships`);
    
    const companies = memberships.map(m => ({
      id: m.organisationId,
      name: m.organisation.name,
      role: m.role,
    }));

    const result = {
      user_id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      profile_picture: user.profilePicture,
      companies,
      isAuthenticated: true,
      // Reflect current auth context so BE2 frontend can hydrate from backend,
      // without relying on legacy localStorage state.
      currentOrganisationId: context?.organisationId ?? null,
      currentLocationId: context?.locationId ?? null,
      tokenType: context?.tokenType ?? 'login',
    };
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/613ef4ed-1e5c-4ea7-9c91-6649f4706354',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'authService.ts:75',message:'getMe result',data:{hasResult:!!result,companiesCount:companies.length,currentOrgId:result.currentOrganisationId,currentLocId:result.currentLocationId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
    // #endregion
    return result;
  },

  async updateProfile(userId: string, data: { firstName: string; lastName: string }) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    const updatedUser = await userRepository.updateUser(userId, {
      firstName: data.firstName,
      lastName: data.lastName,
      name: `${data.firstName} ${data.lastName}`.trim(),
    });

    const { passwordHash: _, ...userSafe } = updatedUser;
    return userSafe;
  },

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    const valid = await verifyPassword(oldPassword, user.passwordHash);
    if (!valid) {
      throw { statusCode: 401, message: 'Invalid old password' };
    }

    const passwordHash = await hashPassword(newPassword);
    // Security: increment tokenVersion on password change to revoke existing refresh tokens.
    const nextTokenVersion = ((user as any).tokenVersion ?? 0) + 1;
    await userRepository.updateUser(userId, { passwordHash, tokenVersion: nextTokenVersion } as any);

    return { message: 'Password updated successfully' };
  },

  async logout(userId: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      // Idempotent logout
      return { success: true };
    }

    const nextTokenVersion = ((user as any).tokenVersion ?? 0) + 1;
    await userRepository.updateUser(userId, { tokenVersion: nextTokenVersion } as any);
    return { success: true };
  },

  /**
   * Atomic onboarding: Creates User, Organisation, Location, and optionally XeroConnection
   * in a single Prisma transaction to prevent orphan records.
   */
  async registerOnboard(input: RegisterOnboardInput) {
    console.log('[AuthService] registerOnboard called', {
      email: input.email,
      hasXeroCode: !!input.xeroCode,
      hasXeroState: !!input.xeroState,
      hasVenueName: !!input.venueName,
    });

    // Validate input mode
    const hasXero = Boolean(input.xeroCode && input.xeroState);
    const hasManual = Boolean(input.venueName);

    if (!hasXero && !hasManual) {
      console.error('[AuthService] No onboarding mode provided');
      throw { statusCode: 400, message: 'Provide either Xero code + state OR venue name' };
    }

    // Check if user already exists
    const existingUser = await userRepository.findByEmail(input.email);
    if (existingUser) {
      console.error('[AuthService] User already exists', { email: input.email });
      throw { statusCode: 409, message: 'User already exists' };
    }

    // Prepare user data
    const passwordHash = await hashPassword(input.password);
    const name = `${input.firstName} ${input.lastName}`.trim();

    // For Xero path: exchange code for tokens first (outside transaction - external API call)
    let xeroData: {
      tenantId: string;
      tenantName: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
    } | null = null;

    if (hasXero) {
      console.log('[AuthService] Starting Xero OAuth exchange');
      try {
        xeroData = await xeroService.exchangeCodeAndPrepareOrgForOnboard({
          xeroCode: input.xeroCode!,
          xeroState: input.xeroState!,
        });
        console.log('[AuthService] Xero OAuth exchange successful', {
          tenantId: xeroData.tenantId,
          tenantName: xeroData.tenantName,
        });
      } catch (error: any) {
        console.error('[AuthService] Xero OAuth exchange failed', {
          error: error.message,
          stack: error.stack,
        });
        throw { statusCode: 400, message: `Xero OAuth failed: ${error.message}` };
      }
    }

    // Check for existing Xero connection (Conflict Check)
    if (hasXero && xeroData) {
      const existingConnection = await prisma.xeroConnection.findUnique({
        where: { xeroTenantId: xeroData.tenantId },
        include: { user: true }
      });

      if (existingConnection) {
        // If the connection belongs to the same user who is trying to register, 
        // normally we would check existingUser.id === existingConnection.userId.
        // But since this is *register*Onboard, existingUser was already checked above and threw 409 if found.
        // So any existing connection here MUST belong to a DIFFERENT user account.
        
        const maskedEmail = maskEmail(existingConnection.user.email);
        console.warn(`[AuthService] Xero tenant ${xeroData.tenantId} already linked to user ${existingConnection.userId} (${maskedEmail})`);
        
        throw { 
          statusCode: 409, 
          message: `This Xero organisation is already connected to an account (${maskedEmail})` 
        };
      }
    }

    // Execute all DB operations in a single transaction
    console.log('[AuthService] Starting database transaction');
    let connectionId: string | undefined;
    
    const result = await prisma.$transaction(async (tx) => {
      // Determine organisation and location names
      const orgName = hasXero ? xeroData!.tenantName : input.venueName!;
      const locationName = orgName; // Same name for both

      console.log('[AuthService] Creating records in transaction', { orgName, locationName });

      // 1. Create Organisation
      const organisation = await tx.organisation.create({
        data: { name: orgName },
      });
      console.log('[AuthService] Organisation created', { id: organisation.id, name: organisation.name });

      // 2. Create Location (default location for Xero, or venue location for manual)
      const location = await tx.location.create({
        data: {
          name: locationName,
          organisationId: organisation.id,
          industry: input.industry || null,
          region: input.region ? input.region.trim().toLowerCase() : null, // Normalize region at write time
        } as any,
      });
      console.log('[AuthService] Location created', { id: location.id, name: location.name, industry: (location as any).industry, region: (location as any).region });

      // 3. Create User
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          name,
        },
      });
      console.log('[AuthService] User created', { id: user.id, email: user.email });

      // 4. Create UserSettings
      await tx.userSettings.create({
        data: {
          userId: user.id,
        },
      });
      console.log('[AuthService] UserSettings created');

      // 5. Create UserOrganisation (Owner role)
      await tx.userOrganisation.create({
        data: {
          userId: user.id,
          organisationId: organisation.id,
          role: OrganisationRole.owner,
        },
      });
      console.log('[AuthService] UserOrganisation created');

      // 6. For Xero path: Create XeroConnection and XeroLocationLink
      if (hasXero && xeroData) {
        console.log('[AuthService] Creating XeroConnection');
        const conn = await xeroService.persistXeroConnectionForOrg({
          tx,
          userId: user.id,
          organisationId: organisation.id,
          locationId: location.id,
          tenantId: xeroData.tenantId,
          tenantName: xeroData.tenantName,
          accessToken: xeroData.accessToken,
          refreshToken: xeroData.refreshToken,
          expiresAt: xeroData.expiresAt,
          xeroCode: input.xeroCode,   // Store for audit/debugging
          xeroState: input.xeroState, // Store for audit/debugging
        });
        connectionId = conn.connectionId;
        console.log('[AuthService] XeroConnection created', { connectionId });
      }

      // 7. Issue final location-level tokens
      const accessToken = signAccessToken({
        sub: user.id,
        orgId: organisation.id,
        locId: location.id,
        tokenType: 'location',
        roles: [OrganisationRole.owner],
        tokenVersion: (user as any).tokenVersion ?? 0,
      });
      const refreshToken = signRefreshToken({
        sub: user.id,
        orgId: organisation.id,
        locId: location.id,
        tokenType: 'location',
        roles: [OrganisationRole.owner],
        tokenVersion: (user as any).tokenVersion ?? 0,
      });

      // 8. Update Onboarding Session if present
      if (input.onboardingSessionId) {
         try {
           await onboardingSessionRepository.completeSession(input.onboardingSessionId, user.email);
           console.log('[AuthService] Onboarding session marked complete', { sessionId: input.onboardingSessionId });
         } catch (e) {
           console.warn('[AuthService] Failed to complete onboarding session (non-fatal)', e);
         }
      }

      return {
        user,
        organisation,
        location,
        accessToken,
        refreshToken,
      };
    }, { timeout: 10000 });

    console.log('[AuthService] Transaction completed successfully');

    // 8. For Xero path: Trigger Backfill & Test Connection
    if (hasXero && xeroData && connectionId) {
      // Test Connection (Verification)
      try {
        console.log('[AuthService] Testing Xero API connection');
        await xeroService.testXeroConnection({
          accessToken: xeroData.accessToken,
          refreshToken: xeroData.refreshToken,
          tenantId: xeroData.tenantId,
        });
        console.log('[AuthService] Xero API connection test successful');
      } catch (testError: any) {
        console.error('[AuthService] Xero API connection test failed (non-blocking)', {
          error: testError.message,
        });
      }

      // Trigger Async Backfill
      console.log('[AuthService] Triggering initial backfill sync');
      // Updated to new syncConnection method
      xeroSyncService.syncConnection({
          connectionId,
          organisationId: result.organisation.id,
          scope: XeroSyncScope.FULL // Initial sync should be full
      })
        .then(() => console.log(`[AuthService] Initial sync completed for org ${result.organisation.id}`))
        .catch((err: unknown) => console.error(`[AuthService] Initial sync failed for org ${result.organisation.id}`, err));
    }

    // Return response in BE2 format
    return {
      user_id: result.user.id,
      profile_picture: result.user.profilePicture,
      organisation: {
        id: result.organisation.id,
        name: result.organisation.name,
      },
      location: {
        id: result.location.id,
        name: result.location.name,
      },
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS, // 15m
    };
  },

  // Keep old method for backward compatibility (deprecated)
  async registerWithOnboarding(input: RegisterOnboardInput) {
    // Redirect to new atomic method
    return this.registerOnboard(input);
  },

  async login(email: string, pass: string) {
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw { statusCode: 401, message: 'Invalid credentials' };
    }

    const valid = await verifyPassword(pass, user.passwordHash);
    if (!valid) {
      throw { statusCode: 401, message: 'Invalid credentials' };
    }

    // Get organisations
    const memberships = await organisationRepository.listForUser(user.id);
    const companies = memberships.map(m => ({
      id: m.organisationId,
      name: m.organisation.name,
      role: m.role,
    }));

    const accessToken = signAccessToken({ sub: user.id, tokenType: 'login', roles: [], tokenVersion: (user as any).tokenVersion ?? 0 });
    const refreshToken = signRefreshToken({ sub: user.id, tokenType: 'login', roles: [], tokenVersion: (user as any).tokenVersion ?? 0 });

    return {
      user_id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      profile_picture: user.profilePicture,
      companies,
      access_token: accessToken,
      refresh_token: refreshToken,
      type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS, // 15m
    };
  },

  async selectOrganisation(userId: string, organisationId: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership) {
      throw { statusCode: 403, message: 'Not a member of this organisation' };
    }

    const locations = await locationService.listForOrganisation(userId, organisationId);
    
    const roles = [membership.role];
    const accessToken = signAccessToken({ sub: userId, orgId: organisationId, tokenType: 'organisation', roles, tokenVersion: (user as any).tokenVersion ?? 0 });
    const refreshToken = signRefreshToken({ sub: userId, orgId: organisationId, tokenType: 'organisation', roles, tokenVersion: (user as any).tokenVersion ?? 0 });

    // Return structure similar to BE1 (implied based on login return + locations)
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      locations,
      type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  },

  async selectLocation(userId: string, locationId: string) {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    const location = await locationRepository.findById(locationId);
    if (!location) {
      throw { statusCode: 404, message: 'Location not found' };
    }

    // Verify membership to the org of this location
    const membership = await userOrganisationRepository.findMembership(userId, location.organisationId);
    if (!membership) {
      throw { statusCode: 403, message: 'Not a member of the organisation owning this location' };
    }

    const settings = await userSettingsRepository.getForUser(userId);
    
    const roles = [membership.role];
    const accessToken = signAccessToken({ 
      sub: userId, 
      orgId: location.organisationId, 
      locId: locationId, 
      tokenType: 'location',
      roles,
      tokenVersion: (user as any).tokenVersion ?? 0
    });
    const refreshToken = signRefreshToken({ 
      sub: userId, 
      orgId: location.organisationId, 
      locId: locationId, 
      tokenType: 'location',
      roles,
      tokenVersion: (user as any).tokenVersion ?? 0
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user_settings: settings,
      type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  },

  async refreshTokens(token: string) {
    // Sanitize token for logs (last 6 chars)
    const tokenSuffix = token.slice(-6);
    const isProd = process.env.NODE_ENV === 'production';

    console.log(`[AuthService.refreshTokens] Start. Token suffix: ...${tokenSuffix}`);

    let decoded: TokenPayload;
    try {
      decoded = verifyRefreshToken(token);
    } catch (err: any) {
      const reason = err.name === 'TokenExpiredError' ? 'expired' : 
                     err.name === 'JsonWebTokenError' ? 'signature_invalid' : 'unknown';
      
      console.warn('[AuthService.refreshTokens] verify failed', {
        reason,
        errorName: err.name,
        errorMessage: err.message,
        tokenSuffix
      });

      throw { statusCode: 401, message: 'Invalid refresh token', code: isProd ? 'REFRESH_FAILED' : reason.toUpperCase() };
    }

    console.log(`[AuthService.refreshTokens] Verified. User: ${decoded.sub}, Type: ${decoded.tokenType}, Org: ${decoded.orgId || 'N/A'}`);

    // Check types
    const validTypes: AuthTokenType[] = ['login', 'organisation', 'location'];
    if (!validTypes.includes(decoded.tokenType)) {
      console.warn(`[AuthService.refreshTokens] Invalid token type: ${decoded.tokenType}`);
      throw { statusCode: 401, message: 'Invalid token type for refresh' };
    }

    const userId = decoded.sub;
    const user = await userRepository.findById(userId);
    if (!user) {
      console.warn(`[AuthService.refreshTokens] User not found: ${userId}`);
      throw { statusCode: 401, message: 'User not found' };
    }

    // Token revocation guard:
    // Do NOT increment tokenVersion on refresh (avoid race conditions with parallel refreshes).
    // Only increment on logout / password change / security breach.
    const currentTokenVersion = (user as any).tokenVersion ?? 0;
    const presentedTokenVersion = typeof (decoded as any).tokenVersion === 'number' ? (decoded as any).tokenVersion : 0;
    if (presentedTokenVersion !== currentTokenVersion) {
      console.warn('[AuthService.refreshTokens] tokenVersion mismatch', {
        userId,
        presentedTokenVersion,
        currentTokenVersion
      });
      throw { statusCode: 401, message: 'Invalid refresh token' };
    }

    let newTokenTokenType: AuthTokenType;
    let extraPayload: any = {};
    let roles: string[] = [];

    if (decoded.tokenType === 'login') {
      newTokenTokenType = 'login';
      roles = [];
    } else if (decoded.tokenType === 'organisation') {
      const orgId = decoded.orgId;
      if (!orgId) throw { statusCode: 401, message: 'Missing orgId in token' };

      // Verify org existence and membership
      const membership = await userOrganisationRepository.findMembership(userId, orgId);
      if (!membership) {
        console.warn(`[AuthService.refreshTokens] Membership invalid for org: ${orgId}`);
        throw { statusCode: 403, message: 'Membership invalid' };
      }

      newTokenTokenType = 'organisation';
      extraPayload = { orgId };
      roles = [membership.role];
    } else {
      // location
      const orgId = decoded.orgId;
      const locId = decoded.locId;
      if (!orgId || !locId) throw { statusCode: 401, message: 'Missing context in token' };

      // Verify location exists and belongs to org
      const location = await locationRepository.findById(locId);
      if (!location || location.organisationId !== orgId) {
        console.warn(`[AuthService.refreshTokens] Invalid location context: ${locId} for org ${orgId}`);
        throw { statusCode: 400, message: 'Invalid location context' };
      }

      // Verify membership
      const membership = await userOrganisationRepository.findMembership(userId, orgId);
      if (!membership) {
        console.warn(`[AuthService.refreshTokens] Membership invalid for org: ${orgId}`);
        throw { statusCode: 403, message: 'Membership invalid' };
      }

      newTokenTokenType = 'location';
      extraPayload = { orgId, locId };
      roles = [membership.role];
    }

    const newAccessToken = signAccessToken({ sub: userId, tokenType: newTokenTokenType, roles, tokenVersion: currentTokenVersion, ...extraPayload });
    const newRefreshToken = signRefreshToken({ sub: userId, tokenType: newTokenTokenType, roles, tokenVersion: currentTokenVersion, ...extraPayload });

    console.log(`[AuthService.refreshTokens] Success. Issued new tokens for user ${userId}, expires_in=${ACCESS_TOKEN_TTL_SECONDS}`);

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
};
