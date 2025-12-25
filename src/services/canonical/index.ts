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

  // Pack-form guard: defer unit extraction for patterns like "2 x 2.5kg".
  // We intentionally avoid extracting the inner unit token because pack parsing is out of scope here,
  // and extracting "KG" would be misleading (the true unit semantics are "pack").
  const PACK_FORM_WITH_UNIT =
    /\b\d+\s*[x×]\s*\d+(?:\.\d+)?\s?(KG|KGS|KILO|KILOS|KILOGRAM|KILOGRAMS|G|GM|GRAM|GRAMS|L|LT|LTR|LITRE|LITRES|LITER|LITERS|ML|MILLILITRE|MILLILITRES|MILLILITER|MILLILITERS)\b/i;
  const allowFallbackUnitExtraction = !PACK_FORM_WITH_UNIT.test(rawDescription);

  let unitLabel = canonicalizeUnitLabel(input.unitLabel, allowFallbackUnitExtraction ? rawDescription : undefined);
  // Coerce potentially Decimal-like inputs to numbers (Prisma can surface Decimal objects in some call paths).
  const qty = input.quantity === null || input.quantity === undefined ? null : Number(input.quantity);

  // NEW: safe UNIT fallback for count-based lines.
  // If quantity is present and there are no explicit weight/volume hints in the description, treat as UNIT.
  // Only treat weight/volume as "explicit" when it appears as a numeric+unit token.
  // This avoids false positives from words like "oiL" or "speciaL".
  // Note: do NOT rely on \b before the unit token because "2.5KG" has no word boundary between digit and letter.
  const hasExplicitWeightOrVolume =
    /\d+(?:\.\d+)?\s?(KG|KILO|KILOGRAM|KILOGRAMS|G|GM|GRAM|GRAMS|L|LT|LITRE|LITRES|LITER|LITERS|ML)\b/i.test(rawDescription);
  if (!unitLabel && qty !== null && Number.isFinite(qty) && !hasExplicitWeightOrVolume) {
    unitLabel = 'UNIT';
  }
  const unitCategory = mapUnitCategory(unitLabel);

  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  const headerCurrencyCode = normalizeCurrencyCode(input.headerCurrencyCode);

  const adjustmentStatus = input.adjustmentStatus ?? AdjustmentStatus.NONE;

  const numericParseWarnReasons = (input.numericParseWarnReasons || []).filter(Boolean);

  const { qualityStatus, warnReasons } = computeQualityStatus({
    quantity: qty,
    unitCategory,
    unitPrice: input.unitPrice === null || input.unitPrice === undefined ? null : Number(input.unitPrice),
    lineTotal: input.lineTotal === null || input.lineTotal === undefined ? null : Number(input.lineTotal),
    adjustmentStatus,
    currencyCode,
    headerCurrencyCode,
    numericParseFailed: numericParseWarnReasons.length > 0,
    numericParseWarnReasons,
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

