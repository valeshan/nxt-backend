import { userRepository } from '../repositories/userRepository';
import { userSettingsRepository } from '../repositories/userSettingsRepository';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { organisationRepository } from '../repositories/organisationRepository';
import { locationRepository } from '../repositories/locationRepository';
import { onboardingSessionRepository } from '../repositories/onboardingSessionRepository';
import { hashPassword, verifyPassword } from '../utils/password';
import { signAccessToken, signRefreshToken, verifyToken, TokenType } from '../utils/jwt';
import { Prisma, OrganisationRole } from '@prisma/client';
import { RegisterOnboardRequestSchema } from '../dtos/authDtos';
import { z } from 'zod';
import { XeroService } from './xeroService';
import prisma from '../infrastructure/prismaClient';

type RegisterOnboardInput = z.infer<typeof RegisterOnboardRequestSchema>;

const xeroService = new XeroService();

export const authService = {
  async registerUser(email: string, password: string, name?: string) {
    const existing = await userRepository.findByEmail(email);
    if (existing) {
      throw { statusCode: 409, message: 'User already exists' };
    }

    const passwordHash = await hashPassword(password);
    const user = await userRepository.createUser({
      email,
      passwordHash,
      name,
    });

    // Use upsert to avoid race conditions if multiple requests try to create settings
    await userSettingsRepository.upsertForUser(user.id, {});

    // Return user without sensitive data
    const { passwordHash: _, ...userSafe } = user;
    return userSafe;
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

    // Execute all DB operations in a single transaction
    console.log('[AuthService] Starting database transaction');
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
        },
      });
      console.log('[AuthService] Location created', { id: location.id, name: location.name });

      // 3. Create User
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
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
        await xeroService.persistXeroConnectionForOrg({
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
        console.log('[AuthService] XeroConnection created');
      }

      // 7. Issue final location-level tokens
      const accessToken = signAccessToken({
        sub: user.id,
        orgId: organisation.id,
        locId: location.id,
        type: 'access_token',
      });
      const refreshToken = signRefreshToken({
        sub: user.id,
        orgId: organisation.id,
        locId: location.id,
        type: 'refresh_token',
      });

      return {
        user,
        organisation,
        location,
        accessToken,
        refreshToken,
      };
    });

    console.log('[AuthService] Transaction completed successfully');

    // 8. For Xero path: Test the API connection to verify it works
    if (hasXero && xeroData) {
      console.log('[AuthService] Testing Xero API connection');
      try {
        await xeroService.testXeroConnection({
          accessToken: xeroData.accessToken,
          refreshToken: xeroData.refreshToken,
          tenantId: xeroData.tenantId,
        });
        console.log('[AuthService] Xero API connection test successful');
      } catch (testError: any) {
        // Log error but don't fail signup - connection is created, test is just verification
        console.error('[AuthService] Xero API connection test failed (non-blocking)', {
          error: testError.message,
          tenantId: xeroData.tenantId,
        });
      }
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
      expires_in: 900, // 15m
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

    const accessToken = signAccessToken({ sub: user.id, type: 'access_token_login' });
    const refreshToken = signRefreshToken({ sub: user.id, type: 'refresh_token_login' });

    return {
      user_id: user.id,
      profile_picture: user.profilePicture,
      companies,
      access_token: accessToken,
      refresh_token: refreshToken,
      type: 'bearer',
      expires_in: 900, // 15m
    };
  },

  async selectOrganisation(userId: string, organisationId: string) {
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership) {
      throw { statusCode: 403, message: 'Not a member of this organisation' };
    }

    const locations = await locationRepository.listForOrganisation(organisationId);
    
    const accessToken = signAccessToken({ sub: userId, orgId: organisationId, type: 'access_token_company' });
    const refreshToken = signRefreshToken({ sub: userId, orgId: organisationId, type: 'refresh_token_company' });

    // Return structure similar to BE1 (implied based on login return + locations)
    // BE1 select-organisation usually returns token + maybe locations?
    // The prompt says: "return identical structure to BE1".
    // Usually this means: access_token, refresh_token, locations?
    // I will assume standard token response + locations.
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      locations,
      type: 'bearer',
      expires_in: 900,
    };
  },

  async selectLocation(userId: string, locationId: string) {
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

    const accessToken = signAccessToken({ 
      sub: userId, 
      orgId: location.organisationId, 
      locId: locationId, 
      type: 'access_token' 
    });
    const refreshToken = signRefreshToken({ 
      sub: userId, 
      orgId: location.organisationId, 
      locId: locationId, 
      type: 'refresh_token' 
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user_settings: settings,
      type: 'bearer',
      expires_in: 900,
    };
  },

  async refreshTokens(token: string) {
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      throw { statusCode: 401, message: 'Invalid refresh token' };
    }

    // Check types
    const validTypes = ['refresh_token_login', 'refresh_token_company', 'refresh_token'];
    if (!validTypes.includes(decoded.type)) {
      throw { statusCode: 401, message: 'Invalid token type for refresh' };
    }

    const userId = decoded.sub;
    const user = await userRepository.findById(userId);
    if (!user) {
      throw { statusCode: 401, message: 'User not found' };
    }

    let newAccessType: TokenType;
    let newRefreshType: TokenType;
    let extraPayload: any = {};

    if (decoded.type === 'refresh_token_login') {
      newAccessType = 'access_token_login';
      newRefreshType = 'refresh_token_login';
    } else if (decoded.type === 'refresh_token_company') {
      const orgId = decoded.orgId;
      if (!orgId) throw { statusCode: 401, message: 'Missing orgId in token' };

      // Verify org existence and membership
      const membership = await userOrganisationRepository.findMembership(userId, orgId);
      if (!membership) throw { statusCode: 403, message: 'Membership invalid' };

      newAccessType = 'access_token_company';
      newRefreshType = 'refresh_token_company';
      extraPayload = { orgId };
    } else {
      // refresh_token (final)
      const orgId = decoded.orgId;
      const locId = decoded.locId;
      if (!orgId || !locId) throw { statusCode: 401, message: 'Missing context in token' };

      // Verify location exists and belongs to org
      const location = await locationRepository.findById(locId);
      if (!location || location.organisationId !== orgId) {
        throw { statusCode: 400, message: 'Invalid location context' };
      }

      // Verify membership
      const membership = await userOrganisationRepository.findMembership(userId, orgId);
      if (!membership) throw { statusCode: 403, message: 'Membership invalid' };

      newAccessType = 'access_token';
      newRefreshType = 'refresh_token';
      extraPayload = { orgId, locId };
    }

    const newAccessToken = signAccessToken({ sub: userId, type: newAccessType, ...extraPayload });
    const newRefreshToken = signRefreshToken({ sub: userId, type: newRefreshType, ...extraPayload });

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      type: 'bearer',
      expires_in: 900,
    };
  }
};
