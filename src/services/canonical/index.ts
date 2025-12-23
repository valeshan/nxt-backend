import { AdjustmentStatus, CanonicalSource } from '@prisma/client';
import { normalizeCurrencyCode } from './quality';
import { computeQualityStatus } from './quality';
import { normalizeDescription } from './normalize';
import { canonicalizeUnitLabel, mapUnitCategory } from './unitCategory';
import type { CanonicalizedLineInput, CanonicalizedLineOutput } from './types';

export function canonicalizeLine(
  input: CanonicalizedLineInput & { headerCurrencyCode?: string | null }
): CanonicalizedLineOutput {
  const rawDescription = String(input.rawDescription ?? '');
  const normalizedDescription = normalizeDescription(rawDescription);

  let unitLabel = canonicalizeUnitLabel(input.unitLabel, rawDescription);
  const qty = input.quantity ?? null;

  // Sprint A: handle count-only invoices (no explicit unit tokens anywhere).
  // If the quantity is an integer and there are no weight/volume hints in the description, treat as UNIT.
  // This keeps aggregation unit-safe while avoiding 100% WARN on typical "Quantity" columns.
  // Note: do NOT rely on \b before the token because "2.5KG" has no word boundary between digit and letter.
  const hasWeightOrVolumeHint = /(KG|KILO|KILOGRAM|KILOGRAMS|G|GM|GRAM|GRAMS|L|LT|LITRE|LITRES|LITER|LITERS|ML)\b/i.test(
    rawDescription
  );
  if (!unitLabel && qty !== null && Number.isFinite(qty) && Number.isInteger(qty) && !hasWeightOrVolumeHint) {
    unitLabel = 'UNIT';
  }
  const unitCategory = mapUnitCategory(unitLabel);

  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  const headerCurrencyCode = normalizeCurrencyCode(input.headerCurrencyCode);

  const adjustmentStatus = input.adjustmentStatus ?? AdjustmentStatus.NONE;

  const { qualityStatus, warnReasons } = computeQualityStatus({
    quantity: input.quantity ?? null,
    unitCategory,
    unitPrice: input.unitPrice ?? null,
    lineTotal: input.lineTotal ?? null,
    adjustmentStatus,
    currencyCode,
    headerCurrencyCode,
    numericParseFailed: false,
  });

  return {
    rawDescription,
    normalizedDescription,
    unitLabel,
    unitCategory,
    currencyCode,
    adjustmentStatus,
    qualityStatus,
    qualityWarnReasons: warnReasons,
  };
}

export function assertCanonicalInvoiceLegacyLink(params: {
  source: CanonicalSource;
  legacyInvoiceId?: string | null;
  legacyXeroInvoiceId?: string | null;
}) {
  const a = params.legacyInvoiceId ? 1 : 0;
  const b = params.legacyXeroInvoiceId ? 1 : 0;
  if (a + b !== 1) {
    throw new Error(
      `[Canonical] Invalid legacy linkage for source=${params.source}: expected exactly one of legacyInvoiceId or legacyXeroInvoiceId`
    );
  }
}

