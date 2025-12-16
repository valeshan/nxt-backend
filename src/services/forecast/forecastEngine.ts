import { subMonths, differenceInDays, isAfter, isBefore, startOfDay, endOfDay, subDays, isSameMonth } from 'date-fns';

// --- Interfaces ---

export interface Invoice {
  id: string;
  supplierId: string;
  supplierName: string;
  issueDate: Date;
  dueDate: Date;
  totalAmount: number; // Tax inclusive/exclusive should be consistent. Assuming inclusive/total payable.
  categoryCode?: string | null;
  categoryName?: string | null;
}

export interface FutureBill {
  supplierId: string;
  expectedAmount: number;
  dueDate: Date;
}

export interface SupplierConfigOverride {
  supplierId: string;
  forceRecurring?: boolean;
  forceVariable?: boolean;
}

export interface RecurringFeature {
  supplierId: string;
  supplierName: string;
  isRecurring: boolean;
  meetsFrequencyRule: boolean;
  meetsCategoryRule: boolean;
  source: 'history' | 'override';
  avgMonthlyAmount?: number;
  usedAmount?: number;
  lowData?: boolean;
}

export interface FixedBreakdownItem {
  supplierId: string;
  supplierName: string;
  source: 'actual_future_bill' | 'historical_average' | 'override';
  amount: number;
}

export interface ForecastResult {
  forecast30DaysFixed: number;
  forecast30DaysVariable: number;
  forecast30DaysTotal: number;
  recurringFeatures: RecurringFeature[];
  debugFixedBreakdown: FixedBreakdownItem[];
  forecastConfidence: 'low' | 'medium' | 'high';
}

// --- Constants ---

const RECURRING_KEYWORDS = [
  'rent', 'lease', 'mortgage', 'utilities', 'electricity', 'power', 
  'gas', 'internet', 'adsl', 'phone', 'subscription', 'saas', 'insurance'
];

// --- Engine ---

