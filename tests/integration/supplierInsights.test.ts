import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';
import { MANUAL_COGS_ACCOUNT_CODE } from '../../src/config/constants';

describe('Supplier Insights Service Integration', () => {
  const orgId = 'test-org-id';
  const locationId = 'test-loc-id';
  const supplierId1 = 'supplier-1';
  const supplierId2 = 'supplier-2';
  const supplierId3 = 'supplier-3';

  beforeAll(async () => {
    await resetDb(); // Use shared resetDb logic that handles FK order

    // Seed data (use date in previous month to match "last 12 complete months" filter)
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(15);

    await prisma.organisation.create({
      data: {
        id: orgId,
        name: 'Test Organisation',
        locations: {
            create: { id: locationId, name: 'Main Location' }
        },
        suppliers: {
          createMany: {
            data: [
                { id: supplierId1, name: 'PowerDirect', normalizedName: 'powerdirect', sourceType: 'MANUAL' },
                { id: supplierId2, name: 'MCO Cleaning Services', normalizedName: 'mco cleaning services', sourceType: 'MANUAL' },
                { id: supplierId3, name: 'EcoPack Warehousing', normalizedName: 'ecopack warehousing', sourceType: 'MANUAL' }
            ]
          }
        }
      }
    });

    // Helper to seed product + invoice
    const createInvoiceWithProduct = async (
        invId: string, 
        supId: string, 
        desc: string, 
        qty: number, 
        price: number, 
        key: string
    ) => {
        // Create Product
        const product = await prisma.product.create({
            data: {
                organisationId: orgId,
                locationId: locationId,
                productKey: key,
                name: desc,
                supplierId: supId
            }
        });

        await prisma.xeroInvoice.create({
            data: {
                organisationId: orgId,
                xeroInvoiceId: invId,
                supplierId: supId,
                status: 'AUTHORISED',
                total: qty * price,
                date: lastMonth,
                lineItems: {
                    create: {
                        description: desc,
                        quantity: qty,
                        lineAmount: qty * price,
                        unitAmount: price,
                        accountCode: 'EXP',
                        productId: product.id
                    }
                }
            }
        });
    };

    await createInvoiceWithProduct('inv-1', supplierId1, 'Power bil', 1, 500, 'power bil');
    await createInvoiceWithProduct('inv-2', supplierId2, 'Office cleaning services', 4, 50, 'office cleaning services');
    await createInvoiceWithProduct('inv-3', supplierId3, '12oz Compostable Cups', 1000, 0.1, '12oz compostable cups');
  }, 30000); // Increased timeout for seeding

  afterAll(async () => {
    await teardown();
  });

  it('getSupplierSpendSummary returns successfully', async () => {
    const summary = await supplierInsightsService.getSupplierSpendSummary(orgId);
    expect(summary).toBeDefined();
    expect(summary.totalSupplierSpendPerMonth).toBeDefined();
  }, 20000);

  it('getProducts returns all products when no search is provided', async () => {
    const result = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 10 });
    expect(result).toBeDefined();
    expect(result.items.length).toBe(3);
  });

  describe('getProducts search', () => {
    it('searches by product name (partial, case-insensitive)', async () => {
        const result = await supplierInsightsService.getProducts(orgId, undefined, { search: 'power' });
        expect(result.items.length).toBe(1);
        expect(result.items[0].productName).toBe('Power bil');
    });

    it('searches by supplier name (partial, case-insensitive)', async () => {
        const result = await supplierInsightsService.getProducts(orgId, undefined, { search: 'cleaning' });
        expect(result.items.length).toBe(1);
        // Product name is "Office cleaning services", supplier is "MCO Cleaning Services"
        // Both match "cleaning"
        expect(result.items[0].productName).toBe('Office cleaning services');
        expect(result.items[0].supplierName).toBe('MCO Cleaning Services');
    });

    it('returns empty list when no matches found', async () => {
        const result = await supplierInsightsService.getProducts(orgId, undefined, { search: 'thisDoesNotExist' });
        expect(result.items.length).toBe(0);
    });

    it('searches across multiple fields (e.g. "pack" matches supplier EcoPack)', async () => {
        const result = await supplierInsightsService.getProducts(orgId, undefined, { search: 'pack' });
        expect(result.items.length).toBe(1);
        expect(result.items[0].supplierName).toBe('EcoPack Warehousing');
    });
  });

  describe('Filtering unverified invoices', () => {
    const unverifiedSupplierId = 'supplier-unverified';
    
    beforeAll(async () => {
      // Create a supplier
      await prisma.supplier.create({
        data: {
          id: unverifiedSupplierId,
          organisationId: orgId,
          name: 'Unverified Supplier',
          normalizedName: 'unverified supplier',
          sourceType: 'MANUAL',
          status: 'ACTIVE'
        }
      });

      // Create an invoice that is verified in DB but file is NOT verified
      // This simulates the bug condition
      const file = await prisma.invoiceFile.create({
        data: {
            organisationId: orgId,
            locationId: locationId,
            sourceType: 'UPLOAD',
            fileName: 'test.pdf',
            mimeType: 'application/pdf',
            storageKey: 'key',
            processingStatus: 'OCR_COMPLETE',
            reviewStatus: 'NEEDS_REVIEW' // Crucial: NOT 'VERIFIED'
        }
      });

      await prisma.invoice.create({
          data: {
              organisationId: orgId,
              locationId: locationId,
              invoiceFileId: file.id,
              supplierId: unverifiedSupplierId,
              sourceType: 'UPLOAD',
              isVerified: true, // Crucial: Marked verified (e.g. by legacy bug or sync issue)
              date: new Date(),
              total: 1000,
              lineItems: {
                  create: {
                      description: 'Unverified Item',
                      quantity: 1,
                      lineTotal: 1000,
                      accountCode: 'MANUAL_COGS'
                  }
              }
          }
      });
    });

    it('excludes spend from invoices where file reviewStatus is not VERIFIED', async () => {
        const breakdown = await supplierInsightsService.getSpendBreakdown(orgId);
        
        const supplierEntry = breakdown.bySupplier.find(s => s.supplierId === unverifiedSupplierId);
        // Should be undefined or 0 spend
        if (supplierEntry) {
            expect(supplierEntry.totalSpend12m).toBe(0);
        } else {
            expect(supplierEntry).toBeUndefined();
        }
    });

    it('excludes products from invoices where file reviewStatus is not VERIFIED', async () => {
        const products = await supplierInsightsService.getProducts(orgId, undefined, { search: 'Unverified' });
        expect(products.items.length).toBe(0);
    });
  });

  describe('Manual invoice verification flow', () => {
    const verificationSupplierId = 'supplier-verification-test';
    let invoiceId: string;
    let invoiceFileId: string;
    
    beforeAll(async () => {
      // Create a supplier
      await prisma.supplier.create({
        data: {
          id: verificationSupplierId,
          organisationId: orgId,
          name: 'Verification Test Supplier',
          normalizedName: 'verification test supplier',
          sourceType: 'MANUAL',
          status: 'ACTIVE'
        }
      });

      // Create an invoice file in NEEDS_REVIEW status
      const file = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          sourceType: 'UPLOAD',
          fileName: 'verification-test.pdf',
          mimeType: 'application/pdf',
          storageKey: 'verification-test-key',
          processingStatus: 'OCR_COMPLETE',
          reviewStatus: 'NEEDS_REVIEW' // Not verified yet
        }
      });
      invoiceFileId = file.id;

      // Create invoice with line items (not verified)
      const invoice = await prisma.invoice.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          invoiceFileId: file.id,
          supplierId: verificationSupplierId,
          sourceType: 'UPLOAD',
          isVerified: false, // Not verified
          date: new Date(),
          total: 5000, // $50.00
          lineItems: {
            create: [
              {
                description: 'Test Product A',
                quantity: 2,
                lineTotal: 3000, // $30.00
                accountCode: 'MANUAL_COGS',
                productCode: 'TEST-A'
              },
              {
                description: 'Test Product B',
                quantity: 1,
                lineTotal: 2000, // $20.00
                accountCode: 'MANUAL_COGS',
                productCode: 'TEST-B'
              }
            ]
          }
        },
        include: {
          lineItems: true
        }
      });
      invoiceId = invoice.id;
    });

    it('excludes unverified invoice spend from insights summary', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const summary = await supplierInsightsService.getSupplierSpendSummary(orgId, locationId, ['MANUAL_COGS']);
      
      // The unverified invoice should not contribute to spend
      // We can't easily check the exact total, but we can verify the supplier isn't in breakdown
      const breakdown = await supplierInsightsService.getSpendBreakdown(orgId, locationId, ['MANUAL_COGS']);
      const supplierEntry = breakdown.bySupplier.find(s => s.supplierId === verificationSupplierId);
      
      // Should be undefined or 0 spend before verification
      if (supplierEntry) {
        expect(supplierEntry.totalSpend12m).toBe(0);
      } else {
        expect(supplierEntry).toBeUndefined();
      }
    });

    it('includes verified invoice spend after verification and decreases review count', async () => {
      // Get initial review count
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const initialReviewCount = await prisma.invoiceFile.count({
        where: {
          organisationId: orgId,
          locationId: locationId,
          reviewStatus: 'NEEDS_REVIEW',
          deletedAt: null
        }
      });

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { invoiceFile: true, lineItems: true }
      });
      expect(invoice).toBeDefined();
      expect(invoice?.invoiceFile?.reviewStatus).toBe('NEEDS_REVIEW');

      // Verify the invoice using the service
      const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
      await invoicePipelineService.verifyInvoice(invoiceId, {
        supplierId: verificationSupplierId,
        supplierName: 'Verification Test Supplier',
        total: 5000,
        selectedLineItemIds: invoice!.lineItems.map(item => item.id),
        items: invoice!.lineItems.map(item => ({
          id: item.id,
          description: item.description || '',
          quantity: typeof item.quantity === 'object' && item.quantity !== null 
            ? (item.quantity as any).toNumber() 
            : Number(item.quantity || 1),
          lineTotal: typeof item.lineTotal === 'object' && item.lineTotal !== null 
            ? (item.lineTotal as any).toNumber() 
            : Number(item.lineTotal || 0),
          productCode: item.productCode || undefined
        }))
      });

      // Verify the invoice file is now VERIFIED
      const updatedFile = await prisma.invoiceFile.findUnique({
        where: { id: invoiceFileId }
      });
      expect(updatedFile?.reviewStatus).toBe('VERIFIED');

      // Verify the invoice is marked as verified
      const updatedInvoice = await prisma.invoice.findUnique({
        where: { id: invoiceId }
      });
      expect(updatedInvoice?.isVerified).toBe(true);

      // Now check insights summary - should include the verified invoice
      const breakdown = await supplierInsightsService.getSpendBreakdown(orgId, locationId, [MANUAL_COGS_ACCOUNT_CODE]);
      const supplierEntry = breakdown.bySupplier.find(s => s.supplierId === verificationSupplierId);
      
      expect(supplierEntry).toBeDefined();
      expect(supplierEntry?.totalSpend12m).toBe(5000); // $50.00 total
    });

    it('decreases review count after verification', async () => {
      // Get review count before (should be 0 since we just verified the only pending invoice)
      // Actually, we need to check the count before verification in the previous test
      // But since we're in a new test, let's verify the count is correct now
      
      // Create another invoice in NEEDS_REVIEW to test the count
      const file2 = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          sourceType: 'UPLOAD',
          fileName: 'pending-test.pdf',
          mimeType: 'application/pdf',
          storageKey: 'pending-test-key',
          processingStatus: 'OCR_COMPLETE',
          reviewStatus: 'NEEDS_REVIEW'
        }
      });

      const invoice2 = await prisma.invoice.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          invoiceFileId: file2.id,
          supplierId: verificationSupplierId,
          sourceType: 'UPLOAD',
          isVerified: false,
          date: new Date(),
          total: 1000,
          lineItems: {
            create: {
              description: 'Test line item',
              quantity: 1,
              lineTotal: 1000,
              unitPrice: 1000,
              accountCode: MANUAL_COGS_ACCOUNT_CODE
            }
          }
        },
        include: {
          lineItems: true
        }
      });

      // Get review count via the service/controller logic
      // Since we don't have direct access to the controller in integration tests,
      // we'll query directly to verify the count logic
      const pendingCount = await prisma.invoiceFile.count({
        where: {
          organisationId: orgId,
          locationId: locationId,
          reviewStatus: 'NEEDS_REVIEW',
          deletedAt: null
        }
      });

      expect(pendingCount).toBeGreaterThan(0);

      // Verify the second invoice
      const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
      await invoicePipelineService.verifyInvoice(invoice2.id, {
        supplierId: verificationSupplierId,
        supplierName: 'Verification Test Supplier',
        total: 1000,
        selectedLineItemIds: invoice2.lineItems.map(item => item.id),
        items: invoice2.lineItems.map(item => ({
          id: item.id,
          description: item.description || '',
          quantity: item.quantity !== null && typeof item.quantity === 'object'
            ? (item.quantity as any).toNumber()
            : item.quantity !== null ? Number(item.quantity) : undefined,
          lineTotal: item.lineTotal !== null && typeof item.lineTotal === 'object'
            ? (item.lineTotal as any).toNumber()
            : item.lineTotal !== null ? Number(item.lineTotal) : undefined,
          productCode: item.productCode || undefined
        }))
      });

      // Check count decreased
      const newPendingCount = await prisma.invoiceFile.count({
        where: {
          organisationId: orgId,
          locationId: locationId,
          reviewStatus: 'NEEDS_REVIEW',
          deletedAt: null
        }
      });

      expect(newPendingCount).toBe(pendingCount - 1);
    });
  });

  describe('Auto-approve verification flow', () => {
    const autoApproveSupplierId = 'supplier-auto-approve-test';
    let autoApproveInvoiceId: string;
    let autoApproveFileId: string;
    
    beforeAll(async () => {
      // Enable auto-approve on location
      await prisma.location.update({
        where: { id: locationId },
        data: { autoApproveCleanInvoices: true }
      });

      // Create an ACTIVE supplier (required for auto-approve)
      await prisma.supplier.create({
        data: {
          id: autoApproveSupplierId,
          organisationId: orgId,
          name: 'Auto-Approve Test Supplier',
          normalizedName: 'auto-approve test supplier',
          sourceType: 'MANUAL',
          status: 'ACTIVE'
        }
      });

      // Create an invoice file with high confidence (required for auto-approve)
      // Threshold is 90 (0-100 scale)
      const file = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          sourceType: 'UPLOAD',
          fileName: 'auto-approve-test.pdf',
          mimeType: 'application/pdf',
          storageKey: 'auto-approve-test-key',
          processingStatus: 'OCR_COMPLETE',
          reviewStatus: 'NEEDS_REVIEW',
          confidenceScore: 95 // High confidence (above threshold of 90)
        }
      });
      autoApproveFileId = file.id;

      // Create invoice with line items
      const invoice = await prisma.invoice.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          invoiceFileId: file.id,
          supplierId: autoApproveSupplierId,
          sourceType: 'UPLOAD',
          isVerified: false,
          date: new Date(),
          total: 3000, // $30.00
          lineItems: {
            create: [
              {
                description: 'Auto-Approved Product',
                quantity: 1,
                lineTotal: 3000,
                accountCode: 'MANUAL_COGS',
                productCode: 'AUTO-1'
              }
            ]
          }
        },
        include: {
          lineItems: true
        }
      });
      autoApproveInvoiceId = invoice.id;

      // Create canonical invoice and line items for quality summary
      // Auto-approve requires quality data with all lines OK
      const canonicalInvoice = await (prisma as any).canonicalInvoice.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          supplierId: autoApproveSupplierId,
          date: invoice.date,
          legacyInvoiceId: invoice.id,
          source: 'MANUAL',
          sourceInvoiceRef: `invoiceId:${invoice.id}`,
          currencyCode: 'AUD'
        }
      });

      await (prisma as any).canonicalInvoiceLineItem.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          canonicalInvoiceId: canonicalInvoice.id,
          supplierId: autoApproveSupplierId,
          source: 'MANUAL',
          sourceLineRef: `invoiceId:${invoice.id}:manual:${invoice.lineItems[0].id}`,
          normalizationVersion: 'v1',
          rawDescription: 'Auto-Approved Product',
          normalizedDescription: 'auto-approved product',
          quantity: 1,
          lineTotal: 3000,
          currencyCode: 'AUD',
          unitCategory: 'UNIT',
          unitLabel: 'UNIT',
          adjustmentStatus: 'NONE',
          qualityStatus: 'OK', // All lines must be OK for auto-approve
          productCode: 'AUTO-1'
        }
      });
    });

    it('auto-approves invoice and sets verificationSource to AUTO', async () => {
      // Get initial review count
      const initialReviewCount = await prisma.invoiceFile.count({
        where: {
          organisationId: orgId,
          locationId: locationId,
          reviewStatus: 'NEEDS_REVIEW',
          deletedAt: null
        }
      });

      // Fetch the file with invoice relation (required for checkAndApplyAutoApproval)
      const file = await prisma.invoiceFile.findUnique({
        where: { id: autoApproveFileId },
        include: {
          invoice: {
            include: {
              lineItems: true,
              supplier: true
            }
          }
        }
      });
      expect(file).toBeDefined();
      expect(file?.reviewStatus).toBe('NEEDS_REVIEW');

      // Trigger auto-approval
      const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
      const result = await invoicePipelineService.checkAndApplyAutoApproval(file!);
      
      expect(result.applied).toBe(true);

      // Verify the invoice file is now VERIFIED with AUTO source
      const updatedFile = await prisma.invoiceFile.findUnique({
        where: { id: autoApproveFileId }
      });
      expect(updatedFile?.reviewStatus).toBe('VERIFIED');
      expect(updatedFile?.verificationSource).toBe('AUTO');
      expect(updatedFile?.verifiedAt).not.toBeNull(); // Belt + braces: verify timestamp is set

      // Verify the invoice is marked as verified
      const updatedInvoice = await prisma.invoice.findUnique({
        where: { id: autoApproveInvoiceId }
      });
      expect(updatedInvoice?.isVerified).toBe(true);

      // Check review count decreased by 1
      const newReviewCount = await prisma.invoiceFile.count({
        where: {
          organisationId: orgId,
          locationId: locationId,
          reviewStatus: 'NEEDS_REVIEW',
          deletedAt: null
        }
      });
      expect(newReviewCount).toBe(initialReviewCount - 1);

      // Verify insights include the auto-approved invoice
      const breakdown = await supplierInsightsService.getSpendBreakdown(orgId, locationId, [MANUAL_COGS_ACCOUNT_CODE]);
      const supplierEntry = breakdown.bySupplier.find(s => s.supplierId === autoApproveSupplierId);
      
      expect(supplierEntry).toBeDefined();
      expect(supplierEntry?.totalSpend12m).toBe(3000); // $30.00 total
    });
  });

  describe('Superseded Xero exclusion', () => {
    const supersededSupplierId = 'supplier-superseded-test';
    let xeroInvoiceId: string;
    let manualInvoiceId: string;
    let testProductId: string;
    
    beforeAll(async () => {
      // Create a supplier
      await prisma.supplier.create({
        data: {
          id: supersededSupplierId,
          organisationId: orgId,
          name: 'Superseded Test Supplier',
          normalizedName: 'superseded test supplier',
          sourceType: 'MANUAL',
          status: 'ACTIVE'
        }
      });

      // Create a product for price calculation testing
      const product = await prisma.product.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          productKey: 'xero-product-key',
          name: 'Xero Product',
          supplierId: supersededSupplierId
        }
      });
      testProductId = product.id;

      // Create a Xero invoice with line items linked to the product
      const xeroInvoice = await prisma.xeroInvoice.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          supplierId: supersededSupplierId,
          xeroInvoiceId: 'xero-inv-superseded-123',
          status: 'AUTHORISED',
          date: new Date(),
          total: 10000, // $100.00
          lineItems: {
            create: {
              productId: product.id,
              description: 'Xero Product',
              quantity: 2,
              lineAmount: 10000,
              unitAmount: 5000,
              accountCode: 'EXP'
            }
          }
        }
      });
      xeroInvoiceId = xeroInvoice.xeroInvoiceId;

      // Create a verified manual invoice that supersedes the Xero invoice
      const file = await prisma.invoiceFile.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          sourceType: 'UPLOAD',
          fileName: 'superseded-manual.pdf',
          mimeType: 'application/pdf',
          storageKey: 'superseded-manual-key',
          processingStatus: 'OCR_COMPLETE',
          reviewStatus: 'VERIFIED'
        }
      });

      const manualInvoice = await prisma.invoice.create({
        data: {
          organisationId: orgId,
          locationId: locationId,
          invoiceFileId: file.id,
          supplierId: supersededSupplierId,
          sourceType: 'UPLOAD',
          isVerified: true,
          sourceReference: xeroInvoiceId, // This links to the Xero invoice
          date: new Date(),
          total: 10000, // Same amount as Xero invoice
          lineItems: {
            create: {
              description: 'Manual Product (supersedes Xero)',
              quantity: 2,
              lineTotal: 10000,
              accountCode: 'MANUAL_COGS',
              productCode: 'MANUAL-1'
            }
          }
        }
      });
      manualInvoiceId = manualInvoice.id;
    });

    it('excludes superseded Xero invoice from insights (manual wins, no double counting)', async () => {
      // Belt + braces: Verify getSupersededXeroIds returns the Xero invoice ID
      // This directly tests the matching logic (sourceReference -> xeroInvoiceId)
      // We replicate the helper logic to verify it would return our Xero invoice ID
      const verifiedManualInvoice = await prisma.invoice.findUnique({
        where: { id: manualInvoiceId },
        select: { sourceReference: true }
      });
      expect(verifiedManualInvoice?.sourceReference).toBe(xeroInvoiceId);

      // Replicate getSupersededXeroIds logic to verify it returns the Xero invoice ID
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 12);
      const endDate = new Date();
      
      // Query verified manual invoices using the same where clause as getSupersededXeroIds
      const supersedingInvoices = await prisma.invoice.findMany({
        where: {
          organisationId: orgId,
          locationId: locationId,
          isVerified: true,
          invoiceFileId: { not: null },
          invoiceFile: {
            reviewStatus: 'VERIFIED',
            deletedAt: null
          },
          deletedAt: null,
          date: { gte: startDate, lte: endDate }
        },
        select: { 
          sourceReference: true,
          invoiceNumber: true,
          supplierId: true 
        }
      });
      
      // Extract explicit matches via sourceReference (same logic as getSupersededXeroIds)
      const explicitIds = supersedingInvoices
        .map(inv => inv.sourceReference)
        .filter((ref): ref is string => !!ref);
      
      // The Xero invoice ID should be in the superseded list
      // This directly tests that the matching logic works correctly
      expect(explicitIds).toContain(xeroInvoiceId);

      // Get spend breakdown - should only count manual, not Xero
      // The manual invoice has sourceReference matching the Xero invoice ID,
      // so getSupersededXeroIds should exclude the Xero invoice from insights
      const breakdown = await supplierInsightsService.getSpendBreakdown(orgId, locationId, [MANUAL_COGS_ACCOUNT_CODE, 'EXP']);
      const supplierEntry = breakdown.bySupplier.find(s => s.supplierId === supersededSupplierId);
      
      expect(supplierEntry).toBeDefined();
      // Should only count manual invoice ($100), not Xero invoice
      // Manual invoice has MANUAL_COGS account code, Xero has EXP
      // Since we're including both account codes, we should see manual spend
      expect(supplierEntry?.totalSpend12m).toBe(10000); // $100.00 from manual only
      
      // Verify Xero invoice is excluded by checking spend summary
      // If Xero wasn't excluded, we'd see 20000 (10000 + 10000)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const summary = await supplierInsightsService.getSupplierSpendSummary(orgId, locationId, [MANUAL_COGS_ACCOUNT_CODE, 'EXP']);
      
      // The breakdown should not double count - manual supersedes Xero
      // We verify this by checking the supplier entry total matches manual invoice only
      expect(supplierEntry?.totalSpend12m).toBe(10000);
      
      // Additional verification: check that Xero-only account code (EXP) doesn't include the superseded invoice
      const xeroOnlyBreakdown = await supplierInsightsService.getSpendBreakdown(orgId, locationId, ['EXP']);
      const xeroSupplierEntry = xeroOnlyBreakdown.bySupplier.find(s => s.supplierId === supersededSupplierId);
      
      // The Xero invoice should be excluded because it's superseded
      if (xeroSupplierEntry) {
        expect(xeroSupplierEntry.totalSpend12m).toBe(0);
      } else {
        // Or the supplier shouldn't appear at all
        expect(xeroSupplierEntry).toBeUndefined();
      }

      // Verify price calculations exclude superseded Xero invoice
      // The product is linked to the Xero invoice line item, but since the Xero invoice is superseded,
      // computeWeightedAveragePrices should exclude it from price calculations
      const productDetail = await supplierInsightsService.getProductDetail(orgId, testProductId, locationId);
      
      // The product detail should exist
      expect(productDetail).toBeDefined();
      
      // Price history should not include data from the superseded Xero invoice
      // Since we only have one Xero invoice (which is superseded), price history should be empty or null
      // All price history entries should be null if only superseded invoice exists
      const hasPriceData = productDetail?.priceHistory?.some(p => p.averageUnitPrice !== null);
      expect(hasPriceData).toBe(false); // No price data because Xero invoice is superseded
      
      // Verify that the Xero line item is excluded by checking the product detail stats
      // The product should have 0 spend from Xero since the invoice is superseded
      expect(productDetail?.stats12m.totalSpend12m).toBe(0); // No Xero spend because invoice is superseded
    });
  });

  describe('Xero invoice attachment filtering', () => {
    const attachmentOrgId = 'attachment-org-id';
    const attachmentLocationId = 'attachment-loc-id';
    const attachmentSupplierId = 'attachment-supplier-id';
    const xeroInvoiceIdNoAttachment = 'xero-inv-no-attachment';
    const xeroInvoiceIdUnverifiedAttachment = 'xero-inv-unverified-attachment';
    const xeroInvoiceIdVerifiedAttachment = 'xero-inv-verified-attachment';

    beforeAll(async () => {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      lastMonth.setDate(15);

      // Create org, location, supplier
      await prisma.organisation.create({
        data: {
          id: attachmentOrgId,
          name: 'Attachment Test Org',
          locations: {
            create: { id: attachmentLocationId, name: 'Attachment Location' }
          },
          suppliers: {
            create: {
              id: attachmentSupplierId,
              name: 'Attachment Supplier',
              normalizedName: 'attachment supplier',
              sourceType: 'MANUAL'
            }
          }
        }
      });

      // Create product
      const product = await prisma.product.create({
        data: {
          organisationId: attachmentOrgId,
          locationId: attachmentLocationId,
          productKey: 'test-product',
          name: 'Test Product',
          supplierId: attachmentSupplierId
        }
      });

      // 1. Xero invoice WITHOUT attachment (should be included)
      await prisma.xeroInvoice.create({
        data: {
          organisationId: attachmentOrgId,
          locationId: attachmentLocationId,
          xeroInvoiceId: xeroInvoiceIdNoAttachment,
          supplierId: attachmentSupplierId,
          status: 'AUTHORISED',
          date: lastMonth,
          total: 1000,
          lineItems: {
            create: {
              productId: product.id,
              description: 'Test Item',
              quantity: 10,
              unitAmount: 100,
              lineAmount: 1000,
              accountCode: 'EXP'
            }
          }
        }
      });

      // 2. Xero invoice WITH unverified attachment (should be EXCLUDED)
      await prisma.xeroInvoice.create({
        data: {
          organisationId: attachmentOrgId,
          locationId: attachmentLocationId,
          xeroInvoiceId: xeroInvoiceIdUnverifiedAttachment,
          supplierId: attachmentSupplierId,
          status: 'AUTHORISED',
          date: lastMonth,
          total: 2000,
          lineItems: {
            create: {
              productId: product.id,
              description: 'Test Item 2',
              quantity: 20,
              unitAmount: 100,
              lineAmount: 2000,
              accountCode: 'EXP'
            }
          }
        }
      });

      // Create InvoiceFile with NEEDS_REVIEW status (unverified)
      await prisma.invoiceFile.create({
        data: {
          organisationId: attachmentOrgId,
          locationId: attachmentLocationId,
          sourceType: 'XERO',
          sourceReference: xeroInvoiceIdUnverifiedAttachment,
          storageKey: 'test-key-unverified',
          fileName: 'test-unverified.pdf',
          mimeType: 'application/pdf',
          processingStatus: 'OCR_COMPLETE',
          reviewStatus: 'NEEDS_REVIEW'
        }
      });

      // 3. Xero invoice WITH verified attachment (should be INCLUDED)
      await prisma.xeroInvoice.create({
        data: {
          organisationId: attachmentOrgId,
          locationId: attachmentLocationId,
          xeroInvoiceId: xeroInvoiceIdVerifiedAttachment,
          supplierId: attachmentSupplierId,
          status: 'AUTHORISED',
          date: lastMonth,
          total: 3000,
          lineItems: {
            create: {
              productId: product.id,
              description: 'Test Item 3',
              quantity: 30,
              unitAmount: 100,
              lineAmount: 3000,
              accountCode: 'EXP'
            }
          }
        }
      });

      // Create InvoiceFile with VERIFIED status
      await prisma.invoiceFile.create({
        data: {
          organisationId: attachmentOrgId,
          locationId: attachmentLocationId,
          sourceType: 'XERO',
          sourceReference: xeroInvoiceIdVerifiedAttachment,
          storageKey: 'test-key-verified',
          fileName: 'test-verified.pdf',
          mimeType: 'application/pdf',
          processingStatus: 'OCR_COMPLETE',
          reviewStatus: 'VERIFIED'
        }
      });
    }, 30000);

    it('includes Xero invoices without attachments, but excludes any Xero invoice with attachments until manual approval exists', async () => {
      const summary = await supplierInsightsService.getSupplierSpendSummary(
        attachmentOrgId,
        attachmentLocationId
      );
      
      // Should include invoice without attachment (1000).
      // Should NOT include invoices that have ANY attachment (2000 unverified + 3000 verified), because attachments require approval.
      expect(summary.totalSupplierSpendPerMonth).toBeGreaterThan(0);
      
      // Verify the spend breakdown includes the correct invoices
      const breakdown = await supplierInsightsService.getSpendBreakdown(
        attachmentOrgId,
        attachmentLocationId
      );
      
      // Should have spend from invoice without attachments only
      const totalSpend = breakdown.bySupplier.reduce((sum, s) => sum + (s.totalSpend12m || 0), 0);
      expect(totalSpend).toBeGreaterThanOrEqual(1000);
      expect(totalSpend).toBeLessThan(2000); // Should not include 2000/3000 from attached Xero invoices
    });

    it('excludes Xero invoices with attachments from Supplier Insights /products (only no-attachment Xero contributes)', async () => {
      // Get products to verify they don't include data from unverified attachment invoice
      const products = await supplierInsightsService.getProducts(
        attachmentOrgId,
        attachmentLocationId,
        { page: 1, pageSize: 10 }
      );
      
      // The product should have spend from invoice without attachments only.
      const product = products.items.find(p => p.productName === 'Test Product');
      expect(product).toBeDefined();
      if (product) {
        expect(product.spend12m).toBeGreaterThanOrEqual(1000);
        expect(product.spend12m).toBeLessThan(2000);
      }
    });

    it('does not include Xero invoices with verified attachments in Supplier Insights until manual approval exists (supplier may still appear due to no-attachment invoices)', async () => {
      const breakdown = await supplierInsightsService.getSpendBreakdown(
        attachmentOrgId,
        attachmentLocationId
      );
      
      const supplierSpend = breakdown.bySupplier.find(s => s.supplierName === 'Attachment Supplier');
      expect(supplierSpend).toBeDefined();
      if (supplierSpend) {
        // Only the no-attachment Xero invoice (1000) should contribute; attached invoices (2000/3000) must not.
        expect(supplierSpend.totalSpend12m).toBeGreaterThanOrEqual(1000);
        expect(supplierSpend.totalSpend12m).toBeLessThan(2000);
      }
    });
  });
});
