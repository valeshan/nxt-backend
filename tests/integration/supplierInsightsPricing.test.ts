import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';

describe('Supplier Insights Pricing Logic', () => {
  const orgId = 'pricing-org-id';
  const locationId = 'pricing-loc-id';
  const supplierId = 'pricing-supplier-id';

  // Helpers
  const createProduct = async (key: string, name: string) => {
    return prisma.product.create({
      data: {
        organisationId: orgId,
        locationId,
        productKey: key,
        name,
        supplierId
      }
    });
  };

  const createInvoiceItem = async (
    prodId: string, 
    date: Date, 
    qty: number, 
    unitAmount: number, 
    taxAmount: number = 0,
    invoiceTotalOverride?: number
  ) => {
    const lineAmount = qty * unitAmount;
    // If invoiceTotalOverride is not provided, assume it matches lineAmount (simple case)
    // If provided, it simulates GST inclusive total or other noise
    const total = invoiceTotalOverride ?? lineAmount;

    await prisma.xeroInvoice.create({
      data: {
        organisationId: orgId,
        xeroInvoiceId: `inv-${Math.random()}`,
        status: 'AUTHORISED',
        date: date,
        total: total, 
        lineItems: {
          create: {
            productId: prodId,
            description: 'Test Item',
            quantity: qty,
            unitAmount: unitAmount,
            lineAmount: lineAmount,
            taxAmount: taxAmount
          }
        }
      }
    });
  };

  beforeAll(async () => {
    await resetDb();
    
    await prisma.organisation.create({
      data: {
        id: orgId,
        name: 'Pricing Test Org',
        locations: { create: { id: locationId, name: 'Loc 1' } },
        suppliers: { create: { id: supplierId, name: 'Test Supplier', normalizedName: 'test supplier', sourceType: 'MANUAL' } }
      }
    });
  });

  afterAll(async () => {
    await teardown();
  });

  it('Test 1: Stable price - unit cost should be stable and change 0%', async () => {
    const product = await createProduct('stable-prod', 'Stable Product');
    
    // 3 months of stable pricing ($35.75)
    const today = new Date();
    const m1 = new Date(today.getFullYear(), today.getMonth(), 15); // This month
    const m2 = new Date(today.getFullYear(), today.getMonth() - 1, 15); // Last month
    const m3 = new Date(today.getFullYear(), today.getMonth() - 2, 15); // 2 months ago

    await createInvoiceItem(product.id, m3, 1, 35.75);
    await createInvoiceItem(product.id, m2, 1, 35.75);
    await createInvoiceItem(product.id, m1, 1, 35.75);

    const list = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 10, search: 'Stable' });
    const item = list.items[0];

    expect(item.latestUnitCost).toBeCloseTo(35.75);
    expect(item.lastPriceChangePercent).toBeCloseTo(0);

    const detail = await supplierInsightsService.getProductDetail(orgId, product.id);
    // Check the last point in history
    const lastPoint = detail?.priceHistory[detail.priceHistory.length - 1];
    expect(lastPoint?.averageUnitPrice).toBeCloseTo(35.75);
  });

  it('Test 2: GST-inclusive invoice total should not affect result', async () => {
    const product = await createProduct('gst-prod', 'GST Product');
    
    const today = new Date();
    // Invoice Total is $39.33 (Tax Inclusive), but unit price is $35.75
    await createInvoiceItem(product.id, today, 1, 35.75, 3.58, 39.33);
    
    // Previous month
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
    await createInvoiceItem(product.id, lastMonth, 1, 35.75, 3.58, 39.33);

    const list = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 10, search: 'GST' });
    const item = list.items[0];

    // Should be 35.75, NOT 39.33
    expect(item.latestUnitCost).toBeCloseTo(35.75);
    expect(item.lastPriceChangePercent).toBeCloseTo(0);
  });

  it('Test 3: Genuine price increase', async () => {
    const product = await createProduct('increase-prod', 'Increasing Product');
    
    const today = new Date();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

    // Month 1: $35.75
    await createInvoiceItem(product.id, lastMonth, 10, 35.75);
    // Month 2: $54.13
    await createInvoiceItem(product.id, today, 10, 54.13);

    const list = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 10, search: 'Increasing' });
    const item = list.items[0];

    const expectedChange = ((54.13 - 35.75) / 35.75) * 100; // ~51.4%

    expect(item.latestUnitCost).toBeCloseTo(54.13);
    expect(item.lastPriceChangePercent).toBeCloseTo(expectedChange);
  });

  it('Test 4: Zero or missing quantities are ignored', async () => {
    const product = await createProduct('zero-qty-prod', 'Zero Qty Product');
    
    const today = new Date();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

    // Last Month: Valid price $10
    await createInvoiceItem(product.id, lastMonth, 5, 10.00);
    
    // This Month: Quantity 0 (e.g. voided line or error), Price technically 0 or irrelevant
    await createInvoiceItem(product.id, today, 0, 0); 

    // The system should ignore the zero-qty month for "latest unit cost" if it has no valid data,
    // OR if it considers it invalid, it might fall back to previous?
    // Based on requirements: "If quantity is null or <= 0, skip that line item"
    // So the "Latest Cost" should effectively be the last valid month ($10) OR 
    // if the current month is empty, it might show $0.
    // Let's assume we want the *latest valid price*.
    
    const list = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 10, search: 'Zero' });
    const item = list.items[0];

    // If logic is "latest month with data", it should find the last month with qty > 0
    expect(item.latestUnitCost).toBeCloseTo(10.00);
  });

  it('Test 5: Weighted average within the month', async () => {
    const product = await createProduct('weighted-prod', 'Weighted Product');
    const today = new Date();
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
    
    // Invoice 1: 10 items @ $10 = $100
    await createInvoiceItem(product.id, lastMonth, 10, 10.00);
    
    // Invoice 2: 10 items @ $20 = $200 (Same month)
    await createInvoiceItem(product.id, lastMonth, 10, 20.00);

    // Total Qty = 20, Total Amount = 300. Avg = 15.00.
    // Current implementation picks one (likely the last inserted or sorted by date).
    
    const list = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 10, search: 'Weighted' });
    const item = list.items[0];

    expect(item.latestUnitCost).toBeCloseTo(15.00);
  });

  it('Test 6: Product Detail Smoothed Trend Logic', async () => {
    const product = await createProduct('trend-prod', 'Trend Product');
    const today = new Date();
    
    // Seed 6 months of data
    // M1: 10
    // M2: 10
    // M3: 10 (Avg Prev = 10)
    // M4: 12
    // M5: 12
    // M6: 12 (Avg Latest = 12)
    // Expect (12-10)/10 = +20%
    
    for(let i=5; i>=0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 15);
        const price = i >= 3 ? 10 : 12;
        await createInvoiceItem(product.id, d, 10, price);
    }

    const detail = await supplierInsightsService.getProductDetail(orgId, product.id);
    expect(detail).toBeDefined();
    expect(detail?.canCalculateProductPriceTrend).toBe(true);
    expect(detail?.productPriceTrendPercent).toBeCloseTo(20.0);
    expect(detail?.unitPriceHistory.length).toBeGreaterThanOrEqual(6);
  });

  it('Test 7: Product Detail Insufficient Data for Trend', async () => {
    const product = await createProduct('short-prod', 'Short History Product');
    const today = new Date();
    
    // Seed only 2 months
    await createInvoiceItem(product.id, new Date(today.getFullYear(), today.getMonth() - 1, 15), 10, 10);
    await createInvoiceItem(product.id, today, 10, 12);

    const detail = await supplierInsightsService.getProductDetail(orgId, product.id);
    expect(detail).toBeDefined();
    expect(detail?.canCalculateProductPriceTrend).toBe(false);
    expect(detail?.productPriceTrendPercent).toBe(0);
  });
});
