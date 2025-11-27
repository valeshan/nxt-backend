import { PrismaClient, Prisma } from '@prisma/client';
import prisma from '../infrastructure/prismaClient';
import { getCategoryName } from '../config/categoryMap';
import { startOfMonth, subMonths } from 'date-fns';

// --- Types & DTOs ---

export interface SpendSummary {
  totalSupplierSpendPerMonth: number;
  totalSpendTrendLast6mPercent: number;
  totalSpendTrendSeries: { monthLabel: string; total: number }[];
  averagePriceMovementLast3mPercent: number;
  averageMonthlyVariancePercent: number;
  canCalculateVariance: boolean;
}

export interface PriceChangeItem {
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
}

export interface ProductDetail {
  productId: string;
  productName: string;
  supplierName: string;
  categoryName: string;
  stats12m: {
    totalSpend12m: number;
    averageMonthlySpend: number;
    quantityPurchased12m: number;
    spendTrend12mPercent: number;
  };
  priceHistory: { monthLabel: string; averageUnitPrice: number }[];
}

export interface GetProductsParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'productName' | 'supplierName' | 'unitCost' | 'lastPriceChangePercent' | 'spend12m';
  sortDirection?: 'asc' | 'desc';
  search?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
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

// --- Service Functions ---

export const supplierInsightsService = {
  async getSupplierSpendSummary(organisationId: string, locationId?: string): Promise<SpendSummary> {
    // 1. Total Supplier Spend Per Month (Last 90 days / 3)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const recentSpendAgg = await prisma.xeroInvoice.aggregate({
      where: {
        organisationId,
        date: { gte: ninetyDaysAgo },
        status: { in: ['AUTHORISED', 'PAID'] }
      },
      _sum: { total: true }
    });
    
    const safeSum = (agg: any) => agg?._sum?.total?.toNumber() || 0;

    const totalRecentSpend = safeSum(recentSpendAgg);
    const totalSupplierSpendPerMonth = totalRecentSpend / 3;

    // 2. Total Spend Trend Series (Monthly for last 12 months)
    const series: { monthLabel: string; total: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - 1 - i);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      
      const monthlyAgg = await prisma.xeroInvoice.aggregate({
        where: { organisationId, date: { gte: start, lte: end }, status: { in: ['AUTHORISED', 'PAID'] } },
        _sum: { total: true }
      });
      
      series.push({
        monthLabel: getMonthLabel(start),
        total: monthlyAgg._sum.total?.toNumber() || 0
      });
    }

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

    // 4. Average Price Movement Last 3m (vs prior 3m)
    const last3m = getFullCalendarMonths(3);
    const prev3mStart = new Date(last3m.start);
    prev3mStart.setMonth(prev3mStart.getMonth() - 3);
    const prev3mEnd = new Date(last3m.start);
    prev3mEnd.setDate(prev3mEnd.getDate() - 1);

    const getAvgPrices = async (start: Date, end: Date) => {
      // Group by Product ID now!
      // We only care about items linked to products for stable tracking.
      const items = await prisma.xeroInvoiceLineItem.findMany({
        where: {
          productId: { not: null }, // Only linked items
          invoice: {
            organisationId,
            date: { gte: start, lte: end },
            status: { in: ['AUTHORISED', 'PAID'] }
          },
          quantity: { not: 0 }
        },
        select: {
          productId: true,
          quantity: true,
          lineAmount: true
        }
      });
      
      const productMap = new Map<string, { totalQty: number, totalAmount: number }>();
      
      for (const item of items) {
        const key = item.productId!;
        const entry = productMap.get(key) || { totalQty: 0, totalAmount: 0 };
        entry.totalQty += Number(item.quantity);
        entry.totalAmount += Number(item.lineAmount);
        productMap.set(key, entry);
      }
      
      const prices = new Map<string, number>();
      for (const [key, val] of productMap.entries()) {
        if (val.totalQty > 0) {
          prices.set(key, val.totalAmount / val.totalQty);
        }
      }
      return prices;
    };

    const [pricesLast3m, pricesPrev3m] = await Promise.all([
      getAvgPrices(last3m.start, last3m.end),
      getAvgPrices(prev3mStart, prev3mEnd)
    ]);

    let sumPctChangePrices = 0;
    let countMatches = 0;
    
    for (const [key, priceLast] of pricesLast3m.entries()) {
      const pricePrev = pricesPrev3m.get(key);
      if (pricePrev && pricePrev > 0) {
        const change = (priceLast - pricePrev) / pricePrev;
        if (Math.abs(change) < 5) { // Filter outliers
            sumPctChangePrices += change;
            countMatches++;
        }
      }
    }
    
    const averagePriceMovementLast3mPercent = countMatches > 0 ? (sumPctChangePrices / countMatches) * 100 : 0;

    return {
      totalSupplierSpendPerMonth,
      totalSpendTrendLast6mPercent: 0,
      totalSpendTrendSeries: series,
      averagePriceMovementLast3mPercent,
      averageMonthlyVariancePercent,
      canCalculateVariance
    };
  },

  async getRecentPriceChanges(organisationId: string, locationId?: string, limit = 5): Promise<PriceChangeItem[]> {
    const last3m = getFullCalendarMonths(3);
    
    // Fetch recent lines linked to Products
    const recentLines = await prisma.xeroInvoiceLineItem.findMany({
      where: {
        productId: { not: null },
        invoice: {
          organisationId,
          date: { gte: last3m.start },
          status: { in: ['AUTHORISED', 'PAID'] }
        }
      },
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
    
    // Group by Product ID
    const productGroups = new Map<string, typeof recentLines>();
    for (const line of recentLines) {
      if (!line.productId) continue;
      const existing = productGroups.get(line.productId) || [];
      existing.push(line);
      productGroups.set(line.productId, existing);
    }
    
    const results: PriceChangeItem[] = [];
    
    for (const [productId, lines] of productGroups.entries()) {
      const latest = lines[0];
      const latestPrice = Number(latest.unitAmount || 0);
      if (latestPrice === 0) continue;
      
      let prevPrice = 0;
      const olderLines = lines.slice(1);
      
      // Look for price change in loaded buffer
      let changeIndex = -1;
      for (let i = 0; i < olderLines.length; i++) {
         if (Math.abs(Number(olderLines[i].unitAmount) - latestPrice) > 0.01) {
           changeIndex = i;
           break;
         }
      }
      
      if (changeIndex !== -1) {
          prevPrice = Number(olderLines[changeIndex].unitAmount);
      }
      
      if (prevPrice > 0) {
        const percentChange = ((latestPrice - prevPrice) / prevPrice) * 100;
        
        if (Math.abs(percentChange) > 0.5) {
             results.push({
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

  async getSpendBreakdown(organisationId: string, locationId?: string): Promise<SpendBreakdown> {
    const last12m = getFullCalendarMonths(12);
    
    const supplierSpend = await prisma.xeroInvoice.groupBy({
      by: ['supplierId'],
      where: {
        organisationId,
        date: { gte: last12m.start, lte: last12m.end },
        status: { in: ['AUTHORISED', 'PAID'] }
      },
      _sum: { total: true }
    });
    
    const supplierIds = supplierSpend.map(s => s.supplierId).filter(id => id !== null) as string[];
    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: supplierIds } }
    });
    const supplierNameMap = new Map(suppliers.map(s => [s.id, s.name]));
    
    const bySupplier = supplierSpend
      .filter(s => s.supplierId && s._sum.total && s._sum.total.toNumber() > 0)
      .map(s => ({
        supplierId: s.supplierId!,
        supplierName: supplierNameMap.get(s.supplierId!) || 'Unknown',
        totalSpend12m: s._sum.total!.toNumber()
      }))
      .sort((a, b) => b.totalSpend12m - a.totalSpend12m);

    const categorySpend = await prisma.xeroInvoiceLineItem.groupBy({
      by: ['accountCode'],
      where: {
        invoice: {
          organisationId,
          date: { gte: last12m.start, lte: last12m.end },
          status: { in: ['AUTHORISED', 'PAID'] }
        }
      },
      _sum: { lineAmount: true }
    });
    
    const byCategory = categorySpend
      .filter(c => c.accountCode && c._sum.lineAmount && c._sum.lineAmount.toNumber() > 0)
      .map(c => ({
        categoryId: c.accountCode!,
        categoryName: getCategoryName(c.accountCode),
        totalSpend12m: c._sum.lineAmount!.toNumber()
      }))
      .sort((a, b) => b.totalSpend12m - a.totalSpend12m);

    return { bySupplier, byCategory };
  },

  async getCostCreepAlerts(organisationId: string, locationId?: string, thresholdPercent = 5): Promise<CostCreepAlert[]> {
    const thisMonth = getCurrentMonthRange();
    const last3m = getFullCalendarMonths(3);
    
    const getAvgUnitPrices = async (start: Date, end: Date) => {
        // Group by Product ID
        const aggs = await prisma.xeroInvoiceLineItem.groupBy({
            by: ['productId'],
            where: {
                productId: { not: null },
                invoice: {
                    organisationId,
                    date: { gte: start, lte: end },
                    status: { in: ['AUTHORISED', 'PAID'] }
                },
                quantity: { not: 0 }
            },
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
        getAvgUnitPrices(thisMonth.start, thisMonth.end),
        getAvgUnitPrices(last3m.start, last3m.end)
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
                 const latestLine = await prisma.xeroInvoiceLineItem.findFirst({
                     where: { productId: product.id, invoice: { organisationId } },
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

  async getProducts(organisationId: string, locationId: string | undefined, params: GetProductsParams): Promise<PaginatedResult<ProductListItem>> {
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const skip = (page - 1) * pageSize;
    const last12m = getFullCalendarMonths(12);

    // Build Where Clause for Products
    const whereClause: Prisma.ProductWhereInput = {
        organisationId,
        ...(locationId ? { locationId } : {}), // Strict location filtering if provided
    };
    
    if (params.search) {
        whereClause.OR = [
            { name: { contains: params.search, mode: 'insensitive' } },
            { productKey: { contains: params.search, mode: 'insensitive' } },
            // Search by supplier name via relation (if set) OR invoices?
            // Searching via invoices is heavy. 
            // Ideally we search Product.supplier (primary).
            { supplier: { name: { contains: params.search, mode: 'insensitive' } } }
        ];
    }

    // We need to get spend stats for these products.
    // Option 1: Fetch all matching products, then aggregate stats (can be heavy if many products).
    // Option 2: Aggregate line items first? No, we want Product list as source of truth now.
    
    // Let's fetch Products first (pagination applies here).
    // BUT sorting by 'spend12m' requires knowing spend.
    // If sorting by spend, we must aggregate first or join.
    // Prisma doesn't support sorting by related aggregation easily.
    
    // Strategy:
    // 1. If sort by static field (name), fetch paginated products, then hydration.
    // 2. If sort by dynamic field (spend, price change), we must fetch ALL matching products stats, sort in memory, then paginate.
    
    // Given the requirement to scale, fetching ALL stats every time is risky if 10k products.
    // However, for "Supplier Insights" usually < 1000 items active.
    // We'll assume memory sort is okay for MVP of this refactor.
    
    // Fetch ALL matching products (lightweight)
    const allProducts = await prisma.product.findMany({
        where: whereClause,
        select: { id: true, name: true, supplierId: true, supplier: { select: { name: true } } }
    });
    
    // Bulk aggregate stats for these products
    const productIds = allProducts.map(p => p.id);
    
    const stats = await prisma.xeroInvoiceLineItem.groupBy({
        by: ['productId'],
        where: {
            productId: { in: productIds },
            invoice: {
                organisationId, // Redundant but safe
                date: { gte: last12m.start, lte: last12m.end },
                status: { in: ['AUTHORISED', 'PAID'] }
            }
        },
        _sum: { lineAmount: true }
    });
    
    const spendMap = new Map<string, number>();
    stats.forEach(s => {
        if (s.productId) spendMap.set(s.productId, s._sum.lineAmount?.toNumber() || 0);
    });
    
    // We also need "latest unit cost".
    // This requires a query per product or a complex window function.
    // Window function via raw query is best.
    // OR: fetch latest line item for each product (in bulk? impossible in prisma easily).
    // We can fetch all products' latest line ID?
    // Let's lazily hydrate latest cost ONLY for the displayed page if we don't sort by it.
    // If we sort by unitCost or priceChange, we are stuck.
    // Let's assume we sort by Spend (default) or Name mostly.
    
    // If sort by Spend:
    let items = allProducts.map(p => ({
        productId: p.id,
        productName: p.name,
        supplierName: p.supplier?.name || 'Unknown', // Primary supplier
        latestUnitCost: 0, // Hydrate later
        lastPriceChangePercent: 0, // Hydrate later
        spend12m: spendMap.get(p.id) || 0
    }));
    
    // Filter out zero spend if desired? Usually yes for "Insights".
    items = items.filter(i => i.spend12m > 0);
    
    // Sort
    if (params.sortBy === 'productName' || params.sortBy === 'supplierName') {
        items.sort((a, b) => {
            const valA = a[params.sortBy as keyof typeof a] as string;
            const valB = b[params.sortBy as keyof typeof b] as string;
            return params.sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        });
    } else if (params.sortBy === 'spend12m') {
        items.sort((a, b) => params.sortDirection === 'asc' ? a.spend12m - b.spend12m : b.spend12m - a.spend12m);
    } 
    // Note: Sorting by unitCost or lastPriceChangePercent is not supported efficiently here yet.
    // We would need to hydrate all. For now, we ignore those sorts or treat as secondary.
    // If user requests sort by cost, we could limit to top 500 then sort?
    // Let's stick to spend/name for now as primary use cases.
    else {
         items.sort((a, b) => b.spend12m - a.spend12m);
    }
    
    const totalItems = items.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const paginatedItems = items.slice(skip, skip + pageSize);
    
    // Hydrate Details for the slice
    const hydratedItems = await Promise.all(paginatedItems.map(async (item) => {
        // Fetch latest line for cost and supplier fallback
        const latestLine = await prisma.xeroInvoiceLineItem.findFirst({
            where: {
                productId: item.productId,
                invoice: { organisationId, status: { in: ['AUTHORISED', 'PAID'] } }
            },
            include: { invoice: { include: { supplier: true } } },
            orderBy: { invoice: { date: 'desc' } }
        });
        
        let latestUnitCost = 0;
        let supplierName = item.supplierName;
        
        if (latestLine) {
            latestUnitCost = Number(latestLine.unitAmount || 0);
            if (supplierName === 'Unknown' && latestLine.invoice.supplier) {
                supplierName = latestLine.invoice.supplier.name;
            }
        }
        
        // Price Change
        let lastPriceChangePercent = 0;
        if (latestUnitCost > 0 && latestLine) {
             // Find previous line (different price? or just previous in time)
             // We need previous relative to latestLine
             const prevLine = await prisma.xeroInvoiceLineItem.findFirst({
                 where: {
                     productId: item.productId,
                     invoice: { 
                         organisationId, 
                         status: { in: ['AUTHORISED', 'PAID'] },
                         date: { lt: latestLine.invoice.date || undefined } // strictly older
                     }
                 },
                 orderBy: { invoice: { date: 'desc' } }
             });
             
             if (prevLine && prevLine.unitAmount) {
                 const prevCost = Number(prevLine.unitAmount);
                 if (prevCost > 0) {
                     lastPriceChangePercent = ((latestUnitCost - prevCost) / prevCost) * 100;
                 }
             }
        }
        
        return { ...item, latestUnitCost, supplierName, lastPriceChangePercent };
    }));
    
    return {
        items: hydratedItems,
        pagination: {
            page,
            pageSize,
            totalItems,
            totalPages
        }
    };
  },

  async getProductDetail(organisationId: string, productId: string): Promise<ProductDetail | null> {
    // 1. Verify Product ownership
    const product = await prisma.product.findUnique({
        where: { id: productId },
        include: { supplier: true }
    });
    
    if (!product || product.organisationId !== organisationId) {
        // 404 or null
        return null;
    }
    
    // 2. Fetch Line Items
    const now = new Date();
    const currentMonthStart = startOfMonth(now);
    const windowStart = startOfMonth(subMonths(currentMonthStart, 12));
    
    const lineItems = await prisma.xeroInvoiceLineItem.findMany({
        where: {
            productId: product.id,
            invoice: {
                organisationId,
                status: { in: ['AUTHORISED', 'PAID'] },
                date: { gte: windowStart, lt: currentMonthStart }
            }
        },
        include: {
            invoice: { select: { date: true, supplier: true } }
        },
        orderBy: { invoice: { date: 'asc' } }
    });
    
    // Defaults
    let totalSpend12m = 0;
    let quantityPurchased12m = 0;
    let spendFirst6m = 0;
    let spendLast6m = 0;
    const splitDate = subMonths(currentMonthStart, 6);
    const supplierSpendMap = new Map<string, { name: string, total: number }>();
    const categorySpendMap = new Map<string, number>();
    const priceHistoryMap = new Map<string, { totalAmount: number, totalQty: number, date: Date }>();
    
    for (const item of lineItems) {
        const amount = Number(item.lineAmount || 0);
        const qty = Number(item.quantity || 0);
        const date = item.invoice.date;
        if (!date) continue;
        
        totalSpend12m += amount;
        quantityPurchased12m += qty;
        
        if (date < splitDate) spendFirst6m += amount;
        else spendLast6m += amount;
        
        if (item.invoice.supplier) {
            const s = item.invoice.supplier;
            const current = supplierSpendMap.get(s.id) || { name: s.name, total: 0 };
            current.total += amount;
            supplierSpendMap.set(s.id, current);
        }
        
        const catName = getCategoryName(item.accountCode);
        categorySpendMap.set(catName, (categorySpendMap.get(catName) || 0) + amount);
        
        const sortKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const hist = priceHistoryMap.get(sortKey) || { totalAmount: 0, totalQty: 0, date };
        hist.totalAmount += amount;
        hist.totalQty += qty;
        priceHistoryMap.set(sortKey, hist);
    }
    
    const averageMonthlySpend = totalSpend12m / 12;
    let spendTrend12mPercent = 0;
    if (spendFirst6m > 0) {
        spendTrend12mPercent = ((spendLast6m - spendFirst6m) / spendFirst6m) * 100;
    }
    
    // Resolve Supplier (Product.supplierId > highest spend)
    let supplierName = product.supplier?.name || 'Unknown';
    if (!product.supplier) {
        let max = -1;
        for (const val of supplierSpendMap.values()) {
            if (val.total > max) {
                max = val.total;
                supplierName = val.name;
            }
        }
    }
    
    // Resolve Category
    let categoryName = 'Uncategorized';
    let maxCat = -1;
    for (const [name, total] of categorySpendMap.entries()) {
        if (total > maxCat) {
            maxCat = total;
            categoryName = name;
        }
    }
    
    const sortedMonths = Array.from(priceHistoryMap.keys()).sort();
    const priceHistory = sortedMonths.map(key => {
        const val = priceHistoryMap.get(key)!;
        const avgPrice = val.totalQty !== 0 ? val.totalAmount / val.totalQty : 0;
        return {
            monthLabel: getMonthLabel(val.date),
            averageUnitPrice: avgPrice
        };
    });
    
    return {
        productId: product.id,
        productName: product.name,
        supplierName,
        categoryName,
        stats12m: {
            totalSpend12m,
            averageMonthlySpend,
            quantityPurchased12m,
            spendTrend12mPercent
        },
        priceHistory
    };
  }
};
