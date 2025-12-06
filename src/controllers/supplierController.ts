import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { Prisma } from '@prisma/client';
import { supplierInsightsService } from '../services/supplierInsightsService';
import { MANUAL_COGS_ACCOUNT_CODE } from '../config/constants';

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
    
    // Helper to build manual invoice filter based on account codes
    // If MANUAL_COGS_ACCOUNT_CODE is in the filter, include all verified manual invoices
    // Otherwise, filter by the specified account codes
    const getManualInvoiceFilter = (): Prisma.InvoiceWhereInput => {
        if (!normalizedAccountCodes || normalizedAccountCodes.length === 0) {
            return {}; // No filter - include all verified invoices
        }
        
        const hasManualCogsCode = normalizedAccountCodes.includes(MANUAL_COGS_ACCOUNT_CODE);
        const otherAccountCodes = normalizedAccountCodes.filter(code => code !== MANUAL_COGS_ACCOUNT_CODE);
        
        if (hasManualCogsCode) {
            // MANUAL_COGS_ACCOUNT_CODE selected - include all verified manual invoices
            // (they're all considered manual COGS regardless of line item account codes)
            // If other codes are also selected, we still include all manual invoices
            // since they're all manual COGS by definition
            return {}; // No filter - include all verified manual invoices
        } else {
            // Only other account codes - filter by those codes
            return {
                lineItems: {
                    some: {
                        accountCode: { in: otherAccountCodes }
                    }
                }
            };
        }
    };
    
    // Note: Suppliers themselves are Organisation-scoped.
    // However, their invoices and activity can be Location-scoped.
    // If we want to list only suppliers active in a location, we'd need to join invoices.
    // For now, we list all suppliers for the Org but filter metrics by location if present.

    // Activity Status Filter Logic
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

    let activityFilter: Prisma.SupplierWhereInput = {};
    if (activityStatus === 'current') {
        activityFilter = {
            OR: [
                {
                    invoices: {
                        some: {
                            organisationId: orgId,
                            ...(locationId ? { locationId } : {}),
                            date: { gte: twelveMonthsAgo },
                            status: { in: ['AUTHORISED', 'PAID'] },
                            deletedAt: null
                        }
                    }
                },
                {
                    ocrInvoices: {
                        some: {
                            organisationId: orgId,
                            ...(locationId ? { locationId } : {}),
                            date: { gte: twelveMonthsAgo },
                            isVerified: true,
                            deletedAt: null
                        }
                    }
                }
            ]
        };
    }

    // Active Invoices Filter: Only show suppliers with at least one non-deleted invoice
    // This prevents suppliers with only deleted invoices from appearing in the list.
    const activeInvoicesFilter: Prisma.SupplierWhereInput = {
        OR: [
            {
                invoices: {
                    some: {
                        organisationId: orgId,
                        deletedAt: null,
                        status: { in: ['AUTHORISED', 'PAID'] },
                        ...(locationId ? { locationId } : {})
                    }
                }
            },
            {
                ocrInvoices: {
                    some: {
                        organisationId: orgId,
                        deletedAt: null,
                        isVerified: true,
                        ...(locationId ? { locationId } : {})
                    }
                }
            }
        ]
    };

    // Account Filter Logic (from service)
    const accountFilter = supplierInsightsService.getSupplierFilterWhereClause(orgId, locationId, normalizedAccountCodes);

    // 1. Pre-fetch Supplier IDs for the given location (if locationId is present)
    let locationSupplierIds: string[] | null = null;

    if (locationId && activityStatus !== 'current') {
        console.log(`[SupplierController] listSuppliers: Pre-fetching IDs for loc=${locationId} org=${orgId}`);
        const [manualIds, xeroIds] = await Promise.all([
            prisma.invoice.findMany({
                where: { organisationId: orgId, locationId, isVerified: true, deletedAt: null },
                select: { supplierId: true },
                distinct: ['supplierId']
            }).then(rows => {
                console.log(`[SupplierController] Found ${rows.length} manual supplier IDs`);
                return rows.map(r => r.supplierId).filter(Boolean) as string[];
            }),
            prisma.xeroInvoice.findMany({
                where: { organisationId: orgId, locationId, status: { in: ['AUTHORISED', 'PAID'] }, deletedAt: null },
                select: { supplierId: true },
                distinct: ['supplierId']
            }).then(rows => {
                console.log(`[SupplierController] Found ${rows.length} Xero supplier IDs`);
                return rows.map(r => r.supplierId).filter(Boolean) as string[];
            })
        ]);
        locationSupplierIds = Array.from(new Set([...manualIds, ...xeroIds]));
        console.log(`[SupplierController] Total unique location supplier IDs: ${locationSupplierIds.length}`);
    }

    const where: Prisma.SupplierWhereInput = {
      organisationId: orgId,
      status: { not: 'ARCHIVED' },
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      // Use explicitly fetched IDs if location filtering is active
      ...(locationSupplierIds !== null ? { id: { in: locationSupplierIds } } : {}),
      ...accountFilter, // Merge account filter logic
      AND: [
          activeInvoicesFilter,
          ...(Object.keys(activityFilter).length > 0 ? [activityFilter] : [])
      ]
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
    
    console.log(`[SupplierController] Final supplier count: ${suppliers.length}, Total: ${total}`);

    if (suppliers.length === 0) {
      return reply.send({
        data: [],
        pagination: { total, page: Number(page), limit: Number(limit) }
      });
    }

    // ...
    
    // Fetch superseded IDs to exclude from Xero queries
    // This ensures verified invoices (via Invoice) take precedence over raw Xero invoices (via XeroInvoice)
    // Since we're doing lifetime aggregation in some parts, we should fetch all superseded IDs for this org/loc
    // We can't easily date-scope this call because listSuppliers aggregates over 12m, 6m, current period, etc.
    // Fetching all superseded IDs for the org/loc is safer.
    // However, we must NOT import the helper here directly if it's not exported, or if it's private in service.
    // supplierInsightsService.ts has it as a private helper?
    // I need to check if I exported getSupersededXeroIds in supplierInsightsService.ts.
    // Looking at my previous edit, I added it as a standalone function at the top of the file, NOT exported.
    // I should have exported it or added it to the service object.
    // Let's fix that first.
    
    // Wait, I can't edit supplierInsightsService.ts again in this turn easily without context switch.
    // But I can just replicate the query here or ask the service to do it.
    // But wait, `supplierInsightsService` object is exported. I can add a public method there.
    // Or I can just use `prisma.invoice.findMany` here directly. It's a controller, it has access to prisma.
    // Replicating the logic is fine for now to avoid breaking changes/imports issues.
    
    const supersededXeroIds = await prisma.invoice.findMany({
        where: {
            organisationId: orgId,
            ...(locationId ? { locationId } : {}),
            sourceType: 'XERO',
            isVerified: true,
            deletedAt: null,
            sourceReference: { not: null }
        },
        select: { sourceReference: true }
    }).then(rows => rows.map(r => r.sourceReference).filter((ref): ref is string => !!ref));

    // Metrics Where Clause Base
    const metricsWhereBase = {
        // supplierId: { in: supplierIds }, -> Added inside groupBys
        date: {}, // -> Added inside groupBys
        status: { in: ['AUTHORISED', 'PAID'] },
        organisationId: orgId,
        deletedAt: null,
        xeroInvoiceId: { notIn: supersededXeroIds },
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

    // Metrics-specific windows based on now2
    const twelveMonthsAgoMetric = new Date(now2.getFullYear() - 1, now2.getMonth(), now2.getDate());
    const sixMonthsAgo = new Date(now2.getFullYear(), now2.getMonth() - 6, now2.getDate());

    // Build account code filter for manual invoices (used in raw SQL query)
    const hasManualCogsCode = normalizedAccountCodes?.includes(MANUAL_COGS_ACCOUNT_CODE) || false;
    const otherAccountCodes = normalizedAccountCodes?.filter(code => code !== MANUAL_COGS_ACCOUNT_CODE) || [];
    const manualItemAccountFilter = (() => {
        if (!normalizedAccountCodes || normalizedAccountCodes.length === 0) {
            return Prisma.empty;
        }
        if (hasManualCogsCode && otherAccountCodes.length === 0) {
            // Only MANUAL_COGS_ACCOUNT_CODE - include all (no filter)
            return Prisma.empty;
        } else if (hasManualCogsCode && otherAccountCodes.length > 0) {
            // MANUAL_COGS_ACCOUNT_CODE + other codes - include manual COGS OR other codes
            return Prisma.sql`AND (li."accountCode" = ${MANUAL_COGS_ACCOUNT_CODE} OR li."accountCode" IN (${Prisma.join(otherAccountCodes)}))`;
        } else {
            // Only other codes - filter by those
            return Prisma.sql`AND li."accountCode" IN (${Prisma.join(otherAccountCodes)})`;
        }
    })();

    // Metrics for Current Period (Spend)
    // Using Promise.all for parallel execution
    const [
        currentPeriodMetricsXero,
        priorPeriodMetricsXero,
        metrics12mXero,
        metrics6mXero,
        currentPeriodMetricsManual,
        priorPeriodMetricsManual,
        metrics12mManual,
        metrics6mManual,
        xeroItemRows,
        manualItemRows
    ] = await Promise.all([
        // Xero Metrics
        prisma.xeroInvoice.groupBy({
            by: ['supplierId'],
            where: {
                ...metricsWhereBase,
                supplierId: { in: supplierIds },
                date: { gte: startOfCurrentPeriod, lte: endOfCurrentPeriod },
            },
            _sum: { total: true },
        }),
        prisma.xeroInvoice.groupBy({
            by: ['supplierId'],
            where: {
                ...metricsWhereBase,
                supplierId: { in: supplierIds },
                date: { gte: startOfPriorPeriod, lte: endOfPriorPeriod },
            },
            _sum: { total: true },
        }),
        prisma.xeroInvoice.groupBy({
            by: ['supplierId'],
            where: {
                ...metricsWhereBase,
                supplierId: { in: supplierIds },
                date: { gte: twelveMonthsAgoMetric },
            },
            _sum: { total: true },
            _count: { id: true }
        }),
        prisma.xeroInvoice.groupBy({
            by: ['supplierId'],
            where: {
                ...metricsWhereBase,
                supplierId: { in: supplierIds },
                date: { gte: sixMonthsAgo },
            },
            _count: { id: true }
        }),
        // Manual Invoice Metrics
        prisma.invoice.groupBy({
            by: ['supplierId'],
            where: {
                supplierId: { in: supplierIds },
                isVerified: true,
                organisationId: orgId,
                ...(locationId ? { locationId } : {}),
                date: { gte: startOfCurrentPeriod, lte: endOfCurrentPeriod },
                deletedAt: null,
                ...getManualInvoiceFilter()
            },
            _sum: { total: true },
        }),
        prisma.invoice.groupBy({
            by: ['supplierId'],
            where: {
                supplierId: { in: supplierIds },
                isVerified: true,
                organisationId: orgId,
                ...(locationId ? { locationId } : {}),
                date: { gte: startOfPriorPeriod, lte: endOfPriorPeriod },
                deletedAt: null,
                ...getManualInvoiceFilter()
            },
            _sum: { total: true },
        }),
        prisma.invoice.groupBy({
            by: ['supplierId'],
            where: {
                supplierId: { in: supplierIds },
                isVerified: true,
                organisationId: orgId,
                ...(locationId ? { locationId } : {}),
                date: { gte: twelveMonthsAgoMetric },
                deletedAt: null,
                ...getManualInvoiceFilter()
            },
            _sum: { total: true },
            _count: { id: true }
        }),
        prisma.invoice.groupBy({
            by: ['supplierId'],
            where: {
                supplierId: { in: supplierIds },
                isVerified: true,
                organisationId: orgId,
                ...(locationId ? { locationId } : {}),
                date: { gte: sixMonthsAgo },
                deletedAt: null,
                ...getManualInvoiceFilter()
            },
            _count: { id: true }
        }),
        // Xero Item Rows
        prisma.$queryRaw<Array<{ supplierId: string, normalisedKey: string }>>`
            SELECT DISTINCT
                i."supplierId",
                COALESCE(li."itemCode", LOWER(TRIM(li."description"))) as "normalisedKey"
            FROM "XeroInvoiceLineItem" li
            JOIN "XeroInvoice" i ON li."invoiceId" = i.id
            WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
            AND i."organisationId" = ${orgId}
            AND i."status" IN ('AUTHORISED', 'PAID')
            AND i."date" >= ${twelveMonthsAgoMetric}
            AND i."deletedAt" IS NULL
            ${supersededXeroIds.length > 0 ? Prisma.sql`AND i."xeroInvoiceId" NOT IN (${Prisma.join(supersededXeroIds)})` : Prisma.empty}
            ${locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty}
            ${normalizedAccountCodes && normalizedAccountCodes.length > 0 
                ? Prisma.sql`AND li."accountCode" IN (${Prisma.join(normalizedAccountCodes)})` 
                : Prisma.empty}
        `,
        // Manual Item Rows
        prisma.$queryRaw<Array<{ supplierId: string, normalisedKey: string }>>`
            SELECT DISTINCT
                i."supplierId",
                COALESCE(li."productCode", LOWER(TRIM(li."description"))) as "normalisedKey"
            FROM "InvoiceLineItem" li
            JOIN "Invoice" i ON li."invoiceId" = i.id
            WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
            AND i."organisationId" = ${orgId}
            AND i."isVerified" = true
            AND i."date" >= ${twelveMonthsAgoMetric}
            AND i."deletedAt" IS NULL
            ${locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty}
            ${manualItemAccountFilter}
        `
    ]);

    // Helper to merge metrics
    const mergeMetrics = (xeroData: any[], manualData: any[], key = '_sum', valueKey = 'total') => {
        const map = new Map<string, number>();
        xeroData.forEach(d => {
            const val = d[key] ? Number(d[key][valueKey] || 0) : Number(d[valueKey] || 0); // Handle both _sum/count structure and direct count
            map.set(d.supplierId, val);
        });
        manualData.forEach(d => {
            // Manual Invoice supplierId can be null in DB type but here it's filtered by ID list so safe
             if (!d.supplierId) return;
             const val = d[key] ? Number(d[key][valueKey] || 0) : Number(d[valueKey] || 0);
             const current = map.get(d.supplierId) || 0;
             map.set(d.supplierId, current + val);
        });
        return map;
    };
    
    // Maps
    const currentPeriodMap = mergeMetrics(currentPeriodMetricsXero, currentPeriodMetricsManual);
    const priorPeriodMap = mergeMetrics(priorPeriodMetricsXero, priorPeriodMetricsManual);
    
    // Special handling for 12m because it has both total and count
    const metrics12mMap = new Map<string, { total: number, count: number }>();
    const process12m = (data: any[]) => {
        data.forEach(d => {
            if(!d.supplierId) return;
            const current = metrics12mMap.get(d.supplierId) || { total: 0, count: 0 };
            metrics12mMap.set(d.supplierId, {
                total: current.total + Number(d._sum.total || 0),
                count: current.count + (d._count.id || 0)
            });
        });
    };
    process12m(metrics12mXero);
    process12m(metrics12mManual);

    // Special handling for 6m count
    const metrics6mMap = new Map<string, number>();
    const process6m = (data: any[]) => {
        data.forEach(d => {
             if(!d.supplierId) return;
             const current = metrics6mMap.get(d.supplierId) || 0;
             metrics6mMap.set(d.supplierId, current + (d._count.id || 0));
        });
    };
    process6m(metrics6mXero);
    process6m(metrics6mManual);

    // Build itemCountsMap with true distinct counts across both sources
    const itemSetsBySupplier = new Map<string, Set<string>>();

    const processItemRows = (rows: any[]) => {
        for (const row of rows) {
            const sId = row.supplierId;
            const key = (row.normalisedKey || '').trim().toLowerCase();
            if (sId && key) {
                if (!itemSetsBySupplier.has(sId)) {
                    itemSetsBySupplier.set(sId, new Set());
                }
                itemSetsBySupplier.get(sId)!.add(key);
            }
        }
    };

    processItemRows(xeroItemRows);
    processItemRows(manualItemRows);

    const itemCountsMap = new Map<string, number>();
    for (const [sId, set] of itemSetsBySupplier.entries()) {
        itemCountsMap.set(sId, set.size);
    }
    
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
    
    const supersededXeroIds = await prisma.invoice.findMany({
        where: {
            organisationId: orgId,
            ...(locationId ? { locationId } : {}),
            sourceType: 'XERO',
            isVerified: true,
            deletedAt: null,
            sourceReference: { not: null }
        },
        select: { sourceReference: true }
    }).then(rows => rows.map(r => r.sourceReference).filter((ref): ref is string => !!ref));

    // Aggregate Invoices (Xero + Manual)
    const [xeroInvoices, manualInvoices] = await Promise.all([
      prisma.xeroInvoice.findMany({
          where: {
              supplierId: id,
              date: { gte: twelveMonthsAgo },
              status: { in: ['AUTHORISED', 'PAID'] },
              organisationId: orgId,
              deletedAt: null,
              xeroInvoiceId: { notIn: supersededXeroIds },
              ...(locationId ? { locationId } : {})
          },
          select: {
              total: true,
              date: true
          }
      }),
      prisma.invoice.findMany({
          where: {
              supplierId: id,
              date: { gte: twelveMonthsAgo },
              isVerified: true,
              organisationId: orgId,
              deletedAt: null,
              ...(locationId ? { locationId } : {})
          },
          select: {
              total: true,
              date: true
          }
      })
    ]);

    const allInvoices = [...xeroInvoices, ...manualInvoices];

    const totalSpend12m = allInvoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
    const avgMonthlySpend = totalSpend12m / 12;

    const spendTrend = Array(12).fill(0);
    allInvoices.forEach(inv => {
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
        ? Prisma.sql`AND i."locationId" = ${locationId}` 
        : Prisma.empty;

    const supersededXeroIds = await prisma.invoice.findMany({
        where: {
            organisationId: orgId,
            ...(locationId ? { locationId } : {}),
            sourceType: 'XERO',
            isVerified: true,
            deletedAt: null,
            sourceReference: { not: null }
        },
        select: { sourceReference: true }
    }).then(rows => rows.map(r => r.sourceReference).filter((ref): ref is string => !!ref));

    const supersededFilter = supersededXeroIds.length > 0
        ? Prisma.sql`AND i."xeroInvoiceId" NOT IN (${Prisma.join(supersededXeroIds)})`
        : Prisma.empty;

    // Query 1: Xero Products
    const xeroProducts: any[] = await prisma.$queryRaw`
        SELECT 
            MAX(li."productId") as "productId",
            COALESCE(MAX("description"), 'Unknown Product') as "name",
            SUM("lineAmount") as "totalSpend",
            SUM("quantity") as "totalQuantity",
            AVG("unitAmount") as "averageCost",
            COALESCE("itemCode", LOWER(TRIM("description"))) as "key"
        FROM "XeroInvoiceLineItem" li
        JOIN "XeroInvoice" i ON li."invoiceId" = i.id
        WHERE i."supplierId" = ${id}
        AND i."status" IN ('AUTHORISED', 'PAID')
        AND i."organisationId" = ${orgId}
        AND i."deletedAt" IS NULL
        ${locationFilter}
        ${supersededFilter}
        GROUP BY COALESCE("itemCode", LOWER(TRIM("description")))
        ORDER BY "totalSpend" DESC
        LIMIT 100
    `;

    // Query 2: Manual Products
    const manualProducts: any[] = await prisma.$queryRaw`
        SELECT 
            COALESCE(MAX("description"), 'Unknown Product') as "name",
            SUM("lineTotal") as "totalSpend",
            SUM("quantity") as "totalQuantity",
            AVG("unitPrice") as "averageCost",
            COALESCE("productCode", LOWER(TRIM("description"))) as "key"
        FROM "InvoiceLineItem" li
        JOIN "Invoice" i ON li."invoiceId" = i.id
        WHERE i."supplierId" = ${id}
        AND i."isVerified" = true
        AND i."organisationId" = ${orgId}
        AND i."deletedAt" IS NULL
        ${locationFilter}
        GROUP BY COALESCE("productCode", LOWER(TRIM("description")))
        ORDER BY "totalSpend" DESC
        LIMIT 100
    `;

    // Merge
    const mergedProducts = new Map<string, any>();

    const addToMap = (products: any[], isManual = false) => {
        for (const p of products) {
            const key = (p.key || '').trim().toLowerCase();
            if (!key) continue;

            const existing = mergedProducts.get(key);
            if (existing) {
                existing.totalSpend = Number(existing.totalSpend) + Number(p.totalSpend);
                existing.totalQuantity = Number(existing.totalQuantity) + Number(p.totalQuantity);
                // Simple average cost update (weighted would be better but simple avg is OK for MVP)
                existing.averageCost = (Number(existing.averageCost) + Number(p.averageCost)) / 2;
            } else {
                // Generate composite ID for manual products if they don't have a productId
                let productId = p.productId;
                if (!productId && isManual) {
                    // Generate composite ID: manual:supplierId:base64(key)
                    const keyBase64 = Buffer.from(key).toString('base64');
                    productId = `manual:${id}:${keyBase64}`;
                }
                
                mergedProducts.set(key, {
                    productId: productId || null,
                    name: p.name,
                    totalSpend: Number(p.totalSpend),
                    totalQuantity: Number(p.totalQuantity),
                    averageCost: Number(p.averageCost)
                });
            }
        }
    };

    addToMap(xeroProducts);
    addToMap(manualProducts, true);

    // Convert to array, sort and limit
    const result = Array.from(mergedProducts.values())
        .sort((a, b) => b.totalSpend - a.totalSpend)
        .slice(0, 100);

    return reply.send(result);
  }

  getProductDetails = async (request: FastifyRequest, reply: FastifyReply) => {
    const { organisationId: orgId, locationId } = this.validateOrgAccess(request);
    const { id, productId } = request.params as any;

    const decodedProductId = decodeURIComponent(productId);

    const supersededXeroIds = await prisma.invoice.findMany({
        where: {
            organisationId: orgId,
            ...(locationId ? { locationId } : {}),
            sourceType: 'XERO',
            isVerified: true,
            deletedAt: null,
            sourceReference: { not: null }
        },
        select: { sourceReference: true }
    }).then(rows => rows.map(r => r.sourceReference).filter((ref): ref is string => !!ref));

    const lineItems = await prisma.xeroInvoiceLineItem.findMany({
        where: {
            invoice: {
                supplierId: id,
                status: { in: ['AUTHORISED', 'PAID'] },
                organisationId: orgId,
                deletedAt: null,
                xeroInvoiceId: { notIn: supersededXeroIds },
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
