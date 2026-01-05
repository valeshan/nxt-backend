import { PrismaClient, Prisma, OrganisationRole } from '@prisma/client';
import prisma from '../infrastructure/prismaClient';
import { getCategoryName } from '../config/categoryMap';
import { startOfMonth, subMonths, subDays } from 'date-fns';
import { createHash } from 'crypto';
import { forecastService } from './forecast/forecastService';
import { MANUAL_COGS_ACCOUNT_CODE } from '../config/constants';
import { mergeTimeSeries, TimeSeriesPoint } from '../utils/dataMerging';
import { config } from '../config/env';
import { NotificationService } from './notificationService';
import { PriceIncreaseItem } from './emailTemplates/priceIncreaseTemplates';
import { getProductKeyFromLineItem } from './helpers/productKey';
import { getOffsetPaginationOrThrow } from '../utils/paginationGuards';
import { isCanonicalLinesEnabledForOrg } from '../utils/canonicalFlags';

function toAccountCodesHash(accountCodes?: string[]): string {
  if (!accountCodes || accountCodes.length === 0) return 'all';
  const normalized = [...new Set(accountCodes.map((c) => String(c).trim()).filter(Boolean))].sort();
  const hash = createHash('sha1').update(normalized.join(',')).digest('hex');
  return `cogs:${hash}`;
}

// --- Types & DTOs ---

export interface SpendSummary {
  totalSupplierSpendPerMonth: number;
  totalSpendTrendLast6mPercent: number;
  totalSpendTrendSeries: { monthLabel: string; total: number }[];
  averagePriceMovementLast3mPercent: number;
  averageMonthlyVariancePercent: number;
  canCalculateVariance: boolean;
  priceMovementSeries: { monthLabel: string; percentChange: number | null }[];
  canCalculatePriceMovement: boolean;
  forecastedSpendNext30Days: number;
  forecastedSpendFixedNext30Days: number;
  forecastedSpendVariableNext30Days: number;
  forecastConfidence: 'low' | 'medium' | 'high';
}

export interface PriceChangeItem {
  productId: string;
  productName: string;
  supplierName: string;
  latestUnitPrice: number;
  percentChange: number;
  effectiveDate: string; // ISO string
}

export interface SpendBreakdown {
  bySupplier: { supplierId: string; supplierName: string; totalSpend12m: number }[];
  byCategory: { categoryId: string; categoryName: string; totalSpend12m: number }[];
}

export interface CostCreepAlert {
  supplierId: string;
  supplierName: string;
  percentIncrease: number;
}

export interface ProductListItem {
  productId: string; // UUID
  productName: string;
  supplierName: string;
  latestUnitCost: number;
  lastPriceChangePercent: number;
  spend12m: number;
  itemCode?: string | null;
  description?: string | null;
}

export interface ProductDetail {
  productId: string;
  productName: string;
  supplierName: string;
  categoryName: string;
  itemCode?: string;
  stats12m: {
    totalSpend12m: number;
    averageMonthlySpend: number;
    quantityPurchased12m: number;
    spendTrend12mPercent: number;
  };
  priceHistory: { monthLabel: string; averageUnitPrice: number | null }[];
  // New fields for trend tile
  unitPriceHistory: { monthLabel: string; averageUnitPrice: number | null }[];
  productPriceTrendPercent: number;
  canCalculateProductPriceTrend: boolean;
  latestUnitCost: number;
}

export interface GetProductsParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'productName' | 'supplierName' | 'unitCost' | 'lastPriceChangePercent' | 'spend12m';
  sortDirection?: 'asc' | 'desc';
  search?: string;
  accountCodes?: string[];
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  statsAsOf?: string | null;
}

export interface AccountDto {
    code: string;
    name: string | null;
    isCogs: boolean;
}

// --- Date Helper ---

function getFullCalendarMonths(monthsBack: number) {
  const now = new Date();
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  endOfLastMonth.setHours(23, 59, 59, 999);
  
  const startOfRange = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  startOfRange.setHours(0, 0, 0, 0);
  
  return { start: startOfRange, end: endOfLastMonth };
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  start.setHours(0, 0, 0, 0);
  return { start, end: now }; // up to now
}

function getMonthLabel(date: Date): string {
  return date.toLocaleString('default', { month: 'short', year: 'numeric' });
}

// --- Helper Logic ---

/**
 * Fetches Xero invoice IDs that have attachments but are NOT verified.
 * These should be excluded from Supplier Insights.
 * 
 * Logic: Xero invoices WITH attachments are only included if they're VERIFIED.
 * Xero invoices WITHOUT attachments are automatically included.
 */
async function getXeroInvoiceIdsWithUnverifiedAttachments(
  organisationId: string,
  locationId?: string
): Promise<string[]> {
  const invoiceFileModel = (prisma as any)?.invoiceFile;
  if (!invoiceFileModel || typeof invoiceFileModel.findMany !== 'function') {
    // In unit tests mocks may omit invoiceFile; fail open (no exclusions) to avoid crashes.
    return [];
  }

  const files = await invoiceFileModel.findMany({
    where: {
      organisationId,
      sourceType: 'XERO',
      deletedAt: null,
      sourceReference: { not: null },
      reviewStatus: { not: 'VERIFIED' }, // Exclude VERIFIED ones (they should be included)
      ...(locationId ? { locationId } : {})
    },
    select: {
      sourceReference: true
    }
  });

  return files
    .map((f: { sourceReference: string | null }) => f.sourceReference)
    .filter((ref: string | null | undefined): ref is string => !!ref);
}

/**
 * Fetches IDs of Xero invoices that have been superseded by a verified local invoice.
 * These should be excluded from analytics to prevent double counting.
 */
async function getSupersededXeroIds(
    organisationId: string,
    locationId?: string,
    startDate?: Date,
    endDate?: Date
): Promise<string[]> {
    const where = getVerifiedManualInvoiceWhere({
        orgId: organisationId,
        locationId,
        startDate,
        endDate
    });

    // Fetch all verified invoices
    // Note: Removed sourceReference: { not: null } to include manual uploads in the search
    const invoices = await prisma.invoice.findMany({
        where,
        select: { 
            sourceReference: true,
            invoiceNumber: true,
            supplierId: true 
        }
    });

    // 1. Explicit matches via sourceReference (Xero ID)
    const explicitIds = invoices
        .map(inv => inv.sourceReference)
        .filter((ref): ref is string => !!ref);

    // 2. Implicit matches via Invoice Number + Supplier
    const candidates = invoices.filter(inv => !inv.sourceReference && inv.invoiceNumber && inv.supplierId);

    if (candidates.length > 0) {
        const candidateNumbers = candidates.map(c => c.invoiceNumber!);

        // Find potential Xero matches by Invoice Number
        const matches = await prisma.xeroInvoice.findMany({
            where: {
                organisationId,
                invoiceNumber: { in: candidateNumbers },
                deletedAt: null
            },
            select: {
                xeroInvoiceId: true,
                invoiceNumber: true,
                supplierId: true
            }
        });

        // Filter ensuring Supplier ID also matches
        const implicitIds = matches
            .filter(m => candidates.some(c => 
                c.invoiceNumber === m.invoiceNumber && 
                c.supplierId === m.supplierId
            ))
            .map(m => m.xeroInvoiceId);
            
        return Array.from(new Set([...explicitIds, ...implicitIds]));
    }

    return explicitIds;
}

/**
 * Computes monthly weighted average unit prices for a set of products.
 * Returns a nested map: ProductID -> MonthKey (YYYY-MM) -> WeightedAvgPrice
 */
async function computeWeightedAveragePrices(
    organisationId: string, 
    productIds: string[], 
    startDate: Date, 
    endDate: Date,
    locationId?: string,
    accountCodes?: string[]
) {
    // Split product IDs into Xero (UUID) and Manual (manual:...)
    const xeroProductIds = productIds.filter(id => !id.startsWith('manual:'));
    const manualProductIds = productIds.filter(id => id.startsWith('manual:'));

    const results = new Map<string, Map<string, number>>();

    // 1. Process Xero Products
    if (xeroProductIds.length > 0) {
        // Get superseded Xero IDs and unverified attachment IDs to exclude from price calculations
        const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
          getSupersededXeroIds(organisationId, locationId, startDate, endDate),
          getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
        ]);
        
        // Fetch all line items for these products in the window
        const lineItems = await prisma.xeroInvoiceLineItem.findMany({
            where: {
                productId: { in: xeroProductIds },
                quantity: { gt: 0 }, // Rule 1 & 4: Ignore zero/negative quantity
                ...getXeroLineItemWhere({
                    orgId: organisationId,
                    locationId,
                    startDate,
                    endDate,
                    supersededIds,
                    accountCodes,
                    xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
                })
            },
            select: {
                productId: true,
                lineAmount: true,
                quantity: true,
                unitAmount: true,
                invoice: { select: { date: true } }
            }
        });

        // Aggregation buckets: productId -> monthKey -> { totalAmount, totalQty }
        const buckets = new Map<string, Map<string, { totalAmount: number, totalQty: number }>>();

        for (const item of lineItems as any[]) {
            if (!item.productId || !item.invoice.date) continue;

            // Convert Prisma Decimal to number properly
            const amount = typeof item.lineAmount === 'object' && item.lineAmount !== null 
                ? (item.lineAmount as any).toNumber() 
                : Number(item.lineAmount || 0);
            const qty = typeof item.quantity === 'object' && item.quantity !== null 
                ? (item.quantity as any).toNumber() 
                : Number(item.quantity || 0);

            if (qty <= 0) continue;

            const date = item.invoice.date;
            // Ensure date is a Date object
            const invoiceDate = date instanceof Date ? date : new Date(date);
            const year = invoiceDate.getFullYear();
            const month = invoiceDate.getMonth() + 1; // getMonth() returns 0-11, we need 1-12
            const monthKey = `${year}-${String(month).padStart(2, '0')}`;
            // console.log(`[Debug] Processing item: ${item.productId} Date: ${invoiceDate.toISOString()} Key: ${monthKey} Amt: ${amount} Qty: ${qty}`);

            if (!buckets.has(item.productId)) {
                buckets.set(item.productId, new Map());
            }
            const prodMap = buckets.get(item.productId)!;
            
            if (!prodMap.has(monthKey)) {
                prodMap.set(monthKey, { totalAmount: 0, totalQty: 0 });
            }
            const current = prodMap.get(monthKey)!;
            
            current.totalAmount += amount;
            current.totalQty += qty;
        }

        // Compute final averages
        for (const [pid, months] of buckets.entries()) {
            const monthMap = new Map<string, number>();
            for (const [mKey, data] of months.entries()) {
                if (data.totalQty > 0) {
                    monthMap.set(mKey, data.totalAmount / data.totalQty);
                }
            }
            results.set(pid, monthMap);
        }
    }

    // 2. Process Manual Products (if any)
    if (manualProductIds.length > 0) {
        // Each manual ID contains the search criteria: manual:supplierId:base64Key
        // We need to query for each one essentially, or build a complex OR query.
        // Since manual IDs are relatively few per page (max 20), we can iterate or build a large OR.
        
        const manualBuckets = new Map<string, Map<string, { totalAmount: number, totalQty: number }>>();

        // Build OR conditions for fetching line items
        const conditions: Prisma.InvoiceLineItemWhereInput[] = [];
        
        // Map to store which condition index maps to which manual ID
        // Actually, fetching all potential matching lines then filtering in memory might be safer 
        // if the number of manual products is small (page size).
        
        // Let's fetch lines for relevant suppliers and filter in memory.
        const supplierIds = new Set<string>();
        manualProductIds.forEach(id => {
            const parts = id.split(':');
            if (parts.length === 3) supplierIds.add(parts[1]);
        });

        const manualLineItems = await prisma.invoiceLineItem.findMany({
            where: {
                ...getVerifiedManualLineItemWhere({
                    orgId: organisationId,
                    locationId,
                    startDate,
                    endDate
                }),
                invoice: {
                    supplierId: { in: Array.from(supplierIds) }
                } as any
            } as any,
            select: {
                invoice: { select: { date: true, supplierId: true } },
                productCode: true,
                description: true,
                lineTotal: true,
                quantity: true
            }
        });

        // Process manual items and match to manualProductIds
        for (const manualId of manualProductIds) {
            const parts = manualId.split(':');
            if (parts.length !== 3) continue;
            const supplierId = parts[1];
            let productKey = '';
            try {
                productKey = Buffer.from(parts[2], 'base64').toString('utf-8');
            } catch (e) { continue; }
            
            const normalizedKey = productKey.toLowerCase().trim();

            // Filter matching lines
            const matchingLines = manualLineItems.filter((item: any) => {
                if (item.invoice.supplierId !== supplierId) return false;
                
                const itemCode = item.productCode?.toLowerCase().trim();
                const itemDesc = item.description?.toLowerCase().trim() || '';
                
                if (itemCode) return itemCode === normalizedKey;
                return itemDesc === normalizedKey;
            });

            if (matchingLines.length === 0) continue;

            // Aggregate
            if (!manualBuckets.has(manualId)) {
                manualBuckets.set(manualId, new Map());
            }
            const prodMap = manualBuckets.get(manualId)!;

            for (const item of matchingLines as any[]) {
                if (!item.invoice.date) continue;
                const amount = Number(item.lineTotal || 0);
                const qty = Number(item.quantity || 0);
                
                if (qty <= 0) continue;

                const date = item.invoice.date;
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

                if (!prodMap.has(monthKey)) {
                    prodMap.set(monthKey, { totalAmount: 0, totalQty: 0 });
                }
                const current = prodMap.get(monthKey)!;
                current.totalAmount += amount;
                current.totalQty += qty;
            }
        }

        // Compute averages for manual products
        for (const [pid, months] of manualBuckets.entries()) {
            const monthMap = new Map<string, number>();
            for (const [mKey, data] of months.entries()) {
                if (data.totalQty > 0) {
                    monthMap.set(mKey, data.totalAmount / data.totalQty);
                }
            }
            results.set(pid, monthMap);
        }
    }
    
    return results;
}

/**
 * Determines if manual invoice data should be included based on accountCodes filter
 */
function shouldIncludeManualData(accountCodes?: string[]): boolean {
    if (!accountCodes || accountCodes.length === 0) {
        return true; // Include all data when no filter
    }
    return accountCodes.includes(MANUAL_COGS_ACCOUNT_CODE);
}

/**
 * Unified helper for verified manual/file-backed invoice eligibility.
 * 
 * Strict definition: Invoice.isVerified = true AND InvoiceFile.reviewStatus = 'VERIFIED' 
 * AND InvoiceFile.deletedAt = null AND Invoice.deletedAt = null
 * 
 * This ensures consistent filtering across all manual invoice queries and prevents
 * manual verification drift across queries.
 */
function getVerifiedManualInvoiceWhere(params: {
  orgId: string;
  locationId?: string;
  startDate?: Date;
  endDate?: Date;
}): Prisma.InvoiceWhereInput {
  const { orgId, locationId, startDate, endDate } = params;

  return {
    organisationId: orgId,
    ...(locationId ? { locationId } : {}),
    isVerified: true,
    invoiceFileId: { not: null },
    invoiceFile: {
      reviewStatus: 'VERIFIED',
      deletedAt: null
    },
    deletedAt: null,
    ...(startDate || endDate ? {
      date: {
        ...(startDate ? { gte: startDate } : {}),
        ...(endDate ? { lte: endDate } : {})
      }
    } : {})
  };
}

