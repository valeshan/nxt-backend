/// <reference types="vitest" />

import { buildApp } from '../src/app';
import { config } from '../src/config/env';
import prisma from '../src/infrastructure/prismaClient';
import { onboardingSessionRepository } from '../src/repositories/onboardingSessionRepository';
import { OnboardingMode } from '@prisma/client';

describe('Onboarding Flow Integration', () => {
  let app: any;

  beforeAll(async () => {
    config.NODE_ENV = 'test';
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Cleanup DB (order matters due to foreign keys)
    // Note: XeroConnection has an FK to User, so delete Xero tables before users.
    await prisma.xeroInvoiceLineItem.deleteMany();
    await prisma.xeroInvoice.deleteMany();
    await prisma.xeroLocationLink.deleteMany();
    await prisma.xeroSyncRun.deleteMany();
    await prisma.xeroConnection.deleteMany();

    await prisma.invoiceLineItem.deleteMany();
    await prisma.invoiceOcrResult.deleteMany();
    await prisma.invoice.deleteMany();         // Must be before location
    await prisma.invoiceFile.deleteMany();

    await prisma.userOrganisation.deleteMany();
    await prisma.userSettings.deleteMany();
    await prisma.user.deleteMany();

    await prisma.locationAccountConfig.deleteMany();
    await prisma.supplierAlias.deleteMany();
    await prisma.location.deleteMany();
    await prisma.supplierSourceLink.deleteMany();
    await prisma.product.deleteMany();
    await prisma.supplier.deleteMany();
    await prisma.organisation.deleteMany();
    await prisma.onboardingSession.deleteMany();
  });

  describe('Manual Onboarding Flow', () => {
    it('should create session, org, location and then register user', async () => {
      // 1. Manual Onboard (No User)
      const onboardRes = await app.inject({
        method: 'POST',
        url: '/organisations/onboard/manual',
        payload: {
          venueName: 'Test Cafe Manual'
        }
      });

      expect(onboardRes.statusCode).toBe(201);
      const onboardData = JSON.parse(onboardRes.payload);
      expect(onboardData).toHaveProperty('onboardingSessionId');
      expect(onboardData).toHaveProperty('organisationId');
      expect(onboardData).toHaveProperty('locationId');
      expect(onboardData.organisationName).toBe('Test Cafe Manual');

      const sessionId = onboardData.onboardingSessionId;
      const locationId = onboardData.locationId;

      // Verify session in DB
      const session = await onboardingSessionRepository.findById(sessionId);
      expect(session).toBeTruthy();
      expect(session?.mode).toBe(OnboardingMode.manual);
      expect(session?.completedAt).toBeNull();

      // 2. Register User linked to session
      const registerRes = await app.inject({
        method: 'POST',
        url: '/auth/register-onboard',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.manual@example.com',
          password: 'password123',
          confirmPassword: 'password123',
          acceptedTerms: true,
          acceptedPrivacy: true,
          onboardingSessionId: sessionId,
          selectedLocationId: locationId,
          venueName: 'Test Cafe Manual' // Required by Zod schema if not using Xero
        }
      });

      expect(registerRes.statusCode).toBe(201);
      const registerData = JSON.parse(registerRes.payload);
      
      expect(registerData).toHaveProperty('user_id');
      expect(registerData).toHaveProperty('access_token');
      expect(registerData).toHaveProperty('refresh_token');
      expect(registerData.organisation.name).toBe('Test Cafe Manual');

      // Verify session completed
      const completedSession = await onboardingSessionRepository.findById(sessionId);
      expect(completedSession?.completedAt).not.toBeNull();
      expect(completedSession?.email).toBe('john.manual@example.com');

      // Verify User
      const user = await prisma.user.findUnique({ where: { id: registerData.user_id } });
      expect(user).toBeTruthy();
      expect(user?.email).toBe('john.manual@example.com');
    }, 15000);
  });

  describe('Xero Onboarding Flow (Mocked)', () => {
    // Since we can't easily mock the Xero callback without more setup, 
    // we will test the start endpoint and session creation.
    
    it('should create Xero session on start', async () => {
      const startRes = await app.inject({
        method: 'GET',
        url: '/xero/authorise/start'
      });

      expect(startRes.statusCode).toBe(200);
      const startData = JSON.parse(startRes.payload);
      expect(startData).toHaveProperty('redirectUrl');
      
      // Extract state to find session ID (mock implementation detail)
      // URL: ...&state=onboard_UUID_TIMESTAMP
      const url = new URL(startData.redirectUrl);
      const state = url.searchParams.get('state');
      expect(state).toContain('onboard_');
      
      const sessionId = state?.split('_')[1];
      expect(sessionId).toBeTruthy();

      const session = await onboardingSessionRepository.findById(sessionId!);
      expect(session).toBeTruthy();
      expect(session?.mode).toBe(OnboardingMode.xero);
    });
  });
});

