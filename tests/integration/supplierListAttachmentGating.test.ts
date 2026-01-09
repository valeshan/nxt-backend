import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, SupplierSourceType, SupplierStatus } from '@prisma/client';

describe('Supplier list attachment gating (Xero)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();
  }, 30000);

  async function bootstrapOrgAndGetOrgToken() {
    // Register
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'supplier-list-test@example.com',
        password: 'password123',
        confirmPassword: 'password123',
        firstName: 'Test',
        lastName: 'User',
        acceptedTerms: true,
        acceptedPrivacy: true,
      },
    });
    expect(registerRes.statusCode).toBe(201);

    // Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'supplier-list-test@example.com', password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginToken = loginRes.json().access_token as string;

    // Manual onboard (creates org + location)
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/organisations/onboard/manual',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { venueName: 'Supplier List Venue' },
    });
    expect(onboardRes.statusCode).toBe(201);
    const { organisationId, locationId } = onboardRes.json() as { organisationId: string; locationId: string };

    // Select org to get org token
    const selectOrgRes = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { organisationId },
    });
    expect(selectOrgRes.statusCode).toBe(200);
    const orgToken = selectOrgRes.json().access_token as string;

    return { organisationId, locationId, orgToken };
  }

  it('excludes suppliers whose only Xero invoices have unverified attachments, but includes doc-less and verified-attachment Xero invoices', async () => {
    const { organisationId, locationId, orgToken } = await bootstrapOrgAndGetOrgToken();

    const supplierNoAttachmentId = 'sup-xero-no-attachment';
    const supplierUnverifiedAttachmentId = 'sup-xero-unverified-attachment';
    const supplierVerifiedAttachmentId = 'sup-xero-verified-attachment';

    await prisma.supplier.createMany({
      data: [
        {
          id: supplierNoAttachmentId,
          organisationId,
          name: 'Xero No Attachment Supplier',
          normalizedName: 'xero no attachment supplier',
          sourceType: SupplierSourceType.XERO,
          status: SupplierStatus.ACTIVE,
        },
        {
          id: supplierUnverifiedAttachmentId,
          organisationId,
          name: 'Xero Unverified Attachment Supplier',
          normalizedName: 'xero unverified attachment supplier',
          sourceType: SupplierSourceType.XERO,
          status: SupplierStatus.ACTIVE,
        },
        {
          id: supplierVerifiedAttachmentId,
          organisationId,
          name: 'Xero Verified Attachment Supplier',
          normalizedName: 'xero verified attachment supplier',
          sourceType: SupplierSourceType.XERO,
          status: SupplierStatus.ACTIVE,
        },
      ],
    });

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(15);

    // 1) Xero invoice with NO attachment → included
    await prisma.xeroInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplierNoAttachmentId,
        xeroInvoiceId: 'xero-inv-no-attachment',
        status: 'AUTHORISED',
        date: lastMonth,
        total: 100,
      },
    });

    // 2) Xero invoice with UNVERIFIED attachment → excluded
    await prisma.xeroInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplierUnverifiedAttachmentId,
        xeroInvoiceId: 'xero-inv-unverified-attachment',
        status: 'AUTHORISED',
        date: lastMonth,
        total: 200,
      },
    });
    await prisma.invoiceFile.create({
      data: {
        organisationId,
        locationId,
        sourceType: InvoiceSourceType.XERO,
        sourceReference: 'xero-inv-unverified-attachment',
        storageKey: 'supplier-list-test-unverified',
        fileName: 'unverified.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.NEEDS_REVIEW,
      },
    });

    // 3) Xero invoice with VERIFIED attachment → included
    await prisma.xeroInvoice.create({
      data: {
        organisationId,
        locationId,
        supplierId: supplierVerifiedAttachmentId,
        xeroInvoiceId: 'xero-inv-verified-attachment',
        status: 'AUTHORISED',
        date: lastMonth,
        total: 300,
      },
    });
    await prisma.invoiceFile.create({
      data: {
        organisationId,
        locationId,
        sourceType: InvoiceSourceType.XERO,
        sourceReference: 'xero-inv-verified-attachment',
        storageKey: 'supplier-list-test-verified',
        fileName: 'verified.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.VERIFIED,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/suppliers?page=1&limit=50',
      headers: { Authorization: `Bearer ${orgToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { data: Array<{ id: string; name: string }>; pagination: any };
    const supplierNames = body.data.map((s) => s.name);

    expect(supplierNames).toContain('Xero No Attachment Supplier');
    expect(supplierNames).toContain('Xero Verified Attachment Supplier');
    expect(supplierNames).not.toContain('Xero Unverified Attachment Supplier');
  }, 20000);
});




