import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { Prisma, SupplierStatus } from '@prisma/client';
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

    // 1. Pre-fetch Valid Supplier IDs (Whitelist)
    // This ensures we ONLY list suppliers that have at least one verified/authorized invoice.
    // This effectively acts as a strict "activeInvoicesFilter" but applied via ID list.
    console.log(`[SupplierController] listSuppliers: Pre-fetching Valid IDs for org=${orgId} loc=${locationId || 'all'}`);
    const [manualIds, xeroIds] = await Promise.all([
        prisma.invoice.findMany({
            where: { 
                organisationId: orgId, 
                isVerified: true, 
                deletedAt: null,
                // Strict check: Invoice must be linked to a VERIFIED file
                // This ensures we don't accidentally include suppliers from 'Pending' invoices that were flagged verified
                invoiceFile: {
                    reviewStatus: 'VERIFIED',
                    deletedAt: null
                },
                ...(locationId ? { locationId } : {}) 
            },
            select: { supplierId: true },
            distinct: ['supplierId']
        }).then(rows => {
            console.log(`[SupplierController] Found ${rows.length} valid manual supplier IDs`);
            return rows.map(r => r.supplierId).filter(Boolean) as string[];
        }),
        prisma.xeroInvoice.findMany({
            where: { 
                organisationId: orgId, 
                status: { in: ['AUTHORISED', 'PAID'] }, 
                deletedAt: null,
                ...(locationId ? { locationId } : {}) 
            },
            select: { supplierId: true },
            distinct: ['supplierId']
        }).then(rows => {
            console.log(`[SupplierController] Found ${rows.length} valid Xero supplier IDs`);
            return rows.map(r => r.supplierId).filter(Boolean) as string[];
        })
    ]);
    const validSupplierIds = Array.from(new Set([...manualIds, ...xeroIds]));
    console.log(`[SupplierController] Total unique valid supplier IDs: ${validSupplierIds.length}`);

    const where: Prisma.SupplierWhereInput = {
      organisationId: orgId,
      status: SupplierStatus.ACTIVE,
      id: { in: validSupplierIds },
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...accountFilter, // Merge account filter logic
      AND: [
          ...(Object.keys(activityFilter).length > 0 ? [activityFilter] : [])
      ]
    };

    console.log('[SupplierController] listSuppliers where:', JSON.stringify({
        organisationId: orgId,
        locationId,
        status: SupplierStatus.ACTIVE,
        validSupplierIdsCount: validSupplierIds.length,
        queryWhere: where
    }, null, 2));
    
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
    console.log('[SupplierController] listSuppliers result count:', suppliers.length);

    if (suppliers.length === 0) {
      return reply.send({
        data: [],
        pagination: { total, page: Number(page), limit: Number(limit) }
      });
    }

    // Fetch superseded IDs to exclude from Xero queries
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

    // 1. Account Filters Setup
    // Manual Invoice Item Filter (for distinct item counts) - same as existing logic
    const hasManualCogsCode = normalizedAccountCodes?.includes(MANUAL_COGS_ACCOUNT_CODE) || false;
    const otherAccountCodes = normalizedAccountCodes?.filter(code => code !== MANUAL_COGS_ACCOUNT_CODE) || [];
    
    const manualItemAccountFilter = (() => {
        if (!normalizedAccountCodes || normalizedAccountCodes.length === 0) {
            return Prisma.empty;
        }
        if (hasManualCogsCode && otherAccountCodes.length === 0) {
            return Prisma.empty;
        } else if (hasManualCogsCode && otherAccountCodes.length > 0) {
            return Prisma.sql`AND (li."accountCode" = ${MANUAL_COGS_ACCOUNT_CODE} OR li."accountCode" IN (${Prisma.join(otherAccountCodes)}))`;
        } else {
            return Prisma.sql`AND li."accountCode" IN (${Prisma.join(otherAccountCodes)})`;
        }
    })();

    // Metrics Account Filters (Invoice Level)
    // For Xero Metrics: Filter invoices that have at least one matching line item
    const xeroMetricsAccountFilter = (() => {
        if (!normalizedAccountCodes || normalizedAccountCodes.length === 0) return Prisma.empty;
        // Use EXISTS to check for line items
        return Prisma.sql`AND EXISTS (
            SELECT 1 FROM "XeroInvoiceLineItem" xli 
            WHERE xli."invoiceId" = i.id 
            AND xli."accountCode" IN (${Prisma.join(normalizedAccountCodes)})
        )`;
    })();

    // For Manual Metrics: Filter invoices that have at least one matching line item (unless manual COGS selected)
    const manualMetricsAccountFilter = (() => {
        if (!normalizedAccountCodes || normalizedAccountCodes.length === 0) return Prisma.empty;
        if (hasManualCogsCode) return Prisma.empty; // Include all verified invoices if Manual COGS is selected
        
        if (otherAccountCodes.length === 0) return Prisma.empty;

        return Prisma.sql`AND EXISTS (
            SELECT 1 FROM "InvoiceLineItem" li 
            WHERE li."invoiceId" = i.id 
            AND li."accountCode" IN (${Prisma.join(otherAccountCodes)})
        )`;
    })();

    // 2. Metrics Queries (Consolidated)
    const [
        xeroMetricsRaw,
        manualMetricsRaw,
        xeroItemRows,
        manualItemRows
    ] = await Promise.all([
        // Consolidated Xero Metrics
        prisma.$queryRaw<Array<{ 
            supplierId: string, 
            currentPeriodTotal: number | null,
            priorPeriodTotal: number | null,
            total12m: number | null,
            count12m: number | bigint,
            count6m: number | bigint
        }>>`
            SELECT 
                i."supplierId",
                SUM(CASE WHEN i."date" >= ${startOfCurrentPeriod} AND i."date" <= ${endOfCurrentPeriod} THEN i."total" ELSE 0 END) as "currentPeriodTotal",
                SUM(CASE WHEN i."date" >= ${startOfPriorPeriod} AND i."date" <= ${endOfPriorPeriod} THEN i."total" ELSE 0 END) as "priorPeriodTotal",
                SUM(CASE WHEN i."date" >= ${twelveMonthsAgoMetric} THEN i."total" ELSE 0 END) as "total12m",
                COUNT(CASE WHEN i."date" >= ${twelveMonthsAgoMetric} THEN 1 END) as "count12m",
                COUNT(CASE WHEN i."date" >= ${sixMonthsAgo} THEN 1 END) as "count6m"
            FROM "XeroInvoice" i
            WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
            AND i."organisationId" = ${orgId}
            AND i."status" IN ('AUTHORISED', 'PAID')
            AND i."deletedAt" IS NULL
            ${locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty}
            ${supersededXeroIds.length > 0 ? Prisma.sql`AND i."xeroInvoiceId" NOT IN (${Prisma.join(supersededXeroIds)})` : Prisma.empty}
            ${xeroMetricsAccountFilter}
            GROUP BY i."supplierId"
        `,
        // Consolidated Manual Metrics
        prisma.$queryRaw<Array<{ 
            supplierId: string, 
            currentPeriodTotal: number | null,
            priorPeriodTotal: number | null,
            total12m: number | null,
            count12m: number | bigint,
            count6m: number | bigint
        }>>`
            SELECT 
                i."supplierId",
                SUM(CASE WHEN i."date" >= ${startOfCurrentPeriod} AND i."date" <= ${endOfCurrentPeriod} THEN i."total" ELSE 0 END) as "currentPeriodTotal",
                SUM(CASE WHEN i."date" >= ${startOfPriorPeriod} AND i."date" <= ${endOfPriorPeriod} THEN i."total" ELSE 0 END) as "priorPeriodTotal",
                SUM(CASE WHEN i."date" >= ${twelveMonthsAgoMetric} THEN i."total" ELSE 0 END) as "total12m",
                COUNT(CASE WHEN i."date" >= ${twelveMonthsAgoMetric} THEN 1 END) as "count12m",
                COUNT(CASE WHEN i."date" >= ${sixMonthsAgo} THEN 1 END) as "count6m"
            FROM "Invoice" i
            JOIN "InvoiceFile" f ON i."invoiceFileId" = f.id
            WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
            AND i."organisationId" = ${orgId}
            AND i."isVerified" = true
            AND f."reviewStatus" = 'VERIFIED'
            AND f."deletedAt" IS NULL
            AND i."deletedAt" IS NULL
            ${locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty}
            ${manualMetricsAccountFilter}
            GROUP BY i."supplierId"
        `,
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
                COALESCE(NULLIF(li."productCode", ''), LOWER(TRIM(li."description"))) as "normalisedKey"
            FROM "InvoiceLineItem" li
            JOIN "Invoice" i ON li."invoiceId" = i.id
            JOIN "InvoiceFile" f ON i."invoiceFileId" = f.id
            WHERE i."supplierId" IN (${Prisma.join(supplierIds)})
            AND i."organisationId" = ${orgId}
            AND i."isVerified" = true
            AND f."reviewStatus" = 'VERIFIED'
            AND f."deletedAt" IS NULL
            AND i."date" >= ${twelveMonthsAgoMetric}
            AND i."deletedAt" IS NULL
            ${locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty}
            ${manualItemAccountFilter}
        `
    ]);

    // 3. Merge Logic
    // Combined Map: SupplierId -> Metrics Object
    const supplierMetricsMap = new Map<string, {
        currentPeriodTotal: number,
        priorPeriodTotal: number,
        total12m: number,
        count12m: number,
        count6m: number
    }>();

    const processMetrics = (rows: any[]) => {
        rows.forEach(row => {
            if (!row.supplierId) return;
            const existing = supplierMetricsMap.get(row.supplierId) || {
                currentPeriodTotal: 0,
                priorPeriodTotal: 0,
                total12m: 0,
                count12m: 0,
                count6m: 0
            };

            supplierMetricsMap.set(row.supplierId, {
                currentPeriodTotal: existing.currentPeriodTotal + (Number(row.currentPeriodTotal) || 0),
                priorPeriodTotal: existing.priorPeriodTotal + (Number(row.priorPeriodTotal) || 0),
                total12m: existing.total12m + (Number(row.total12m) || 0),
                count12m: existing.count12m + (Number(row.count12m) || 0),
                count6m: existing.count6m + (Number(row.count6m) || 0)
            });
        });
    };

    processMetrics(xeroMetricsRaw);
    processMetrics(manualMetricsRaw);

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
      const metrics = supplierMetricsMap.get(s.id) || {
          currentPeriodTotal: 0,
          priorPeriodTotal: 0,
          total12m: 0,
          count12m: 0,
          count6m: 0
      };
      
      const isRecurring = metrics.count6m >= 3;
      const purchaseFrequency = isRecurring ? metrics.count12m : 0;

      const currentPeriodSpend = metrics.currentPeriodTotal;
      const priorPeriodSpend = metrics.priorPeriodTotal;

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
        totalSpend: metrics.total12m,
        purchaseFrequency,
        totalOrders: metrics.count12m,
        avgInvoiceSize: metrics.count12m > 0 ? metrics.total12m / metrics.count12m : 0,
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
              invoiceFile: {
                  reviewStatus: 'VERIFIED',
                  deletedAt: null
              },
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
            COALESCE(NULLIF("productCode", ''), LOWER(TRIM("description"))) as "key"
        FROM "InvoiceLineItem" li
        JOIN "Invoice" i ON li."invoiceId" = i.id
        JOIN "InvoiceFile" f ON i."invoiceFileId" = f.id
        WHERE i."supplierId" = ${id}
        AND i."isVerified" = true
        AND f."reviewStatus" = 'VERIFIED'
        AND f."deletedAt" IS NULL
        AND i."organisationId" = ${orgId}
        AND i."deletedAt" IS NULL
        ${locationFilter}
        GROUP BY COALESCE(NULLIF("productCode", ''), LOWER(TRIM("description")))
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
