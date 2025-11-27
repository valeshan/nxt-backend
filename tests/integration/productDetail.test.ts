import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';

describe('Product Detail Integration', () => {
  const orgId = 'test-org-id-detail';
  const locationId = 'test-loc-id-detail';
  const supplierId = 'supplier-detail';
  let productId: string;

  beforeAll(async () => {
    await resetDb(); // Use shared resetDb logic that handles FK order

    await prisma.organisation.create({
      data: {
        id: orgId,
        name: 'Detail Test Org',
        locations: { create: { id: locationId, name: 'Main' } },
        suppliers: {
            create: { id: supplierId, name: 'Detail Supplier', normalizedName: 'detail supplier', sourceType: 'MANUAL' }
        }
      }
    });

    const product = await prisma.product.create({
        data: {
            organisationId: orgId,
            locationId,
            productKey: 'test-product',
            name: 'Test Product Detail',
            supplierId
        }
    });
    productId = product.id;

    // Add some history
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 15);

    await prisma.xeroInvoice.create({
        data: {
            organisationId: orgId,
            xeroInvoiceId: 'inv-d-1',
            status: 'AUTHORISED',
            date: lastMonth,
            supplierId,
            lineItems: {
                create: {
                    productId,
                    description: 'Test Product Detail',
                    quantity: 10,
                    unitAmount: 100,
                    lineAmount: 1000,
                    accountCode: 'EXP'
                }
            }
        }
    });

    await prisma.xeroInvoice.create({
        data: {
            organisationId: orgId,
            xeroInvoiceId: 'inv-d-2',
            status: 'AUTHORISED',
            date: twoMonthsAgo,
            supplierId,
            lineItems: {
                create: {
                    productId,
                    description: 'Test Product Detail',
                    quantity: 5,
                    unitAmount: 90,
                    lineAmount: 450,
                    accountCode: 'EXP'
                }
            }
        }
    });
  });

  afterAll(async () => {
    await teardown();
  });

  it('returns product details with correct stats', async () => {
    const detail = await supplierInsightsService.getProductDetail(orgId, productId);
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.productName).toBe('Test Product Detail');
    expect(detail.supplierName).toBe('Detail Supplier');
    
    // Stats
    // Total Spend: 1000 + 450 = 1450
    expect(detail.stats12m.totalSpend12m).toBe(1450);
    expect(detail.stats12m.quantityPurchased12m).toBe(15);
    
    // Price History: 2 entries
    expect(detail.priceHistory.length).toBe(2);
    // Order by month asc
    expect(detail.priceHistory[0].averageUnitPrice).toBe(90);
    expect(detail.priceHistory[1].averageUnitPrice).toBe(100);
  });

  it('returns null/404 for invalid product ID', async () => {
    // Assuming UUID format is required by Prisma findUnique, otherwise it throws? 
    // findUnique returns null if not found.
    const detail = await supplierInsightsService.getProductDetail(orgId, '00000000-0000-0000-0000-000000000000');
    expect(detail).toBeNull();
  });

  it('returns null if product belongs to another org', async () => {
    const detail = await supplierInsightsService.getProductDetail('other-org', productId);
    expect(detail).toBeNull();
  });
});
