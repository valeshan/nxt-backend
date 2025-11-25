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

  async registerWithOnboarding(input: RegisterOnboardInput) {
    let session = null;
    let location = null;

    const hasSessionPath = Boolean(input.onboardingSessionId && input.selectedLocationId);
    const hasXeroPath = Boolean(input.xeroCode && input.xeroState);

    if (hasSessionPath) {
      session = await onboardingSessionRepository.findById(input.onboardingSessionId!);
      if (!session || session.completedAt || session.expiresAt < new Date()) {
        throw { statusCode: 400, message: 'Invalid or expired onboarding session' };
      }

      if (!session.locationId || !session.organisationId) {
        throw { statusCode: 400, message: 'Onboarding session is incomplete (missing venue)' };
      }

      location = await locationRepository.findById(input.selectedLocationId!);
      if (!location || location.organisationId !== session.organisationId) {
        throw { statusCode: 400, message: 'Invalid location selection' };
      }
    } else if (hasXeroPath) {
      // Process Xero callback directly via backend
      const xeroResult = await xeroService.processCallback(input.xeroCode!, input.xeroState!);
      session = await onboardingSessionRepository.findById(xeroResult.onboardingSessionId);

      if (!session || session.completedAt || session.expiresAt < new Date()) {
        throw { statusCode: 400, message: 'Invalid or expired onboarding session' };
      }

      if (!session.organisationId) {
        throw { statusCode: 400, message: 'Organisation missing from onboarding session' };
      }

      const resolvedLocationId =
        xeroResult.locations?.[0]?.id ||
        session.locationId;

      if (!resolvedLocationId) {
        throw { statusCode: 400, message: 'No locations available from Xero onboarding' };
      }

      location = await locationRepository.findById(resolvedLocationId);
      if (!location || location.organisationId !== session.organisationId) {
        throw { statusCode: 400, message: 'Invalid location derived from Xero onboarding' };
      }
    } else {
      throw { statusCode: 400, message: 'Provide onboarding session or Xero code to register' };
    }

    // 3. Create User
    if (!session || !location) {
      throw { statusCode: 500, message: 'Unable to resolve onboarding context' };
    }

    const existingUser = await userRepository.findByEmail(input.email);
    if (existingUser) {
      throw { statusCode: 409, message: 'User already exists' };
    }

    const passwordHash = await hashPassword(input.password);
    const name = `${input.firstName} ${input.lastName}`.trim();
    
    const user = await userRepository.createUser({
      email: input.email,
      passwordHash,
      name,
    });

    // 4. Create UserSettings
    await userSettingsRepository.upsertForUser(user.id, {});

    // 5. Create UserOrganisation (Owner)
    await userOrganisationRepository.addUserToOrganisation(user.id, session.organisationId, OrganisationRole.owner);

    // 6. Mark Session Completed
    await onboardingSessionRepository.markCompleted(session.id);
    // Update session email if not set
    if (!session.email) {
        await onboardingSessionRepository.updateEmail(session.id, user.email);
    }

    // 7. Issue Tokens (Final Access/Refresh Tokens for the selected location)
    // We skip login/org tokens and go straight to location token as per new flow requirement
    const accessToken = signAccessToken({ 
      sub: user.id, 
      orgId: session.organisationId, 
      locId: location.id, 
      type: 'access_token' 
    });
    const refreshToken = signRefreshToken({ 
      sub: user.id, 
      orgId: session.organisationId, 
      locId: location.id, 
      type: 'refresh_token' 
    });

    // Get Org details for response
    const org = await organisationRepository.findById(session.organisationId);

    return {
      user_id: user.id,
      profile_picture: user.profilePicture,
      organisation: {
        id: org?.id,
        name: org?.name
      },
      location: {
        id: location.id,
        name: location.name
      },
      access_token: accessToken,
      refresh_token: refreshToken,
      type: 'bearer',
      expires_in: 900, // 15m
    };
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
