# Cash Flow Forecasting (Supplier Spend)

## 1. Purpose

The forecasting engine predicts supplier spend for the **next 30 days**. This helps business owners with cash planning and provides awareness of upcoming fixed commitments vs. variable spend patterns.

## 2. Data Sources

- **Invoices**: Fetched from Xero via `XeroInvoice` model.
- **Status**: Only `AUTHORISED` and `PAID` invoices are included. `VOIDED` invoices are excluded.
- **Time Window**: The engine analyzes the last **6 full calendar months** of history.
- **Future Bills**: (v1 Placeholder) Intended to use actual upcoming bills if they exist in the system.

## 3. Definitions

### Fixed / Recurring Spend
Spend that happens on a regular schedule (monthly).
- **Detection**: A supplier is marked as recurring if:
  1. **Frequency Rule**: Invoices appear in at least 3 distinct months within the last 6 months.
  2. **Category Rule**: The invoice category (or description) matches keywords like 'rent', 'lease', 'insurance', 'subscription', 'internet', etc.
  3. **Override**: A manual configuration forces the supplier to be treated as recurring.

### Variable Spend
"Everything else" – spend from suppliers not identified as recurring.
- Calculated based on the **recent run rate** (last 90 days) to capture latest operational intensity.

## 4. Algorithm Overview

The `generateForecast` function follows these steps:

1. **Preprocessing**: 
   - Filter invoices to the last 6 months.
   - Group by Supplier.

2. **Recurring Detection**:
   - Apply Frequency and Category rules to each supplier.
   - Check for Overrides.

3. **Fixed Calculation**:
   - For recurring suppliers, look for a **Future Bill** due in the next 30 days.
   - If found, use that amount.
   - If not, use the **Historical Monthly Average** (Total Spend / Months Active).

4. **Variable Calculation**:
   - Filter for non-recurring suppliers.
   - Limit data to the last **90 days**.
   - Compute `Daily Average = Total Spend / 90` (or actual days spanned if < 90).
   - `Forecast Variable = Daily Average * 30`.

5. **Fallback**:
   - If total history is < 30 days, use a naive daily average across all invoices.
   - Flag confidence as `low`.

## 5. Confidence Levels

The forecast returns a confidence flag:
- **High**: At least 3 recurring suppliers identified AND > 90 days of history.
- **Medium**: > 30 days of history but fewer recurring signals.
- **Low**: < 30 days of history (Fallback mode).

## 6. Limitations / Future Work

- **Line Items**: Currently uses primary category/description. Could be enhanced to split a single invoice into fixed vs variable line items.
- **Overrides UI**: Need a frontend interface to manage `SupplierConfigOverride` (force recurring/variable).
- **Scenario Modelling**: Allow users to adjust "what if" scenarios (e.g. "Rent increases by 5%").












