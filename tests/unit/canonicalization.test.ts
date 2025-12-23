import { describe, expect, it } from 'vitest';
import { AdjustmentStatus, UnitCategory } from '@prisma/client';
import { canonicalizeLine } from '../../src/services/canonical';

describe('canonicalizeLine', () => {
  it('normalizes description + bounded unit extraction (simple kg token)', () => {
    const res = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: '  Ham Leg 2kg  ',
      quantity: 1,
      lineTotal: 10,
      currencyCode: 'aud',
    });

    expect(res.normalizedDescription).toBe('ham leg 2kg');
    expect(res.unitLabel).toBe('KG');
    expect(res.unitCategory).toBe(UnitCategory.WEIGHT);
    expect(res.currencyCode).toBe('AUD');
  });

  it('treats count-only integer quantities as UNIT when no unit hints exist', () => {
    const res = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: 'Pringles (Cheese)',
      quantity: 90,
      lineTotal: 450,
      currencyCode: 'AUD',
    });

    expect(res.unitLabel).toBe('UNIT');
    expect(res.unitCategory).toBe(UnitCategory.UNIT);
    expect(res.qualityStatus).toBe('OK');
  });

  it('does not attempt pack parsing (2 x 2.5kg) and can default unit UNKNOWN', () => {
    const res = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: 'Chicken 2 x 2.5kg',
      quantity: 2,
      lineTotal: 20,
      currencyCode: 'AUD',
    });

    // Bounded extractor should not extract from pack form (deferred)
    expect(res.unitLabel).toBeNull();
    expect(res.unitCategory).toBe(UnitCategory.UNKNOWN);
    expect(res.qualityStatus).toBe('WARN');
    expect(res.qualityWarnReasons).toContain('UNKNOWN_UNIT_CATEGORY');
  });

  it('WARNs on invalid currency and missing currency when header missing', () => {
    const invalid = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: 'Milk',
      quantity: 1,
      lineTotal: 5,
      currencyCode: 'AU$', // invalid
      headerCurrencyCode: null,
    });
    expect(invalid.qualityStatus).toBe('WARN');
    expect(invalid.qualityWarnReasons).toContain('INVALID_CURRENCY_CODE');

    const missing = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: 'Milk',
      quantity: 1,
      lineTotal: 5,
      currencyCode: null,
      headerCurrencyCode: null,
    });
    expect(missing.qualityStatus).toBe('WARN');
    expect(missing.qualityWarnReasons).toContain('MISSING_CURRENCY_CODE');
  });

  it('negative lineTotal is OK when CREDITED, WARN otherwise', () => {
    const credited = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: 'Credit note adjustment',
      // Credit notes often have totals without meaningful unit quantity in Sprint A.
      quantity: null,
      lineTotal: -5,
      currencyCode: 'AUD',
      adjustmentStatus: AdjustmentStatus.CREDITED,
    });
    expect(credited.qualityStatus).toBe('OK');

    const notCredited = canonicalizeLine({
      source: 'OCR' as any,
      rawDescription: 'Adjustment',
      quantity: 1,
      lineTotal: -5,
      currencyCode: 'AUD',
      adjustmentStatus: AdjustmentStatus.NONE,
    });
    expect(notCredited.qualityStatus).toBe('WARN');
    expect(notCredited.qualityWarnReasons).toContain('NEGATIVE_LINE_TOTAL_NOT_CREDITED');
  });
});


