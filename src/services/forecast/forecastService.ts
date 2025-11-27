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
    locationId?: string
  ): Promise<ForecastResult> {
    // 1. Define Time Window: Last 6 full calendar months
    // E.g. if now is Nov 27, 6 months ago is May. Start of May? 
    // "last 6 full calendar months from now" usually implies "start of month 6 months ago".
    const now = new Date();
    const startDate = startOfMonth(subMonths(now, 6));

    // 2. Fetch Invoices
    // Filter by Organisation
    // If locationId is provided, we might need to filter by linked suppliers or if invoices have location?
    // The Prisma schema shows XeroInvoice has organisationId. 
    // Supplier has location? No, Supplier has organisationId. 
    // Location filtering might be tricky if invoices don't have location directly.
    // Looking at schema: XeroInvoice doesn't have locationId.
    // However, SupplierInsightsService usually ignores locationId or tries to filter.
    // For v1, if location filtering is not straightforward in the schema (e.g. via XeroLocationLink or similar), 
    // we might just scope to Organisation or check if Supplier is linked to location?
    // The schema shows Product has locationId. Supplier does not.
    // Let's stick to Organisation scope for now as per usual Xero integration patterns unless specified.
    // The plan says: "Query invoices filtered by organisationId and (if applicable) locationId / linked suppliers for that location."
    // Since I don't see a direct link on Invoice, I will just use organisationId for now to be safe, 
    // or if there is a known pattern (like filtering suppliers that "belong" to a location), I'd use that.
    // But Supplier model only has organisationId. 
    // I'll proceed with organisationId only for v1 robustness.

    const xeroInvoices = await prisma.xeroInvoice.findMany({
      where: {
        organisationId,
        status: { in: ['AUTHORISED', 'PAID'] },
        date: { gte: startDate }
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
        // We might want category (Account Code). 
        // Invoices have lineItems. We can take the primary account code from the first line item?
        // Or if we need category for the "Category Rule" (rent, utilities, etc).
        lineItems: {
          take: 1,
          select: {
            accountCode: true,
            description: true // sometimes category keywords are in description
          }
        }
      }
    });

    // 3. Map to Engine Interface
    const invoices: Invoice[] = xeroInvoices.map(inv => {
      const primaryLine = inv.lineItems[0];
      
      return {
        id: inv.id,
        supplierId: inv.supplierId || 'unknown',
        supplierName: inv.supplier?.name || 'Unknown Supplier',
        issueDate: inv.date || new Date(), // Should not happen if queried well, but safe fallback
        dueDate: inv.dueDate || inv.date || new Date(),
        totalAmount: inv.total ? inv.total.toNumber() : 0,
        categoryCode: primaryLine?.accountCode,
        categoryName: primaryLine?.description // Using description as proxy for category name if account name not available
      };
    }).filter(i => i.totalAmount > 0); // Filter out zero/negative if any (credit notes are usually different type or negative)

    // 4. Future Bills (v1: empty)
    const futureBills: any[] = [];

    // 5. Overrides (v1: empty)
    const overrides: any[] = [];

    // 6. Generate Forecast
    return generateForecast(invoices, futureBills, overrides);
  }
};

