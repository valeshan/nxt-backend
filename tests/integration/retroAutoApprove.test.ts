import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, SupplierStatus } from '@prisma/client';

async function bootstrapOrgAndLocation(app: FastifyInstance) {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: 'retro-test@example.com',
      password: 'Password!23',
      confirmPassword: 'Password!23',
      firstName: 'Retro',
      lastName: 'Test',
      acceptedTerms: true,
      acceptedPrivacy: true,
    },
  });

  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'retro-test@example.com', password: 'Password!23' },
  });
  const loginToken = loginRes.json().access_token;

  const onboardRes = await app.inject({
    method: 'POST',
    url: '/organisations/onboard/manual',
    headers: { Authorization: `Bearer ${loginToken}` },
    payload: { venueName: 'Retro Test Org' },
  });
  const organisationId = onboardRes.json().organisationId as string;
  const locationId = onboardRes.json().locationId as string;

  const selectOrgRes = await app.inject({
    method: 'POST',
    url: '/auth/select-organisation',
    headers: { Authorization: `Bearer ${loginToken}` },
    payload: { organisationId },
  });
  const orgToken = selectOrgRes.json().access_token as string;

  const selectLocRes = await app.inject({
    method: 'POST',
    url: '/auth/select-location',
    headers: { Authorization: `Bearer ${orgToken}` },
    payload: { locationId },
  });
  const locationToken = selectLocRes.json().access_token as string;

  const userId = (await prisma.user.findFirstOrThrow({ where: { email: 'retro-test@example.com' }, select: { id: true } })).id;

  return { organisationId, locationId, userId, locationToken };
}

