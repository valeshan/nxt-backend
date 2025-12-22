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

  const unitLabel = canonicalizeUnitLabel(input.unitLabel, rawDescription);
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

