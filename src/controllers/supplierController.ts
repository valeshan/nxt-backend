import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { Prisma } from '@prisma/client';

export class SupplierController {
  
  // Helper for org access validation
  private validateOrgAccess(request: FastifyRequest, targetOrgId?: string) {
    const user = request.user as any; // Using any as types might need adjustment
    if (!user || !user.orgId) {
       throw { statusCode: 401, message: 'Unauthorized' };
    }
    
    // If a specific target org is requested, check against token
    // Otherwise, we usually just use the token's orgId
    if (targetOrgId && targetOrgId !== user.orgId) {
       throw { statusCode: 403, message: 'Forbidden' };
    }
    return user.orgId;
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

    // Calculate basic spend metrics for list view (optional, can be heavy)
    // For now, we'll just return the list. Real-time spend calc for list might need aggregation table.
    
    return reply.send({
      data: suppliers,
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
    // We use COALESCE(itemCode, normalizedDesc) as key
    // Note: Postgres specific SQL
    const products = await prisma.$queryRaw`
        SELECT 
            COALESCE("itemCode", LOWER(TRIM("description"))) as "productId",
            MAX("description") as "name",
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
                    // We'll fetch possible matches or rely on exact description match?
                    // Creating a view or computed column is better but schema is fixed.
                    // Let's fetch raw matching logic.
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

