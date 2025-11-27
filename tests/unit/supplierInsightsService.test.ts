import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supplierInsightsService } from '../../src/services/supplierInsightsService';
// import { prisma } from '../../src/infrastructure/prismaClient'; // Don't use named import if service uses default

// Define mocks using vi.hoisted to avoid hoisting issues
const { mockAggregate, mockGroupBy, mockFindMany, mockFindFirst } = vi.hoisted(() => {
  return {
    mockAggregate: vi.fn(),
    mockGroupBy: vi.fn(),
    mockFindMany: vi.fn(),
    mockFindFirst: vi.fn(),
  };
});

// Mock the entire module to handle default export
vi.mock('../../src/infrastructure/prismaClient', () => {
  const mockClient = {
    xeroInvoice: {
      aggregate: mockAggregate,
      groupBy: mockGroupBy,
    },
    xeroInvoiceLineItem: {
      findMany: mockFindMany,
      groupBy: mockGroupBy,
      aggregate: mockAggregate,
      findFirst: mockFindFirst,
    },
    supplier: {
      findMany: mockFindMany,
    }
  };
  return {
    __esModule: true,
    default: mockClient,
    prisma: mockClient
  };
});

// Import the mocked client to configure it
import prisma from '../../src/infrastructure/prismaClient';

describe('supplierInsightsService', () => {
  const orgId = 'org-123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSupplierSpendSummary', () => {
    it('should calculate totalSupplierSpendPerMonth correctly', async () => {
      // Mock aggregations using implementation to be robust against call order
      const aggregateMock = vi.mocked(prisma.xeroInvoice.aggregate);
      aggregateMock.mockReset();

      aggregateMock.mockImplementation(async (args: any) => {
          // Identify call by date range or other characteristics
          // Recent: ~90 days ago
          // Last 6m: ~6 months window
          // Prev 6m: ~6 months window (earlier)
          // Monthly: 1 month window
          
          const where = args.where || {};
          const dateGte = where.date?.gte;
          
          if (!dateGte) return { _sum: { total: { toNumber: () => 1000 } } } as any;
          
          const now = new Date();
          const diffTime = Math.abs(now.getTime() - new Date(dateGte).getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          
          if (diffDays <= 95 && diffDays >= 85) {
               // Recent 90 days
               return { _sum: { total: { toNumber: () => 3000 } } } as any;
          }
          
          // Last 6m vs Prev 6m
          // Last 6m starts ~6 months ago (approx 180 days)
          // Prev 6m starts ~12 months ago (approx 365 days)
          
          if (diffDays >= 150 && diffDays <= 210) {
              // Last 6m
              return { _sum: { total: { toNumber: () => 6000 } } } as any;
          }
          
          if (diffDays >= 330) {
              // Prev 6m
              return { _sum: { total: { toNumber: () => 5000 } } } as any;
          }
          
          // Default (Series months)
          return { _sum: { total: { toNumber: () => 1000 } } } as any;
      });

      // Mock prices calls (findMany)
      vi.mocked(prisma.xeroInvoiceLineItem.findMany).mockResolvedValue([]); // Default empty

      const result = await supplierInsightsService.getSupplierSpendSummary(orgId);
      
      expect(result.totalSupplierSpendPerMonth).toBe(1000); // 3000 / 3
      expect(result.totalSpendTrendLast6mPercent).toBe(20); // (6000-5000)/5000 * 100
    });

    it('should use correct date ranges for Last 6 months', async () => {
        const now = new Date('2025-11-26T10:00:00Z');
        vi.useFakeTimers();
        vi.setSystemTime(now);
        
        const aggregateMock = vi.mocked(prisma.xeroInvoice.aggregate);
        aggregateMock.mockReset();
        aggregateMock.mockResolvedValue({ _sum: { total: { toNumber: () => 0 } } } as any);
        
        vi.mocked(prisma.xeroInvoiceLineItem.findMany).mockResolvedValue([]);
        
        await supplierInsightsService.getSupplierSpendSummary(orgId);
        
        const calls = aggregateMock.mock.calls;
        
        // We expect calls: 
        // 1. recentSpendAgg
        // 2. last6mSpend
        // 3. prev6mSpend
        // 4..9. Series months
        
        // Check 2nd call (Last 6m)
        const last6mCall = calls[1][0];
        const where: any = last6mCall.where;
        
        const startDate = where.date.gte as Date;
        expect(startDate.getFullYear()).toBe(2025);
        expect(startDate.getMonth()).toBe(4); // May
        expect(startDate.getDate()).toBe(1);
        
        // Check 3rd call (Prev 6m)
        const prev6mCall = calls[2][0];
        const prevWhere: any = prev6mCall.where;
        const prevStartDate = prevWhere.date.gte as Date;
        
        expect(prevStartDate.getFullYear()).toBe(2024);
        expect(prevStartDate.getMonth()).toBe(10); // Nov
        expect(prevStartDate.getDate()).toBe(1);
        
        vi.useRealTimers();
    });
  });
  
  describe('generateProductId / getProductDetail', () => {
      // We need to test if generateProductId (internal) matches expectation?
      // Or just test getProductDetail with a known ID logic.
      // But generateProductId is not exported. 
      // We can test via getProducts and then feed that ID to getProductDetail.
      
      it('should parse valid base64 product ID', async () => {
          const rawId = 'supplier1:::item1';
          const encodedId = Buffer.from(rawId).toString('base64');
          
      // Mock aggregations for getProductDetail
      vi.mocked(prisma.xeroInvoiceLineItem.aggregate).mockResolvedValue({
          _sum: { lineAmount: { toNumber: () => 1200 }, quantity: { toNumber: () => 120 } }
      } as any);
      
      // Mock findMany to return data for getProductDetail
      // Note: getAvgPrices also calls findMany, so we should use mockImplementation or mockResolvedValueOnce carefully.
      // But getProductDetail calls findMany once for lineItems, then does memory aggregation.
      // Wait, does it call anything else?
      // No, just findMany.
      
      vi.mocked(prisma.xeroInvoiceLineItem.findMany).mockResolvedValue([
          {
              lineAmount: 1200,
              quantity: 120,
              invoice: {
                  date: new Date(),
                  supplier: { id: 'sup1', name: 'Sup1' }
              },
              accountCode: '200'
          }
      ] as any);
      
      await supplierInsightsService.getProductDetail(orgId, encodedId);
      
      const calls = vi.mocked(prisma.xeroInvoiceLineItem.findMany).mock.calls;
      // findMany is called multiple times?
      // getProductDetail calls findMany once to get lineItems.
      const firstCall = calls[0][0];
      const where: any = firstCall.where;
      
      // Check it looked for item1 in description
      // { description: { equals: 'item1', mode: 'insensitive' }, invoice: ... }
      expect(where.description).toEqual({ equals: 'item1', mode: 'insensitive' });
  });
  });
});

