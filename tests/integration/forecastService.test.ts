import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { forecastService } from '../../src/services/forecast/forecastService';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb, teardown } from './testApp';
import { subMonths } from 'date-fns';

describe('Forecast Service Integration', () => {
  const orgId = 'forecast-org-id';
  const supplierId = 'forecast-supplier-id';

  beforeAll(async () => {
    await resetDb();
    await prisma.organisation.create({
      data: {
        id: orgId,
        name: 'Forecast Org',
        suppliers: { 
            create: { 
                id: supplierId, 
                name: 'Forecast Supplier', 
                normalizedName: 'forecast supplier', 
                sourceType: 'MANUAL' 
            } 
        }
      }
    });
  }, 30000);

  afterAll(async () => {
    await teardown();
  });

  it('should generate a forecast based on seeded invoices', async () => {
    // Seed invoices
    // 4 recurring invoices for "Forecast Supplier" (Rent/Subscription style)
    const dates = [
        subMonths(new Date(), 1),
        subMonths(new Date(), 2),
        subMonths(new Date(), 3),
        subMonths(new Date(), 4),
    ];

    for (const date of dates) {
        await prisma.xeroInvoice.create({
            data: {
                organisationId: orgId,
                xeroInvoiceId: `inv-${date.getTime()}`,
                supplierId: supplierId,
                date: date,
                dueDate: date,
                status: 'AUTHORISED',
                total: 100.00,
                lineItems: {
                    create: {
                        description: 'Monthly Service',
                        quantity: 1,
                        unitAmount: 100.00,
                        lineAmount: 100.00,
                        accountCode: '400' // Rent/Service
                    }
                }
            }
        });
    }

    const result = await forecastService.getForecastForOrgAndLocation(orgId);

    // Expect 100 fixed (avg of 100s)
    expect(result.forecast30DaysFixed).toBeCloseTo(100.00);
    expect(result.recurringFeatures.length).toBeGreaterThan(0);
    
    const feature = result.recurringFeatures.find(f => f.supplierId === supplierId);
    expect(feature).toBeDefined();
    expect(feature?.isRecurring).toBe(true);
  }, 15000);
});





