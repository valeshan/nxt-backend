import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';
import { subMonths } from 'date-fns';

describe('Supplier Insights - Get Products Supplier Resolution', () => {
  const orgId = 'resolution-org-id';
  const locationId = 'resolution-loc-id';

  beforeAll(async () => {
    await resetDb();
    
    await prisma.organisation.create({
      data: {
        id: orgId,
        name: 'Resolution Org',
        locations: { create: { id: locationId, name: 'Loc 1' } }
      }
    });
  }, 30000);

  afterAll(async () => {
    await teardown();
  });

  it('should resolve unknown supplier name from invoice history', async () => {
    const supplier = await prisma.supplier.create({
      data: {
        organisationId: orgId,
        name: 'History Supplier',
        normalizedName: 'history supplier',
        sourceType: 'MANUAL'
      }
    });

    const product = await prisma.product.create({
      data: {
        organisationId: orgId,
        locationId,
        productKey: 'unknown-supplier-prod',
        name: 'Orphan Product',
      }
    });

    // Use a date in the past month to ensure it falls within the "last 12 FULL months" window
    // getFullCalendarMonths excludes current month.
    const pastDate = subMonths(new Date(), 1); 
    
    await prisma.xeroInvoice.create({
      data: {
        organisationId: orgId,
        xeroInvoiceId: `inv-${Math.random()}`,
        status: 'AUTHORISED',
        date: pastDate,
        total: 100,
        supplierId: supplier.id,
        lineItems: {
          create: {
            productId: product.id,
            description: 'Test Item',
            quantity: 1,
            unitAmount: 100,
            lineAmount: 100
          }
        }
      }
    });

    const result = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 100 });
    
    const item = result.items.find(i => i.productId === product.id);
    
    expect(item).toBeDefined();
    expect(item?.productName).toBe('Orphan Product');
    expect(item?.supplierName).toBe('History Supplier');
  }, 15000);

  it('should leave supplier as Unknown if no history exists', async () => {
    const product = await prisma.product.create({
      data: {
        organisationId: orgId,
        locationId,
        productKey: 'truly-unknown-prod',
        name: 'Mystery Product',
      }
    });
    
    const pastDate = subMonths(new Date(), 1);

    await prisma.xeroInvoice.create({
        data: {
          organisationId: orgId,
          xeroInvoiceId: `inv-mystery-${Math.random()}`,
          status: 'AUTHORISED',
          date: pastDate,
          total: 50,
          lineItems: {
            create: {
              productId: product.id,
              description: 'Mystery Item',
              quantity: 1,
              unitAmount: 50,
              lineAmount: 50
            }
          }
        }
      });

    const result = await supplierInsightsService.getProducts(orgId, undefined, { page: 1, pageSize: 100 });
    const item = result.items.find(i => i.productId === product.id);
    
    expect(item).toBeDefined();
    expect(item?.supplierName).toBe('Unknown');
  }, 15000);
});