describe('Retro Auto-Approve Integration', () => {
  let app: FastifyInstance;
  let organisationId: string;
  let locationId: string;
  let locationToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();
    const boot = await bootstrapOrgAndLocation(app);
    organisationId = boot.organisationId;
    locationId = boot.locationId;
    locationToken = boot.locationToken;
  });

  it('should persist a per-user-per-location "seen" flag for the retro auto-approve discovery modal', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });

    expect(before.statusCode).toBe(200);
    expect(before.json().hasSeenDiscoveryModal).toBe(false);

    const markSeen = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/discovery/seen',
      headers: { Authorization: `Bearer ${locationToken}` },
    });

    expect(markSeen.statusCode).toBe(200);
    expect(markSeen.json()).toEqual({ ok: true });

    const after = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });

    expect(after.statusCode).toBe(200);
    expect(after.json().hasSeenDiscoveryModal).toBe(true);
  });

  it('should surface candidates only after supplier becomes ACTIVE, then approve in a batch with audit + idempotency', async () => {
    // Enable plan + location flag for running
    await prisma.organisation.update({
      where: { id: organisationId },
      data: { planKey: 'pro', billingState: 'active' },
    });
    await prisma.location.update({
      where: { id: locationId },
      data: { autoApproveCleanInvoices: true },
    });

    // Supplier starts as PENDING_REVIEW (not eligible yet)
    const supplier = await prisma.supplier.create({
      data: {
        organisationId,
        name: 'Supplier Pending',
        normalizedName: 'supplier pending',
        sourceType: 'OCR',
        status: SupplierStatus.PENDING_REVIEW,
      } as any,
    });

    // Candidate invoice (OCR_COMPLETE, NEEDS_REVIEW, high confidence, clean canonical header)
    const invoiceFile = await prisma.invoiceFile.create({
      data: {
        organisationId,
        locationId,
        sourceType: InvoiceSourceType.UPLOAD,
        storageKey: 'mock-key',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.NEEDS_REVIEW,
        confidenceScore: 95,
        validationErrors: null,
        ocrResult: { create: { rawResultJson: {}, parsedJson: {} } },
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        organisationId,
        locationId,
        invoiceFileId: invoiceFile.id,
        sourceType: InvoiceSourceType.UPLOAD,
        supplierId: supplier.id,
        total: 50,
        date: new Date('2026-01-01T00:00:00.000Z'),
        isVerified: false,
      } as any,
    });
    await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplier.id,
        source: 'OCR',
        legacyInvoiceId: invoice.id,
        legacyXeroInvoiceId: null,
        sourceInvoiceRef: `invoiceFileId:${invoiceFile.id}`,
        date: invoice.date,
        currencyCode: 'AUD',
        deletedAt: null,
        warningLineCount: 0,
      },
    });

    // Before supplier is ACTIVE → 0 candidates
    const summaryBefore = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });
    expect(summaryBefore.statusCode).toBe(200);
    expect(summaryBefore.json().candidateCount).toBe(0);

    // Supplier becomes ACTIVE → candidate appears
    await prisma.supplier.update({
      where: { id: supplier.id },
      data: { status: SupplierStatus.ACTIVE },
    });

    const summaryAfter = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });
    expect(summaryAfter.statusCode).toBe(200);
    expect(summaryAfter.json().candidateCount).toBe(1);
    expect(summaryAfter.json().canRun).toBe(true);

    const idempotencyKey = '7f54c18a-2f7a-4ce7-9c35-0c2f10f0db5b';

    const run = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/run',
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: { idempotencyKey },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().approvedCount).toBe(1);
    expect(run.json().batchId).toBeDefined();
    expect(run.json().reusedBatch).toBe(false);

    const refreshedFile = await prisma.invoiceFile.findUniqueOrThrow({ where: { id: invoiceFile.id } });
    const refreshedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(refreshedFile.reviewStatus).toBe(ReviewStatus.VERIFIED);
    expect(refreshedInvoice.isVerified).toBe(true);

    const auditRows = await (prisma as any).invoiceAuditEvent.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe('AUTO_APPROVED_BATCH');
    expect(auditRows[0].reason).toBe('RETRO_SUPPLIER_VERIFIED');

    // Idempotency: same request returns stored result
    const runAgain = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/run',
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: { idempotencyKey },
    });
    expect(runAgain.statusCode).toBe(200);
    expect(runAgain.json().reusedBatch).toBe(true);
    expect(runAgain.json().approvedCount).toBe(1);
  });

  it('should not count the just-verified invoice as a retro candidate (only remaining NEEDS_REVIEW invoices)', async () => {
    await prisma.organisation.update({
      where: { id: organisationId },
      data: { planKey: 'pro', billingState: 'active' },
    });
    await prisma.location.update({
      where: { id: locationId },
      data: { autoApproveCleanInvoices: true },
    });

    // Supplier starts pending
    const supplier = await prisma.supplier.create({
      data: {
        organisationId,
        name: 'Supplier Pending',
        normalizedName: 'supplier pending',
        sourceType: 'OCR',
        status: SupplierStatus.PENDING_REVIEW,
      } as any,
    });

    const createCandidate = async (suffix: string) => {
      const invoiceFile = await prisma.invoiceFile.create({
        data: {
          organisationId,
          locationId,
          sourceType: InvoiceSourceType.UPLOAD,
          storageKey: `mock-key-${suffix}`,
          fileName: `test-${suffix}.pdf`,
          mimeType: 'application/pdf',
          processingStatus: ProcessingStatus.OCR_COMPLETE,
          reviewStatus: ReviewStatus.NEEDS_REVIEW,
          confidenceScore: 95,
          validationErrors: null,
          ocrResult: { create: { rawResultJson: {}, parsedJson: {} } },
        },
      });
      const invoice = await prisma.invoice.create({
        data: {
          organisationId,
          locationId,
          invoiceFileId: invoiceFile.id,
          sourceType: InvoiceSourceType.UPLOAD,
          supplierId: supplier.id,
          total: 50,
          date: new Date('2026-01-01T00:00:00.000Z'),
          isVerified: false,
        } as any,
      });
      await (prisma as any).canonicalInvoice.create({
        data: {
          organisationId,
          locationId,
          supplierId: supplier.id,
          source: 'OCR',
          legacyInvoiceId: invoice.id,
          legacyXeroInvoiceId: null,
          sourceInvoiceRef: `invoiceFileId:${invoiceFile.id}`,
          date: invoice.date,
          currencyCode: 'AUD',
          deletedAt: null,
          warningLineCount: 0,
        },
      });
      const lineItem = await prisma.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          description: `Item ${suffix}`,
          quantity: 1,
          lineTotal: 50,
          isIncludedInAnalytics: true,
        } as any,
      });
      return { invoiceFile, invoice, lineItemId: lineItem.id };
    };

    const a = await createCandidate('a');
    const b = await createCandidate('b');

    // Supplier not ACTIVE -> no retro candidates
    const before = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().candidateCount).toBe(0);

    // Verify one invoice manually (this will activate the supplier)
    const verify = await app.inject({
      method: 'PATCH',
      url: `/invoices/${a.invoice.id}/verify`,
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: {
        supplierId: supplier.id,
        total: 50,
        date: '2026-01-01',
        selectedLineItemIds: [a.lineItemId],
      },
    });
    expect(verify.statusCode).toBe(200);

    // Simulate the supplier being approved (becoming ACTIVE) after the first invoice was verified.
    // This is the real-world trigger for retro auto-approval candidates.
    await prisma.supplier.update({
      where: { id: supplier.id },
      data: { status: SupplierStatus.ACTIVE },
    });

    // Retro candidates should only include the remaining NEEDS_REVIEW invoice (b)
    const after = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });
    expect(after.statusCode).toBe(200);
    const afterJson = after.json() as { candidateCount: number; preview: Array<{ invoiceId: string }> };
    expect(afterJson.candidateCount).toBe(1);
    expect(afterJson.preview.map((p) => p.invoiceId)).toContain(b.invoice.id);
  });

  it('should still return a preview even when canRun=false (e.g. location auto-approve toggle off)', async () => {
    // Plan is Pro so the feature is available, but location toggle stays OFF
    await prisma.organisation.update({
      where: { id: organisationId },
      data: { planKey: 'pro', billingState: 'active' },
    });

    const supplier = await prisma.supplier.create({
      data: {
        organisationId,
        name: 'Supplier Active',
        normalizedName: 'supplier active',
        sourceType: 'OCR',
        status: SupplierStatus.ACTIVE,
      } as any,
    });

    const invoiceFile = await prisma.invoiceFile.create({
      data: {
        organisationId,
        locationId,
        sourceType: InvoiceSourceType.UPLOAD,
        storageKey: 'mock-key-preview',
        fileName: 'preview.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.NEEDS_REVIEW,
        confidenceScore: 95,
        validationErrors: null,
        ocrResult: { create: { rawResultJson: {}, parsedJson: {} } },
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        organisationId,
        locationId,
        invoiceFileId: invoiceFile.id,
        sourceType: InvoiceSourceType.UPLOAD,
        supplierId: supplier.id,
        total: 50,
        date: new Date('2026-01-01T00:00:00.000Z'),
        isVerified: false,
      } as any,
    });
    await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplier.id,
        source: 'OCR',
        legacyInvoiceId: invoice.id,
        legacyXeroInvoiceId: null,
        sourceInvoiceRef: `invoiceFileId:${invoiceFile.id}`,
        date: invoice.date,
        currencyCode: 'AUD',
        deletedAt: null,
        warningLineCount: 0,
      },
    });

    const summary = await app.inject({
      method: 'GET',
      url: '/invoices/auto-approve/retro/summary',
      headers: { Authorization: `Bearer ${locationToken}` },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().candidateCount).toBe(1);
    expect(summary.json().canRun).toBe(false);
    expect(Array.isArray(summary.json().preview)).toBe(true);
    expect(summary.json().preview.length).toBeGreaterThan(0);
  });

  it('should support dryRun without mutating invoices or writing audit rows', async () => {
    await prisma.organisation.update({
      where: { id: organisationId },
      data: { planKey: 'pro', billingState: 'active' },
    });
    await prisma.location.update({
      where: { id: locationId },
      data: { autoApproveCleanInvoices: true },
    });

    const supplier = await prisma.supplier.create({
      data: {
        organisationId,
        name: 'Supplier Active',
        normalizedName: 'supplier active',
        sourceType: 'OCR',
        status: SupplierStatus.ACTIVE,
      } as any,
    });

    const invoiceFile = await prisma.invoiceFile.create({
      data: {
        organisationId,
        locationId,
        sourceType: InvoiceSourceType.UPLOAD,
        storageKey: 'mock-key',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.NEEDS_REVIEW,
        confidenceScore: 95,
        validationErrors: null,
        ocrResult: { create: { rawResultJson: {}, parsedJson: {} } },
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        organisationId,
        locationId,
        invoiceFileId: invoiceFile.id,
        sourceType: InvoiceSourceType.UPLOAD,
        supplierId: supplier.id,
        total: 50,
        date: new Date('2026-01-01T00:00:00.000Z'),
        isVerified: false,
      } as any,
    });
    await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplier.id,
        source: 'OCR',
        legacyInvoiceId: invoice.id,
        legacyXeroInvoiceId: null,
        sourceInvoiceRef: `invoiceFileId:${invoiceFile.id}`,
        date: invoice.date,
        currencyCode: 'AUD',
        deletedAt: null,
        warningLineCount: 0,
      },
    });

    const run = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/run',
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: { idempotencyKey: 'c83c7e36-2db7-4d64-a20c-5a1fcbdb74b7', dryRun: true },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().dryRun).toBe(true);
    expect(run.json().approvedCount).toBe(1);

    const refreshedFile = await prisma.invoiceFile.findUniqueOrThrow({ where: { id: invoiceFile.id } });
    const refreshedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(refreshedFile.reviewStatus).toBe(ReviewStatus.NEEDS_REVIEW);
    expect(refreshedInvoice.isVerified).toBe(false);

    const auditRows = await (prisma as any).invoiceAuditEvent.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(auditRows.length).toBe(0);
  });

  it('should enforce plan gating on /run (403 FEATURE_DISABLED + upgradeTarget)', async () => {
    await prisma.location.update({
      where: { id: locationId },
      data: { autoApproveCleanInvoices: true },
    });

    const supplier = await prisma.supplier.create({
      data: {
        organisationId,
        name: 'Supplier Active',
        normalizedName: 'supplier active',
        sourceType: 'OCR',
        status: SupplierStatus.ACTIVE,
      } as any,
    });

    const invoiceFile = await prisma.invoiceFile.create({
      data: {
        organisationId,
        locationId,
        sourceType: InvoiceSourceType.UPLOAD,
        storageKey: 'mock-key',
        fileName: 'test.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.NEEDS_REVIEW,
        confidenceScore: 95,
        validationErrors: null,
        ocrResult: { create: { rawResultJson: {}, parsedJson: {} } },
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        organisationId,
        locationId,
        invoiceFileId: invoiceFile.id,
        sourceType: InvoiceSourceType.UPLOAD,
        supplierId: supplier.id,
        total: 50,
        date: new Date('2026-01-01T00:00:00.000Z'),
        isVerified: false,
      } as any,
    });
    await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplier.id,
        source: 'OCR',
        legacyInvoiceId: invoice.id,
        legacyXeroInvoiceId: null,
        sourceInvoiceRef: `invoiceFileId:${invoiceFile.id}`,
        date: invoice.date,
        currencyCode: 'AUD',
        deletedAt: null,
        warningLineCount: 0,
      },
    });

    const run = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/run',
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: { idempotencyKey: 'ae8c0ff2-6e21-4d2a-a781-fc8b68c96df3' },
    });
    expect(run.statusCode).toBe(403);
    expect(run.json().error?.code).toBe('FEATURE_DISABLED');
    expect(run.json().error?.upgradeTarget).toBe('pro');
  });

  it('should 409 on idempotency key reuse with different payload', async () => {
    await prisma.organisation.update({
      where: { id: organisationId },
      data: { planKey: 'pro', billingState: 'active' },
    });
    await prisma.location.update({
      where: { id: locationId },
      data: { autoApproveCleanInvoices: true },
    });

    const idempotencyKey = '4be2b2a5-0e18-44d4-b7a6-0f743e9b1ed1';

    // First run (dryRun)
    const first = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/run',
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: { idempotencyKey, dryRun: true },
    });
    expect(first.statusCode).toBe(200);

    // Reuse same key with different payload (dryRun false) -> 409
    const second = await app.inject({
      method: 'POST',
      url: '/invoices/auto-approve/retro/run',
      headers: { Authorization: `Bearer ${locationToken}` },
      payload: { idempotencyKey, dryRun: false },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error?.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
  });
});


