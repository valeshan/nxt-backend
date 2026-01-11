import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import prisma from '../../src/infrastructure/prismaClient';
import { signAccessToken } from '../../src/utils/jwt';
import { OrganisationRole, InvoiceSourceType, ProcessingStatus, ReviewStatus } from '@prisma/client';

describe('Supplier Insights /products approval + selection gating', () => {
  let app: any;

  const user = { id: 'user-ap', email: 'ap@test.com', name: 'User AP' };
  const org = { id: 'org-ap', name: 'Org AP' };
  const loc = { id: 'loc-ap', name: 'Loc AP', organisationId: org.id };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();

    await prisma.user.create({
      data: { id: user.id, email: user.email, passwordHash: 'hash', name: user.name },
    });
    await prisma.organisation.create({ data: org });
    await prisma.location.create({ data: loc });
    await prisma.userOrganisation.create({
      data: { userId: user.id, organisationId: org.id, role: OrganisationRole.owner },
    });
  });

  function makeLocationToken() {
    return signAccessToken({
      sub: user.id,
      orgId: org.id,
      locId: loc.id,
      tokenType: 'location',
      roles: ['owner'],
      tokenVersion: 0,
    });
  }

  it('manual/email invoices: only approved invoices and only selected line items appear', async () => {
    const supplier = await prisma.supplier.create({
      data: {
        id: 'sup-manual',
        organisationId: org.id,
        name: 'Manual Supplier',
        normalizedName: 'manual supplier',
        sourceType: 'MANUAL',
        status: 'ACTIVE',
      },
    });

    // Create a VERIFIED invoice file (simulates approved)
    const file = await prisma.invoiceFile.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        sourceType: InvoiceSourceType.EMAIL,
        fileName: 'email.pdf',
        mimeType: 'application/pdf',
        storageKey: 'email-key',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.VERIFIED,
      },
    });

    // Create invoice marked verified with 2 line items, only one selected for analytics
    const inv = await prisma.invoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        invoiceFileId: file.id,
        supplierId: supplier.id,
        sourceType: InvoiceSourceType.EMAIL,
        isVerified: true,
        date: new Date(),
        total: 3000,
        lineItems: {
          create: [
            {
              description: 'Included Item',
              quantity: 1,
              lineTotal: 2000,
              unitPrice: 2000,
              accountCode: 'MANUAL_COGS',
              isIncludedInAnalytics: true,
            },
            {
              description: 'Excluded Item',
              quantity: 1,
              lineTotal: 1000,
              unitPrice: 1000,
              accountCode: 'MANUAL_COGS',
              isIncludedInAnalytics: false,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    expect(inv.lineItems).toHaveLength(2);

    const token = makeLocationToken();
    const res = await app.inject({
      method: 'GET',
      url: `/supplier-insights/products?page=1&pageSize=50`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ productName: string; supplierName: string; spend12m: number }> };

    // Only the included line item should contribute to spend
    const rowsForSupplier = body.items.filter((r) => r.supplierName === 'Manual Supplier');
    expect(rowsForSupplier.length).toBeGreaterThan(0);
    const totalSpend = rowsForSupplier.reduce((sum, r) => sum + (r.spend12m || 0), 0);
    expect(totalSpend).toBe(2000);
  });

  it('xero invoices with attachments: excluded from products until manual-approved invoice exists', async () => {
    const supplier = await prisma.supplier.create({
      data: {
        id: 'sup-xero-att',
        organisationId: org.id,
        name: 'Xero Attachment Supplier',
        normalizedName: 'xero attachment supplier',
        sourceType: 'XERO',
        status: 'ACTIVE',
      },
    });

    // Product + Xero invoice line item (would normally be visible if no gating existed)
    const product = await prisma.product.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        productKey: 'xero-product',
        name: 'Xero Product',
        supplierId: supplier.id,
      },
    });

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(15);

    await prisma.xeroInvoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        xeroInvoiceId: 'xero-att-inv-1',
        status: 'AUTHORISED',
        date: lastMonth,
        total: 5000,
        lineItems: {
          create: {
            productId: product.id,
            description: 'Xero Product',
            quantity: 1,
            unitAmount: 5000,
            lineAmount: 5000,
            accountCode: 'EXP',
          },
        },
      },
    });

    // Presence of ANY InvoiceFile for this xeroInvoiceId means "has attachments" => must be excluded from Xero analytics
    await prisma.invoiceFile.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        sourceType: InvoiceSourceType.XERO,
        sourceReference: 'xero-att-inv-1',
        storageKey: 'xero-att-key',
        fileName: 'xero-att.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.VERIFIED,
      },
    });

    const token = makeLocationToken();
    const res = await app.inject({
      method: 'GET',
      url: `/supplier-insights/products?page=1&pageSize=50&search=Xero%20Product`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ productName: string; spend12m: number }> };
    expect(body.items.length).toBe(0);
  });

  it('xero invoices without attachments: included immediately, including blank-description lines via supplier-scoped accountCode fallback', async () => {
    const supplier = await prisma.supplier.create({
      data: {
        id: 'sup-xero-noatt',
        organisationId: org.id,
        name: 'Xero No-Att Supplier',
        normalizedName: 'xero no-att supplier',
        sourceType: 'XERO',
        status: 'ACTIVE',
      },
    });

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(15);

    const xero = await prisma.xeroInvoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        xeroInvoiceId: 'xero-noatt-inv-1',
        status: 'AUTHORISED',
        date: lastMonth,
        total: 7000,
      },
    });

    // Blank line item (no itemCode/description) but has accountCode & accountName.
    await prisma.xeroInvoiceLineItem.create({
      data: {
        invoiceId: xero.id,
        description: null,
        itemCode: null,
        accountCode: '400',
        accountName: 'Food COGS',
        quantity: 1,
        unitAmount: 7000,
        lineAmount: 7000,
        productId: null,
      } as any,
    });

    // No InvoiceFile created => treated as no-attachment => should appear.
    const token = makeLocationToken();
    const res = await app.inject({
      method: 'GET',
      url: `/supplier-insights/products?page=1&pageSize=50&search=Food`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ productName: string; supplierName: string; spend12m: number }> };

    expect(body.items.length).toBeGreaterThan(0);
    const row = body.items.find((r) => r.supplierName === 'Xero No-Att Supplier');
    expect(row).toBeDefined();
    expect(row?.productName).toContain('Food');
    expect(row?.spend12m).toBeGreaterThanOrEqual(7000);
  });

  it('xero invoices with attachments: once approved, only selected (isIncludedInAnalytics=true) OCR line items appear in /products', async () => {
    const supplier = await prisma.supplier.create({
      data: {
        id: 'sup-xero-ocr',
        organisationId: org.id,
        name: 'Xero OCR Supplier',
        normalizedName: 'xero ocr supplier',
        sourceType: 'XERO',
        status: 'ACTIVE',
      },
    });

    // Xero invoice exists, and has an attachment (InvoiceFile) => Xero-native line items are excluded from insights.
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(15);

    await prisma.xeroInvoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        xeroInvoiceId: 'xero-att-approved-1',
        status: 'AUTHORISED',
        date: lastMonth,
        total: 9999,
      },
    });

    const file = await prisma.invoiceFile.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        sourceType: InvoiceSourceType.XERO,
        sourceReference: 'xero-att-approved-1',
        storageKey: 'xero-att-approved-key',
        fileName: 'xero-att-approved.pdf',
        mimeType: 'application/pdf',
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        reviewStatus: ReviewStatus.VERIFIED,
      },
    });

    // Approved invoice record (this is the “manual approval” representation), with 2 OCR line items.
    // Only one is selected (included in analytics).
    await prisma.invoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        invoiceFileId: file.id,
        supplierId: supplier.id,
        sourceType: InvoiceSourceType.XERO,
        isVerified: true,
        date: lastMonth,
        total: 3000,
        lineItems: {
          create: [
            {
              description: 'Approved Selected Item',
              quantity: 1,
              lineTotal: 2000,
              unitPrice: 2000,
              accountCode: 'MANUAL_COGS',
              isIncludedInAnalytics: true,
              source: 'OCR',
            },
            {
              description: 'Approved Unselected Item',
              quantity: 1,
              lineTotal: 1000,
              unitPrice: 1000,
              accountCode: 'MANUAL_COGS',
              isIncludedInAnalytics: false,
              source: 'OCR',
            },
          ],
        },
      },
    });

    const token = makeLocationToken();
    const res = await app.inject({
      method: 'GET',
      url: `/supplier-insights/products?page=1&pageSize=50&search=Approved`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ productName: string; supplierName: string; spend12m: number }> };

    const rows = body.items.filter((r) => r.supplierName === 'Xero OCR Supplier');
    // Must include selected line
    expect(rows.some((r) => r.productName.includes('Approved Selected Item'))).toBe(true);
    // Must NOT include unselected line
    expect(rows.some((r) => r.productName.includes('Approved Unselected Item'))).toBe(false);
  });
});


