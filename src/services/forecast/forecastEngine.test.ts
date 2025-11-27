import { describe, it, expect } from 'vitest';
import { generateForecast, Invoice, FutureBill, SupplierConfigOverride } from './forecastEngine';
import { subDays, addDays } from 'date-fns';

// Helpers
const now = new Date();

function daysAgo(n: number): Date {
  return subDays(now, n);
}

function daysFuture(n: number): Date {
  return addDays(now, n);
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

describe('Forecast Engine', () => {
  
  it('1. Heavily weights recent variable spend spikes', () => {
    // One supplier with irregular high amounts in the last 30 days
    const invoices: Invoice[] = [
      // Old variable spend (small)
      mockInvoice('S1', 'Var Supplier', 100, 100),
      mockInvoice('S1', 'Var Supplier', 100, 110),
      
      // Recent spike (large) - last 90 days
      mockInvoice('S1', 'Var Supplier', 500, 10),
      mockInvoice('S1', 'Var Supplier', 500, 20),
      
      // Sufficient history to avoid fallback
      mockInvoice('S1', 'Var Supplier', 100, 180) // 6 months ago
    ];

    const result = generateForecast(invoices, [], []);

    // Variable calculation:
    // Recents in last 90 days: 500 + 500 = 1000.
    // Divisor: 90 days (since history spans > 90 days).
    // Daily avg: 1000 / 90 = 11.11
    // 30 day forecast: 333.33
    
    // If we used 6 month avg (100+100+500+500+100 = 1300 / 180 = 7.2 -> 216), it would be lower.
    // The recent spike should pull it up.
    
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
    expect(result.forecastConfidence).toBe('high');
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
    ];
    
    // Override
    const overrides: SupplierConfigOverride[] = [
        { supplierId: 'S4', forceRecurring: true }
    ];

    const result = generateForecast(invoices, [], overrides);

    expect(result.recurringFeatures[0].isRecurring).toBe(true);
    expect(result.recurringFeatures[0].source).toBe('override');
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
    
    // Naive avg: 300 total / 10 days (approx, helper daysAgo(10)) -> 30/day -> 900
    // Actually logic uses calculateTotalDaysHistory.
    // Max date = daysAgo(2), Min = daysAgo(10). Diff = 8 days.
    // totalSpend = 300.
    // daily = 300 / 8 = 37.5.
    // 30 days = 1125.
    expect(result.forecast30DaysVariable).toBeGreaterThan(0);
    expect(result.recurringFeatures[0].lowData).toBe(true);
  });

});

