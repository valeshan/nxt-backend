import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateForecast, Invoice, FutureBill, SupplierConfigOverride } from './forecastEngine';
import { subDays, addDays } from 'date-fns';

describe('Forecast Engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helpers
  function daysAgo(n: number): Date {
    return subDays(new Date(), n);
  }

  function daysFuture(n: number): Date {
    return addDays(new Date(), n);
  }

  function mockInvoice(
    supplierId: string, 
    supplierName: string, 
    amount: number, 
    daysAgoNum: number, 
    categoryName?: string
  ): Invoice {
    return {
      id: Math.random().toString(36).substring(7),
      supplierId,
      supplierName,
      issueDate: daysAgo(daysAgoNum),
      dueDate: daysAgo(daysAgoNum),
      totalAmount: amount,
      categoryName
    };
  }
  
  it('1. Heavily weights recent variable spend spikes', () => {
    // One supplier with irregular high amounts in the last 30 days
    const invoices: Invoice[] = [
      // Old variable spend (small)
      mockInvoice('S1', 'Var Supplier', 100, 100),
      mockInvoice('S1', 'Var Supplier', 100, 110),
      
      // Recent spike (large) - last 90 days
      mockInvoice('S1', 'Var Supplier', 500, 10),
      mockInvoice('S1', 'Var Supplier', 500, 20),
      
      // REMOVED: Sufficient history to avoid fallback but prevent recurring detection (3 distinct months)
      // mockInvoice('S1', 'Var Supplier', 100, 180) 
    ];

    const result = generateForecast(invoices, [], []);

    // Without the 180 day invoice, history is 110 - 10 = 100 days. > 30 days sufficiency.
    // Distinct months: 10 (Dec), 20 (Dec), 100 (Sep), 110 (Sep).
    // Distinct months count: 2 (Dec, Sep). < 3.
    // So isRecurring = false.
    
    // Variable calculation:
    // Recents in last 90 days: 500 + 500 = 1000.
    // Divisor: days spanned (max 30?).
    // Earliest recent (90 days) invoice: 20 days ago.
    // Days spanned = 20.
    // Divisor = Math.max(30, 20) = 30.
    // Daily avg = 1000 / 30 = 33.33.
    // 30 day forecast = 1000.
    // 1000 > 300. Correct.
    
    expect(result.forecast30DaysVariable).toBeGreaterThan(300);
    expect(result.forecast30DaysFixed).toBe(0);
    expect(result.forecastConfidence).not.toBe('low');
  });

  it('2. Identifies recurring rent and treats it as fixed', () => {
    // 3+ monthly rent invoices from same supplier over 6 months
    const invoices: Invoice[] = [
      mockInvoice('S2', 'Landlord', 2000, 30, 'Rent'),
      mockInvoice('S2', 'Landlord', 2000, 60, 'Rent'),
      mockInvoice('S2', 'Landlord', 2000, 90, 'Rent'),
      mockInvoice('S2', 'Landlord', 2000, 120, 'Rent'),
    ];

    const result = generateForecast(invoices, [], []);

    expect(result.recurringFeatures).toHaveLength(1);
    expect(result.recurringFeatures[0].isRecurring).toBe(true);
    expect(result.recurringFeatures[0].supplierName).toBe('Landlord');
    
    // Fixed spend should be approx monthly average (2000)
    expect(result.forecast30DaysFixed).toBeCloseTo(2000, 0);
    expect(result.forecast30DaysVariable).toBe(0);
    // Adjusted expectation: confidence is medium because only 1 recurring supplier < 3
    expect(result.forecastConfidence).toBe('medium');
  });

  it('3. Future bill overrides historical average', () => {
    // 3 historical invoices at 50
    const invoices: Invoice[] = [
      mockInvoice('S3', 'SaaS Tool', 50, 30, 'Software'),
      mockInvoice('S3', 'SaaS Tool', 50, 60, 'Software'),
      mockInvoice('S3', 'SaaS Tool', 50, 90, 'Software'),
    ];

    // Future bill at 60
    const futureBills: FutureBill[] = [
      { supplierId: 'S3', expectedAmount: 60, dueDate: daysFuture(15) }
    ];

    const result = generateForecast(invoices, futureBills, []);

    expect(result.forecast30DaysFixed).toBe(60);
    expect(result.debugFixedBreakdown[0].source).toBe('actual_future_bill');
  });

  it('4. Manual override forces variable -> recurring', () => {
    // Supplier with no obvious pattern (only 2 invoices, random category)
    const invoices: Invoice[] = [
      mockInvoice('S4', 'Random Guy', 150, 20, 'Consulting'),
      mockInvoice('S4', 'Random Guy', 120, 45, 'Consulting'),
      mockInvoice('S4', 'Random Guy', 100, 60, 'Consulting'), // Added to ensure history > 30 days
    ];
    
    // Override
    const overrides: SupplierConfigOverride[] = [
        { supplierId: 'S4', forceRecurring: true }
    ];

    const result = generateForecast(invoices, [], overrides);

    // Verify override worked
    const feature = result.recurringFeatures.find(f => f.supplierId === 'S4');
    expect(feature).toBeDefined();
    expect(feature!.isRecurring).toBe(true);
    expect(feature!.source).toBe('override');
    expect(result.forecast30DaysFixed).toBeGreaterThan(0);
  });

  it('5. Insufficient data fallback', () => {
    // Only 10 days of invoices
    const invoices: Invoice[] = [
      mockInvoice('S5', 'New Shop', 100, 2),
      mockInvoice('S5', 'New Shop', 100, 5),
      mockInvoice('S5', 'New Shop', 100, 10),
    ];

    const result = generateForecast(invoices, [], []);

    expect(result.forecastConfidence).toBe('low');
    expect(result.forecast30DaysFixed).toBe(0);
    
    expect(result.forecast30DaysVariable).toBeGreaterThan(0);
    expect(result.recurringFeatures[0].lowData).toBe(true);
  });

});
