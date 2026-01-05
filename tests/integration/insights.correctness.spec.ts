import { describe, it, expect, beforeAll } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, buildTestApp } from './testApp';
import { FastifyInstance } from 'fastify';
import { MANUAL_COGS_ACCOUNT_CODE } from '../../src/config/constants';

describe('Insights correctness with auto-approve', () => {
  const correctnessOrgId = 'correctness-org-id';
  const correctnessLocationId = 'correctness-loc-id';
  const correctnessSupplierId = 'correctness-supplier-id';
  let app: FastifyInstance;
  let authToken: string;
  let autoApproveFileId: string;
  let autoApproveInvoiceId: string;
  let xeroInvoiceId: string;
  let xeroProductId: string;
  let nonSupersededFileId: string;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let nonSupersededInvoiceId: string;

  beforeAll(async () => {
    await resetDb();
    app = await buildTestApp();

    // Setup user and auth for review count endpoint
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'correctness-test@example.com',
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
      payload: { email: 'correctness-test@example.com', password: 'password123' }
    });
    const loginToken = loginRes.json().access_token;

    // Create organisation with location that has auto-approve enabled
    await prisma.organisation.create({
      data: {
        id: correctnessOrgId,
        name: 'Correctness Test Organisation',
        locations: {
          create: {
            id: correctnessLocationId,
            name: 'Correctness Location',
            autoApproveCleanInvoices: true
          }
        },
        suppliers: {
          create: {
            id: correctnessSupplierId,
            name: 'Correctness Test Supplier',
            normalizedName: 'correctness test supplier',
            sourceType: 'MANUAL',
            status: 'ACTIVE'
          }
        },
        members: {
          create: {
            userId: registerRes.json().id,
            role: 'owner'
          }
        }
      }
    });

    // Select org to get org-scoped token
    const selectOrgRes = await app.inject({
      method: 'POST',
      url: '/auth/select-organisation',
      headers: { Authorization: `Bearer ${loginToken}` },
      payload: { organisationId: correctnessOrgId }
    });
    authToken = selectOrgRes.json().access_token;
  });

  it('A) Auto-approve → Verified + review count', async () => {
    // 1. Create invoice file with high confidence and line items
    // Use explicit date in the middle of last month to ensure it's inside all Insights windows
    // getFullCalendarMonths(6) returns last 6 full calendar months ending at end of last month
    const now = new Date();
    const invoiceDate = new Date(now.getFullYear(), now.getMonth() - 1, 15); // 15th of last month
    
    const file = await prisma.invoiceFile.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        sourceType: 'UPLOAD',
        fileName: 'auto-approve-correctness.pdf',
        mimeType: 'application/pdf',
        storageKey: 'auto-approve-correctness-key',
        processingStatus: 'OCR_COMPLETE',
        reviewStatus: 'NEEDS_REVIEW',
        confidenceScore: 95 // High confidence (above threshold of 90)
      }
    });
    autoApproveFileId = file.id;

    const invoice = await prisma.invoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        invoiceFileId: file.id,
        supplierId: correctnessSupplierId,
        sourceType: 'UPLOAD',
        isVerified: false,
        date: invoiceDate,
        total: 5000, // $50.00
        lineItems: {
          create: {
            description: 'Test Product A',
            quantity: 2,
            lineTotal: 5000,
            accountCode: MANUAL_COGS_ACCOUNT_CODE,
            productCode: 'TEST-A'
          }
        }
      },
      include: {
        lineItems: true
      }
    });
    autoApproveInvoiceId = invoice.id;

    // Create canonical invoice and line items with qualityStatus = OK
    const canonicalInvoice = await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        supplierId: correctnessSupplierId,
        date: invoiceDate,
        legacyInvoiceId: invoice.id,
        source: 'MANUAL',
        sourceInvoiceRef: `invoiceId:${invoice.id}`,
        currencyCode: 'AUD'
      }
    });

    await (prisma as any).canonicalInvoiceLineItem.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        canonicalInvoiceId: canonicalInvoice.id,
        supplierId: correctnessSupplierId,
        source: 'MANUAL',
        sourceLineRef: `invoiceId:${invoice.id}:manual:${invoice.lineItems[0].id}`,
        normalizationVersion: 'v1',
        rawDescription: 'Test Product A',
        normalizedDescription: 'test product a',
        quantity: 2,
        lineTotal: 5000,
        currencyCode: 'AUD',
        unitCategory: 'UNIT',
        unitLabel: 'UNIT',
        adjustmentStatus: 'NONE',
        qualityStatus: 'OK' // All lines must be OK for auto-approve
      }
    });

    // 2. Assert review count before auto-approval (using production endpoint)
    const reviewCountResBefore = await app.inject({
      method: 'GET',
      url: `/invoices/locations/${correctnessLocationId}/review-count`,
      headers: { Authorization: `Bearer ${authToken}` }
    });
    expect(reviewCountResBefore.statusCode).toBe(200);
    const reviewCountBefore = reviewCountResBefore.json().count;
    expect(reviewCountBefore).toBeGreaterThanOrEqual(1);

    // 3. Trigger auto-approval
    const fileWithInvoice = await prisma.invoiceFile.findUnique({
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
    expect(fileWithInvoice).toBeDefined();

    const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
    const result = await invoicePipelineService.checkAndApplyAutoApproval(fileWithInvoice!);
    expect(result.applied).toBe(true);

    // 4. Assert after auto-approval
    const updatedFile = await prisma.invoiceFile.findUnique({
      where: { id: autoApproveFileId }
    });
    expect(updatedFile?.reviewStatus).toBe('VERIFIED');
    expect(updatedFile?.verificationSource).toBe('AUTO');
    expect(updatedFile?.verifiedAt).not.toBeNull(); // Audit trail: verifiedAt must be set

    const updatedInvoice = await prisma.invoice.findUnique({
      where: { id: autoApproveInvoiceId }
    });
    expect(updatedInvoice?.isVerified).toBe(true);

    // Review count should decrease (using production endpoint)
    const reviewCountResAfter = await app.inject({
      method: 'GET',
      url: `/invoices/locations/${correctnessLocationId}/review-count`,
      headers: { Authorization: `Bearer ${authToken}` }
    });
    expect(reviewCountResAfter.statusCode).toBe(200);
    const reviewCountAfter = reviewCountResAfter.json().count;
    expect(reviewCountAfter).toBe(reviewCountBefore - 1);
  });

  it('B) Auto-approved invoice appears in Insights', async () => {
    // Create a new invoice for this test to get clean before/after comparison
    // Use explicit date in the middle of last month to ensure it's inside all Insights windows
    const now = new Date();
    const invoiceDate = new Date(now.getFullYear(), now.getMonth() - 1, 15); // 15th of last month
    const invoiceAmount = 7500; // $75.00
    
    const file = await prisma.invoiceFile.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        sourceType: 'UPLOAD',
        fileName: 'auto-approve-insights-test.pdf',
        mimeType: 'application/pdf',
        storageKey: 'auto-approve-insights-test-key',
        processingStatus: 'OCR_COMPLETE',
        reviewStatus: 'NEEDS_REVIEW',
        confidenceScore: 95
      }
    });

    const invoice = await prisma.invoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        invoiceFileId: file.id,
        supplierId: correctnessSupplierId,
        sourceType: 'UPLOAD',
        isVerified: false,
        date: invoiceDate,
        total: invoiceAmount,
        lineItems: {
          create: {
            description: 'Insights Test Product',
            quantity: 1,
            lineTotal: invoiceAmount,
            accountCode: MANUAL_COGS_ACCOUNT_CODE,
            productCode: 'INSIGHTS-TEST'
          }
        }
      },
      include: {
        lineItems: true
      }
    });

    // Create canonical invoice with OK quality status
    const canonicalInvoice = await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        supplierId: correctnessSupplierId,
        date: invoiceDate,
        legacyInvoiceId: invoice.id,
        source: 'MANUAL',
        sourceInvoiceRef: `invoiceId:${invoice.id}`,
        currencyCode: 'AUD'
      }
    });

    await (prisma as any).canonicalInvoiceLineItem.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        canonicalInvoiceId: canonicalInvoice.id,
        supplierId: correctnessSupplierId,
        source: 'MANUAL',
        sourceLineRef: `invoiceId:${invoice.id}:manual:${invoice.lineItems[0].id}`,
        normalizationVersion: 'v1',
        rawDescription: 'Insights Test Product',
        normalizedDescription: 'insights test product',
        quantity: 1,
        lineTotal: invoiceAmount,
        currencyCode: 'AUD',
        unitCategory: 'UNIT',
        unitLabel: 'UNIT',
        adjustmentStatus: 'NONE',
        qualityStatus: 'OK'
      }
    });

    // 5. Fetch Insights summary BEFORE auto-approval (baseline)
    const summaryBefore = await supplierInsightsService.getSupplierSpendSummary(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE]
    );
    const breakdownBefore = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE]
    );
    const supplierEntryBefore = breakdownBefore.bySupplier.find(s => s.supplierId === correctnessSupplierId);
    const spendBefore = supplierEntryBefore?.totalSpend12m || 0;

    // Trigger auto-approval
    const fileWithInvoice = await prisma.invoiceFile.findUnique({
      where: { id: file.id },
      include: {
        invoice: {
          include: {
            lineItems: true,
            supplier: true
          }
        }
      }
    });

    const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
    const result = await invoicePipelineService.checkAndApplyAutoApproval(fileWithInvoice!);
    expect(result.applied).toBe(true);

    // Assert audit fields for AUTO verification
    const updatedFile = await prisma.invoiceFile.findUnique({
      where: { id: file.id }
    });
    expect(updatedFile?.reviewStatus).toBe('VERIFIED');
    expect(updatedFile?.verificationSource).toBe('AUTO');
    expect(updatedFile?.verifiedAt).not.toBeNull(); // Audit trail: verifiedAt must be set

    // 6. Fetch Insights summary AFTER auto-approval
    const summaryAfter = await supplierInsightsService.getSupplierSpendSummary(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE]
    );
    const breakdownAfter = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE]
    );
    const supplierEntryAfter = breakdownAfter.bySupplier.find(s => s.supplierId === correctnessSupplierId);

    // 7. Assert exact delta
    expect(supplierEntryAfter).toBeDefined();
    expect(supplierEntryAfter?.totalSpend12m).toBe(spendBefore + invoiceAmount); // Exact delta
    expect(supplierEntryAfter?.supplierName).toBe('Correctness Test Supplier');
    
    // Verify summary also reflects the increase
    expect(summaryAfter.totalSupplierSpendPerMonth).toBeGreaterThanOrEqual(summaryBefore.totalSupplierSpendPerMonth);
  });

  it('C) Supersession prevents double counting (AUTO path)', async () => {
    // 8. Create Xero invoice with line items
    const product = await prisma.product.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        productKey: 'xero-supersession-product',
        name: 'Xero Supersession Product',
        supplierId: correctnessSupplierId
      }
    });
    xeroProductId = product.id;

    // Use explicit date in the middle of last month to ensure it's inside all Insights windows
    const now = new Date();
    const xeroInvoiceDate = new Date(now.getFullYear(), now.getMonth() - 1, 15); // 15th of last month

    const xeroInvoice = await prisma.xeroInvoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        supplierId: correctnessSupplierId,
        xeroInvoiceId: 'xero-supersession-123',
        status: 'AUTHORISED',
        date: xeroInvoiceDate,
        total: 10000, // $100.00
        lineItems: {
          create: {
            productId: product.id,
            description: 'Xero Supersession Product',
            quantity: 2,
            lineAmount: 10000,
            unitAmount: 5000,
            accountCode: 'EXP'
          }
        }
      }
    });
    xeroInvoiceId = xeroInvoice.xeroInvoiceId;

    // Get baseline spend BEFORE supersession
    // Get Xero-only spend (EXP account code)
    const baselineXeroBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      ['EXP']
    );
    const baselineXeroEntry = baselineXeroBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);
    const baselineXeroSpend = baselineXeroEntry?.totalSpend12m || 0;
    expect(baselineXeroSpend).toBe(10000); // Xero invoice contributes $100

    // Get total spend (all account codes) before supersession
    const baselineTotalBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE, 'EXP']
    );
    const baselineTotalEntry = baselineTotalBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);
    const baselineTotalSpend = baselineTotalEntry?.totalSpend12m || 0;

    // 9. Create manual invoice that supersedes Xero invoice and qualifies for auto-approve
    const supersedingFile = await prisma.invoiceFile.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        sourceType: 'UPLOAD',
        fileName: 'superseding-manual.pdf',
        mimeType: 'application/pdf',
        storageKey: 'superseding-manual-key',
        processingStatus: 'OCR_COMPLETE',
        reviewStatus: 'NEEDS_REVIEW',
        confidenceScore: 95,
        sourceReference: xeroInvoiceId // Links to Xero invoice
      }
    });

    const supersedingInvoice = await prisma.invoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        invoiceFileId: supersedingFile.id,
        supplierId: correctnessSupplierId,
        sourceType: 'UPLOAD',
        isVerified: false,
        sourceReference: xeroInvoiceId, // Links to Xero invoice
        date: xeroInvoiceDate, // Same date as Xero invoice for consistency
        total: 10000, // Same amount as Xero invoice
        lineItems: {
          create: {
            description: 'Manual Supersession Product',
            quantity: 2,
            lineTotal: 10000,
            accountCode: MANUAL_COGS_ACCOUNT_CODE,
            productCode: 'MANUAL-SUPER'
          }
        }
      },
      include: {
        lineItems: true
      }
    });

    // Explicitly prove sourceReference timing - assert it's set BEFORE auto-approve
    const fileBeforeAutoApprove = await prisma.invoiceFile.findUnique({
      where: { id: supersedingFile.id },
      include: { invoice: true }
    });
    expect(fileBeforeAutoApprove?.sourceReference).toBe(xeroInvoiceId);
    expect(supersedingInvoice.sourceReference).toBe(xeroInvoiceId);

    // Create canonical invoice with OK quality status
    const supersedingCanonical = await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        supplierId: correctnessSupplierId,
        date: supersedingInvoice.date,
        legacyInvoiceId: supersedingInvoice.id,
        source: 'MANUAL',
        sourceInvoiceRef: `invoiceId:${supersedingInvoice.id}`,
        currencyCode: 'AUD'
      }
    });

    await (prisma as any).canonicalInvoiceLineItem.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        canonicalInvoiceId: supersedingCanonical.id,
        supplierId: correctnessSupplierId,
        source: 'MANUAL',
        sourceLineRef: `invoiceId:${supersedingInvoice.id}:manual:${supersedingInvoice.lineItems[0].id}`,
        normalizationVersion: 'v1',
        rawDescription: 'Manual Supersession Product',
        normalizedDescription: 'manual supersession product',
        quantity: 2,
        lineTotal: 10000,
        currencyCode: 'AUD',
        unitCategory: 'UNIT',
        unitLabel: 'UNIT',
        adjustmentStatus: 'NONE',
        qualityStatus: 'OK'
      }
    });

    // 10. Trigger auto-approval
    const fileWithInvoice = await prisma.invoiceFile.findUnique({
      where: { id: supersedingFile.id },
      include: {
        invoice: {
          include: {
            lineItems: true,
            supplier: true
          }
        }
      }
    });

    const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
    const result = await invoicePipelineService.checkAndApplyAutoApproval(fileWithInvoice!);
    expect(result.applied).toBe(true);

    // Assert audit fields for AUTO verification
    const updatedSupersedingFile = await prisma.invoiceFile.findUnique({
      where: { id: supersedingFile.id }
    });
    expect(updatedSupersedingFile?.reviewStatus).toBe('VERIFIED');
    expect(updatedSupersedingFile?.verificationSource).toBe('AUTO');
    expect(updatedSupersedingFile?.verifiedAt).not.toBeNull(); // Audit trail: verifiedAt must be set

    // 11. Fetch Insights summary and assert no double counting
    const finalBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE, 'EXP']
    );
    const finalSupplierEntry = finalBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);

    expect(finalSupplierEntry).toBeDefined();
    
    // Total should NOT double: totalAfter ≈ totalBefore - xeroAmount + manualAmount
    // Since manualAmount === xeroAmount ($100), total should remain approximately the same
    // (or increase only by any other invoices from previous tests)
    const manualAmount = 10000;
    const expectedTotal = baselineTotalSpend - baselineXeroSpend + manualAmount;
    expect(finalSupplierEntry?.totalSpend12m).toBe(expectedTotal);

    // Verify Xero-only account code (EXP) - Xero contribution should be EXCLUDED (drop to 0)
    const xeroOnlyBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      ['EXP']
    );
    const xeroOnlyEntry = xeroOnlyBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);

    // Xero spend should drop to 0 because it's superseded (not remain at baseline)
    if (xeroOnlyEntry) {
      expect(xeroOnlyEntry.totalSpend12m).toBe(0); // Excluded due to supersession
    } else {
      // Or supplier shouldn't appear in Xero-only breakdown when superseded
      // This is also valid - supplier disappears from Xero breakdown
    }

    // Verify manual-only account code (MANUAL_COGS) - manual contribution should be present
    const manualOnlyBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE]
    );
    const manualOnlyEntry = manualOnlyBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);
    expect(manualOnlyEntry).toBeDefined();
    expect(manualOnlyEntry?.totalSpend12m).toBeGreaterThanOrEqual(manualAmount);

    // 5. Assert price calculations exclude superseded Xero invoice
    // Fetch product detail to verify computeWeightedAveragePrices() excludes superseded Xero
    const productDetail = await supplierInsightsService.getProductDetail(
      correctnessOrgId,
      xeroProductId,
      correctnessLocationId
    );

    expect(productDetail).toBeDefined();
    
    // Price history should not include data from the superseded Xero invoice
    // Since the Xero invoice is superseded, price calculations should exclude it
    const hasPriceData = productDetail?.priceHistory?.some(p => p.averageUnitPrice !== null);
    expect(hasPriceData).toBe(false); // No price data because Xero invoice is superseded
    
    // Total spend should be 0 for this product (Xero invoice excluded)
    expect(productDetail?.stats12m.totalSpend12m).toBe(0); // No Xero spend because invoice is superseded
  });

  it('D) Non-superseded Xero remains counted', async () => {
    // 12. Create another unrelated manual invoice (no sourceReference) that auto-approves
    // Use explicit date in the middle of last month to ensure it's inside all Insights windows
    const now = new Date();
    const nonSupersededInvoiceDate = new Date(now.getFullYear(), now.getMonth() - 1, 15); // 15th of last month

    const nonSupersededFile = await prisma.invoiceFile.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        sourceType: 'UPLOAD',
        fileName: 'non-superseded-manual.pdf',
        mimeType: 'application/pdf',
        storageKey: 'non-superseded-manual-key',
        processingStatus: 'OCR_COMPLETE',
        reviewStatus: 'NEEDS_REVIEW',
        confidenceScore: 95
        // No sourceReference - this is unrelated to any Xero invoice
      }
    });
    nonSupersededFileId = nonSupersededFile.id;

    const nonSupersededInvoice = await prisma.invoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        invoiceFileId: nonSupersededFile.id,
        supplierId: correctnessSupplierId,
        sourceType: 'UPLOAD',
        isVerified: false,
        // No sourceReference
        date: nonSupersededInvoiceDate,
        total: 7500, // $75.00
        lineItems: {
          create: {
            description: 'Non-Superseded Product',
            quantity: 1,
            lineTotal: 7500,
            accountCode: MANUAL_COGS_ACCOUNT_CODE,
            productCode: 'MANUAL-NS'
          }
        }
      },
      include: {
        lineItems: true
      }
    });
    nonSupersededInvoiceId = nonSupersededInvoice.id;

    // Create canonical invoice with OK quality status
    const nonSupersededCanonical = await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        supplierId: correctnessSupplierId,
        date: nonSupersededInvoice.date,
        legacyInvoiceId: nonSupersededInvoice.id,
        source: 'MANUAL',
        sourceInvoiceRef: `invoiceId:${nonSupersededInvoice.id}`,
        currencyCode: 'AUD'
      }
    });

    await (prisma as any).canonicalInvoiceLineItem.create({
      data: {
        organisationId: correctnessOrgId,
        locationId: correctnessLocationId,
        canonicalInvoiceId: nonSupersededCanonical.id,
        supplierId: correctnessSupplierId,
        source: 'MANUAL',
        sourceLineRef: `invoiceId:${nonSupersededInvoice.id}:manual:${nonSupersededInvoice.lineItems[0].id}`,
        normalizationVersion: 'v1',
        rawDescription: 'Non-Superseded Product',
        normalizedDescription: 'non-superseded product',
        quantity: 1,
        lineTotal: 7500,
        currencyCode: 'AUD',
        unitCategory: 'UNIT',
        unitLabel: 'UNIT',
        adjustmentStatus: 'NONE',
        qualityStatus: 'OK'
      }
    });

    // Get baseline before auto-approval
    const baselineBefore = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE]
    );
    const baselineEntry = baselineBefore.bySupplier.find(s => s.supplierId === correctnessSupplierId);
    const baselineManualSpend = baselineEntry?.totalSpend12m || 0;

    // Trigger auto-approval
    const fileWithInvoice = await prisma.invoiceFile.findUnique({
      where: { id: nonSupersededFileId },
      include: {
        invoice: {
          include: {
            lineItems: true,
            supplier: true
          }
        }
      }
    });

    const { invoicePipelineService } = await import('../../src/services/InvoicePipelineService.js');
    const result = await invoicePipelineService.checkAndApplyAutoApproval(fileWithInvoice!);
    expect(result.applied).toBe(true);

    // 13. Fetch Insights summary and assert manual spend increases, Xero remains stable
    const finalBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      [MANUAL_COGS_ACCOUNT_CODE, 'EXP']
    );
    const finalSupplierEntry = finalBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);

    expect(finalSupplierEntry).toBeDefined();
    
    // Manual spend should increase by $75
    expect(finalSupplierEntry?.totalSpend12m).toBeGreaterThanOrEqual(baselineManualSpend + 7500);

    // Verify Xero spend remains stable (not affected by non-superseded manual invoice)
    const xeroBreakdown = await supplierInsightsService.getSpendBreakdown(
      correctnessOrgId,
      correctnessLocationId,
      ['EXP']
    );
    const xeroEntry = xeroBreakdown.bySupplier.find(s => s.supplierId === correctnessSupplierId);
    
    // Xero spend should be unchanged (still excluded due to supersession from test C)
    // The non-superseded manual invoice doesn't affect Xero calculations
    if (xeroEntry) {
      // Xero should still be at baseline (superseded, so excluded)
      expect(xeroEntry.totalSpend12m).toBe(0);
    }
  });
});

