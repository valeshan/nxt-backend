import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { Prisma } from '@prisma/client';
import { supplierInsightsService } from '../services/supplierInsightsService';

export class SupplierController {
  
  // Helper for org access validation
  private validateOrgAccess(request: FastifyRequest, targetOrgId?: string) {
    const { organisationId, tokenType, locationId } = request.authContext;
    
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
    return { organisationId, locationId: locationId || undefined };
  }

  listAccounts = async (request: FastifyRequest, reply: FastifyReply) => {
      const { organisationId: orgId, locationId } = this.validateOrgAccess(request);
      const accounts = await supplierInsightsService.getAccounts(orgId, locationId);
      return reply.send(accounts);
  }

  saveAccountConfig = async (request: FastifyRequest, reply: FastifyReply) => {
      const { organisationId, locationId } = this.validateOrgAccess(request);
      const { accountCodes } = request.body as { accountCodes: string[] };
      
      if (!locationId) {
          return reply.status(400).send({ error: 'Location context required to save configuration' });
      }

      const result = await supplierInsightsService.saveLocationAccountConfig(organisationId, locationId, accountCodes);
      return reply.send(result);
  }

  listSuppliers = async (request: FastifyRequest, reply: FastifyReply) => {
    const { organisationId: orgId, locationId } = this.validateOrgAccess(request);
    const { page = 1, limit = 50, search, activityStatus, accountCodes } = request.query as any;
    const skip = (page - 1) * limit;
    
    // Normalize accountCodes to string[]
    let normalizedAccountCodes: string[] | undefined = undefined;
    if (accountCodes) {
        if (Array.isArray(accountCodes)) {
            normalizedAccountCodes = accountCodes;
        } else if (typeof accountCodes === 'string') {
            // Support comma separated string if needed, or just single value
            normalizedAccountCodes = accountCodes.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
    }
    
    // Note: Suppliers themselves are Organisation-scoped.
    // However, their invoices and activity can be Location-scoped.
    // If we want to list only suppliers active in a location, we'd need to join invoices.
    // For now, we list all suppliers for the Org but filter metrics by location if present.

    // Activity Status Filter Logic
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

    let activityFilter = {};
    if (activityStatus === 'current') {
        activityFilter = {
            OR: [
                {
                    invoices: {
                        some: {
                            organisationId: orgId,
                            ...(locationId ? { locationId } : {}),
                            date: { gte: twelveMonthsAgo },
                            status: { in: ['AUTHORISED', 'PAID'] }
                        }
                    }
                },
                {
                    ocrInvoices: {
                        some: {
                            organisationId: orgId,
                            ...(locationId ? { locationId } : {}),
                            date: { gte: twelveMonthsAgo },
                            isVerified: true
                        }
                    }
                }
            ]
        };
    }

    // Account Filter Logic (from service)
    const accountFilter = supplierInsightsService.getSupplierFilterWhereClause(orgId, locationId, normalizedAccountCodes);

    const where: Prisma.SupplierWhereInput = {
      organisationId: orgId,
      status: { not: 'ARCHIVED' },
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(locationId && activityStatus !== 'current' ? {
        invoices: {
          some: {
            locationId: locationId
          }
        }
      } : {}),
      ...activityFilter,
      ...accountFilter // Merge account filter logic
    };
    
    // ... existing fetching logic
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
    
    // ...
    
    // Metrics Where Clause Base
    const metricsWhereBase = {
        // supplierId: { in: supplierIds }, -> Added inside groupBys
        date: {}, // -> Added inside groupBys
        status: { in: ['AUTHORISED', 'PAID'] },
        organisationId: orgId,
        ...(locationId ? { locationId } : {}),
        ...(normalizedAccountCodes && normalizedAccountCodes.length > 0 ? {
            lineItems: {
                some: {
                    accountCode: { in: normalizedAccountCodes }
                }
            }
        } : {})
    };

    // ... Update queries to use metricsWhereBase
    
    const supplierIds = suppliers.map(s => s.id);
    
    // Date Logic for Spend Trend
    const now2 = new Date();
    const startOfCurrentMonth = new Date(now2.getFullYear(), now2.getMonth(), 1);
    
    const endOfCurrentPeriod = new Date(startOfCurrentMonth);
    endOfCurrentPeriod.setDate(0);
    endOfCurrentPeriod.setHours(23, 59, 59, 999);

    const startOfCurrentPeriod = new Date(startOfCurrentMonth);
    startOfCurrentPeriod.setMonth(startOfCurrentPeriod.getMonth() - 6); 

    const endOfPriorPeriod = new Date(startOfCurrentPeriod);
    endOfPriorPeriod.setDate(0);
    endOfPriorPeriod.setHours(23, 59, 59, 999);

    const startOfPriorPeriod = new Date(startOfCurrentPeriod);
    startOfPriorPeriod.setMonth(startOfPriorPeriod.getMonth() - 6); 

    // Metrics for Current Period (Spend)
    const currentPeriodMetrics = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        ...metricsWhereBase,
        supplierId: { in: supplierIds },
        date: { gte: startOfCurrentPeriod, lte: endOfCurrentPeriod },
      },
      _sum: { total: true },
    });

    // Metrics for Prior Period (Spend)
    const priorPeriodMetrics = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        ...metricsWhereBase,
        supplierId: { in: supplierIds },
        date: { gte: startOfPriorPeriod, lte: endOfPriorPeriod },
      },
      _sum: { total: true },
    });

    // Standard 12m Metrics
    const twelveMonthsAgoMetric = new Date(now2.getFullYear() - 1, now2.getMonth(), now2.getDate());
    const sixMonthsAgo = new Date(now2.getFullYear(), now2.getMonth() - 6, now2.getDate());

    const metrics12m = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        ...metricsWhereBase,
        supplierId: { in: supplierIds },
        date: { gte: twelveMonthsAgoMetric },
      },
      _sum: { total: true },
      _count: { id: true }
    });

    // Metrics for Recurring Logic
    const metrics6m = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        ...metricsWhereBase,
        supplierId: { in: supplierIds },
        date: { gte: sixMonthsAgo },
      },
      _count: { id: true }
    });

    // Calculate item counts (distinct products) per supplier
    let itemCountsMap = new Map<string, number>();
    
    if (supplierIds.length > 0) {
      // Raw query needs explicit location filter if present
      const locationFilter = locationId 
        ? Prisma.sql`AND i."locationId" = ${locationId}` 
        : Prisma.empty;
      
      // Account filter for raw query
      const accountFilterRaw = (normalizedAccountCodes && normalizedAccountCodes.length > 0)
        ? Prisma.sql`AND li."accountCode" IN (${Prisma.join(normalizedAccountCodes)})`
        : Prisma.empty;

      const itemCounts: any[] = await prisma.$queryRaw`
        SELECT i."supplierId", COUNT(DISTINCT COALESCE("itemCode", LOWER(TRIM("description"))))::int as "count"
        FROM "XeroInvoiceLineItem" li
        JOIN "XeroInvoice" i ON li."invoiceId" = i.id
        WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
        AND i."status" IN ('AUTHORISED', 'PAID')
        AND i."organisationId" = ${orgId}
        ${locationFilter}
        ${accountFilterRaw}
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
      
      const isRecurring = count6m >= 3;
      const purchaseFrequency = isRecurring ? m12.count : 0;

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
        totalOrders: m12.count, // Use filtered count
        avgInvoiceSize: m12.count > 0 ? m12.total / m12.count : 0,
        yoySpendChange: 0,
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
    const { organisationId: orgId } = this.validateOrgAccess(request);
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
    const { organisationId: orgId, locationId } = this.validateOrgAccess(request);
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
            status: { in: ['AUTHORISED', 'PAID'] },
            organisationId: orgId,
            ...(locationId ? { locationId } : {})
        },
        select: {
            total: true,
            date: true
        }
    });

    const totalSpend12m = invoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
    const avgMonthlySpend = totalSpend12m / 12;

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
    const { organisationId: orgId, locationId } = this.validateOrgAccess(request);
    const { id } = request.params as any;

    // Verify existence
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.organisationId !== orgId) {
        return reply.status(404).send({ error: 'Supplier not found' });
    }

    // Raw query to aggregate products
    const locationFilter = locationId 
        ? Prisma.sql`AND "XeroInvoice"."locationId" = ${locationId}` 
        : Prisma.empty;

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
        AND "XeroInvoice"."organisationId" = ${orgId}
        ${locationFilter}
        GROUP BY COALESCE("itemCode", LOWER(TRIM("description")))
        ORDER BY "totalSpend" DESC
        LIMIT 100
    `;

    return reply.send(products);
  }

  getProductDetails = async (request: FastifyRequest, reply: FastifyReply) => {
    const { organisationId: orgId, locationId } = this.validateOrgAccess(request);
    const { id, productId } = request.params as any;

    const decodedProductId = decodeURIComponent(productId);

    const lineItems = await prisma.xeroInvoiceLineItem.findMany({
        where: {
            invoice: {
                supplierId: id,
                status: { in: ['AUTHORISED', 'PAID'] },
                organisationId: orgId,
                ...(locationId ? { locationId } : {})
            },
            OR: [
                { itemCode: decodedProductId },
                { 
                  AND: [
                    { itemCode: null },
                    { description: { contains: decodedProductId, mode: 'insensitive' } } 
                  ]
                }
            ]
        },
        include: {
            invoice: { select: { date: true } }
        },
        orderBy: { invoice: { date: 'asc' } }
    });
    
    // Filter strictly in JS
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

    const totalSpend = filteredItems.reduce((sum, item) => sum + (Number(item.lineAmount) || 0), 0);
    const totalQuantity = filteredItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    
    const priceHistory = filteredItems.map(item => ({
        date: item.invoice.date,
        price: Number(item.unitAmount)
    }));

    return reply.send({
        productId: decodedProductId,
        name: filteredItems[filteredItems.length - 1].description, 
        totalSpend,
        totalQuantity,
        priceHistory
    });
  }
}
