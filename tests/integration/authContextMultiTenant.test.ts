import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, resetDb, teardown } from './testApp';
import prisma from '../../src/infrastructure/prismaClient';
import { signAccessToken } from '../../src/utils/jwt';
import { OrganisationRole } from '@prisma/client';

describe('Multi-Tenant Auth Context Integration', () => {
  let app: any;

  // Test Data
  const userA = { id: 'user-a', email: 'a@test.com', name: 'User A' };
  const userB = { id: 'user-b', email: 'b@test.com', name: 'User B' };
  
  const orgA = { id: 'org-a', name: 'Org A' };
  const orgB = { id: 'org-b', name: 'Org B' };
  
  const locA = { id: 'loc-a', name: 'Loc A', organisationId: orgA.id };
  const locB = { id: 'loc-b', name: 'Loc B', organisationId: orgB.id };
  
  const supplierA = { id: 'sup-a', name: 'Supplier A', organisationId: orgA.id };
  const supplierB = { id: 'sup-b', name: 'Supplier B', organisationId: orgB.id };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await teardown();
  });

  beforeEach(async () => {
    await resetDb();
    
    // Seed Data
    await prisma.user.createMany({ data: [
        { id: userA.id, email: userA.email, passwordHash: 'hash', name: userA.name },
        { id: userB.id, email: userB.email, passwordHash: 'hash', name: userB.name }
    ]});

    await prisma.organisation.createMany({ data: [orgA, orgB] });

    await prisma.location.createMany({ data: [locA, locB] });

    await prisma.userOrganisation.createMany({ data: [
        { userId: userA.id, organisationId: orgA.id, role: OrganisationRole.owner },
        { userId: userB.id, organisationId: orgB.id, role: OrganisationRole.owner }
    ]});

    await prisma.supplier.createMany({ data: [
        { id: supplierA.id, name: supplierA.name, organisationId: supplierA.organisationId, normalizedName: 'supplier a', sourceType: 'MANUAL' },
        { id: supplierB.id, name: supplierB.name, organisationId: supplierB.organisationId, normalizedName: 'supplier b', sourceType: 'MANUAL' }
    ]});

    // Add dummy verified invoices so suppliers appear in list (due to activeInvoicesFilter)
    // Note: listSuppliers requires InvoiceFile with reviewStatus='VERIFIED' for manual invoices
    // So we use XeroInvoice instead, which doesn't have this requirement
    await prisma.xeroInvoice.create({
        data: {
            xeroInvoiceId: 'xero-inv-a',
            organisationId: orgA.id,
            locationId: locA.id,
            supplierId: supplierA.id,
            status: 'AUTHORISED',
            date: new Date(),
            total: 100,
            invoiceNumber: 'INV-A-001'
        }
    });

    await prisma.xeroInvoice.create({
        data: {
            xeroInvoiceId: 'xero-inv-b',
            organisationId: orgB.id,
            locationId: locB.id,
            supplierId: supplierB.id,
            status: 'AUTHORISED',
            date: new Date(),
            total: 100,
            invoiceNumber: 'INV-B-001'
        }
    });

    // Seed an InvoiceFile + Invoice in Org A so cross-org requests are meaningful
    await prisma.invoiceFile.create({
      data: {
        id: 'file-a',
        organisationId: orgA.id,
        locationId: locA.id,
        sourceType: 'UPLOAD',
        storageKey: 'test/file-a.pdf',
        fileName: 'file-a.pdf',
        mimeType: 'application/pdf',
        processingStatus: 'OCR_FAILED',
        reviewStatus: 'NONE',
      },
    });

    await prisma.invoice.create({
      data: {
        id: 'inv-a',
        organisationId: orgA.id,
        locationId: locA.id,
        sourceType: 'UPLOAD',
        invoiceFileId: 'file-a',
        supplierId: supplierA.id,
        isVerified: false,
      },
    });
  }, 30000); // Increased timeout for slow DB reset/seed

  it('Test 1: Valid tenant access - Location Token for Org A should see Supplier A', async () => {
    const token = signAccessToken({
        sub: userA.id,
        orgId: orgA.id,
        locId: locA.id,
        tokenType: 'location',
        roles: ['owner'],
        tokenVersion: 0,
    });

    const response = await app.inject({
        method: 'GET',
        url: '/suppliers',
        headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(supplierA.id);
    expect(body.data[0].name).toBe(supplierA.name);
  }, 10000);

  it('Test 2: Spoofed headers should be ignored', async () => {
    const token = signAccessToken({
        sub: userA.id,
        orgId: orgA.id,
        locId: locA.id,
        tokenType: 'location',
        roles: ['owner'],
        tokenVersion: 0,
    });

    // Attempt to spoof accessing Org B using Org A token + Org B headers
    const response = await app.inject({
        method: 'GET',
        url: '/suppliers',
        headers: { 
            Authorization: `Bearer ${token}`,
            'x-org-id': orgB.id,
            'x-location-id': locB.id
        }
    });

    // The system should IGNORE headers and use the token (Org A)
    // So it should return Org A's suppliers (200 OK)
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(supplierA.id); // Should still be Supplier A
  });

  it('Test 3: Missing token should return 401', async () => {
    const response = await app.inject({
        method: 'GET',
        url: '/suppliers'
    });

    expect(response.statusCode).toBe(401);
  });

  it('Test 4: Context Mismatch - Org token accessing location route should return 403', async () => {
    // Issue Organisation Token (no locationId)
    const token = signAccessToken({
        sub: userA.id,
        orgId: orgA.id,
        tokenType: 'organisation',
        roles: ['owner'],
        tokenVersion: 0,
    });

    // /supplier-insights/summary requires location context
    const response = await app.inject({
        method: 'GET',
        url: '/supplier-insights/summary',
        headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error.message).toContain('Location context required');
  });

  it('Test 5: Org Token vs Org Route should succeed', async () => {
    const token = signAccessToken({
        sub: userA.id,
        orgId: orgA.id,
        tokenType: 'organisation',
        roles: ['owner'],
        tokenVersion: 0,
    });

    // /organisations/ requires valid org context
    // Note: /organisations/ root list route uses userId only, but let's try POST /select-organisation or something?
    // Wait, auth routes are special.
    // Let's look for an org-level protected route. 
    // /organisations/ (list) uses userId only.
    // /organisations/ (create) uses userId only.
    
    // Let's try /suppliers which uses validateOrgAccess.
    // In SupplierController, we allow 'organisation' or 'location' token types.
    // So this should pass for Org Token.
    
    const response = await app.inject({
        method: 'GET',
        url: '/suppliers',
        headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(supplierA.id);
  });

  it('Test 6: Cross-Org Isolation - User A cannot see User B data', async () => {
    // Setup: User B has a supplier in Org B (already done in beforeEach)
    
    // User A queries /suppliers
    const token = signAccessToken({
        sub: userA.id,
        orgId: orgA.id,
        locId: locA.id,
        tokenType: 'location',
        roles: ['owner'],
        tokenVersion: 0,
    });

    const response = await app.inject({
        method: 'GET',
        url: '/suppliers',
        headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    
    // Verify we ONLY see Org A's data
    const returnedIds = body.data.map((s: any) => s.id);
    expect(returnedIds).toContain(supplierA.id);
    expect(returnedIds).not.toContain(supplierB.id);
  });

  it('Test 7: IDOR regression - Org B cannot access Org A invoice file status (404)', async () => {
    const tokenB = signAccessToken({
      sub: userB.id,
      orgId: orgB.id,
      locId: locB.id,
      tokenType: 'location',
      roles: ['owner'],
      tokenVersion: 0,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/invoices/file-a/status',
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('Test 8: IDOR regression - Org B cannot verify Org A invoice (404)', async () => {
    const tokenB = signAccessToken({
      sub: userB.id,
      orgId: orgB.id,
      locId: locB.id,
      tokenType: 'location',
      roles: ['owner'],
      tokenVersion: 0,
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/invoices/inv-a/verify',
      headers: { Authorization: `Bearer ${tokenB}` },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });
});





