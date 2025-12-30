import { AdjustmentStatus, QualityStatus, UnitCategory } from '@prisma/client';

export function normalizeCurrencyCode(currencyCode: string | null | undefined): string | null {
  const v = (currencyCode ?? '').trim().toUpperCase();
  if (!v) return null;
  return v;
}

export function isValidCurrencyCode(currencyCode: string | null | undefined): boolean {
  const v = normalizeCurrencyCode(currencyCode);
  if (!v) return false;
  return /^[A-Z]{3}$/.test(v);
}

export type QualityInput = {
  quantity?: number | null;
  unitCategory: UnitCategory;
  unitPrice?: number | null;
  lineTotal?: number | null;
  adjustmentStatus: AdjustmentStatus;
  currencyCode: string | null;
  headerCurrencyCode: string | null;
  numericParseFailed?: boolean;
  numericParseWarnReasons?: string[] | null;
};

export function computeQualityStatus(input: QualityInput): { qualityStatus: QualityStatus; warnReasons: string[] } {
  const warnReasons: string[] = [];

  const qty = input.quantity ?? null;
  const lineTotal = input.lineTotal ?? null;
  const unitPrice = input.unitPrice ?? null;

  const parseWarns = (input.numericParseWarnReasons || []).filter(Boolean);
  if (input.numericParseFailed || parseWarns.length > 0) warnReasons.push('FAILED_NUMERIC_PARSE');
  for (const r of parseWarns) {
    if (!warnReasons.includes(r)) warnReasons.push(r);
  }

  // Quantity validation: separate warnings for missing vs invalid
  // Credit notes are exempt from missing quantity checks (they often have totals without meaningful unit quantity)
  if (qty === null && input.adjustmentStatus !== AdjustmentStatus.CREDITED) {
    warnReasons.push('MISSING_QUANTITY');
  } else if (qty !== null && qty <= 0) {
    warnReasons.push('NON_POSITIVE_QUANTITY');
  }

  if (lineTotal !== null && lineTotal < 0 && input.adjustmentStatus !== AdjustmentStatus.CREDITED) {
    warnReasons.push('NEGATIVE_LINE_TOTAL_NOT_CREDITED');
  }

  if ((qty ?? 0) > 0 && input.unitCategory === UnitCategory.UNKNOWN) {
    warnReasons.push('UNKNOWN_UNIT_CATEGORY');
  }

  // Currency rules:
  // - WARN if currencyCode is present but invalid
  // - WARN if both line and header currency are missing (true unknown)
  if (input.currencyCode && !isValidCurrencyCode(input.currencyCode)) warnReasons.push('INVALID_CURRENCY_CODE');
  if (!input.currencyCode && !input.headerCurrencyCode) warnReasons.push('MISSING_CURRENCY_CODE');

  // Inconsistent pricing fields:
  // - unitPrice exists but quantity missing/zero
  // - quantity exists but lineTotal missing and unitPrice missing
  const qtyVal = qty ?? 0;
  if (unitPrice !== null && qtyVal <= 0) warnReasons.push('UNIT_PRICE_WITHOUT_QUANTITY');
  if (qtyVal > 0 && unitPrice === null && lineTotal === null) warnReasons.push('MISSING_PRICE_FIELDS');

  return {
    qualityStatus: warnReasons.length > 0 ? QualityStatus.WARN : QualityStatus.OK,
    warnReasons,
  };
}

