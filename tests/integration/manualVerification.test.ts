import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import { FastifyInstance } from 'fastify';
import prisma from '../../src/infrastructure/prismaClient';
import { ProcessingStatus, InvoiceSourceType } from '@prisma/client';

describe('Manual Invoice Verification Integration', () => {
  let app: FastifyInstance;
  let authToken: string;
  let orgId: string;
  let locId: string;
  let invoiceId: string;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'verify-test@example.com',
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
      payload: { email: 'verify-test@example.com', password: 'password123' }
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

    // 2. Create Mock Invoice File & Invoice
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
                    { description: 'OCR Item 1', quantity: 10, unitPrice: 10, lineTotal: 100 }
                ]
            }
        }
    });
    invoiceId = invoice.id;
  }, 30000); // Increased timeout

  it('should persist verified items and delete old OCR items', async () => {
    // Get actual line item IDs from database
    const existingLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId }
    });
    expect(existingLineItems.length).toBeGreaterThan(0);
    const lineItemId = existingLineItems[0].id;

    // Verify with NEW values
    const payload = {
        supplierName: 'New Supplier',
        total: 50,
        date: new Date().toISOString(),
        selectedLineItemIds: [lineItemId],
        items: [
            { id: lineItemId, description: 'Verified Item 1 1kg', quantity: 5, lineTotal: 50, productCode: 'PROD-A' }
        ]
    };

    const res = await app.inject({
        method: 'PATCH',
        url: `/invoices/${invoiceId}/verify`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload
    });

    expect(res.statusCode).toBe(200);

    // Check Database
    const dbLines = await prisma.invoiceLineItem.findMany({
        where: { invoiceId }
    });

    // If schema validation stripped items, this will be 0
    expect(dbLines.length).toBe(1);
    expect(dbLines[0].description).toBe('Verified Item 1 1kg');
    expect(dbLines[0].quantity?.toNumber()).toBe(5);
    expect(dbLines[0].lineTotal?.toNumber()).toBe(50);
    expect(dbLines[0].accountCode).toBe('Cost of Goods Sold (Manual)');

    // Sprint A: canonical dual-write assertions
    const canonicalInvoice = await (prisma as any).canonicalInvoice.findUnique({
      where: { legacyInvoiceId: invoiceId },
      include: { lineItems: true },
    });
    expect(canonicalInvoice).toBeTruthy();
    expect(canonicalInvoice.source).toBe('MANUAL');
    expect(canonicalInvoice.deletedAt).toBeNull();
    expect(canonicalInvoice.organisationId).toBe(orgId);
    expect(canonicalInvoice.locationId).toBe(locId);

    expect(canonicalInvoice.lineItems.length).toBe(1);
    expect(canonicalInvoice.lineItems[0].source).toBe('MANUAL');
    expect(String(canonicalInvoice.lineItems[0].sourceLineRef)).toContain(`invoiceId:${invoiceId}:manual:`);
    expect(canonicalInvoice.lineItems[0].rawDescription).toBe('Verified Item 1 1kg');
    expect(canonicalInvoice.lineItems[0].normalizedDescription).toContain('verified item 1');

    // Idempotency: re-verify should not create duplicate canonical lines
    // Get the updated line item ID (might have changed after verification)
    const updatedLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId }
    });
    const updatedLineItemId = updatedLineItems[0].id;
    
    const res2 = await app.inject({
      method: 'PATCH',
      url: `/invoices/${invoiceId}/verify`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        ...payload,
        selectedLineItemIds: [updatedLineItemId],
        items: [
          { id: updatedLineItemId, description: 'Verified Item 1 1kg', quantity: 5, lineTotal: 50, productCode: 'PROD-A' }
        ]
      }
    });
    expect(res2.statusCode).toBe(200);

    const canonicalInvoice2 = await (prisma as any).canonicalInvoice.findUnique({
      where: { legacyInvoiceId: invoiceId },
      include: { lineItems: true },
    });
    expect(canonicalInvoice2.lineItems.length).toBe(1);

    // WARN exclusion sanity: adding a WARN canonical line should not affect canonical spend parity
    await (prisma as any).canonicalInvoiceLineItem.create({
      data: {
        canonicalInvoiceId: canonicalInvoice2.id,
        organisationId: orgId,
        locationId: locId,
        supplierId: canonicalInvoice2.supplierId,
        source: 'MANUAL',
        sourceLineRef: `invoiceId:${invoiceId}:manual:warn-line`,
        normalizationVersion: 'v1',
        rawDescription: 'Warn Line',
        normalizedDescription: 'warn line',
        quantity: 1,
        unitCategory: 'UNKNOWN',
        lineTotal: 9999,
        currencyCode: 'AUD',
        adjustmentStatus: 'NONE',
        qualityStatus: 'WARN',
      },
    });

    const { supplierInsightsService } = await import('../../src/services/supplierInsightsService.js');
    const parity = await supplierInsightsService.getCanonicalParityChecklist(orgId, locId);
    expect(parity.totals.canonicalSpend90d).toBe(50);

    // Hard delete cascade: deleting legacy invoice should remove canonical header + lines
    await prisma.invoice.delete({ where: { id: invoiceId } });
    const afterDelete = await (prisma as any).canonicalInvoice.findUnique({ where: { legacyInvoiceId: invoiceId } });
    expect(afterDelete).toBeNull();
  }, 30000);

  it('should handle empty product codes by normalizing them to null', async () => {
    // Get actual line item IDs from database
    const existingLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId }
    });
    expect(existingLineItems.length).toBeGreaterThan(0);
    const lineItemId = existingLineItems[0].id;

    const payload = {
        supplierName: 'Supplier B',
        total: 100,
        selectedLineItemIds: [lineItemId],
        items: [
            { id: lineItemId, description: 'Item No Code', quantity: 1, lineTotal: 100, productCode: '' }
        ]
    };

    const res = await app.inject({
        method: 'PATCH',
        url: `/invoices/${invoiceId}/verify`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload
    });

    expect(res.statusCode).toBe(200);

    const dbLines = await prisma.invoiceLineItem.findMany({ where: { invoiceId } });
    expect(dbLines.length).toBe(1);
    expect(dbLines[0].productCode).toBeNull();
  }, 30000);

  it('should display verified products in supplier products endpoint', async () => {
    // Get actual line item IDs from database
    const existingLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId }
    });
    expect(existingLineItems.length).toBeGreaterThan(0);
    const lineItemId = existingLineItems[0].id;

    // 1. Verify Invoice
    await app.inject({
        method: 'PATCH',
        url: `/invoices/${invoiceId}/verify`,
        headers: { Authorization: `Bearer ${authToken}` },
        payload: {
            supplierName: 'Visible Supplier',
            total: 200,
            selectedLineItemIds: [lineItemId],
            items: [
                { id: lineItemId, description: 'Visible Product', quantity: 2, lineTotal: 200, productCode: 'VIS-1' }
            ]
        }
    });

    // Get Supplier ID - ensure invoice is refreshed after verification
    const invoice = await prisma.invoice.findUnique({ 
      where: { id: invoiceId },
      include: { supplier: true }
    });
    const supplierId = invoice?.supplierId;
    expect(supplierId).toBeDefined();
    
    // Verify supplier exists and belongs to organization
    const supplier = await prisma.supplier.findUnique({ 
      where: { id: supplierId! },
      select: { id: true, organisationId: true }
    });
    expect(supplier).toBeDefined();
    expect(supplier?.organisationId).toBe(orgId);

    // 2. Fetch Supplier Products (Simulate Dashboard Drilldown)
    const res = await app.inject({
        method: 'GET',
        url: `/suppliers/${supplierId}/products`,
        headers: { Authorization: `Bearer ${authToken}` }
    });

    expect(res.statusCode).toBe(200);
    const products = res.json();
    
    expect(products.length).toBeGreaterThan(0);
    const product = products.find((p: any) => p.name === 'Visible Product');
    expect(product).toBeDefined();
    expect(product.totalSpend).toBe(200);
    expect(product.totalQuantity).toBe(2);
  }, 30000);

  it('should mirror soft delete + restore onto canonical invoice header', async () => {
    // Get actual line item IDs from database
    const existingLineItems = await prisma.invoiceLineItem.findMany({
      where: { invoiceId }
    });
    expect(existingLineItems.length).toBeGreaterThan(0);
    const lineItemId = existingLineItems[0].id;

    // 1) Verify (creates canonical)
    const verifyRes = await app.inject({
      method: 'PATCH',
      url: `/invoices/${invoiceId}/verify`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        supplierName: 'Delete Restore Supplier',
        total: 10,
        selectedLineItemIds: [lineItemId],
        items: [{ id: lineItemId, description: 'Milk 1L', quantity: 1, lineTotal: 10, productCode: 'MILK' }],
      },
    });
    expect(verifyRes.statusCode).toBe(200);

    const canonicalBefore = await (prisma as any).canonicalInvoice.findUnique({ where: { legacyInvoiceId: invoiceId } });
    expect(canonicalBefore).toBeTruthy();
    expect(canonicalBefore.deletedAt).toBeNull();

    // 2) Soft delete invoice
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/invoices/${invoiceId}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    const deletedInvoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(deletedInvoice?.deletedAt).toBeTruthy();

    const canonicalDeleted = await (prisma as any).canonicalInvoice.findUnique({ where: { legacyInvoiceId: invoiceId } });
    expect(canonicalDeleted?.deletedAt).toBeTruthy();

    // 3) Restore invoice
    const restoreRes = await app.inject({
      method: 'POST',
      url: `/invoices/${invoiceId}/restore`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(restoreRes.statusCode).toBe(200);

    const restoredInvoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(restoredInvoice?.deletedAt).toBeNull();

    const canonicalRestored = await (prisma as any).canonicalInvoice.findUnique({ where: { legacyInvoiceId: invoiceId } });
    expect(canonicalRestored?.deletedAt).toBeNull();
  }, 30000);
});