export function generateForecast(
  invoices: Invoice[],
  futureBills: FutureBill[],
  overrides: SupplierConfigOverride[] = []
): ForecastResult {
  const now = new Date();
  const sixMonthsAgo = subMonths(now, 6);
  const ninetyDaysAgo = subDays(now, 90);

  // 0. Pre-check data sufficiency
  const totalDaysHistory = calculateTotalDaysHistory(invoices);
  if (totalDaysHistory < 30) {
    return calculateFallbackForecast(invoices, totalDaysHistory);
  }

  // A. Preprocessing
  // Filter invoices to last 6 full calendar months (approx) - using simple date window for now
  const recentInvoices = invoices.filter(inv => isAfter(inv.issueDate, sixMonthsAgo));
  
  const supplierMap = groupInvoicesBySupplier(recentInvoices);

  // Prepare results containers
  let forecast30DaysFixed = 0;
  let forecast30DaysVariable = 0;
  const recurringFeatures: RecurringFeature[] = [];
  const debugFixedBreakdown: FixedBreakdownItem[] = [];
  const recurringSupplierIds = new Set<string>();

  // B. Process each supplier for recurring status
  for (const [supplierId, supplierInvoices] of supplierMap.entries()) {
    const firstInv = supplierInvoices[0]; // sample for name/category
    const supplierName = firstInv.supplierName;
    
    // Metrics
    const distinctMonths = new Set(supplierInvoices.map(i => 
      `${i.issueDate.getFullYear()}-${i.issueDate.getMonth()}`
    )).size;

    // Rules
    const meetsFrequencyRule = distinctMonths >= 3;
    
    const categoryStr = ((firstInv.categoryName || '') + ' ' + (firstInv.categoryCode || '')).toLowerCase();
    const meetsCategoryRule = RECURRING_KEYWORDS.some(kw => categoryStr.includes(kw));
    
    const override = overrides.find(o => o.supplierId === supplierId);
    const forceRecurring = override?.forceRecurring === true;
    const forceVariable = override?.forceVariable === true;

    let isRecurring = false;
    let source: 'history' | 'override' = 'history';

    if (forceVariable) {
      isRecurring = false;
      source = 'override';
    } else if (forceRecurring) {
      isRecurring = true;
      source = 'override';
    } else if (meetsFrequencyRule || meetsCategoryRule) {
      isRecurring = true;
    }

    if (isRecurring) {
      recurringSupplierIds.add(supplierId);

      // C. Fixed Spend Calculation for this supplier
      let fixedContribution = 0;
      let contributionSource: 'actual_future_bill' | 'historical_average' | 'override' = 'historical_average';

      // 1. Check Future Bill
      // Find matching future bill due in next 30 days
      const futureBill = futureBills.find(fb => 
        fb.supplierId === supplierId && 
        differenceInDays(fb.dueDate, now) <= 30 &&
        differenceInDays(fb.dueDate, now) >= 0
      );

      if (futureBill) {
        fixedContribution = futureBill.expectedAmount;
        contributionSource = 'actual_future_bill';
      } else {
        // 2. Historical Average
        // Compute monthly average over the active months or just total / 6? 
        // Plan says: (total spend last 6 months) / number of months with invoices
        const totalSpend = supplierInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
        // Avoid division by zero, though distinctMonths should be >=1 if we are here
        const divisor = Math.max(1, distinctMonths);
        fixedContribution = totalSpend / divisor;
      }

      forecast30DaysFixed += fixedContribution;
      
      debugFixedBreakdown.push({
        supplierId,
        supplierName,
        source: contributionSource,
        amount: fixedContribution
      });

      recurringFeatures.push({
        supplierId,
        supplierName,
        isRecurring: true,
        meetsFrequencyRule,
        meetsCategoryRule,
        source,
        avgMonthlyAmount: fixedContribution,
        usedAmount: fixedContribution
      });
    } else {
      // Not recurring, just track for metadata if needed
       recurringFeatures.push({
        supplierId,
        supplierName,
        isRecurring: false,
        meetsFrequencyRule,
        meetsCategoryRule,
        source: 'history'
      });
    }
  }

  // D. Variable Spend Calculation
  // 1. Filter for variable suppliers only
  // 2. Use last 90 days of invoices
  const variableInvoices = recentInvoices.filter(inv => 
    !recurringSupplierIds.has(inv.supplierId) && 
    isAfter(inv.issueDate, ninetyDaysAgo)
  );

  const totalVariableSpend90 = variableInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  
  // Divisor: 90 days, or actual days spanned if less, min 30
  // We'll assume 90 as the standard denominator for "last 90 days rate", 
  // but if the dataset is shorter, we should adjust to avoid dilution.
  // However, if we have < 30 days history total, we hit fallback. 
  // If we have > 30 days but variable invoices are sparse, dividing by 90 is conservative (correct).
  // Plan says: "divide by actual days spanned but minimum divisor = 30"
  let divisor = 90;
  if (variableInvoices.length > 0) {
      // Find earliest invoice in this set
      const earliest = variableInvoices.reduce((min, inv) => inv.issueDate < min ? inv.issueDate : min, variableInvoices[0].issueDate);
      const daysSpanned = differenceInDays(now, earliest);
      divisor = Math.max(30, daysSpanned);
      // Cap at 90 if we filtered by 90?
      if (divisor > 90) divisor = 90; 
  }
  
  const dailyAverageVariable = totalVariableSpend90 / divisor;
  forecast30DaysVariable = dailyAverageVariable * 30;

  // Confidence
  const confidence = calculateConfidence(recurringFeatures.filter(r => r.isRecurring).length, totalDaysHistory);

  return {
    forecast30DaysFixed,
    forecast30DaysVariable,
    forecast30DaysTotal: forecast30DaysFixed + forecast30DaysVariable,
    recurringFeatures,
    debugFixedBreakdown,
    forecastConfidence: confidence
  };
}

// --- Helpers ---

function calculateTotalDaysHistory(invoices: Invoice[]): number {
  if (invoices.length < 2) return 0;
  const dates = invoices.map(i => i.issueDate.getTime());
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  return Math.ceil((max - min) / (1000 * 60 * 60 * 24));
}

function calculateFallbackForecast(invoices: Invoice[], daysCovered: number): ForecastResult {
  const totalSpend = invoices.reduce((sum, i) => sum + i.totalAmount, 0);
  const effectiveDays = Math.max(7, daysCovered); // Avoid wild division for 1-2 days
  const dailyAvg = totalSpend / effectiveDays;
  const forecast = dailyAvg * 30;

  return {
    forecast30DaysFixed: 0,
    forecast30DaysVariable: forecast,
    forecast30DaysTotal: forecast,
    recurringFeatures: invoices.length > 0 ? [{
      supplierId: 'all',
      supplierName: 'Multiple Suppliers',
      isRecurring: false,
      meetsFrequencyRule: false,
      meetsCategoryRule: false,
      source: 'history',
      lowData: true
    }] : [],
    debugFixedBreakdown: [],
    forecastConfidence: 'low'
  };
}

function groupInvoicesBySupplier(invoices: Invoice[]): Map<string, Invoice[]> {
  const map = new Map<string, Invoice[]>();
  for (const inv of invoices) {
    if (!map.has(inv.supplierId)) {
      map.set(inv.supplierId, []);
    }
    map.get(inv.supplierId)!.push(inv);
  }
  return map;
}

function calculateConfidence(numRecurring: number, daysHistory: number): 'low' | 'medium' | 'high' {
  if (daysHistory < 30) return 'low';
  if (daysHistory < 90) return 'medium';
  if (numRecurring >= 3) return 'high';
  return 'medium';
}