/**
 * Helper for verified manual invoice line items.
 * Use this for InvoiceLineItem queries that need verified manual invoices.
 */
function getVerifiedManualLineItemWhere(params: {
  orgId: string;
  locationId?: string;
  startDate?: Date;
  endDate?: Date;
}): Prisma.InvoiceLineItemWhereInput {
  const { orgId, locationId, startDate, endDate } = params;

  return {
    invoice: getVerifiedManualInvoiceWhere({
      orgId,
      locationId,
      startDate,
      endDate
    }),
    isIncludedInAnalytics: true // Only include items marked for inclusion in analytics
  } as Prisma.InvoiceLineItemWhereInput;
}

/**
 * Unified helper for Xero invoice line item eligibility.
 * 
 * Always includes:
 * - invoice.status IN ('AUTHORISED', 'PAID')
 * - invoice.deletedAt = null
 * - invoice.xeroInvoiceId NOT IN supersededIds
 * - invoice.xeroInvoiceId NOT IN unverifiedAttachmentIds (if provided)
 * - date range / org / location filters
 * - optional accountCodes filter
 * 
 * Exclusion logic for attachments:
 * - Xero invoices WITHOUT attachments → automatically included
 * - Xero invoices WITH attachments → only included if InvoiceFile.reviewStatus = 'VERIFIED'
 * 
 * This ensures consistent filtering across all Xero line item queries.
 */
function getXeroLineItemWhere(params: {
  orgId: string;
  locationId?: string;
  startDate?: Date;
  endDate?: Date;
  supersededIds: string[];
  accountCodes?: string[];
  excludeUnverifiedAttachments?: boolean; // Default: true
  xeroInvoiceIdsWithUnverifiedAttachments?: string[]; // Pre-fetched list
}): Prisma.XeroInvoiceLineItemWhereInput {
  const { 
    orgId, 
    locationId, 
    startDate, 
    endDate, 
    supersededIds, 
    accountCodes,
    excludeUnverifiedAttachments = true, // Default to excluding unverified attachments
    xeroInvoiceIdsWithUnverifiedAttachments = []
  } = params;

  // Combine superseded IDs with unverified attachment IDs
  const excludedIds = [...supersededIds];
  if (excludeUnverifiedAttachments && xeroInvoiceIdsWithUnverifiedAttachments.length > 0) {
    excludedIds.push(...xeroInvoiceIdsWithUnverifiedAttachments);
  }

  return {
    invoice: {
      organisationId: orgId,
      ...(locationId ? { locationId } : {}),
      status: { in: ['AUTHORISED', 'PAID'] },
      deletedAt: null,
      ...(excludedIds.length > 0 ? { xeroInvoiceId: { notIn: excludedIds } } : {}),
      ...(startDate || endDate ? {
        date: {
          ...(startDate ? { gte: startDate } : {}),
          ...(endDate ? { lte: endDate } : {})
        }
      } : {})
    },
    ...(accountCodes && accountCodes.length > 0 ? { accountCode: { in: accountCodes } } : {})
  } as Prisma.XeroInvoiceLineItemWhereInput;
}

/**
 * Builds where clause for manual invoice line items
 * Note: This should only be called when shouldIncludeManualData returns true
 * @deprecated Use getVerifiedManualLineItemWhere instead
 */
function getManualLineItemWhere(
    organisationId: string,
    locationId: string | undefined,
    startDate: Date,
    endDate?: Date
): Prisma.InvoiceLineItemWhereInput {
    return getVerifiedManualLineItemWhere({
        orgId: organisationId,
        locationId,
        startDate,
        endDate
    });
}


// --- Service Functions ---

