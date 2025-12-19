import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
        locationId: locationId,
        supplierId: supplierId,
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

  const createManualInvoiceItem = async (
    prodKey: string, 
    date: Date, 
    qty: number, 
    unitPrice: number
  ) => {
    // Ensure product exists so manual lines can map productKey -> productId
    // (supplierInsightsService maps manual line items via productKey derived from (productCode, description))
    await prisma.product.upsert({
      where: {
        organisationId_locationId_productKey: {
          organisationId: orgId,
          locationId,
          productKey: prodKey,
        },
      },
      update: {},
      create: {
        organisationId: orgId,
        locationId,
        productKey: prodKey,
        name: `Manual Product ${prodKey}`,
        supplierId,
      },
    });

    // Create InvoiceFile (required for manual lines)
    const file = await prisma.invoiceFile.create({
        data: {
            organisationId: orgId,
            locationId: locationId,
            sourceType: 'UPLOAD',
            storageKey: `invoices/test/${Math.random()}.pdf`,
            fileName: 'test.pdf',
            mimeType: 'application/pdf',
            processingStatus: 'OCR_COMPLETE',
            reviewStatus: 'VERIFIED'
        }
    });

    const invoice = await prisma.invoice.create({
        data: {
            organisationId: orgId,
            locationId: locationId,
            supplierId: supplierId,
            invoiceFileId: file.id,
            sourceType: 'UPLOAD',
            date: date,
            isVerified: true,
            total: qty * unitPrice,
        }
    });

    await prisma.invoiceLineItem.create({
        data: {
            invoiceId: invoice.id,
            description: `Manual Item ${prodKey}`,
            productCode: prodKey,
            quantity: qty,
            unitPrice: unitPrice,
            lineTotal: qty * unitPrice
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
    
    // Create a user for uploadedByUserId constraint if needed
    // Assuming user table is not strictly FK linked for this test or handled by resetDb
  }, 30000);

  afterAll(async () => {
    await teardown();
  });

  // Keep org/location/supplier, but isolate pricing tests from each other.
  // This prevents:
  // - getRecentPriceChanges() default limit (5) from dropping later-test products
  // - unique constraint collisions on (organisationId, locationId, productKey)
  beforeEach(async () => {
    await prisma.xeroInvoiceLineItem.deleteMany();
    await prisma.invoiceLineItem.deleteMany();
    await prisma.xeroInvoice.deleteMany();
    await prisma.invoiceOcrResult.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.invoiceFile.deleteMany();
    await prisma.product.deleteMany();
  });

  it('Test 1: Stable price - unit cost should be stable and change 0%', async () => {
    const product = await createProduct('stable-prod', 'Stable Product');
    
    // 3 months of stable pricing ($35.75)
    const today = new Date();
    const m1 = today; // Use today to ensure it's within the "lte: now" window
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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

  // ========== getRecentPriceChanges Tests ==========
  
  describe('getRecentPriceChanges', () => {
    it('should detect price change with 2 invoices from same supplier', async () => {
      const product = await createProduct('price-change-prod', 'Price Change Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Older invoice: $10.00
      await createInvoiceItem(product.id, lastMonth, 1, 10.00);
      // Recent invoice: $12.00 (20% increase)
      await createInvoiceItem(product.id, today, 1, 12.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      expect(changes.length).toBeGreaterThan(0);
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      expect(change?.latestUnitPrice).toBeCloseTo(12.00);
      expect(change?.percentChange).toBeCloseTo(20.0); // (12-10)/10 * 100
      expect(change?.productName).toBe('Price Change Product');
      expect(change?.supplierName).toBe('Test Supplier');
    }, 15000);

    it('should correctly sort invoices by date when created out of order', async () => {
      const product = await createProduct('out-of-order-prod', 'Out of Order Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
      const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 15);

      // Create invoices out of chronological order
      await createInvoiceItem(product.id, today, 1, 15.00); // Most recent
      await createInvoiceItem(product.id, twoMonthsAgo, 1, 10.00); // Oldest
      await createInvoiceItem(product.id, lastMonth, 1, 12.00); // Middle

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      // Should compare latest ($15) with most recent different price ($12), not oldest ($10)
      expect(change?.latestUnitPrice).toBeCloseTo(15.00);
      expect(change?.percentChange).toBeCloseTo(25.0); // (15-12)/12 * 100 = 25%
    }, 15000);

    it('should require at least 2 invoices to detect a change', async () => {
      const product = await createProduct('single-invoice-prod', 'Single Invoice Product');
      const today = new Date();

      // Only one invoice
      await createInvoiceItem(product.id, today, 1, 10.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeUndefined(); // Should not appear since only 1 invoice
    }, 15000);

    it('should find most recent different price when multiple invoices have same price', async () => {
      const product = await createProduct('same-price-prod', 'Same Price Product');
      const today = new Date();
      const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
      const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 15);

      // Oldest: $10.00
      await createInvoiceItem(product.id, twoMonthsAgo, 1, 10.00);
      // Last month: $12.00 (first change)
      await createInvoiceItem(product.id, lastMonth, 1, 12.00);
      // Last week: $12.00 (same as last month)
      await createInvoiceItem(product.id, lastWeek, 1, 12.00);
      // Today: $15.00 (new change)
      await createInvoiceItem(product.id, today, 1, 15.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      // Should compare $15 (latest) with $12 (most recent different price), not $10
      expect(change?.latestUnitPrice).toBeCloseTo(15.00);
      expect(change?.percentChange).toBeCloseTo(25.0); // (15-12)/12 * 100 = 25%
    }, 15000);

    it('should filter out price changes less than 0.5%', async () => {
      const product = await createProduct('tiny-change-prod', 'Tiny Change Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Last month: $10.00
      await createInvoiceItem(product.id, lastMonth, 1, 10.00);
      // Today: $10.03 (0.3% increase - below 0.5% threshold)
      await createInvoiceItem(product.id, today, 1, 10.03);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeUndefined(); // Should be filtered out
    }, 15000);

    it('should include price changes greater than 0.5%', async () => {
      const product = await createProduct('small-change-prod', 'Small Change Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Last month: $10.00
      await createInvoiceItem(product.id, lastMonth, 1, 10.00);
      // Today: $10.06 (0.6% increase - above 0.5% threshold)
      await createInvoiceItem(product.id, today, 1, 10.06);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      expect(change?.percentChange).toBeCloseTo(0.6); // (10.06-10)/10 * 100 = 0.6%
    }, 15000);

    it('should handle price decreases correctly', async () => {
      const product = await createProduct('decrease-prod', 'Decrease Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Last month: $12.00
      await createInvoiceItem(product.id, lastMonth, 1, 12.00);
      // Today: $10.00 (16.67% decrease)
      await createInvoiceItem(product.id, today, 1, 10.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      expect(change?.latestUnitPrice).toBeCloseTo(10.00);
      expect(change?.percentChange).toBeCloseTo(-16.67, 1); // (10-12)/12 * 100 = -16.67%
    }, 15000);

    it('should return multiple products sorted by absolute percent change', async () => {
      const product1 = await createProduct('small-change-prod', 'Small Change Product');
      const product2 = await createProduct('large-change-prod', 'Large Change Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Product 1: 5% increase
      await createInvoiceItem(product1.id, lastMonth, 1, 10.00);
      await createInvoiceItem(product1.id, today, 1, 10.50);

      // Product 2: 20% increase (should appear first)
      await createInvoiceItem(product2.id, lastMonth, 1, 10.00);
      await createInvoiceItem(product2.id, today, 1, 12.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId, undefined, 10);
      
      expect(changes.length).toBeGreaterThanOrEqual(2);
      // Should be sorted by absolute percent change descending
      const product2Change = changes.find(c => c.productId === product2.id);
      const product1Change = changes.find(c => c.productId === product1.id);
      
      expect(product2Change).toBeDefined();
      expect(product1Change).toBeDefined();
      
      // Product 2 (20%) should appear before Product 1 (5%)
      const product2Index = changes.findIndex(c => c.productId === product2.id);
      const product1Index = changes.findIndex(c => c.productId === product1.id);
      expect(product2Index).toBeLessThan(product1Index);
    }, 15000);

    it('should not show changes when prices are identical', async () => {
      const product = await createProduct('no-change-prod', 'No Change Product');
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Both invoices have same price
      await createInvoiceItem(product.id, lastMonth, 1, 10.00);
      await createInvoiceItem(product.id, today, 1, 10.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeUndefined(); // Should not appear since no price change
    }, 15000);

    it('should respect the limit parameter', async () => {
      // Create multiple products with different price changes
      const products = [];
      for (let i = 0; i < 10; i++) {
        const product = await createProduct(`limit-prod-${i}`, `Limit Product ${i}`);
        products.push(product);
        const today = new Date();
        const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
        
        await createInvoiceItem(product.id, lastMonth, 1, 10.00);
        await createInvoiceItem(product.id, today, 1, 10.00 + i); // Different prices
      }

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId, undefined, 5);
      
      expect(changes.length).toBeLessThanOrEqual(5);
    }, 20000);

    it('should only show price changes within the last 3 months', async () => {
      const product = await createProduct('old-change-prod', 'Old Change Product');
      const today = new Date();
      const fourMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 4, 15);
      const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, 1);
      const twoMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 15);
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // Invoice from 4 months ago (outside 3-month window): $10.00
      await createInvoiceItem(product.id, fourMonthsAgo, 1, 10.00);
      
      // Invoice from 3 months ago (just inside window): $12.00
      await createInvoiceItem(product.id, threeMonthsAgo, 1, 12.00);
      
      // Invoice from 2 months ago: $12.00 (same price)
      await createInvoiceItem(product.id, twoMonthsAgo, 1, 12.00);
      
      // Invoice from last month: $15.00 (price change)
      await createInvoiceItem(product.id, lastMonth, 1, 15.00);

      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      // Should compare $15 (last month) with $12 (3 months ago), NOT with $10 (4 months ago)
      expect(change?.latestUnitPrice).toBeCloseTo(15.00);
      expect(change?.percentChange).toBeCloseTo(25.0); // (15-12)/12 * 100 = 25%
      // Should NOT be comparing against the $10 from 4 months ago (which would be 50% change)
    }, 15000);

    it('should not show price changes if the previous price is outside 3-month window', async () => {
      const product = await createProduct('outside-window-prod', 'Outside Window Product');
      const today = new Date();
      const fourMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 4, 15);

      // Only invoice from 4 months ago (outside 3-month window): $10.00
      await createInvoiceItem(product.id, fourMonthsAgo, 1, 10.00);
      
      // No invoices within the last 3 months
      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeUndefined(); // Should not appear since no invoices in last 3 months
    }, 15000);

    it('should detect price changes from MANUAL invoices', async () => {
      // 1. Create Product (so we have a matching key)
      const product = await createProduct('manual-prod-key', 'Manual Product');
      
      const today = new Date();
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);

      // 2. Create Manual Invoices
      // Old: $10.00
      await createManualInvoiceItem('manual-prod-key', lastMonth, 1, 10.00);
      // New: $12.00
      await createManualInvoiceItem('manual-prod-key', today, 1, 12.00);

      // 3. Enable manual data (accountCodes=['MANUAL_COGS'])
      // Or if we pass [] or undefined, it depends on shouldIncludeManualData implementation.
      // shouldIncludeManualData returns true if accountCodes is undefined/empty or contains MANUAL_COGS_ACCOUNT_CODE.
      // Let's pass undefined to be safe/default.
      
      const changes = await supplierInsightsService.getRecentPriceChanges(orgId, locationId);
      
      const change = changes.find(c => c.productId === product.id);
      expect(change).toBeDefined();
      expect(change?.latestUnitPrice).toBeCloseTo(12.00);
      expect(change?.percentChange).toBeCloseTo(20.0);
      expect(change?.productName).toBe('Manual Product');
    }, 15000);
  });
});
