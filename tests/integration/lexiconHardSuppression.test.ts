import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';
import { ProcessingStatus, InvoiceSourceType } from '@prisma/client';
import { normalizePhraseKey } from '../../src/utils/descriptionQuality';

describe('Lexicon Hard Suppression E2E Tests', () => {
  let app: FastifyInstance;
  let authToken: string;
  let orgId: string;
  let locId: string;
  let supplierId: string;
  let invoiceId: string;
  let invoiceFileId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();

    // 1. Setup User & Org
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'lexicon-test@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        firstName: 'Test',
        lastName: 'User',
        acceptedTerms: true,
        acceptedPrivacy: true
      }
    });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'lexicon-test@example.com', password: 'password123' }
    });
    const loginToken = loginRes.json().access_token;

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/organisations/onboard/manual',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { venueName: 'Test Venue' }
    });
    orgId = onboardRes.json().organisationId;
    locId = onboardRes.json().locationId;

    const selectOrgRes = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { organisationId: orgId }
    });
    authToken = selectOrgRes.json().access_token;

    // 2. Create Supplier
    const supplier = await prisma.supplier.create({
      data: {
        organisationId: orgId,
        name: 'Test Supplier',
        normalizedName: 'test supplier',
        sourceType: 'MANUAL',
        status: 'ACTIVE'
      }
    });
    supplierId = supplier.id;

    // 3. Create Mock Invoice File & Invoice
    const file = await prisma.invoiceFile.create({
      data: {
        organisationId: orgId,
        locationId: locId,
        sourceType: InvoiceSourceType.UPLOAD,
        storageKey: 'mock-key',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        ocrResult: {
          create: {
            rawResultJson: {},
            parsedJson: {}
          }
        }
      }
    });
    invoiceFileId = file.id;

    const invoice = await prisma.invoice.create({
      data: {
        organisationId: orgId,
        locationId: locId,
        invoiceFileId: file.id,
        invoiceNumber: 'INV-001',
        sourceType: InvoiceSourceType.UPLOAD,
        isVerified: false,
        lineItems: {
          create: [
            { description: 'Test Item', quantity: 1, unitPrice: 10, lineTotal: 10 }
          ]
        }
      }
    });
    invoiceId = invoice.id;
  }, 30000);

  // Test A: Punctuation invariance
  it('Test A - Punctuation invariance: approve "topp.chocolate cott. 3 lt." and reprocess "topp chocolate cott 3 lt" should have no warnings', async () => {
    const approvedPhrase = 'topp.chocolate cott. 3 lt.';
    const reprocessPhrase = 'topp chocolate cott 3 lt';

    // Step 1: Approve the phrase by verifying an invoice with it
    // Note: Learning only happens if DESCRIPTION_POSSIBLE_TYPO would trigger
    // For this test, we'll manually create the lexicon entry to simulate approval
    await (prisma as any).organisationLexiconEntry.create({
      data: {
        organisationId: orgId,
        phrase: approvedPhrase.toLowerCase().trim(),
        phraseKey: normalizePhraseKey(approvedPhrase),
        lastSeenAt: new Date(),
        timesSeen: 1
      }
    });

    // Step 2: Verify the phrase exists in lexicon
    const lexiconEntry = await (prisma as any).organisationLexiconEntry.findFirst({
      where: {
        organisationId: orgId,
        phraseKey: normalizePhraseKey(approvedPhrase)
      }
    });
    expect(lexiconEntry).toBeTruthy();

    // Step 3: Check warnings for the reprocessed phrase (different punctuation)
    const lexiconEntries = await (prisma as any).organisationLexiconEntry.findMany({
      where: { organisationId: orgId },
      select: { phraseKey: true }
    });

    const { computeDescriptionWarnings } = await import('../../src/utils/descriptionQuality');
    const warnings = computeDescriptionWarnings(reprocessPhrase, {
      lexicon: new Set(lexiconEntries.map((e: any) => e.phraseKey)),
      ocrConfidence: 95
    });

    // Assert: No warnings should be present (hard suppression works across punctuation variations)
    expect(warnings).toEqual([]);
    
    // Verify that normalizePhraseKey matches both variations
    expect(normalizePhraseKey(approvedPhrase)).toBe(normalizePhraseKey(reprocessPhrase));
  });

  // Test B: Decimal spacing invariance
  it('Test B - Decimal spacing invariance: approve "zammit bacon rindless loose2x2.5k" and reprocess "zammit bacon rindless loose2x2. 5k" should have no warnings', async () => {
    const approvedPhrase = 'zammit bacon rindless loose2x2.5k';
    const reprocessPhrase = 'zammit bacon rindless loose2x2. 5k';

    // Step 1: Manually create lexicon entry (simulating approval)
    await (prisma as any).organisationLexiconEntry.create({
      data: {
        organisationId: orgId,
        phrase: approvedPhrase.toLowerCase().trim(),
        phraseKey: normalizePhraseKey(approvedPhrase),
        lastSeenAt: new Date(),
        timesSeen: 1
      }
    });

    // Step 2: Verify the phrase exists
    const lexiconEntry = await (prisma as any).organisationLexiconEntry.findFirst({
      where: {
        organisationId: orgId,
        phraseKey: normalizePhraseKey(approvedPhrase)
      }
    });
    expect(lexiconEntry).toBeTruthy();

    // Step 3: Check warnings for the reprocessed phrase (with space before decimal)
    const lexiconEntries = await (prisma as any).organisationLexiconEntry.findMany({
      where: { organisationId: orgId },
      select: { phraseKey: true }
    });

    const { computeDescriptionWarnings } = await import('../../src/utils/descriptionQuality');
    const warnings = computeDescriptionWarnings(reprocessPhrase, {
      lexicon: new Set(lexiconEntries.map((e: any) => e.phraseKey)),
      ocrConfidence: 90
    });

    // Assert: No warnings (hard suppression works even with spacing differences)
    expect(warnings).toEqual([]);
    
    // Verify that normalizePhraseKey matches both variations (whitespace collapse handles this)
    expect(normalizePhraseKey(approvedPhrase)).toBe(normalizePhraseKey(reprocessPhrase));
  });

  // Test C: Ultra-low confidence exception
  it('Test C - Ultra-low confidence exception: approved phrase with confidence < 0.25 should only show DESCRIPTION_ULTRA_LOW_CONFIDENCE', async () => {
    const approvedPhrase = 'topp.chocolate cott. 3 lt.';

    // Step 1: Manually create lexicon entry (simulating approval)
    await (prisma as any).organisationLexiconEntry.create({
      data: {
        organisationId: orgId,
        phrase: approvedPhrase.toLowerCase().trim(),
        phraseKey: normalizePhraseKey(approvedPhrase),
        lastSeenAt: new Date(),
        timesSeen: 1
      }
    });

    // Step 2: Verify the phrase exists
    const lexiconEntry = await (prisma as any).organisationLexiconEntry.findFirst({
      where: {
        organisationId: orgId,
        phraseKey: normalizePhraseKey(approvedPhrase)
      }
    });
    expect(lexiconEntry).toBeTruthy();

    // Step 3: Check warnings with ultra-low confidence (< 0.25)
    const lexiconEntries = await (prisma as any).organisationLexiconEntry.findMany({
      where: { organisationId: orgId },
      select: { phraseKey: true }
    });

    const { computeDescriptionWarnings } = await import('../../src/utils/descriptionQuality');
    const warnings = computeDescriptionWarnings(approvedPhrase, {
      lexicon: new Set(lexiconEntries.map((e: any) => e.phraseKey)),
      ocrConfidence: 0.20 // Ultra-low confidence (< 0.25)
    });

    // Assert: Only DESCRIPTION_ULTRA_LOW_CONFIDENCE warning, no other warnings
    expect(warnings).toEqual(['DESCRIPTION_ULTRA_LOW_CONFIDENCE']);
    expect(warnings.length).toBe(1);

    // Step 4: Verify that with normal confidence, no warnings appear
    const warningsNormal = computeDescriptionWarnings(approvedPhrase, {
      lexicon: new Set(lexiconEntries.map((e: any) => e.phraseKey)),
      ocrConfidence: 0.50 // Normal confidence
    });
    expect(warningsNormal).toEqual([]);

    // Step 5: Verify that with confidence exactly at threshold (0.25), no warnings appear
    const warningsThreshold = computeDescriptionWarnings(approvedPhrase, {
      lexicon: new Set(lexiconEntries.map((e: any) => e.phraseKey)),
      ocrConfidence: 0.25 // Exactly at threshold
    });
    expect(warningsThreshold).toEqual([]);
  });
});

