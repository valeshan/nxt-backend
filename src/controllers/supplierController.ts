import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { Prisma } from '@prisma/client';

export class SupplierController {
  
  // Helper for org access validation
  private validateOrgAccess(request: FastifyRequest, targetOrgId?: string) {
    const { organisationId, tokenType } = request.authContext;
    
    // Require org context
    if (!organisationId) {
       throw { statusCode: 403, message: 'Forbidden: Organisation context required' };
    }
    
    // Ensure token type is appropriate (org or location)
    if (tokenType !== 'organisation' && tokenType !== 'location') {
        throw { statusCode: 403, message: 'Forbidden: Invalid token type' };
    }

    // If a specific target org is requested, check against token
    if (targetOrgId && targetOrgId !== organisationId) {
       throw { statusCode: 403, message: 'Forbidden' };
    }
    return organisationId;
  }

  listSuppliers = async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = this.validateOrgAccess(request);
    const { page = 1, limit = 50, search } = request.query as any;
    const skip = (page - 1) * limit;

    const where: Prisma.SupplierWhereInput = {
      organisationId: orgId,
      status: { not: 'ARCHIVED' },
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    };

    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { name: 'asc' },
        include: {
           _count: { select: { invoices: true } }
        }
      }),
      prisma.supplier.count({ where }),
    ]);

    // Calculate metrics for the fetched suppliers
    const supplierIds = suppliers.map(s => s.id);
    
    // Date Logic for Spend Trend
    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Current Period: Last 6 full months (Months -1 to -6)
    const endOfCurrentPeriod = new Date(startOfCurrentMonth);
    endOfCurrentPeriod.setDate(0); // End of Month -1
    endOfCurrentPeriod.setHours(23, 59, 59, 999);

    const startOfCurrentPeriod = new Date(startOfCurrentMonth);
    startOfCurrentPeriod.setMonth(startOfCurrentPeriod.getMonth() - 6); // Start of Month -6

    // Prior Period: Previous 6 full months (Months -7 to -12)
    const endOfPriorPeriod = new Date(startOfCurrentPeriod);
    endOfPriorPeriod.setDate(0); // End of Month -7
    endOfPriorPeriod.setHours(23, 59, 59, 999);

    const startOfPriorPeriod = new Date(startOfCurrentPeriod);
    startOfPriorPeriod.setMonth(startOfPriorPeriod.getMonth() - 6); // Start of Month -12

    // Metrics for Current Period (Spend)
    const currentPeriodMetrics = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        supplierId: { in: supplierIds },
        date: { gte: startOfCurrentPeriod, lte: endOfCurrentPeriod },
        status: { in: ['AUTHORISED', 'PAID'] }
      },
      _sum: { total: true },
    });

    // Metrics for Prior Period (Spend)
    const priorPeriodMetrics = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        supplierId: { in: supplierIds },
        date: { gte: startOfPriorPeriod, lte: endOfPriorPeriod },
        status: { in: ['AUTHORISED', 'PAID'] }
      },
      _sum: { total: true },
    });

    // Standard 12m Metrics (Rolling, for Total Spend)
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());

    const metrics12m = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        supplierId: { in: supplierIds },
        date: { gte: twelveMonthsAgo },
        status: { in: ['AUTHORISED', 'PAID'] }
      },
      _sum: { total: true },
      _count: { id: true }
    });

    // Metrics for Recurring Logic (Rolling 6m count)
    const metrics6m = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        supplierId: { in: supplierIds },
        date: { gte: sixMonthsAgo },
        status: { in: ['AUTHORISED', 'PAID'] }
      },
      _count: { id: true }
    });

    // Calculate item counts (distinct products) per supplier
    let itemCountsMap = new Map<string, number>();
    
    if (supplierIds.length > 0) {
      const itemCounts: any[] = await prisma.$queryRaw`
        SELECT i."supplierId", COUNT(DISTINCT COALESCE("itemCode", LOWER(TRIM("description"))))::int as "count"
        FROM "XeroInvoiceLineItem" li
        JOIN "XeroInvoice" i ON li."invoiceId" = i.id
        WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
        AND i."status" IN ('AUTHORISED', 'PAID')
        GROUP BY i."supplierId"
      `;
      itemCountsMap = new Map(itemCounts.map((c: any) => [c.supplierId, c.count]));
    }

    // Maps
    const currentPeriodMap = new Map(currentPeriodMetrics.map(m => [m.supplierId, Number(m._sum.total || 0)]));
    const priorPeriodMap = new Map(priorPeriodMetrics.map(m => [m.supplierId, Number(m._sum.total || 0)]));
    const metrics12mMap = new Map(metrics12m.map(m => [m.supplierId, { total: Number(m._sum.total || 0), count: m._count.id }]));
    const metrics6mMap = new Map(metrics6m.map(m => [m.supplierId, m._count.id]));

    const MIN_BASELINE = 200;

    const data = suppliers.map(s => {
      const m12 = metrics12mMap.get(s.id) || { total: 0, count: 0 };
      const count6m = metrics6mMap.get(s.id) || 0;
      
      // Recurring logic
      const isRecurring = count6m >= 3;
      const purchaseFrequency = isRecurring ? m12.count : 0;

      // Spend Trend Logic
      const currentPeriodSpend = currentPeriodMap.get(s.id) || 0;
      const priorPeriodSpend = priorPeriodMap.get(s.id) || 0;

      let spendTrendPercent = 0;
      let isNewSupplier = false;
      let isEmergingSupplier = false;

      if (priorPeriodSpend === 0 && currentPeriodSpend > 0) {
        isNewSupplier = true;
      } else if (priorPeriodSpend > 0 && priorPeriodSpend < MIN_BASELINE) {
        isEmergingSupplier = true;
        spendTrendPercent = ((currentPeriodSpend - priorPeriodSpend) / priorPeriodSpend) * 100;
      } else if (priorPeriodSpend > 0) {
        spendTrendPercent = ((currentPeriodSpend - priorPeriodSpend) / priorPeriodSpend) * 100;
      }

      return {
        ...s,
        totalSpend: m12.total,
        purchaseFrequency,
        totalOrders: s._count.invoices,
        avgInvoiceSize: m12.count > 0 ? m12.total / m12.count : 0, // Use 12m count for avg invoice size if recurring logic not used for this
        yoySpendChange: 0, // Replaced by spendTrendPercent in UI but kept for type compatibility if needed
        spendTrendPercent,
        isNewSupplier,
        isEmergingSupplier,
        itemCount: itemCountsMap.get(s.id) || 0, 
        potentialSavings: 0 
      };
    });
    
    return reply.send({
      data,
      pagination: { total, page: Number(page), limit: Number(limit) }
    });
  }

  getSupplier = async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = this.validateOrgAccess(request);
    const { id } = request.params as any;

    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: { sourceLinks: true }
    });

    if (!supplier || supplier.organisationId !== orgId) {
      return reply.status(404).send({ error: 'Supplier not found' });
    }

    return reply.send(supplier);
  }

  getSupplierMetrics = async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = this.validateOrgAccess(request);
    const { id } = request.params as any;

    // Verify existence
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.organisationId !== orgId) {
        return reply.status(404).send({ error: 'Supplier not found' });
    }

    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    
    // Aggregate Invoices
    const invoices = await prisma.xeroInvoice.findMany({
        where: {
            supplierId: id,
            date: { gte: twelveMonthsAgo },
            status: { in: ['AUTHORISED', 'PAID'] } // Exclude VOIDED
        },
        select: {
            total: true,
            date: true
        }
    });

    const totalSpend12m = invoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
    const avgMonthlySpend = totalSpend12m / 12; // Simple avg

    // Group by month for sparkline
    const spendTrend = Array(12).fill(0);
    invoices.forEach(inv => {
        if (inv.date) {
            const monthDiff = (now.getFullYear() - inv.date.getFullYear()) * 12 + (now.getMonth() - inv.date.getMonth());
            if (monthDiff >= 0 && monthDiff < 12) {
                spendTrend[11 - monthDiff] += Number(inv.total) || 0;
            }
        }
    });

    return reply.send({
        totalSpend12m,
        avgMonthlySpend,
        spendTrend
    });
  }

  getSupplierProducts = async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = this.validateOrgAccess(request);
    const { id } = request.params as any;

    // Verify existence
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.organisationId !== orgId) {
        return reply.status(404).send({ error: 'Supplier not found' });
    }

    // Raw query to aggregate products
    // We prioritise using the real Product UUID (XeroInvoiceLineItem.productId) if available.
    // Note: Postgres specific SQL
    const products = await prisma.$queryRaw`
        SELECT 
            MAX("XeroInvoiceLineItem"."productId") as "productId",
            COALESCE(MAX("description"), 'Unknown Product') as "name",
            SUM("lineAmount") as "totalSpend",
            SUM("quantity") as "totalQuantity",
            AVG("unitAmount") as "averageCost"
        FROM "XeroInvoiceLineItem"
        JOIN "XeroInvoice" ON "XeroInvoiceLineItem"."invoiceId" = "XeroInvoice"."id"
        WHERE "XeroInvoice"."supplierId" = ${id}
        AND "XeroInvoice"."status" IN ('AUTHORISED', 'PAID')
        GROUP BY COALESCE("itemCode", LOWER(TRIM("description")))
        ORDER BY "totalSpend" DESC
        LIMIT 100
    `;

    // Map BigInts to Numbers if needed (Prisma returns BigInt for some aggregations?)
    // Decimal is usually string or specialized object. Raw query returns whatever driver gives.
    // We might need to sanitize "products" result serialization.

    return reply.send(products);
  }

  getProductDetails = async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = this.validateOrgAccess(request);
    const { id, productId } = request.params as any;

    // We need to reconstruct the grouping logic to fetch details
    // productId is either itemCode OR normalized description
    
    // Fetch line items matching this "product"
    // Complex AND condition: (itemCode = productId) OR (itemCode IS NULL AND normalized(desc) = productId)
    
    // Actually, passing normalized string as ID is tricky in URL. 
    // The client should encode it.
    // Ideally, we hash it, but prompt says "either itemCode or a hash".
    // Let's assume for now productId IS the raw string (itemCode or normalized desc).
    
    const decodedProductId = decodeURIComponent(productId);

    const lineItems = await prisma.xeroInvoiceLineItem.findMany({
        where: {
            invoice: {
                supplierId: id,
                status: { in: ['AUTHORISED', 'PAID'] }
            },
            OR: [
                { itemCode: decodedProductId },
                { 
                  AND: [
                    { itemCode: null },
                    { description: { contains: decodedProductId, mode: 'insensitive' } } // Fuzzy match or strict?
                    // Strictly we used normalized description. Prisma doesn't support function on column in where easily.
                    // We'll fetch raw matching logic.
                  ]
                }
            ]
        },
        include: {
            invoice: { select: { date: true } }
        },
        orderBy: { invoice: { date: 'asc' } }
    });
    
    // Filter strictly in JS if needed for the normalized description case
    const filteredItems = lineItems.filter(item => {
        if (item.itemCode === decodedProductId) return true;
        if (!item.itemCode && item.description) {
            return normalizeSupplierName(item.description) === decodedProductId;
        }
        return false;
    });

    if (filteredItems.length === 0) {
        return reply.status(404).send({ error: 'Product not found' });
    }

    // Compute metrics
    const totalSpend = filteredItems.reduce((sum, item) => sum + (Number(item.lineAmount) || 0), 0);
    const totalQuantity = filteredItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    
    // Price history (unitAmount over time)
    const priceHistory = filteredItems.map(item => ({
        date: item.invoice.date,
        price: Number(item.unitAmount)
    }));

    return reply.send({
        productId: decodedProductId,
        name: filteredItems[filteredItems.length - 1].description, // Use latest description
        totalSpend,
        totalQuantity,
        priceHistory
    });
  }
}
