import prisma from '../../infrastructure/prismaClient';
import { generateForecast, Invoice, ForecastResult } from './forecastEngine';
import { subMonths, startOfMonth } from 'date-fns';

export const forecastService = {
  /**
   * Generates a spend forecast for the next 30 days for a given organisation and location.
   * Aggregates invoices from the last 6 full months.
   */
  async getForecastForOrgAndLocation(
    organisationId: string, 
    locationId?: string,
    accountCodes?: string[]
  ): Promise<ForecastResult> {
    // 1. Define Time Window: Last 6 full calendar months
    const now = new Date();
    const startDate = startOfMonth(subMonths(now, 6));

    // 2. Fetch Invoices
    // If accountCodes present, we need to sum only matching line items.
    const isFiltering = accountCodes && accountCodes.length > 0;

    const xeroInvoices = await prisma.xeroInvoice.findMany({
      where: {
        organisationId,
        ...(locationId ? { locationId } : {}),
        status: { in: ['AUTHORISED', 'PAID'] },
        date: { gte: startDate },
        ...(isFiltering ? {
            lineItems: { some: { accountCode: { in: accountCodes } } }
        } : {})
      },
      select: {
        id: true,
        supplierId: true,
        supplier: {
          select: {
            name: true
          }
        },
        date: true,
        dueDate: true,
        total: true,
        lineItems: {
          where: isFiltering ? { accountCode: { in: accountCodes } } : undefined,
          take: isFiltering ? undefined : 1, // If not filtering, just take 1 for category info
          select: {
            accountCode: true,
            description: true,
            lineAmount: true 
          }
        }
      }
    });

    // 3. Map to Engine Interface
    const invoices: Invoice[] = xeroInvoices.map(inv => {
      const primaryLine = inv.lineItems[0];
      
      let totalAmount = 0;
      if (isFiltering) {
          // Sum matching lines
          totalAmount = inv.lineItems.reduce((sum, li) => sum + (Number(li.lineAmount) || 0), 0);
      } else {
          // Use invoice total
          totalAmount = inv.total ? inv.total.toNumber() : 0;
      }
      
      return {
        id: inv.id,
        supplierId: inv.supplierId || 'unknown',
        supplierName: inv.supplier?.name || 'Unknown Supplier',
        issueDate: inv.date || new Date(),
        dueDate: inv.dueDate || inv.date || new Date(),
        totalAmount,
        categoryCode: primaryLine?.accountCode,
        categoryName: primaryLine?.description
      };
    }).filter(i => i.totalAmount > 0);

    // 4. Future Bills (v1: empty)
    const futureBills: any[] = [];

    // 5. Overrides (v1: empty)
    const overrides: any[] = [];

    // 6. Generate Forecast
    return generateForecast(invoices, futureBills, overrides);
  }
};