export const supplierInsightsService = {
  /**
   * Feature gate for canonical analytics (scoped rollout).
   *
   * Global gate: USE_CANONICAL_LINES=true
   * Optional scope gate: CANONICAL_LINES_ORG_ALLOWLIST contains org id
   */
  isCanonicalAnalyticsEnabled(organisationId: string): boolean {
    return isCanonicalLinesEnabledForOrg(organisationId);
  },

  /**
   * Canonical parity checklist (fail-closed): compares a few high-signal aggregates between
   * legacy sources and canonical tables for a specific org+location over the last 90 days.
   *
   * Intended for internal validation before enabling USE_CANONICAL_LINES.
   */
  async getCanonicalParityChecklist(
    organisationId: string,
    locationId: string
  ): Promise<{
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; details: any }>;
    totals: { legacySpend90d: number; canonicalSpend90d: number; deltaPct: number };
    meta: {
      checkedAt: string;
      window: { startUtc: string; endUtc: string; days: number };
      excludes: { canonical: { qualityStatus: string[] }; legacy: { manualRequiresVerified: boolean; xeroStatuses: string[] } };
      tolerances: { spendDeltaPct: number; supplierDeltaPct: number };
    };
    explanation: string;
  }> {
    const now = new Date();
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const checkedAt = now.toISOString();
    const meta = {
      checkedAt,
      window: { startUtc: ninetyDaysAgo.toISOString(), endUtc: now.toISOString(), days: 90 },
      excludes: {
        canonical: { qualityStatus: ['WARN'] },
        legacy: { manualRequiresVerified: true, xeroStatuses: ['AUTHORISED', 'PAID'] },
      },
      tolerances: { spendDeltaPct: 0.5, supplierDeltaPct: 0.5 },
    };
    const explanation =
      'Legacy spend = Xero lineAmount (AUTHORISED/PAID, not deleted, not superseded, excludes unverified attachments) + manual verified lineTotal (invoiceFile VERIFIED). ' +
      'Canonical spend = sum(lineTotal) from CanonicalInvoiceLineItem with qualityStatus=OK on non-deleted CanonicalInvoice rows. ' +
      'All comparisons use the same 90-day invoice date window.';

    const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, ninetyDaysAgo),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);
  const excludedIds = [...supersededIds, ...unverifiedAttachmentIds];

    const safeSum = (agg: any) => agg?._sum?.lineAmount?.toNumber?.() || agg?._sum?.lineAmount?.toNumber?.() || 0;
    const safeSumManual = (agg: any) => agg?._sum?.lineTotal?.toNumber?.() || agg?._sum?.lineTotal?.toNumber?.() || 0;

    // Legacy spend: Xero lineAmount + Manual lineTotal
    const [legacyXeroAgg, legacyManualAgg] = await Promise.all([
      prisma.xeroInvoiceLineItem.aggregate({
        where: getXeroLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: ninetyDaysAgo,
          endDate: now,
          supersededIds,
          accountCodes: undefined,
          xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
        }),
        _sum: { lineAmount: true },
      }),
      prisma.invoiceLineItem.aggregate({
        where: getVerifiedManualLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: ninetyDaysAgo,
          endDate: now
        }),
        _sum: { lineTotal: true },
      }),
    ]);

    const legacySpend90d = safeSum(legacyXeroAgg) + safeSumManual(legacyManualAgg);

    // Canonical spend: sum(lineTotal) over OK rows, canonicalInvoice not deleted, date in range.
    const canonicalSpendAgg = await (prisma as any).canonicalInvoiceLineItem.aggregate({
      where: {
        organisationId,
        locationId,
        qualityStatus: 'OK',
        canonicalInvoice: {
          deletedAt: null,
          date: { gte: ninetyDaysAgo, lte: now },
        },
      },
      _sum: { lineTotal: true },
    });
    const canonicalSpend90d = Number(canonicalSpendAgg?._sum?.lineTotal || 0);

    const deltaPct = legacySpend90d > 0 ? ((canonicalSpend90d - legacySpend90d) / legacySpend90d) * 100 : 0;

    // Counts: invoices + suppliers (high-level sanity)
    const [legacyInvoiceCount, canonicalInvoiceCount] = await Promise.all([
      prisma.invoice.count({
        where: { organisationId, locationId, deletedAt: null, date: { gte: ninetyDaysAgo, lte: now } },
      }),
      (prisma as any).canonicalInvoice.count({
        where: { organisationId, locationId, deletedAt: null, date: { gte: ninetyDaysAgo, lte: now } },
      }),
    ]);

    const [legacySupplierCount, canonicalSupplierCount] = await Promise.all([
      prisma.invoice
        .findMany({
          where: {
            organisationId,
            locationId,
            deletedAt: null,
            date: { gte: ninetyDaysAgo, lte: now },
            supplierId: { not: null },
          },
          select: { supplierId: true },
        })
        .then((rows) => new Set(rows.map((r) => r.supplierId).filter(Boolean)).size),
      (prisma as any).canonicalInvoice
        .findMany({
          where: { organisationId, locationId, deletedAt: null, date: { gte: ninetyDaysAgo, lte: now } },
          select: { supplierId: true },
        })
        .then((rows: any[]) => new Set(rows.map((r) => r.supplierId).filter(Boolean)).size),
    ]);

    // Supplier-level spend parity (required before flip)
    // Legacy: sum Xero lineAmount + manual lineTotal grouped by supplierId
    const [legacySpendBySupplier, canonicalSpendBySupplier] = await Promise.all([
      prisma.$queryRaw<
        Array<{ supplierId: string | null; spend: number }>
      >(
        Prisma.sql`
        WITH legacy_xero AS (
          SELECT xi."supplierId" AS "supplierId", COALESCE(SUM(xil."lineAmount"), 0)::float8 AS spend
          FROM "XeroInvoiceLineItem" xil
          JOIN "XeroInvoice" xi ON xi.id = xil."invoiceId"
          WHERE xi."organisationId" = ${organisationId}
            AND xi."locationId" = ${locationId}
            AND xi."deletedAt" IS NULL
            AND xi."status" IN ('AUTHORISED','PAID')
            -- Dates are stored as timestamp (no tz). Compare against UTC-normalized boundaries.
            AND xi."date" >= (${ninetyDaysAgo} AT TIME ZONE 'UTC')
            AND xi."date" <= (${now} AT TIME ZONE 'UTC')
            -- EXCLUDE: superseded invoices and invoices with unverified attachments
            AND (${excludedIds.length > 0 ? Prisma.sql`xi."xeroInvoiceId" NOT IN (${Prisma.join(excludedIds)})` : Prisma.sql`TRUE`})
          GROUP BY xi."supplierId"
        ),
        legacy_manual AS (
          SELECT i."supplierId" AS "supplierId", COALESCE(SUM(ili."lineTotal"), 0)::float8 AS spend
          FROM "InvoiceLineItem" ili
          JOIN "Invoice" i ON i.id = ili."invoiceId"
          JOIN "InvoiceFile" f ON f.id = i."invoiceFileId"
          WHERE i."organisationId" = ${organisationId}
            AND i."locationId" = ${locationId}
            AND i."deletedAt" IS NULL
            AND i."isVerified" = true
            AND i."invoiceFileId" IS NOT NULL
            AND f."reviewStatus" = 'VERIFIED'
            AND f."deletedAt" IS NULL
            AND i."date" >= (${ninetyDaysAgo} AT TIME ZONE 'UTC')
            AND i."date" <= (${now} AT TIME ZONE 'UTC')
          GROUP BY i."supplierId"
        )
        -- Avoid FULL OUTER JOIN with IS NOT DISTINCT FROM (unsupported for FULL JOIN in Postgres)
        -- Equivalent result: UNION ALL + aggregate by supplierId (null buckets preserved)
        , merged AS (
          SELECT * FROM legacy_xero
          UNION ALL
          SELECT * FROM legacy_manual
        )
        SELECT "supplierId", SUM(spend)::float8 AS spend
        FROM merged
        GROUP BY "supplierId"
        `
      ),
      prisma.$queryRaw<
        Array<{ supplierId: string | null; spend: number }>
      >(
        Prisma.sql`
        SELECT "supplierId" AS "supplierId",
               COALESCE(SUM("lineTotal"), 0)::float8 AS spend
        FROM "CanonicalInvoiceLineItem"
        WHERE "organisationId" = ${organisationId}
          AND "locationId" = ${locationId}
          AND "qualityStatus" = 'OK'
          AND "canonicalInvoiceId" IN (
            SELECT id FROM "CanonicalInvoice"
            WHERE "organisationId" = ${organisationId}
              AND "locationId" = ${locationId}
              AND "deletedAt" IS NULL
              AND "date" >= (${ninetyDaysAgo} AT TIME ZONE 'UTC')
              AND "date" <= (${now} AT TIME ZONE 'UTC')
          )
        GROUP BY "supplierId"
        `
      ),
    ]);

    const legacyBySupplierMap = new Map<string, number>();
    for (const row of legacySpendBySupplier) legacyBySupplierMap.set(String(row.supplierId ?? 'null'), Number(row.spend || 0));

    const canonicalBySupplierMap = new Map<string, number>();
    for (const row of canonicalSpendBySupplier) canonicalBySupplierMap.set(String(row.supplierId ?? 'null'), Number(row.spend || 0));

    const supplierDeltaRows: Array<{ supplierId: string | null; legacy: number; canonical: number; deltaPct: number }> = [];
    for (const [supplierKey, legacySpend] of legacyBySupplierMap.entries()) {
      const canonicalSpend = canonicalBySupplierMap.get(supplierKey) ?? 0;
      const pct = legacySpend > 0 ? ((canonicalSpend - legacySpend) / legacySpend) * 100 : 0;
      supplierDeltaRows.push({
        supplierId: supplierKey === 'null' ? null : supplierKey,
        legacy: legacySpend,
        canonical: canonicalSpend,
        deltaPct: pct,
      });
    }
    // If canonical has extra supplier buckets not present in legacy, include them too (should be near-zero if everything is consistent)
    for (const [supplierKey, canonicalSpend] of canonicalBySupplierMap.entries()) {
      if (legacyBySupplierMap.has(supplierKey)) continue;
      supplierDeltaRows.push({
        supplierId: supplierKey === 'null' ? null : supplierKey,
        legacy: 0,
        canonical: canonicalSpend,
        deltaPct: canonicalSpend === 0 ? 0 : 100,
      });
    }

    // Top products snapshot (directional): canonical uses grouping key; legacy uses itemCode/productCode/description.
    const [canonicalTopProducts, legacyTopProducts] = await Promise.all([
      (prisma as any).canonicalInvoiceLineItem.groupBy({
        by: ['supplierId', 'normalizedDescription', 'unitCategory'],
        where: {
          organisationId,
          locationId,
          qualityStatus: 'OK',
          canonicalInvoice: { deletedAt: null, date: { gte: ninetyDaysAgo, lte: now } },
        },
        _sum: { lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 20,
      }),
      prisma.$queryRaw<
        Array<{ supplierId: string | null; label: string; spend: number }>
      >(
        Prisma.sql`
        WITH legacy_xero AS (
          SELECT xi."supplierId" AS "supplierId",
                 COALESCE(NULLIF(TRIM(xil."itemCode"),''), NULLIF(TRIM(xil."description"),''), 'UNKNOWN') AS label,
                 COALESCE(SUM(xil."lineAmount"), 0)::float8 AS spend
          FROM "XeroInvoiceLineItem" xil
          JOIN "XeroInvoice" xi ON xi.id = xil."invoiceId"
          WHERE xi."organisationId" = ${organisationId}
            AND xi."locationId" = ${locationId}
            AND xi."deletedAt" IS NULL
            AND xi."status" IN ('AUTHORISED','PAID')
            AND xi."date" >= (${ninetyDaysAgo} AT TIME ZONE 'UTC')
            AND xi."date" <= (${now} AT TIME ZONE 'UTC')
            -- EXCLUDE: superseded invoices and invoices with unverified attachments
            AND (${excludedIds.length > 0 ? Prisma.sql`xi."xeroInvoiceId" NOT IN (${Prisma.join(excludedIds)})` : Prisma.sql`TRUE`})
          GROUP BY xi."supplierId", label
        ),
        legacy_manual AS (
          SELECT i."supplierId" AS "supplierId",
                 COALESCE(NULLIF(TRIM(ili."productCode"),''), NULLIF(TRIM(ili."description"),''), 'UNKNOWN') AS label,
                 COALESCE(SUM(ili."lineTotal"), 0)::float8 AS spend
          FROM "InvoiceLineItem" ili
          JOIN "Invoice" i ON i.id = ili."invoiceId"
          JOIN "InvoiceFile" f ON f.id = i."invoiceFileId"
          WHERE i."organisationId" = ${organisationId}
            AND i."locationId" = ${locationId}
            AND i."deletedAt" IS NULL
            AND i."isVerified" = true
            AND i."invoiceFileId" IS NOT NULL
            AND f."reviewStatus" = 'VERIFIED'
            AND f."deletedAt" IS NULL
            AND i."date" >= (${ninetyDaysAgo} AT TIME ZONE 'UTC')
            AND i."date" <= (${now} AT TIME ZONE 'UTC')
          GROUP BY i."supplierId", label
        ),
        merged AS (
          SELECT * FROM legacy_xero
          UNION ALL
          SELECT * FROM legacy_manual
        )
        SELECT "supplierId", label, SUM(spend)::float8 AS spend
        FROM merged
        GROUP BY "supplierId", label
        ORDER BY spend DESC
        LIMIT 20
        `
      ),
    ]);

    const canonicalTopProductsNormalized = (canonicalTopProducts || []).map((r: any) => ({
      supplierId: r.supplierId ?? null,
      key: `${r.normalizedDescription}::${r.unitCategory}`,
      spend: Number(r._sum?.lineTotal || 0),
      normalizedDescription: r.normalizedDescription,
      unitCategory: r.unitCategory,
    }));

    // WARN rate (line-level) and "all-warn invoice" count (invoice-level)
    const [canonicalOkLines, canonicalWarnLines, canonicalInvoicesAllWarn] = await Promise.all([
      (prisma as any).canonicalInvoiceLineItem.count({
        where: { organisationId, locationId, qualityStatus: 'OK', canonicalInvoice: { deletedAt: null, date: { gte: ninetyDaysAgo, lte: now } } },
      }),
      (prisma as any).canonicalInvoiceLineItem.count({
        where: { organisationId, locationId, qualityStatus: 'WARN', canonicalInvoice: { deletedAt: null, date: { gte: ninetyDaysAgo, lte: now } } },
      }),
      prisma.$queryRaw<Array<{ count: number }>>(
        Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "CanonicalInvoice" ci
        WHERE ci."organisationId" = ${organisationId}
          AND ci."locationId" = ${locationId}
          AND ci."deletedAt" IS NULL
          AND ci."date" >= ${ninetyDaysAgo} AND ci."date" <= ${now}
          AND NOT EXISTS (
            SELECT 1 FROM "CanonicalInvoiceLineItem" li
            WHERE li."canonicalInvoiceId" = ci.id AND li."qualityStatus" = 'OK'
          )
        `
      ).then((rows) => rows?.[0]?.count ?? 0),
    ]);

    const warnRate = canonicalOkLines + canonicalWarnLines > 0 ? canonicalWarnLines / (canonicalOkLines + canonicalWarnLines) : 0;

    // WARN reason breakdown (why lines are excluded)
    const warnReasonRows = await prisma.$queryRaw<Array<{ reason: string; count: number }>>(
      Prisma.sql`
        SELECT reason, COUNT(*)::int AS count
        FROM (
          SELECT unnest(li."warnReasons") AS reason
          FROM "CanonicalInvoiceLineItem" li
          JOIN "CanonicalInvoice" ci ON ci.id = li."canonicalInvoiceId"
          WHERE li."organisationId" = ${organisationId}
            AND li."locationId" = ${locationId}
            AND li."qualityStatus" = 'WARN'
            AND ci."deletedAt" IS NULL
            AND ci."date" >= (${ninetyDaysAgo} AT TIME ZONE 'UTC')
            AND ci."date" <= (${now} AT TIME ZONE 'UTC')
        ) t
        GROUP BY reason
        ORDER BY count DESC
      `
    );
    const warnReasonsByReason: Record<string, number> = {};
    for (const r of warnReasonRows || []) warnReasonsByReason[String(r.reason)] = Number((r as any).count || 0);

    // Tolerances (as per pre-flip checklist)
    const spendOk = Math.abs(deltaPct) <= 0.5;
    const supplierOk = canonicalSupplierCount <= legacySupplierCount + 1; // allow 1 for unknown bucket edge

    const supplierSpendOk = supplierDeltaRows.every((r) => Math.abs(r.deltaPct) <= 0.5 || r.legacy === 0);
    const invoiceOk = canonicalInvoiceCount >= legacyInvoiceCount - canonicalInvoicesAllWarn;

    const checks = [
      { name: 'spend_last_90d', ok: spendOk, details: { legacySpend90d, canonicalSpend90d, deltaPct } },
      {
        name: 'spend_last_90d_by_supplier',
        ok: supplierSpendOk,
        details: { tolerancePct: 0.5, rows: supplierDeltaRows.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)).slice(0, 25) },
      },
      {
        name: 'top_products_snapshot',
        ok: true,
        details: { legacyTopProducts, canonicalTopProducts: canonicalTopProductsNormalized },
      },
      {
        name: 'invoice_count_last_90d',
        ok: invoiceOk,
        details: { legacyInvoiceCount, canonicalInvoiceCount, canonicalInvoicesAllWarn },
      },
      { name: 'supplier_count_last_90d', ok: supplierOk, details: { legacySupplierCount, canonicalSupplierCount } },
      { name: 'warn_rate_lines', ok: warnRate <= 0.5, details: { warnRate, canonicalOkLines, canonicalWarnLines } },
      { name: 'warn_reasons', ok: true, details: { byReason: warnReasonsByReason } },
    ];

    return { ok: checks.every((c) => c.ok), checks, totals: { legacySpend90d, canonicalSpend90d, deltaPct }, meta, explanation };
  },

  async getSupplierSpendSummary(organisationId: string, locationId?: string, accountCodes?: string[]): Promise<SpendSummary> {
    // 1. Total Supplier Spend Per Month (Last 90 days / 3)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const [supersededIds, xeroInvoiceIdsWithUnverifiedAttachments] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, ninetyDaysAgo),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    const safeSum = (agg: any) => agg?._sum?.lineAmount?.toNumber() || 0;
    const safeSumManual = (agg: any) => agg?._sum?.lineTotal?.toNumber() || 0;
    
    // Fetch Xero and Manual data in parallel
    const [recentSpendAgg, recentManualSpendAgg] = await Promise.all([
      prisma.xeroInvoiceLineItem.aggregate({
        where: getXeroLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: ninetyDaysAgo,
          supersededIds,
          accountCodes,
          xeroInvoiceIdsWithUnverifiedAttachments
        }),
        _sum: { lineAmount: true }
      }),
      shouldIncludeManualData(accountCodes) ? prisma.invoiceLineItem.aggregate({
        where: getManualLineItemWhere(organisationId, locationId, ninetyDaysAgo),
        _sum: { lineTotal: true }
      }) : Promise.resolve({ _sum: { lineTotal: null } })
    ]);

    const totalRecentSpend = safeSum(recentSpendAgg) + safeSumManual(recentManualSpendAgg);
    const totalSupplierSpendPerMonth = totalRecentSpend / 3;

    // 1.5 Calculate Spend Trend Last 6m vs Prev 6m
    const last6m = getFullCalendarMonths(6);
    // Prev 6m: The 6 months prior to last6m
    // last6m.start is Month-6 (e.g. May 1st). 
    // We want Month-12 to Month-7.
    // Start: Month-12 (e.g. Nov 1st prev year). End: Month-7 end (Apr 30th).
    const prev6mStart = new Date(last6m.start);
    prev6mStart.setMonth(prev6mStart.getMonth() - 6);
    
    const prev6mEnd = new Date(last6m.start);
    prev6mEnd.setDate(prev6mEnd.getDate() - 1);
    prev6mEnd.setHours(23, 59, 59, 999);

    // Fetch superseded IDs for the wider range (last 12m)
    const [trendSupersededIds, trendUnverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, prev6mStart),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    const [last6mAgg, last6mManualAgg, prev6mAgg, prev6mManualAgg] = await Promise.all([
      prisma.xeroInvoiceLineItem.aggregate({
        where: getXeroLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: last6m.start,
          endDate: last6m.end,
          supersededIds: trendSupersededIds,
          accountCodes,
          xeroInvoiceIdsWithUnverifiedAttachments: trendUnverifiedAttachmentIds
        }),
        _sum: { lineAmount: true }
      }),
      shouldIncludeManualData(accountCodes) ? prisma.invoiceLineItem.aggregate({
        where: getManualLineItemWhere(organisationId, locationId, last6m.start, last6m.end),
        _sum: { lineTotal: true }
      }) : Promise.resolve({ _sum: { lineTotal: null } }),
      prisma.xeroInvoiceLineItem.aggregate({
        where: getXeroLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: prev6mStart,
          endDate: prev6mEnd,
          supersededIds: trendSupersededIds,
          accountCodes,
          xeroInvoiceIdsWithUnverifiedAttachments: trendUnverifiedAttachmentIds
        }),
        _sum: { lineAmount: true }
      }),
      shouldIncludeManualData(accountCodes) ? prisma.invoiceLineItem.aggregate({
        where: getManualLineItemWhere(organisationId, locationId, prev6mStart, prev6mEnd),
        _sum: { lineTotal: true }
      }) : Promise.resolve({ _sum: { lineTotal: null } })
    ]);

    const spendLast6m = safeSum(last6mAgg) + safeSumManual(last6mManualAgg);
    const spendPrev6m = safeSum(prev6mAgg) + safeSumManual(prev6mManualAgg);
    
    let totalSpendTrendLast6mPercent = 0;
    if (spendPrev6m > 0) {
        totalSpendTrendLast6mPercent = ((spendLast6m - spendPrev6m) / spendPrev6m) * 100;
    }

    // 2. Total Spend Trend Series (Monthly for last 12 months)
    const xeroSeries: TimeSeriesPoint[] = [];
    const manualSeries: TimeSeriesPoint[] = [];
    
    // Superseded IDs for last 12m
    const trendStart = new Date();
    trendStart.setMonth(trendStart.getMonth() - 12);
    const [seriesSupersededIds, seriesUnverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, trendStart),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    // Build all month queries in parallel
    const monthQueries: Promise<{ monthLabel: string; xeroTotal: number; manualTotal: number }>[] = [];
    
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      const monthLabel = getMonthLabel(start);
      
      const query = Promise.all([
        prisma.xeroInvoiceLineItem.aggregate({
          where: getXeroLineItemWhere({
            orgId: organisationId,
            locationId,
            startDate: start,
            endDate: end,
            supersededIds: seriesSupersededIds,
            accountCodes,
            xeroInvoiceIdsWithUnverifiedAttachments: seriesUnverifiedAttachmentIds
          }),
          _sum: { lineAmount: true }
        }),
        shouldIncludeManualData(accountCodes) ? prisma.invoiceLineItem.aggregate({
          where: getManualLineItemWhere(organisationId, locationId, start, end),
          _sum: { lineTotal: true }
        }) : Promise.resolve({ _sum: { lineTotal: null } })
      ]).then(([xeroAgg, manualAgg]) => ({
        monthLabel,
        xeroTotal: safeSum(xeroAgg),
        manualTotal: safeSumManual(manualAgg)
      }));
      
      monthQueries.push(query);
    }
    
    const monthResults = await Promise.all(monthQueries);
    
    for (const result of monthResults) {
      xeroSeries.push({ monthLabel: result.monthLabel, total: result.xeroTotal });
      if (shouldIncludeManualData(accountCodes)) {
        manualSeries.push({ monthLabel: result.monthLabel, total: result.manualTotal });
      }
    }
    
    const series = shouldIncludeManualData(accountCodes) 
      ? mergeTimeSeries(xeroSeries, manualSeries)
      : xeroSeries;

    // 3. Calculate averageMonthlyVariancePercent
    const monthTotals = series.map(s => s.total);
    const variances: number[] = [];

    for (let i = 1; i < monthTotals.length; i++) {
        const prev = monthTotals[i - 1];
        const current = monthTotals[i];
        
        if (prev <= 0 || current <= 0) {
            continue;
        }

        const diff = Math.abs(current - prev);
        const midpoint = (current + prev) / 2;

        if (midpoint <= 0) continue;

        const variance = diff / midpoint;
        variances.push(variance);
    }

    let averageMonthlyVariancePercent = 0;
    const validPairs = variances.length;
    const canCalculateVariance = validPairs >= 3;

    if (canCalculateVariance) {
        const avg = variances.reduce((sum, v) => sum + v, 0) / validPairs;
        averageMonthlyVariancePercent = avg * 100;
    }

    // 4. Average Price Movement Last 6m (Recurring Items)
    const last6mForPrice = getFullCalendarMonths(6);
    const priceMovementStart = last6mForPrice.start;
    const priceMovementEnd = last6mForPrice.end;

    const [priceSupersededIds, priceUnverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, priceMovementStart, priceMovementEnd),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    // Fetch all line items for the last 6 months
    const allLineItems = await prisma.xeroInvoiceLineItem.findMany({
      where: {
        ...getXeroLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: priceMovementStart,
          endDate: priceMovementEnd,
          supersededIds: priceSupersededIds,
          accountCodes,
          xeroInvoiceIdsWithUnverifiedAttachments: priceUnverifiedAttachmentIds
        }),
        quantity: { gt: 0 }
      } as any,
      select: {
        description: true,
        quantity: true,
        lineAmount: true,
        invoice: {
          select: {
            date: true,
            supplierId: true
          }
        }
      }
    });

    // Normalize and bucket by month & key
    const monthKeyData: Record<string, Record<string, { totalLineAmount: number; totalQuantity: number }>> = {};

    for (const item of allLineItems as any[]) {
        const desc = (item.description || '').trim().toLowerCase();
        if (!desc) continue;
        
        const supplierId = item.invoice.supplierId || 'unknown';
        const key = `${supplierId}::${desc}`;
        
        const date = item.invoice.date;
        if (!date) continue;
        
        const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
        
        if (!monthKeyData[monthStart]) {
            monthKeyData[monthStart] = {};
        }
        if (!monthKeyData[monthStart][key]) {
            monthKeyData[monthStart][key] = { totalLineAmount: 0, totalQuantity: 0 };
        }
        
        monthKeyData[monthStart][key].totalLineAmount += Number(item.lineAmount || 0);
        monthKeyData[monthStart][key].totalQuantity += Number(item.quantity || 0);
    }

    // Sort months chronologically
    const sortedMonths = Object.keys(monthKeyData).sort();
    
    const priceMovementSeries: { monthLabel: string; percentChange: number | null }[] = [];
    const validPriceChanges: number[] = [];

    for (let i = 1; i < sortedMonths.length; i++) {
        const prevMonthIso = sortedMonths[i - 1];
        const currMonthIso = sortedMonths[i];
        const prevMonthData = monthKeyData[prevMonthIso];
        const currMonthData = monthKeyData[currMonthIso];
        
        const prevKeys = Object.keys(prevMonthData);
        const currKeys = Object.keys(currMonthData);
        const overlappingKeys = prevKeys.filter(k => currKeys.includes(k));
        
        let weightedSumChange = 0;
        let totalWeight = 0;
        
        for (const key of overlappingKeys) {
            const prevItem = prevMonthData[key];
            const currItem = currMonthData[key];
            
            if (prevItem.totalQuantity <= 0 || currItem.totalQuantity <= 0) continue;
            
            const prevPrice = prevItem.totalLineAmount / prevItem.totalQuantity;
            const currPrice = currItem.totalLineAmount / currItem.totalQuantity;
            
            if (prevPrice <= 0) continue;
            
            const priceChange = (currPrice - prevPrice) / prevPrice;
            const weight = currItem.totalLineAmount; // Weight by current spend
            
            weightedSumChange += priceChange * weight;
            totalWeight += weight;
        }
        
        let percentChange: number | null = null;
        if (overlappingKeys.length > 0 && totalWeight > 0) {
            const weightedChange = weightedSumChange / totalWeight;
            percentChange = weightedChange * 100;
            validPriceChanges.push(percentChange);
        }
        
        priceMovementSeries.push({
            monthLabel: getMonthLabel(new Date(currMonthIso)),
            percentChange
        });
    }

    let averagePriceMovementLast3mPercent = 0;
    let canCalculatePriceMovement = false;

    if (validPriceChanges.length >= 3) {
        const lastUpToThree = validPriceChanges.slice(-3); // Get last 3
        const sum = lastUpToThree.reduce((a, b) => a + b, 0);
        averagePriceMovementLast3mPercent = sum / lastUpToThree.length;
        canCalculatePriceMovement = true;
    } else {
        averagePriceMovementLast3mPercent = 0;
        canCalculatePriceMovement = false;
    }

    // 5. Forecast
    const forecast = await forecastService.getForecastForOrgAndLocation(organisationId, locationId, accountCodes);

    return {
      totalSupplierSpendPerMonth,
      totalSpendTrendLast6mPercent,
      totalSpendTrendSeries: series,
      averagePriceMovementLast3mPercent,
      averageMonthlyVariancePercent,
      canCalculateVariance,
      priceMovementSeries,
      canCalculatePriceMovement,
      forecastedSpendNext30Days: forecast.forecast30DaysTotal,
      forecastedSpendFixedNext30Days: forecast.forecast30DaysFixed,
      forecastedSpendVariableNext30Days: forecast.forecast30DaysVariable,
      forecastConfidence: forecast.forecastConfidence
    };
  },

  async getRecentPriceChanges(organisationId: string, locationId?: string, accountCodes?: string[], limit = 5): Promise<PriceChangeItem[]> {
    const last3m = getFullCalendarMonths(3);
    const now = new Date();
    
    const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, last3m.start),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    // Fetch recent lines linked to Products - only from the last 3 months
    // Using both start and end to ensure we only get invoices within the 3-month window
    const recentLines = await prisma.xeroInvoiceLineItem.findMany({
      where: {
        ...getXeroLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: last3m.start,
          endDate: now,
          supersededIds,
          accountCodes,
          xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
        }),
        productId: { not: null }
      } as any,
      include: {
        product: true,
        invoice: {
          select: { date: true, supplier: true }
        }
      },
      orderBy: {
        invoice: { date: 'desc' }
      }
    });

    // Handle Manual Data
    let manualLinesFormatted: any[] = [];
    if (shouldIncludeManualData(accountCodes)) {
      const manualLines = await prisma.invoiceLineItem.findMany({
        where: getVerifiedManualLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: last3m.start,
          endDate: now
        }),
        include: {
          invoice: {
            select: { date: true, supplier: true }
          }
        },
        orderBy: { invoice: { date: 'desc' } }
      });

      if (manualLines.length > 0) {
        // Collect product keys
        const manualItemsWithKeys = manualLines.map(line => ({
          ...line,
          productKey: getProductKeyFromLineItem(line.productCode, line.description)
        })).filter(i => i.productKey !== 'unknown');

        const distinctKeys = [...new Set(manualItemsWithKeys.map(i => i.productKey))];
        
        if (distinctKeys.length > 0) {
          // Fetch matching products
          const products = await prisma.product.findMany({
            where: {
              organisationId,
              ...(locationId ? { locationId } : {}),
              productKey: { in: distinctKeys }
            }
          });

          const productMap = new Map(products.map(p => [p.productKey, p]));

          // Map manual lines to common format
          manualLinesFormatted = manualItemsWithKeys
            .map(line => {
              const product = productMap.get(line.productKey);
              if (!product) return null;
              
              return {
                ...line,
                productId: product.id,
                product: product,
                unitAmount: line.unitPrice, // Map unitPrice to unitAmount
                invoice: line.invoice
              };
            })
            .filter(line => line !== null);
        }
      }
    }

    // Combine Xero and Manual lines
    const allLines = [...recentLines, ...manualLinesFormatted];
    
    // Group by Product ID
    const productGroups = new Map<string, typeof allLines>();
    for (const line of allLines) {
      if (!line.productId) continue;
      const existing = productGroups.get(line.productId) || [];
      existing.push(line);
      productGroups.set(line.productId, existing);
    }
    
    const results: PriceChangeItem[] = [];
    
    for (const [productId, lines] of productGroups.entries()) {
      // Sort lines by invoice date descending to ensure most recent is first
      // This is critical because grouping doesn't preserve the query's sort order
      const sortedLines = [...lines].sort((a, b) => {
        const dateA = a.invoice?.date ? new Date(a.invoice.date).getTime() : 0;
        const dateB = b.invoice?.date ? new Date(b.invoice.date).getTime() : 0;
        return dateB - dateA; // Descending order (newest first)
      });
      
      if (sortedLines.length < 2) continue; // Need at least 2 invoices to detect a change
      
      const latest = sortedLines[0] as any; // Casting to access relation fields properly
      const latestPrice = Number(latest.unitAmount || 0);
      if (latestPrice === 0) continue;
      
      // Validate that the latest invoice is within the last 3 months
      const latestDate = latest.invoice?.date ? new Date(latest.invoice.date) : null;
      if (!latestDate || latestDate < last3m.start || latestDate > now) {
        continue; // Skip if latest invoice is outside the 3-month window
      }
      
      // Find the most recent price that's different from the latest price
      // AND ensure it's also within the last 3 months
      let prevPrice = 0;
      let prevInvoiceDate: Date | null = null;
      for (let i = 1; i < sortedLines.length; i++) {
        const olderLine = sortedLines[i] as any;
        const olderDate = olderLine.invoice?.date ? new Date(olderLine.invoice.date) : null;
        
        // Ensure the previous invoice is also within the 3-month window
        if (!olderDate || olderDate < last3m.start || olderDate > now) {
          continue; // Skip invoices outside the 3-month window
        }
        
        const olderPrice = Number(olderLine.unitAmount || 0);
        if (olderPrice > 0 && Math.abs(olderPrice - latestPrice) > 0.01) {
          prevPrice = olderPrice;
          prevInvoiceDate = olderDate;
          break; // Found the most recent different price within the 3-month window
        }
      }
      
      // Only include if we found a valid previous price within the 3-month window
      if (prevPrice > 0 && prevInvoiceDate && prevInvoiceDate >= last3m.start) {
        const percentChange = ((latestPrice - prevPrice) / prevPrice) * 100;
        
        // Only include if change is significant (more than 0.5%)
        if (Math.abs(percentChange) > 0.5) {
             // If this change came from verified manual invoices (and the group is not mixed with Xero),
             // emit a manual-style productId so the product detail endpoint routes to manual detail logic.
             //
             // Why: manual lines are mapped to an existing Product UUID for grouping, but ProductDetail(UUID)
             // only considers Xero lines. For manual-only changes, we need a manual:* ID.
             const hasXeroLines = sortedLines.some((l: any) => l?.lineAmount != null); // XeroInvoiceLineItem has lineAmount
             const isManualLatest = (latest as any)?.lineTotal != null; // InvoiceLineItem has lineTotal

             let resolvedProductId = latest.productId || latest.product?.id || 'unknown';

             if (isManualLatest && !hasXeroLines) {
               const supplierId =
                 (latest as any)?.invoice?.supplier?.id ||
                 (latest as any)?.invoice?.supplierId;

               const normalizedKey =
                 typeof (latest as any)?.productKey === 'string'
                   ? (latest as any).productKey
                   : getProductKeyFromLineItem(
                       (latest as any)?.productCode,
                       (latest as any)?.description
                     );

               if (supplierId && normalizedKey && normalizedKey !== 'unknown') {
                 resolvedProductId = `manual:${supplierId}:${Buffer.from(normalizedKey).toString('base64')}`;
               }
             }

             results.push({
               productId: resolvedProductId,
               productName: latest.product?.name || latest.description || 'Unknown',
               supplierName: latest.invoice.supplier?.name || 'Unknown',
               latestUnitPrice: latestPrice,
               percentChange,
               effectiveDate: latest.invoice.date?.toISOString() || new Date().toISOString()
             });
        }
      }
    }
    
    results.sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
    return results.slice(0, limit);
  },

  async getSpendBreakdown(organisationId: string, locationId?: string, accountCodes?: string[]): Promise<SpendBreakdown> {
    const last6m = getFullCalendarMonths(6); // Changed from 12 to 6 as requested
    const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, last6m.start, new Date()),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    // Combine excluded IDs
    const excludedIds = [...supersededIds, ...unverifiedAttachmentIds];

    const whereInvoiceBase = {
        organisationId,
        ...(locationId ? { locationId } : {}),
        date: { gte: last6m.start, lte: new Date() },
        status: { in: ['AUTHORISED', 'PAID'] },
        deletedAt: null,
        xeroInvoiceId: { notIn: excludedIds }
    };

    // Fetch Xero and Manual line items in parallel
    const [xeroLineItemsRaw, manualLineItemsRaw] = await Promise.all([
      prisma.$queryRaw<Array<{
        lineAmount: number | null;
        supplierId: string | null;
        supplierName: string | null;
        accountCode: string | null;
      }>>`
        SELECT
          xli."lineAmount",
          xi."supplierId",
          s."name" as "supplierName",
          xli."accountCode"
        FROM "XeroInvoiceLineItem" xli
        JOIN "XeroInvoice" xi ON xli."invoiceId" = xi.id
        LEFT JOIN "Supplier" s ON xi."supplierId" = s.id
        WHERE xi."organisationId" = ${organisationId}
        AND xi."status" IN ('AUTHORISED', 'PAID')
        AND xi."deletedAt" IS NULL
        AND xi."date" >= ${last6m.start}
        AND xi."date" <= ${new Date()}
        -- EXCLUDE: superseded invoices and invoices with unverified attachments
        -- Include invoices that either:
        --   1. Have NO InvoiceFile (no attachment), OR
        --   2. Have an InvoiceFile with reviewStatus = 'VERIFIED'
        AND (
          ${excludedIds.length > 0 
            ? Prisma.sql`xi."xeroInvoiceId" NOT IN (${Prisma.join(excludedIds)})` 
            : Prisma.sql`TRUE`
          }
        )
        ${locationId ? Prisma.sql`AND xi."locationId" = ${locationId}` : Prisma.empty}
        ${accountCodes && accountCodes.length > 0 ? Prisma.sql`AND xli."accountCode" IN (${Prisma.join(accountCodes)})` : Prisma.empty}
      `,
      shouldIncludeManualData(accountCodes) ? prisma.$queryRaw<Array<{
        lineTotal: number | null;
        supplierId: string | null;
        supplierName: string | null;
        accountCode: string | null;
      }>>`
        SELECT 
          li."lineTotal",
          i."supplierId",
          s."name" as "supplierName",
          li."accountCode"
        FROM "InvoiceLineItem" li
        JOIN "Invoice" i ON li."invoiceId" = i.id
        JOIN "InvoiceFile" f ON i."invoiceFileId" = f.id
        LEFT JOIN "Supplier" s ON i."supplierId" = s.id
        WHERE i."organisationId" = ${organisationId}
        AND i."isVerified" = true
        AND i."invoiceFileId" IS NOT NULL
        AND f."reviewStatus" = 'VERIFIED'
        AND f."deletedAt" IS NULL
        AND i."deletedAt" IS NULL
        AND i."date" >= ${last6m.start}
        AND i."date" <= ${new Date()}
        ${locationId ? Prisma.sql`AND i."locationId" = ${locationId}` : Prisma.empty}
      ` : Promise.resolve([])
    ]);

    // Transform raw SQL results to match expected format
    const xeroLineItems = xeroLineItemsRaw.map((item: any) => ({
      lineAmount: item.lineAmount,
      invoice: {
        supplierId: item.supplierId,
        supplier: item.supplierName ? { name: item.supplierName } : null
      },
      accountCode: item.accountCode
    }));

    const manualLineItems = manualLineItemsRaw.map((item: any) => ({
      lineTotal: item.lineTotal,
      invoice: {
        supplierId: item.supplierId,
        supplier: item.supplierName ? { name: item.supplierName } : null
      },
      accountCode: item.accountCode
    }));

    const supplierMap = new Map<string, { name: string, total: number }>();
    const categoryMap = new Map<string, { total: number }>();

    // Process Xero line items
    for (const item of xeroLineItems as any[]) {
        const amount = Number(item.lineAmount || 0);
        if (amount <= 0) continue;

        // Supplier
        const supId = item.invoice.supplierId;
        const supName = item.invoice.supplier?.name || 'Unknown';
        if (supId) {
             if (!supplierMap.has(supId)) {
                 supplierMap.set(supId, { name: supName, total: 0 });
             }
             supplierMap.get(supId)!.total += amount;
        }

        // Category
        if (item.accountCode) {
            if (!categoryMap.has(item.accountCode)) {
                categoryMap.set(item.accountCode, { total: 0 });
            }
            categoryMap.get(item.accountCode)!.total += amount;
        }
    }

    // Process Manual line items
    for (const item of manualLineItems as any[]) {
        const amount = Number(item.lineTotal || 0);
        if (amount <= 0) continue;

        // Supplier
        const supId = item.invoice.supplierId;
        const supName = item.invoice.supplier?.name || 'Unknown';
        if (supId) {
             if (!supplierMap.has(supId)) {
                 supplierMap.set(supId, { name: supName, total: 0 });
             }
             supplierMap.get(supId)!.total += amount;
        }

        // Category (manual invoices use MANUAL_COGS_ACCOUNT_CODE)
        const accountCode = item.accountCode || MANUAL_COGS_ACCOUNT_CODE;
        if (!categoryMap.has(accountCode)) {
            categoryMap.set(accountCode, { total: 0 });
        }
        categoryMap.get(accountCode)!.total += amount;
    }

    const bySupplier = Array.from(supplierMap.entries())
        .filter(([id, data]) => data.total > 0) // Filter out suppliers with zero spend
        .map(([id, data]) => ({
            supplierId: id,
            supplierName: data.name,
            totalSpend12m: data.total
        }))
        .sort((a, b) => b.totalSpend12m - a.totalSpend12m);

    const byCategory = Array.from(categoryMap.entries()).map(([code, data]) => ({
        categoryId: code,
        categoryName: getCategoryName(code),
        totalSpend12m: data.total
    })).sort((a, b) => b.totalSpend12m - a.totalSpend12m);

    return { bySupplier, byCategory };
  },

  async getCostCreepAlerts(organisationId: string, locationId?: string, accountCodes?: string[], thresholdPercent = 5): Promise<CostCreepAlert[]> {
    const thisMonth = getCurrentMonthRange();
    const last3m = getFullCalendarMonths(3);
    const whereBase = {
        organisationId,
        ...(locationId ? { locationId } : {}),
    };
    
    const [supersededIdsThisMonth, supersededIdsLast3m, unverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, thisMonth.start, thisMonth.end),
      getSupersededXeroIds(organisationId, locationId, last3m.start, last3m.end),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    const getAvgUnitPrices = async (start: Date, end: Date, supersededIds: string[]) => {
        // Group by Product ID
        const aggs = await prisma.xeroInvoiceLineItem.groupBy({
            by: ['productId'],
            where: {
                ...getXeroLineItemWhere({
                    orgId: organisationId,
                    locationId,
                    startDate: start,
                    endDate: end,
                    supersededIds,
                    accountCodes,
                    xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
                }),
                productId: { not: null },
                quantity: { not: 0 }
            } as any,
            _sum: { lineAmount: true, quantity: true }
        });
        
        const map = new Map<string, number>();
        for (const agg of aggs) {
            if (!agg.productId) continue;
            const total = agg._sum.lineAmount?.toNumber() || 0;
            const qty = agg._sum.quantity?.toNumber() || 0;
            if (qty > 0) {
                map.set(agg.productId, total / qty);
            }
        }
        return map;
    };
    
    const [thisMonthPrices, trailing3mPrices] = await Promise.all([
        getAvgUnitPrices(thisMonth.start, thisMonth.end, supersededIdsThisMonth),
        getAvgUnitPrices(last3m.start, last3m.end, supersededIdsLast3m)
    ]);
    
    const potentialAlerts: { productId: string; percentIncrease: number }[] = [];

    for (const [key, currentPrice] of thisMonthPrices.entries()) {
        const oldPrice = trailing3mPrices.get(key);
        if (oldPrice && oldPrice > 0) {
            const percentIncrease = ((currentPrice - oldPrice) / oldPrice) * 100;
            if (percentIncrease >= thresholdPercent) {
                potentialAlerts.push({ productId: key, percentIncrease });
            }
        }
    }

    const alerts: CostCreepAlert[] = [];
    
    if (potentialAlerts.length > 0) {
        // Fetch Product details for names and suppliers
        const products = await prisma.product.findMany({
            where: { id: { in: potentialAlerts.map(p => p.productId) } },
            include: { supplier: true }
        });
        
        const productMap = new Map(products.map(p => [p.id, p]));
        
        for(const p of potentialAlerts) {
            const product = productMap.get(p.productId);
            // If product has no primary supplier, we might need to resolve from invoices, but for now take product supplier or fallback
            // Wait, alerts list shows Supplier Name.
            // If Product.supplierId is null, we can't show "Supplier Name" easily without looking at invoices.
            // Let's try to resolve from Product.supplier first.
            // If null, skip or label unknown.
            if (product && product.supplier) {
                alerts.push({
                    supplierId: product.supplier.id,
                    supplierName: product.supplier.name,
                    percentIncrease: p.percentIncrease
                });
            } else if (product) {
                 // Fallback: find latest invoice for this product to get supplier
                 const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
                   getSupersededXeroIds(organisationId, locationId),
                   getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
                 ]);
                 const excludedIds = [...supersededIds, ...unverifiedAttachmentIds];
                 const latestLine = await prisma.xeroInvoiceLineItem.findFirst({
                     where: { 
                         productId: product.id, 
                         invoice: { 
                             ...whereBase, 
                             deletedAt: null,
                             xeroInvoiceId: { notIn: excludedIds } 
                         } 
                     } as any,
                     include: { invoice: { include: { supplier: true } } },
                     orderBy: { invoice: { date: 'desc' } }
                 });
                 if (latestLine?.invoice?.supplier) {
                     alerts.push({
                        supplierId: latestLine.invoice.supplier.id,
                        supplierName: latestLine.invoice.supplier.name,
                        percentIncrease: p.percentIncrease
                     });
                 }
            }
        }
    }
    
    alerts.sort((a, b) => b.percentIncrease - a.percentIncrease);
    return alerts;
  },

  async refreshProductStatsForLocation(
    organisationId: string,
    locationId: string,
    accountCodes?: string[]
  ): Promise<{ accountCodesHash: string; statsAsOf: Date; count: number }> {
    const accountCodesHash = toAccountCodesHash(accountCodes);
    const last12m = getFullCalendarMonths(12);
    const statsAsOf = new Date();

    const whereInvoiceBase = {
      organisationId,
      locationId,
      deletedAt: null,
    };

    const xeroProducts = await prisma.product.findMany({
      where: { organisationId, locationId },
      select: { id: true, name: true, supplier: { select: { name: true } } },
    });

    const productIds = xeroProducts.map((p) => p.id);
    const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, last12m.start),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);

    const xeroStats = productIds.length
      ? await prisma.xeroInvoiceLineItem.groupBy({
          by: ['productId'],
          where: {
            ...getXeroLineItemWhere({
              orgId: organisationId,
              locationId,
              startDate: last12m.start,
              endDate: new Date(),
              supersededIds,
              accountCodes,
              xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
            }),
            productId: { in: productIds }
          } as any,
          _sum: { lineAmount: true },
        })
      : [];

    const xeroSpendMap = new Map<string, number>();
    xeroStats.forEach((s) => {
      if (s.productId) xeroSpendMap.set(String(s.productId), s._sum.lineAmount?.toNumber() || 0);
    });

    const manualStats = await prisma.invoiceLineItem.groupBy({
      by: ['productCode', 'description', 'invoiceId'],
      where: {
        ...getVerifiedManualLineItemWhere({
          orgId: organisationId,
          locationId,
          startDate: last12m.start,
          endDate: new Date()
        }),
        ...(accountCodes && accountCodes.length > 0
          ? {
              OR: [
                { accountCode: { in: accountCodes } },
                ...(accountCodes.includes(MANUAL_COGS_ACCOUNT_CODE) ? [{ accountCode: null }] : []),
              ],
            }
          : {}),
      } as any,
      _sum: { lineTotal: true },
    });

    const manualInvoiceIds = [...new Set(manualStats.map((s) => s.invoiceId))];
    const manualInvoices = manualInvoiceIds.length
      ? await prisma.invoice.findMany({
          where: { id: { in: manualInvoiceIds } },
          select: { id: true, supplierId: true, supplier: { select: { name: true } } },
        })
      : [];
    const invoiceSupplierMap = new Map(manualInvoices.map((i) => [i.id, i]));

    const mergedMap = new Map<
      string,
      { productId: string; productName: string; supplierName: string; spend12m: number; isManual: boolean }
    >();

    for (const p of xeroProducts) {
      mergedMap.set(p.id, {
        productId: p.id,
        productName: p.name,
        supplierName: p.supplier?.name || 'Unknown',
        spend12m: xeroSpendMap.get(p.id) || 0,
        isManual: false,
      });
    }

    for (const stat of manualStats) {
      const inv = invoiceSupplierMap.get(stat.invoiceId);
      if (!inv || !inv.supplierId) continue;

      const key = (stat.productCode || stat.description || 'Unknown').trim();
      const normalizedKey = key.toLowerCase();
      const compositeKey = `${inv.supplierId}::${normalizedKey}`;
      const spend = stat._sum.lineTotal?.toNumber() || 0;

      const existing = mergedMap.get(compositeKey);
      if (existing) {
        existing.spend12m += spend;
      } else {
        const id = `manual:${inv.supplierId}:${Buffer.from(normalizedKey).toString('base64')}`;
        mergedMap.set(compositeKey, {
          productId: id,
          productName: key,
          supplierName: inv.supplier?.name || 'Unknown',
          spend12m: spend,
          isManual: true,
        });
      }
    }

    const rows = Array.from(mergedMap.values())
      .filter((i) => i.spend12m > 0)
      .map((i) => ({
        organisationId,
        locationId,
        accountCodesHash,
        source: i.isManual ? ('MANUAL' as const) : ('XERO' as const),
        productId: i.productId,
        productName: i.productName,
        supplierName: i.supplierName,
        spend12m: new Prisma.Decimal(i.spend12m),
        statsAsOf,
      }));

    await prisma.$transaction(async (tx) => {
      // Cast to avoid TS tooling drift around Prisma type generation.
      await (tx as any).productStats.deleteMany({ where: { organisationId, locationId, accountCodesHash } });
      if (rows.length > 0) {
        await (tx as any).productStats.createMany({ data: rows });
      }
    });

    return { accountCodesHash, statsAsOf, count: rows.length };
  },

  async refreshProductStatsNightly(): Promise<void> {
    const locations = await prisma.location.findMany({ select: { id: true, organisationId: true } });

    for (const loc of locations) {
      try {
        await this.refreshProductStatsForLocation(loc.organisationId, loc.id, undefined);

        const codes = await prisma.locationAccountConfig.findMany({
          where: { locationId: loc.id, category: 'COGS' },
          select: { accountCode: true },
        });
        const accountCodes = codes.map((c) => c.accountCode).filter(Boolean);
        if (accountCodes.length > 0) {
          await this.refreshProductStatsForLocation(loc.organisationId, loc.id, accountCodes);
        }
      } catch (e) {
        console.error(`[ProductStats] Nightly refresh failed for org=${loc.organisationId} loc=${loc.id}`, e);
      }
    }
  },

  async getProducts(organisationId: string, locationId: string | undefined, params: GetProductsParams): Promise<PaginatedResult<ProductListItem>> {
    const { page, limit: pageSize, skip } = getOffsetPaginationOrThrow({
      page: params.page || 1,
      limit: params.pageSize || 20,
      maxLimit: 100,
      maxOffset: 5000,
    });
    const last12m = getFullCalendarMonths(12);

    let statsAsOf: string | null = null;
    let totalItems = 0;
    let totalPages = 0;
    let paginatedItems: Array<{
        productId: string;
        productName: string;
        supplierName: string;
        latestUnitCost: number;
        lastPriceChangePercent: number;
        spend12m: number;
    }> = [];

    if (!locationId) {
        // Org-wide fallback (used by some tests / internal callers).
        // The production route is location-scoped and uses ProductStats for DB-driven pagination.
        const whereClause: Prisma.ProductWhereInput = { organisationId };
        if (params.search) {
            whereClause.OR = [
                { name: { contains: params.search, mode: 'insensitive' } },
                { productKey: { contains: params.search, mode: 'insensitive' } },
                { supplier: { name: { contains: params.search, mode: 'insensitive' } } }
            ];
        }

        const whereInvoiceBase = { organisationId, deletedAt: null };

        const xeroProducts = await prisma.product.findMany({
            where: whereClause,
            select: { id: true, name: true, productKey: true, supplierId: true, supplier: { select: { name: true } } }
        });

        const productIds = xeroProducts.map(p => p.id);
        const supersededIds = await getSupersededXeroIds(organisationId, locationId, last12m.start);
        const xeroStats = await prisma.xeroInvoiceLineItem.groupBy({
            by: ['productId'],
            where: {
                ...getXeroLineItemWhere({
                    orgId: organisationId,
                    locationId: undefined,
                    startDate: last12m.start,
                    endDate: new Date(),
                    supersededIds,
                    accountCodes: params.accountCodes
                }),
                productId: { in: productIds }
            } as any,
            _sum: { lineAmount: true }
        });

        const manualStats = await prisma.invoiceLineItem.groupBy({
            by: ['productCode', 'description', 'invoiceId'],
            where: {
                ...getVerifiedManualLineItemWhere({
                    orgId: organisationId,
                    locationId: undefined,
                    startDate: last12m.start,
                    endDate: new Date()
                }),
                ...(params.accountCodes && params.accountCodes.length > 0
                    ? {
                        OR: [
                            { accountCode: { in: params.accountCodes } },
                            ...(params.accountCodes.includes(MANUAL_COGS_ACCOUNT_CODE) ? [{ accountCode: null }] : [])
                        ]
                      }
                    : {}),
                ...(params.search ? {
                    OR: [
                        { productCode: { contains: params.search, mode: 'insensitive' } },
                        { description: { contains: params.search, mode: 'insensitive' } },
                        { invoice: { supplier: { name: { contains: params.search, mode: 'insensitive' } } } }
                    ]
                } : {})
            } as any,
            _sum: { lineTotal: true }
        });

        const manualInvoiceIds = [...new Set(manualStats.map(s => s.invoiceId))];
        const manualInvoices = await prisma.invoice.findMany({
            where: { id: { in: manualInvoiceIds } },
            select: { id: true, supplierId: true, supplier: { select: { name: true } } }
        });
        const invoiceSupplierMap = new Map(manualInvoices.map(i => [i.id, i]));

        const mergedMap = new Map<string, {
            productId: string;
            productName: string;
            supplierId?: string;
            supplierName: string;
            spend12m: number;
            isManual: boolean;
        }>();

        const xeroSpendMap = new Map<string, number>();
        xeroStats.forEach(s => {
            if (s.productId) xeroSpendMap.set(s.productId, s._sum.lineAmount?.toNumber() || 0);
        });

        for (const p of xeroProducts) {
            mergedMap.set(p.id, {
                productId: p.id,
                productName: p.name,
                supplierId: p.supplierId || undefined,
                supplierName: p.supplier?.name || 'Unknown',
                spend12m: xeroSpendMap.get(p.id) || 0,
                isManual: false
            });
        }

        for (const stat of manualStats) {
            const inv = invoiceSupplierMap.get(stat.invoiceId);
            if (!inv || !inv.supplierId) continue;

            const key = (stat.productCode || stat.description || 'Unknown').trim();
            const normalizedKey = key.toLowerCase();
            const compositeKey = `${inv.supplierId}::${normalizedKey}`;
            const spend = stat._sum.lineTotal?.toNumber() || 0;

            const existingManual = mergedMap.get(compositeKey);
            if (existingManual) {
                existingManual.spend12m += spend;
            } else {
                const id = `manual:${inv.supplierId}:${Buffer.from(normalizedKey).toString('base64')}`;
                mergedMap.set(compositeKey, {
                    productId: id,
                    productName: key,
                    supplierId: inv.supplierId,
                    supplierName: inv.supplier?.name || 'Unknown',
                    spend12m: spend,
                    isManual: true
                });
            }
        }

        let items = Array.from(mergedMap.values()).map(i => ({
            productId: i.productId,
            productName: i.productName,
            supplierName: i.supplierName,
            latestUnitCost: 0,
            lastPriceChangePercent: 0,
            spend12m: i.spend12m
        }));

        items = items.filter(i => i.spend12m > 0);

        if (params.sortBy === 'productName' || params.sortBy === 'supplierName') {
            items.sort((a, b) => {
                const valA = a[params.sortBy as keyof typeof a] as string;
                const valB = b[params.sortBy as keyof typeof a] as string;
                return params.sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            });
        } else {
            items.sort((a, b) => params.sortDirection === 'asc' ? a.spend12m - b.spend12m : b.spend12m - a.spend12m);
        }

        totalItems = items.length;
        totalPages = Math.ceil(totalItems / pageSize);
        paginatedItems = items.slice(skip, skip + pageSize);
    } else {
        const accountCodesHash = toAccountCodesHash(params.accountCodes);

        // Ensure stats exist (nightly cron fills this; on-demand fallback keeps endpoint working immediately after deploy)
        const existingCount = await (prisma as any).productStats.count({
            where: { organisationId, locationId, accountCodesHash }
        });
        if (existingCount === 0) {
            await this.refreshProductStatsForLocation(organisationId, locationId, params.accountCodes);
        }

        const whereStats: any = {
            organisationId,
            locationId,
            accountCodesHash,
            ...(params.search ? {
                OR: [
                    { productName: { contains: params.search, mode: 'insensitive' } },
                    { supplierName: { contains: params.search, mode: 'insensitive' } },
                ]
            } : {})
        };

        totalItems = await (prisma as any).productStats.count({ where: whereStats });
        totalPages = Math.ceil(totalItems / pageSize);

        const sortDirection = params.sortDirection === 'asc' ? 'asc' : 'desc';
        const statsRows: any[] = await (prisma as any).productStats.findMany({
            where: whereStats,
            orderBy: (params.sortBy === 'productName')
                ? { productName: sortDirection }
                : (params.sortBy === 'supplierName')
                    ? { supplierName: sortDirection }
                    : { spend12m: sortDirection },
            take: pageSize,
            skip
        });

        statsAsOf = statsRows.length > 0 ? statsRows[0].statsAsOf.toISOString() : null;

        paginatedItems = statsRows.map((row: any) => ({
            productId: row.productId,
            productName: row.productName,
            supplierName: row.supplierName,
            latestUnitCost: 0,
            lastPriceChangePercent: 0,
            spend12m: row.spend12m.toNumber()
        }));
    }

    // 1.5 Resolve Missing Suppliers (Only for Xero items that might be missing it)
    // (Manual items always have supplier from invoice)
    const unknownProductIds = paginatedItems
        .filter(p => p.supplierName === 'Unknown' && !p.productId.startsWith('manual:'))
        .map(p => p.productId);

    if (unknownProductIds.length > 0) {
        const supersededIds = await getSupersededXeroIds(organisationId, locationId); // No date range as we need latest regardless of date
        const resolvedSuppliers = await prisma.xeroInvoiceLineItem.findMany({
            where: {
                productId: { in: unknownProductIds },
                invoice: {
                    status: { not: 'VOIDED' },
                    deletedAt: null,
                    xeroInvoiceId: { notIn: supersededIds }
                }
            } as any,
            distinct: ['productId'],
            orderBy: {
                invoice: { date: 'desc' }
            },
            select: {
                productId: true,
                invoice: {
                    select: {
                        supplier: {
                            select: { name: true }
                        }
                    }
                }
            }
        });

        const resolvedMap = new Map<string, string>();
        for (const res of resolvedSuppliers) {
            if (res.productId && res.invoice.supplier?.name) {
                resolvedMap.set(res.productId, res.invoice.supplier.name);
            }
        }

        for (const item of paginatedItems) {
            if (item.supplierName === 'Unknown' && resolvedMap.has(item.productId)) {
                item.supplierName = resolvedMap.get(item.productId)!;
            }
        }
    }
    
    // 2. Hydrate Price Data Efficiently (Bulk)
    const pageProductIds = paginatedItems.map(p => p.productId);
    const priceLookbackDate = subMonths(new Date(), 12); 

    // Extract Xero Product IDs and Manual Keys
    const xeroProductIds = pageProductIds.filter(id => !id.startsWith('manual:'));
    const manualProductIds = pageProductIds.filter(id => id.startsWith('manual:'));

    // 2a. Fetch Latest Xero Details (Description, ItemCode)
    let latestXeroByProductId = new Map<string, { description: string | null; itemCode: string | null }>();
    if (xeroProductIds.length > 0) {
        const xeroDetails = await prisma.xeroInvoiceLineItem.findMany({
            where: {
                productId: { in: xeroProductIds },
                invoice: {
                    organisationId,
                    ...(locationId ? { locationId } : {}),
                    deletedAt: null
                } as any
            },
            orderBy: {
                invoice: { date: 'desc' }
            },
            select: {
                productId: true,
                description: true,
                itemCode: true
            }
        });

        for (const detail of xeroDetails) {
            if (detail.productId && !latestXeroByProductId.has(detail.productId)) {
                latestXeroByProductId.set(detail.productId, {
                    description: detail.description,
                    itemCode: detail.itemCode
                });
            }
        }
    }

    // 2b. Fetch Latest Manual Details
    let latestManualByKey = new Map<string, { description: string | null; itemCode: string | null }>();
    if (manualProductIds.length > 0) {
        // We need to match by productCode or description using the same logic as aggregation
        // manual:supplierId:base64(key)
        const manualQueries = manualProductIds.map(async (manualId) => {
             const parts = manualId.split(':');
             if (parts.length !== 3) return null;
             const supplierId = parts[1];
             let productKey = '';
             try {
                productKey = Buffer.from(parts[2], 'base64').toString('utf-8');
             } catch (e) { return null; }
             const normalizedKey = productKey.toLowerCase().trim();

             const latestLine = await prisma.invoiceLineItem.findFirst({
                 where: {
                     ...getVerifiedManualLineItemWhere({
                         orgId: organisationId,
                         locationId
                     }),
                     invoice: {
                         supplierId
                     } as any,
                     OR: [
                        { productCode: { equals: normalizedKey, mode: 'insensitive' } },
                        {
                            AND: [
                                { productCode: null },
                                { description: { contains: productKey, mode: 'insensitive' } }
                            ]
                        }
                    ]
                 },
                 orderBy: { invoice: { date: 'desc' } },
                 select: {
                     description: true,
                     productCode: true
                 }
             });
             
             if (latestLine) {
                 return { manualId, description: latestLine.description, itemCode: latestLine.productCode };
             }
             return null;
        });
        
        const manualResults = await Promise.all(manualQueries);
        for (const res of manualResults) {
            if (res) {
                latestManualByKey.set(res.manualId, { description: res.description, itemCode: res.itemCode });
            }
        }
    }
    
    const priceMap = await computeWeightedAveragePrices(organisationId, pageProductIds, priceLookbackDate, new Date(), locationId, params.accountCodes);

    const hydratedItems = paginatedItems.map(item => {
        const productPrices = priceMap.get(item.productId);
        let latestUnitCost = 0;
        let lastPriceChangePercent = 0;

        if (productPrices && productPrices.size > 0) {
            const sortedMonths = Array.from(productPrices.keys()).sort().reverse();
            const latestMonth = sortedMonths[0];
            latestUnitCost = productPrices.get(latestMonth) || 0;

            if (sortedMonths.length > 1) {
                const prevMonth = sortedMonths[1];
                const prevCost = productPrices.get(prevMonth) || 0;
                if (prevCost > 0) {
                    lastPriceChangePercent = ((latestUnitCost - prevCost) / prevCost) * 100;
                }
            }
        }

        // Hydrate description and itemCode
        let description: string | null = null;
        let itemCode: string | null = null;

        if (item.productId.startsWith('manual:')) {
            const details = latestManualByKey.get(item.productId);
            if (details) {
                description = details.description;
                itemCode = details.itemCode;
            } else {
                description = item.productName; // Fallback
            }
        } else {
            const details = latestXeroByProductId.get(item.productId);
            if (details) {
                description = details.description;
                itemCode = details.itemCode;
            }
        }

        return { 
            ...item, 
            latestUnitCost, 
            lastPriceChangePercent,
            description: description || item.productName, // Ensure we always have something
            itemCode: itemCode || null
        };
    });
    
    return {
        items: hydratedItems,
        pagination: { page, pageSize, totalItems, totalPages },
        statsAsOf,
    };
  },

  async getManualProductDetail(organisationId: string, productId: string, locationId?: string): Promise<ProductDetail | null> {
    // Parse manual ID: manual:supplierId:base64Key
    const parts = productId.split(':');
    if (parts.length !== 3 || parts[0] !== 'manual') {
        return null;
    }
    
    const supplierId = parts[1];
    const keyBase64 = parts[2];
    let productKey: string;
    try {
        productKey = Buffer.from(keyBase64, 'base64').toString('utf-8');
    } catch (e) {
        return null;
    }

    // Verify supplier exists and belongs to org
    const supplier = await prisma.supplier.findUnique({
        where: { id: supplierId }
    });
    
    if (!supplier || supplier.organisationId !== organisationId) {
        return null;
    }

    // Date ranges
    const now = new Date();
    const startOfCurrentMonth = startOfMonth(now);
    const windowStart = startOfMonth(subMonths(startOfCurrentMonth, 12)); // Last 12 full months

    const whereInvoiceBase = {
        organisationId,
        supplierId,
        ...(locationId ? { locationId } : {}),
        isVerified: true,
        invoiceFileId: { not: null },
        invoiceFile: {
            reviewStatus: 'VERIFIED',
            deletedAt: null
        },
    };

    // Build where clause for line items matching the product key
    // Match either productCode or normalized description
    const normalizedKey = productKey.toLowerCase().trim();

    // 1. Calculate Stats (Spend, Qty) using InvoiceLineItem aggregation
    const lineItems = await prisma.invoiceLineItem.findMany({
        where: {
            invoice: {
                ...whereInvoiceBase,
                date: { gte: windowStart, lte: now },
                deletedAt: null
            },
            isIncludedInAnalytics: true, // Only include items marked for inclusion in analytics
            OR: [
                { productCode: { equals: normalizedKey, mode: 'insensitive' } },
                {
                    AND: [
                        { productCode: null },
                        { description: { contains: productKey, mode: 'insensitive' } }
                    ]
                }
            ]
        } as any,
        select: {
            lineTotal: true,
            quantity: true,
            unitPrice: true,
            description: true,
            productCode: true,
            accountCode: true,
            invoice: {
                select: {
                    date: true
                }
            }
        }
    });

    // Filter more strictly in JS to match exact key
    // The key is generated as: COALESCE(productCode, LOWER(TRIM(description)))
    // So we match if: (productCode exists and matches) OR (productCode is null and normalized description matches)
    const filteredItems = lineItems.filter(item => {
        const itemProductCode = item.productCode?.toLowerCase().trim();
        const itemDescription = item.description?.toLowerCase().trim() || '';
        
        if (itemProductCode) {
            return itemProductCode === normalizedKey;
        } else {
            return itemDescription === normalizedKey;
        }
    });

    if (filteredItems.length === 0) {
        // Fallback: Check if product exists historically (outside 12m window)
        // We just need one item to confirm existence and get metadata
        const fallbackItems = await prisma.invoiceLineItem.findMany({
            where: {
                ...getVerifiedManualLineItemWhere({
                    orgId: organisationId,
                    locationId,
                    endDate: now
                }),
                invoice: {
                    supplierId
                } as any,
                 OR: [
                    { productCode: { equals: normalizedKey, mode: 'insensitive' } },
                    {
                        AND: [
                            { productCode: null },
                            { description: { contains: productKey, mode: 'insensitive' } }
                        ]
                    }
                ]
            } as any,
            orderBy: { invoice: { date: 'desc' } },
            take: 50, // Fetch a few to filter in JS
            select: {
                lineTotal: true,
                quantity: true,
                unitPrice: true,
                description: true,
                productCode: true,
                accountCode: true,
                invoice: {
                    select: {
                        date: true
                    }
                }
            }
        });

        const validFallback = fallbackItems.find(item => {
             const itemProductCode = item.productCode?.toLowerCase().trim();
             const itemDescription = item.description?.toLowerCase().trim() || '';
             
             if (itemProductCode) {
                 return itemProductCode === normalizedKey;
             } else {
                 return itemDescription === normalizedKey;
             }
        });

        if (!validFallback) {
             return null;
        }

        // Found valid item, but no history in last 12m. Return empty stats.
        const emptyHistory = Array(12).fill(null).map((_, i) => {
             const d = new Date();
             d.setMonth(d.getMonth() - (11 - i));
             return {
                 monthLabel: getMonthLabel(d),
                 averageUnitPrice: null
             };
        });
        
        // Resolve Category
        let fallbackCategoryName = 'Uncategorized';
        if (validFallback.accountCode) {
            fallbackCategoryName = getCategoryName(validFallback.accountCode);
        }

        return {
            productId: productId,
            productName: validFallback.description || productKey,
            supplierName: supplier.name,
            categoryName: fallbackCategoryName,
            itemCode: productKey,
            stats12m: {
                totalSpend12m: 0,
                averageMonthlySpend: 0,
                quantityPurchased12m: 0,
                spendTrend12mPercent: 0
            },
            priceHistory: emptyHistory,
            unitPriceHistory: emptyHistory,
            productPriceTrendPercent: 0,
            canCalculateProductPriceTrend: false,
            latestUnitCost: Number(validFallback.unitPrice || 0)
        };
    }

    // Calculate totals
    const totalSpend12m = filteredItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
    const quantityPurchased12m = filteredItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const averageMonthlySpend = totalSpend12m / 12;

    // Calculate spend trend (last 6m vs prev 6m)
    const last6m = getFullCalendarMonths(6);
    const prev6mStart = new Date(last6m.start);
    prev6mStart.setMonth(prev6mStart.getMonth() - 6);
    const prev6mEnd = new Date(last6m.start);
    prev6mEnd.setDate(prev6mEnd.getDate() - 1);
    prev6mEnd.setHours(23, 59, 59, 999);

    const last6mItems = filteredItems.filter(item => {
        const itemDate = item.invoice.date;
        return itemDate && itemDate >= last6m.start && itemDate <= last6m.end;
    });
    const prev6mItems = filteredItems.filter(item => {
        const itemDate = item.invoice.date;
        return itemDate && itemDate >= prev6mStart && itemDate <= prev6mEnd;
    });

    const sLast = last6mItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
    const sPrev = prev6mItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
    let spendTrend12mPercent = 0;
    if (sPrev > 0) {
        spendTrend12mPercent = ((sLast - sPrev) / sPrev) * 100;
    }

    // 2. Price History (Last 12 months) - group by month
    const priceHistoryMap = new Map<string, { totalAmount: number; totalQty: number }>();

    for (const item of filteredItems) {
        if (!item.invoice.date) continue;
        const monthKey = `${item.invoice.date.getFullYear()}-${String(item.invoice.date.getMonth() + 1).padStart(2, '0')}`;
        const amount = Number(item.lineTotal || 0);
        const qty = Number(item.quantity || 0);
        
        if (qty <= 0) continue;

        const existing = priceHistoryMap.get(monthKey) || { totalAmount: 0, totalQty: 0 };
        priceHistoryMap.set(monthKey, {
            totalAmount: existing.totalAmount + amount,
            totalQty: existing.totalQty + qty
        });
    }

    // Build price history array for last 12 months
    const priceHistory: { monthLabel: string; averageUnitPrice: number | null }[] = [];
    const unitPriceHistory: { monthLabel: string; averageUnitPrice: number | null }[] = [];

    for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = getMonthLabel(d);
        
        const monthData = priceHistoryMap.get(monthKey);
        const price = monthData && monthData.totalQty > 0 
            ? monthData.totalAmount / monthData.totalQty 
            : null;
        
        priceHistory.push({ monthLabel: label, averageUnitPrice: price });
        unitPriceHistory.push({ monthLabel: label, averageUnitPrice: price });
    }

    // 3. Calculate Product Price Trend
    let productPriceTrendPercent = 0;
    let canCalculateProductPriceTrend = false;

    const sortedMonths = Array.from(priceHistoryMap.keys()).sort();
    if (sortedMonths.length >= 2) {
        const latestMonth = sortedMonths[sortedMonths.length - 1];
        const latestData = priceHistoryMap.get(latestMonth);
        const latestPrice = latestData && latestData.totalQty > 0 
            ? latestData.totalAmount / latestData.totalQty 
            : 0;

        // Find comparison point approx 3-6 months back
        const lookbackIndex = sortedMonths.length - 4;
        let comparisonPrice = 0;
        if (lookbackIndex >= 0) {
            const comparisonData = priceHistoryMap.get(sortedMonths[lookbackIndex]);
            comparisonPrice = comparisonData && comparisonData.totalQty > 0
                ? comparisonData.totalAmount / comparisonData.totalQty
                : 0;
        } else if (sortedMonths.length > 0) {
            const oldestData = priceHistoryMap.get(sortedMonths[0]);
            comparisonPrice = oldestData && oldestData.totalQty > 0
                ? oldestData.totalAmount / oldestData.totalQty
                : 0;
        }

        if (comparisonPrice > 0 && latestPrice > 0) {
            productPriceTrendPercent = ((latestPrice - comparisonPrice) / comparisonPrice) * 100;
            canCalculateProductPriceTrend = true;
        }
    }

    // Calculate latestUnitCost from priceHistory (most recent non-null)
    let latestUnitCost = 0;
    for (let i = 0; i < priceHistory.length; i++) {
        if (priceHistory[i].averageUnitPrice !== null) {
            latestUnitCost = priceHistory[i].averageUnitPrice!;
        }
    }

    // Get product name from most recent item
    const productName = filteredItems[filteredItems.length - 1]?.description || 'Unknown Product';

    // Resolve Category Name (from most frequent account code)
    let categoryName = 'Uncategorized';
    const accountCodeCounts = new Map<string, number>();
    for (const item of filteredItems) {
        const accountCode = item.accountCode;
        if (accountCode) {
            accountCodeCounts.set(accountCode, (accountCodeCounts.get(accountCode) || 0) + 1);
        }
    }
    
    if (accountCodeCounts.size > 0) {
        const topCategory = Array.from(accountCodeCounts.entries())
            .sort((a, b) => b[1] - a[1])[0];
        if (topCategory) {
            categoryName = getCategoryName(topCategory[0]);
        }
    }

    return {
        productId: productId,
        productName: productName,
        supplierName: supplier.name,
        categoryName,
        itemCode: productKey,
        stats12m: {
            totalSpend12m,
            averageMonthlySpend,
            quantityPurchased12m,
            spendTrend12mPercent
        },
        priceHistory,
        unitPriceHistory,
        productPriceTrendPercent,
        canCalculateProductPriceTrend,
        latestUnitCost
    };
  },

  async getProductDetail(organisationId: string, productId: string, locationId?: string): Promise<ProductDetail | null> {
    // Check if this is a manual product ID (format: manual:supplierId:base64Key)
    if (productId.startsWith('manual:')) {
        return this.getManualProductDetail(organisationId, productId, locationId);
    }

    const product = await prisma.product.findUnique({
        where: { id: productId },
        include: { supplier: true }
    });
    
    if (!product || product.organisationId !== organisationId) return null;
    
    // Date ranges
    const now = new Date();
    const startOfCurrentMonth = startOfMonth(now); 
    const windowStart = startOfMonth(subMonths(startOfCurrentMonth, 12)); // Last 12 full months
    
    const whereInvoiceBase = {
        organisationId,
        ...(locationId ? { locationId } : {}),
        deletedAt: null
    };

    // 1. Calculate Stats (Spend, Qty) using raw aggregation
    const [supersededIds, unverifiedAttachmentIds] = await Promise.all([
      getSupersededXeroIds(organisationId, locationId, windowStart),
      getXeroInvoiceIdsWithUnverifiedAttachments(organisationId, locationId)
    ]);
    const excludedIds = [...supersededIds, ...unverifiedAttachmentIds];
    const statsAgg = await prisma.xeroInvoiceLineItem.aggregate({
        where: {
            productId: productId,
            invoice: {
                ...whereInvoiceBase,
                date: { gte: windowStart, lte: now },
                status: { in: ['AUTHORISED', 'PAID'] },
                xeroInvoiceId: { notIn: excludedIds }
            }
        } as any,
        _sum: { lineAmount: true, quantity: true }
    });

    const totalSpend12m = statsAgg._sum.lineAmount?.toNumber() || 0;
    const quantityPurchased12m = statsAgg._sum.quantity?.toNumber() || 0;
    const averageMonthlySpend = totalSpend12m / 12;

    // 1.5 Trend
    // Compare last 6m vs prev 6m
    const last6m = getFullCalendarMonths(6);
    const prev6mStart = new Date(last6m.start);
    prev6mStart.setMonth(prev6mStart.getMonth() - 6);
    const prev6mEnd = new Date(last6m.start);
    prev6mEnd.setDate(prev6mEnd.getDate() - 1);

    const last6mSpend = await prisma.xeroInvoiceLineItem.aggregate({
        where: {
            ...getXeroLineItemWhere({
                orgId: organisationId,
                locationId,
                startDate: last6m.start,
                endDate: last6m.end,
                supersededIds,
                accountCodes: undefined,
                xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
            }),
            productId: productId
        } as any,
        _sum: { lineAmount: true }
    });
    const prev6mSpend = await prisma.xeroInvoiceLineItem.aggregate({
        where: {
            ...getXeroLineItemWhere({
                orgId: organisationId,
                locationId,
                startDate: prev6mStart,
                endDate: prev6mEnd,
                supersededIds,
                accountCodes: undefined,
                xeroInvoiceIdsWithUnverifiedAttachments: unverifiedAttachmentIds
            }),
            productId: productId
        } as any,
        _sum: { lineAmount: true }
    });

    const sLast = last6mSpend._sum.lineAmount?.toNumber() || 0;
    const sPrev = prev6mSpend._sum.lineAmount?.toNumber() || 0;
    let spendTrend12mPercent = 0;
    if (sPrev > 0) {
        spendTrend12mPercent = ((sLast - sPrev) / sPrev) * 100;
    }

    // 2. Price History (Last 12 months)
    // Pass locationId to helper
    const priceMap = await computeWeightedAveragePrices(organisationId, [productId], windowStart, now, locationId);
    const productPrices = priceMap.get(productId);

    const priceHistory: { monthLabel: string; averageUnitPrice: number | null }[] = [];
    const unitPriceHistory: { monthLabel: string; averageUnitPrice: number | null }[] = [];
    
    // Iterate last 12 months (11 months ago to current month)
    // Use date-fns for reliable date calculations
    for (let i = 11; i >= 0; i--) {
        const targetMonth = subMonths(startOfCurrentMonth, i);
        const year = targetMonth.getFullYear();
        const month = targetMonth.getMonth() + 1; // getMonth() returns 0-11, we need 1-12
        const monthKey = `${year}-${String(month).padStart(2, '0')}`;
        const label = getMonthLabel(targetMonth);
        
        const price = productPrices?.get(monthKey) || null;
        
        priceHistory.push({ monthLabel: label, averageUnitPrice: price });
        unitPriceHistory.push({ monthLabel: label, averageUnitPrice: price });
    }

    // 3. Calculate Product Price Trend (Last 3m vs Prev 3m)
    // OR just purely based on available points in history?
    // Let's do Last Price vs Avg of prev 3 months?
    // Or strict Last 6 months trend line?
    // Let's match the "Last Price Change" logic:
    // Find latest price, compare to price 3-6 months ago.
    
    let productPriceTrendPercent = 0;
    let canCalculateProductPriceTrend = false;

    if (productPrices && productPrices.size >= 3) {
         const sortedMonths = Array.from(productPrices.keys()).sort();
         const latestMonth = sortedMonths[sortedMonths.length - 1];
         const latestPrice = productPrices.get(latestMonth)!;
         
         // Find a comparison point approx 3-6 months back
         let comparisonPrice = 0;
         // Try 3 months back index
         const lookbackIndex = sortedMonths.length - 4; 
         if (lookbackIndex >= 0) {
             comparisonPrice = productPrices.get(sortedMonths[lookbackIndex])!;
         } else {
             // Fallback to oldest available
             comparisonPrice = productPrices.get(sortedMonths[0])!;
         }
         
         if (comparisonPrice > 0) {
             productPriceTrendPercent = ((latestPrice - comparisonPrice) / comparisonPrice) * 100;
             canCalculateProductPriceTrend = true;
         }
    }

    // Calculate latestUnitCost from priceHistory (most recent non-null)
    let latestUnitCost = 0;
    for (let i = 0; i < priceHistory.length; i++) {
        if (priceHistory[i].averageUnitPrice !== null) {
            latestUnitCost = priceHistory[i].averageUnitPrice!;
        }
    }

    // Resolve Supplier Name if missing
    let supplierName = product.supplier?.name;
    if (!supplierName) {
        // No supersededIds filter here as we just want ANY name match, date doesn't matter much but we should respect deletedAt
        // We can re-use supersededIds from above or fetch new if needed. The name shouldn't change much.
        // Let's just add deletedAt: null for consistency.
        const latestLine = await prisma.xeroInvoiceLineItem.findFirst({
            where: {
                productId: product.id,
                invoice: { ...whereInvoiceBase, deletedAt: null }
            } as any,
            include: {
                invoice: {
                    select: {
                        supplier: { select: { name: true } }
                    }
                }
            },
            orderBy: { invoice: { date: 'desc' } }
        });
        
        if (latestLine?.invoice?.supplier?.name) {
            supplierName = latestLine.invoice.supplier.name;
        } else {
            supplierName = 'Unknown';
        }
    }

    // Resolve Category Name (from most frequent account code)
    // Here we should exclude superseded items to avoid skewing the category with old data
    let categoryName = 'Uncategorized';
    const topCategory = await prisma.xeroInvoiceLineItem.groupBy({
        by: ['accountCode'],
        where: { 
            productId: productId, 
            invoice: { 
                deletedAt: null,
                xeroInvoiceId: { notIn: supersededIds }
            } 
        } as any,
        _count: { accountCode: true },
        orderBy: { _count: { accountCode: 'desc' } },
        take: 1
    });
    if (topCategory.length > 0 && topCategory[0].accountCode) {
        categoryName = getCategoryName(topCategory[0].accountCode);
    }

    return {
        productId: product.id,
        productName: product.name,
        supplierName: supplierName,
        categoryName,
        itemCode: product.productKey || undefined,
        stats12m: {
            totalSpend12m,
            averageMonthlySpend,
            quantityPurchased12m,
            spendTrend12mPercent
        },
        priceHistory,
        unitPriceHistory,
        productPriceTrendPercent,
        canCalculateProductPriceTrend,
        latestUnitCost
    };
  },

  async getAccounts(organisationId: string, locationId?: string): Promise<AccountDto[]> {
      // Fetch all superseded IDs (no date filter as accounts can be from any time)
      const supersededIds = await getSupersededXeroIds(organisationId, locationId);

      const whereInvoice = {
          organisationId,
          ...(locationId ? { locationId } : {}),
          deletedAt: null
      };

      // 1. Group by accountCode and accountName to get distinct pairs
      const accounts = await prisma.xeroInvoiceLineItem.groupBy({
          by: ['accountCode', 'accountName'],
          where: {
              invoice: {
                  ...whereInvoice,
                  xeroInvoiceId: { notIn: supersededIds }
              },
              accountCode: { not: null }
          } as any,
      });

      // 2. Check if manual invoices exist for this org/location
      const hasManualInvoices = await prisma.invoiceLineItem.count({
          where: {
              invoice: whereInvoice,
              accountCode: MANUAL_COGS_ACCOUNT_CODE
          } as any,
          take: 1
      }) > 0;

      // 3. Fetch Location Config
      const cogsSet = new Set<string>();
      if (locationId) {
          const config = await prisma.locationAccountConfig.findMany({
              where: { organisationId, locationId },
              select: { accountCode: true }
          });
          config.forEach(c => cogsSet.add(c.accountCode));
      }

      // 4. Map to DTO
      const accountMap = new Map<string, string | null>();
      
      for (const acc of accounts) {
          if (!acc.accountCode) continue;
          if (!accountMap.has(acc.accountCode)) {
              accountMap.set(acc.accountCode, acc.accountName);
          } else {
              const existingName = accountMap.get(acc.accountCode);
              if (!existingName && acc.accountName) {
                   accountMap.set(acc.accountCode, acc.accountName);
              }
          }
      }

      const result: AccountDto[] = [];
      for (const [code, name] of accountMap.entries()) {
          result.push({ 
            code, 
            name,
            isCogs: cogsSet.has(code) 
          });
      }

      // 5. Add manual account if manual invoices exist (and not already present)
      if (hasManualInvoices && !accountMap.has(MANUAL_COGS_ACCOUNT_CODE)) {
          result.push({
              code: MANUAL_COGS_ACCOUNT_CODE,
              name: MANUAL_COGS_ACCOUNT_CODE,
              isCogs: cogsSet.has(MANUAL_COGS_ACCOUNT_CODE)
          });
      }
      
      // Sort by code for nicer display
      result.sort((a, b) => a.code.localeCompare(b.code));
      
      return result;
  },

  async saveLocationAccountConfig(organisationId: string, locationId: string, accountCodes: string[]) {
    // Use transaction to replace all configs for this location
    return prisma.$transaction(async (tx) => {
        // 1. Delete existing
        await tx.locationAccountConfig.deleteMany({
            where: {
                organisationId,
                locationId
            }
        });

        // 2. Insert new
        if (accountCodes.length > 0) {
             // Deduplicate input
             const uniqueCodes = Array.from(new Set(accountCodes));
             await tx.locationAccountConfig.createMany({
                 data: uniqueCodes.map(code => ({
                     organisationId,
                     locationId,
                     accountCode: code,
                     category: 'COGS'
                 }))
             });
        }
        
        return { success: true, count: accountCodes.length };
    });
  },

  getSupplierFilterWhereClause(organisationId: string, locationId?: string, accountCodes?: string[]) {
    if (!accountCodes || accountCodes.length === 0) {
        return {};
    }

    const hasManualCogsCode = accountCodes.includes(MANUAL_COGS_ACCOUNT_CODE);
    const xeroAccountCodes = accountCodes.filter(code => code !== MANUAL_COGS_ACCOUNT_CODE);

    // Build conditions for Xero invoices and manual invoices
    const conditions: Prisma.SupplierWhereInput[] = [];

    // Condition 1: Xero invoices with matching account codes
    // We can't easily filter superseded IDs here without fetching them first, which might be heavy for a filter clause helper.
    // However, listSuppliers usually fetches IDs and passes them to where clause.
    // For this helper, we just build the Prisma filter object.
    // The Controller handles the superseded exclusion for aggregations. 
    // BUT for listSuppliers, we are filtering *Suppliers* based on whether they have *any* invoice matching the criteria.
    // If a supplier ONLY has superseded invoices in that account code, they should probably not show up if we are strict.
    // But complex query in a helper is tricky. 
    // Let's leave this helper as is for now (just deletedAt: null) or accept supersededIds as arg?
    // The plan says "Update getSupplierFilterWhereClause". 
    // Let's try to be safe. If we don't filter superseded here, a supplier might show up even if their only relevant invoice was verified and changed category.
    // But filtering supersededIds requires async. This helper is synchronous.
    // Let's keep it simple for now and rely on the metrics filtering to zero out values. 
    // The supplier will appear but with 0 spend in that category if filtered correctly elsewhere.
    // Actually, if we want to be 100% correct, we should filter. But let's stick to the plan for now which focuses on metrics.
    // Just ensuring deletedAt: null is present (which I did in previous turn) is the key step for "soft deletes".
    // The "Superseded" logic is mainly for *Spend* and *Counts* to avoid double counting.
    if (xeroAccountCodes.length > 0) {
        conditions.push({
            invoices: {
                some: {
                    organisationId,
                    ...(locationId ? { locationId } : {}),
                    deletedAt: null,
                    lineItems: {
                        some: {
                            accountCode: { in: xeroAccountCodes }
                        }
                    }
                }
            } as any
        });
    }

    // Condition 2: Manual invoices (ocrInvoices) - all verified manual invoices are considered COGS
    if (hasManualCogsCode) {
        conditions.push({
            ocrInvoices: {
                some: {
                    organisationId,
                    ...(locationId ? { locationId } : {}),
                    isVerified: true,
                    deletedAt: null
                }
            } as any
        });
    }

    // If we have both conditions, use OR; otherwise return the single condition
    if (conditions.length === 0) {
        return {};
    } else if (conditions.length === 1) {
        return conditions[0];
    } else {
        return {
            OR: conditions
        };
    }
  },

  // NOTE:
  // Price Alerts are first-party, per-location insights.
  // They compare a venue's own historical prices (did MY supplier raise MY price?).
  // K-anonymity and contributor thresholds apply ONLY to future cross-venue
  // Market Benchmark features where data is aggregated across organisations.
  // Do NOT add aggregation guards here.
  async scanAndSendPriceIncreaseAlertsForOrg(organisationId: string, locationIdFilter?: string): Promise<void> {
    const notificationService = new NotificationService();
    const recencyDays = config.PRICE_ALERT_RECENCY_DAYS;
    const dedupeDays = config.PRICE_ALERT_DEDUPE_DAYS;

    // Calculate date thresholds
    const now = new Date();
    const recencyCutoff = subDays(now, recencyDays);
    const historyStart = subMonths(now, 6); // Look back 6 months for history comparison
    const dedupeCutoff = subDays(now, dedupeDays);

    // Fetch price changes (similar to getRecentPriceChanges but with wider filter)
    // 1. Fetch Xero Line Items
    const supersededIds = await getSupersededXeroIds(organisationId, undefined, historyStart);

    const xeroLines = await prisma.xeroInvoiceLineItem.findMany({
      where: {
        productId: { not: null },
        invoice: {
          organisationId,
          date: { gte: historyStart },
          status: { in: ['AUTHORISED', 'PAID'] },
          deletedAt: null,
          xeroInvoiceId: { notIn: supersededIds }
        }
      } as any,
      include: {
        product: {
          include: { supplier: true }
        },
        invoice: {
          select: { 
            date: true,
            locationId: true,
            location: {
              select: { name: true }
            },
            supplier: {
              select: { id: true, name: true }
            }
          }
        }
      },
      orderBy: {
        invoice: { date: 'desc' }
      }
    });

    // 2. Fetch Manual/OCR Line Items
    const manualLines = await prisma.invoiceLineItem.findMany({
      where: {
        ...getVerifiedManualLineItemWhere({
          orgId: organisationId,
          locationId: undefined,
          startDate: historyStart
        }),
        // Ensure valid price data
        unitPrice: { gt: 0 },
        quantity: { gt: 0 }
      } as any,
      select: {
        id: true,
        description: true,
        productCode: true,
        unitPrice: true,
        quantity: true,
        invoice: {
          select: {
            date: true,
            locationId: true,
            location: {
              select: { name: true }
            },
            supplier: {
              select: { id: true, name: true }
            }
          }
        }
      },
      orderBy: {
        invoice: { date: 'desc' }
      }
    });

    // Group by Product Key + Location (Unified)
    // For Xero: use productId:locationId
    // For Manual: use `manual:supplierId:base64(key):locationId`
    const productGroups = new Map<string, Array<{
      unitAmount: number;
      date: Date;
      supplierId?: string;
      supplierName?: string;
      productName: string;
      productId: string;
      locationId?: string;
      locationName?: string;
    }>>();

    // Process Xero Lines
    for (const line of xeroLines) {
      if (!line.productId) continue;
      const locationId = line.invoice.locationId || 'unknown';
      const key = `${line.productId}:${locationId}`;
      const existing = productGroups.get(key) || [];
      
      existing.push({
        unitAmount: Number(line.unitAmount || 0),
        date: line.invoice.date!,
        supplierId: line.product?.supplierId || line.invoice.supplier?.id,
        supplierName: line.product?.supplier?.name || line.invoice.supplier?.name,
        productName: line.product?.name || line.description || 'Unknown',
        productId: line.productId,
        locationId: line.invoice.locationId || undefined,
        locationName: line.invoice.location?.name || undefined
      });
      
      productGroups.set(key, existing);
    }

    // Process Manual Lines
    for (const line of manualLines) {
      if (!line.invoice.supplier?.id) continue;
      
      const supplierId = line.invoice.supplier.id;
      const keyStr = (line.productCode || line.description || '').trim().toLowerCase();
      if (!keyStr) continue;

      const locationId = line.invoice.locationId || 'unknown';
      // Generate manual ID with location
      const manualId = `manual:${supplierId}:${Buffer.from(keyStr).toString('base64')}:${locationId}`;
      
      const existing = productGroups.get(manualId) || [];
      
      existing.push({
        unitAmount: Number(line.unitPrice || 0),
        date: line.invoice.date!,
        supplierId: supplierId,
        supplierName: line.invoice.supplier.name,
        productName: line.description || line.productCode || 'Unknown',
        productId: manualId,
        locationId: line.invoice.locationId || undefined,
        locationName: line.invoice.location?.name || undefined
      });
      
      productGroups.set(manualId, existing);
    }

    // Sort groups by date desc
    for (const group of productGroups.values()) {
      group.sort((a, b) => b.date.getTime() - a.date.getTime());
    }

    // Collect qualifying price changes
    const candidateAlerts: Array<{
      productId: string;
      productName: string;
      supplierId: string;
      supplierName: string;
      locationId?: string;
      locationName?: string;
      oldPrice: number;
      newPrice: number;
      absoluteChange: number;
      percentChange: number;
      effectiveDate: Date;
    }> = [];

    for (const [productId, lines] of productGroups.entries()) {
      if (lines.length < 2) continue; // Need at least 2 price points

      const latest = lines[0];
      const latestPrice = latest.unitAmount;
      const latestDate = latest.date;
      
      if (latestPrice === 0) continue;
      
      // Ensure latest price is within recency window
      if (latestDate < recencyCutoff) continue;

      // Find previous price
      let prevPrice = 0;
      const olderLines = lines.slice(1);
      
      for (let i = 0; i < olderLines.length; i++) {
        const candidatePrice = olderLines[i].unitAmount;
        // Use logic similar to getRecentPriceChanges: allow tiny variance to filter noise but ensure change
        if (candidatePrice > 0 && Math.abs(candidatePrice - latestPrice) > 0.01) {
          prevPrice = candidatePrice;
          break;
        }
      }

      if (prevPrice <= 0) continue;

      const absoluteChange = latestPrice - prevPrice;
      const percentChange = (absoluteChange / prevPrice) * 100;

      // Apply threshold filter: (Percent >= 20% AND Abs >= $0.50) OR (Abs >= $2.00 AND Percent >= 10%)
      const meetsThreshold = 
        (percentChange >= 20 && Math.abs(absoluteChange) >= 0.50) ||
        (Math.abs(absoluteChange) >= 2.00 && percentChange >= 10);

      if (!meetsThreshold) continue;

      const supplierId = latest.supplierId;
      const supplierName = latest.supplierName || 'Unknown';

      if (!supplierId) continue;

      candidateAlerts.push({
        productId,
        productName: latest.productName,
        supplierId,
        supplierName,
        locationId: latest.locationId,
        locationName: latest.locationName,
        oldPrice: prevPrice,
        newPrice: latestPrice,
        absoluteChange: Math.abs(absoluteChange),
        percentChange: Math.abs(percentChange),
        effectiveDate: latestDate,
      });
    }

    if (candidateAlerts.length === 0) {
      console.log(`[PriceAlert] No qualifying alerts for org ${organisationId}`);
      return;
    }

    // Check deduplication against PriceAlertHistory
    const filteredAlerts: typeof candidateAlerts = [];
    
    for (const alert of candidateAlerts) {
      const existing = await prisma.priceAlertHistory.findFirst({
        where: {
          organisationId,
          supplierId: alert.supplierId,
          productId: alert.productId,
          oldPrice: alert.oldPrice,
          newPrice: alert.newPrice,
          sentAt: { gte: dedupeCutoff }
        }
      });

      if (!existing) {
        filteredAlerts.push(alert);
      }
    }

    if (filteredAlerts.length === 0) {
      console.log(`[PriceAlert] All alerts for org ${organisationId} were deduplicated`);
      return;
    }

    // Fetch organisation name
    const organisation = await prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { name: true }
    });
    const organisationName = organisation?.name || 'Your Organisation';

    // Group alerts by locationId
    const alertsByLocation = new Map<string, typeof filteredAlerts>();
    const alertsWithoutLocation: typeof filteredAlerts = [];

    for (const alert of filteredAlerts) {
      if (!alert.locationId) {
        alertsWithoutLocation.push(alert);
      } else {
        const existing = alertsByLocation.get(alert.locationId) || [];
        existing.push(alert);
        alertsByLocation.set(alert.locationId, existing);
      }
    }

    // Log warnings for alerts without locationId
    if (alertsWithoutLocation.length > 0) {
      console.warn(`[PriceAlert] Skipping ${alertsWithoutLocation.length} alert(s) with missing locationId for org ${organisationId}`);
    }

    // If caller wants a single location, filter now
    if (locationIdFilter) {
      const onlyAlerts = alertsByLocation.get(locationIdFilter);
      if (!onlyAlerts || onlyAlerts.length === 0) {
        console.log(`[PriceAlert] No qualifying alerts for location ${locationIdFilter} in org ${organisationId}`);
        return;
      }
      alertsByLocation.clear();
      alertsByLocation.set(locationIdFilter, onlyAlerts);
    }

    // Process each location
    for (const [locationId, locationAlerts] of alertsByLocation.entries()) {
      // Fetch location and its shared emails
      const location = await prisma.location.findUnique({
        where: { id: locationId },
        select: {
          id: true,
          name: true,
          sharedReportEmails: true
        } as any
      });

      if (!location) {
        console.warn(`[PriceAlert] Location ${locationId} not found, skipping ${locationAlerts.length} alert(s)`);
        continue;
      }

      // Get recipients for this location
      const recipients = Array.from(new Set((location as any).sharedReportEmails || [])) as string[];

      // If no recipients, skip this location
      if (recipients.length === 0) {
        console.log(`[PriceAlert] No recipients for location ${locationId} (${location.name}), skipping ${locationAlerts.length} alert(s)`);
        continue;
      }

      // Sort by percent change descending and take top 10 for display
      const sortedAlerts = locationAlerts.sort((a, b) => b.percentChange - a.percentChange);
      const displayAlerts = sortedAlerts.slice(0, 10);
      const totalCount = locationAlerts.length;

      // Convert to PriceIncreaseItem format
      const locationNameForEmail = (location as any).name as string;
      const emailItems: PriceIncreaseItem[] = displayAlerts.map(alert => ({
        productName: alert.productName,
        supplierName: alert.supplierName,
        locationName: (typeof alert.locationName === 'string' ? alert.locationName : locationNameForEmail) || undefined,
        oldPrice: alert.oldPrice,
        newPrice: alert.newPrice,
        absoluteChange: alert.absoluteChange,
        percentChange: alert.percentChange,
      }));

      try {
        // Send email with location name in subject
        await notificationService.sendPriceIncreaseAlert({
          toEmail: recipients,
          organisationName: `${organisationName} - ${location.name}`,
          items: emailItems,
          totalCount,
        });

        // Record history for ALL location alerts (not just displayed ones)
        const historyRecords = locationAlerts.map(alert => ({
          organisationId,
          supplierId: alert.supplierId,
          productId: alert.productId,
          oldPrice: alert.oldPrice,
          newPrice: alert.newPrice,
          percentChange: alert.percentChange,
          channel: 'EMAIL',
          recipientEmail: recipients[0] || '', // Use first recipient for history tracking
        }));

        try {
          await prisma.priceAlertHistory.createMany({
            data: historyRecords,
          });
          console.log(`[PriceAlert] Recorded ${historyRecords.length} alert(s) in history for location ${locationId} (${location.name})`);
        } catch (dbError) {
          // Log error loudly but don't fail the entire operation
          console.error(`[PriceAlert] CRITICAL: Failed to write alert history for location ${locationId}:`, dbError);
          console.error(`[PriceAlert] Alert was sent but not recorded. Manual fix may be needed.`, {
            organisationId,
            locationId,
            locationName: location.name,
            recipientEmails: recipients,
            alertCount: historyRecords.length,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (emailError) {
        console.error(`[PriceAlert] Failed to send alert for location ${locationId} (${location.name}):`, emailError);
        // Continue to next location instead of throwing
      }
    }
  },

  async scanAndSendPriceIncreaseAlertsAllOrgs(): Promise<void> {
    const organisations = await prisma.organisation.findMany({
      select: { id: true },
    });

    console.log(`[PriceAlert] Starting scan for ${organisations.length} organisation(s)`);

    for (const org of organisations) {
      try {
        await this.scanAndSendPriceIncreaseAlertsForOrg(org.id);
      } catch (error) {
        console.error(`[PriceAlert] Failed to process org ${org.id}:`, error);
        // Continue to the next org, don't crash the job
      }
    }

    console.log(`[PriceAlert] Completed scan for all organisations`);
  }
};
