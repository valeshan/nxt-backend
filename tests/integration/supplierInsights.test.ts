import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';
import { getProductKeyFromLineItem } from '../../src/services/helpers/productKey';

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
});
