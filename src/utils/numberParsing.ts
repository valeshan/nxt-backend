export type ParseMoneyOptions = {
  kind: 'LINE_TOTAL' | 'UNIT_PRICE' | 'TAX' | 'DISCOUNT' | 'OTHER';
  maxDecimals?: number; // overrides kind default if provided
};

export type ParsedMoney = {
  value: number | null;
  cents: number | null;
  normalized: string | null;
  wasNormalized: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason?: 'AMBIGUOUS_DECIMAL_SEPARATOR' | 'INVALID_FORMAT';
  displayText2dp?: string; // for UNIT_PRICE
};

export const UNIT_PRICE_MAX_REASONABLE_FOR_DOT_ONLY_4DP = 100;

function isDecimalLike(x: any): x is { toNumber: () => number } {
  return x && typeof x === 'object' && typeof x.toNumber === 'function';
}

function stripNbsp(s: string) {
  return s.replace(/\u00A0/g, ' ');
}

function getMaxDecimals(opts: ParseMoneyOptions): number {
  if (typeof opts.maxDecimals === 'number') return opts.maxDecimals;
  return opts.kind === 'UNIT_PRICE' ? 4 : 2;
}

function roundTo(n: number, dp: number): number {
  const p = Math.pow(10, dp);
  return Math.round(n * p) / p;
}

function displayText2dpFromValue(n: number): string {
  return roundTo(n, 2).toFixed(2);
}

function applyParenthesesNegative(raw: string): { s: string; wasNormalized: boolean } {
  const s0 = raw.trim();
  if (!/^\(.*\)$/.test(s0)) return { s: s0, wasNormalized: false };
  const inner = s0.slice(1, -1);
  if (!/[0-9]/.test(inner)) return { s: s0, wasNormalized: false };
  return { s: `-${inner}`, wasNormalized: true };
}

function isUsMixedValid(s: string): boolean {
  // 1,234.56 | 12,345 | 1,234,567.89
  return /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s);
}

function isEuMixedValid(s: string): boolean {
  // 1.234,56 | 12.345 | 1.234.567,89
  return /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s);
}

function isFiniteNumber(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

function withInvalidFormat(wasNormalized: boolean): ParsedMoney {
  return {
    value: null,
    cents: null,
    normalized: null,
    wasNormalized,
    confidence: 'LOW',
    reason: 'INVALID_FORMAT',
  };
}

function withAmbiguous(wasNormalized: boolean): ParsedMoney {
  return {
    value: null,
    cents: null,
    normalized: null,
    wasNormalized,
    confidence: 'LOW',
    reason: 'AMBIGUOUS_DECIMAL_SEPARATOR',
  };
}

function finalize(n: number, opts: ParseMoneyOptions, normalized: string, wasNormalized: boolean, confidence: 'HIGH' | 'MEDIUM'): ParsedMoney {
  const maxDecimals = getMaxDecimals(opts);

  // Enforce decimal precision limit (based on normalized value string)
  const m = normalized.match(/\.(\d+)$/);
  const fracLen = m?.[1]?.length ?? 0;
  if (fracLen > maxDecimals) return withInvalidFormat(wasNormalized);

  if (opts.kind === 'UNIT_PRICE') {
    return {
      value: n,
      cents: null,
      normalized,
      wasNormalized,
      confidence,
      displayText2dp: displayText2dpFromValue(n),
    };
  }

  // Money fields: round to 2dp and compute cents from rounded value
  const v2 = roundTo(n, 2);
  return {
    value: v2,
    cents: Math.round(v2 * 100),
    normalized: String(v2),
    wasNormalized: wasNormalized || v2 !== n,
    confidence,
  };
}

/**
 * parseMoneyLike
 *
 * - Backend-only money parser for OCR ingestion (Textract) and canonicalization.
 * - Kind-sensitive precision rules: UNIT_PRICE allows up to 4dp; others default 2dp.
 * - Avoids thousands separator ambiguity. In particular, for money fields:
 *   - "1.234" is treated as ambiguous (not interpreted as 1234).
 */
export function parseMoneyLike(input: unknown, opts: ParseMoneyOptions): ParsedMoney {
  const maxDecimals = getMaxDecimals(opts);

  // Numbers / Decimal-like
  if (typeof input === 'number') {
    if (!isFiniteNumber(input)) return withInvalidFormat(false);
    const s = String(input);
    return finalize(input, opts, s, false, 'HIGH');
  }
  if (isDecimalLike(input)) {
    return parseMoneyLike(input.toNumber(), opts);
  }

  if (typeof input !== 'string') return withInvalidFormat(false);

  let raw = stripNbsp(input);
  const paren = applyParenthesesNegative(raw);
  raw = paren.s;

  // Cleaning:
  // - remove currency codes/letters
  // - remove common currency symbols
  // - remove whitespace (including thousands spaces)
  // - keep a single leading minus
  const cleaned = raw
    .trim()
    .replace(/[A-Za-z]/g, '')
    .replace(/[$€£¥]/g, '')
    .replace(/\s+/g, '')
    .replace(/(?!^)-/g, '');

  const wasNormalizedBase = paren.wasNormalized || cleaned !== raw;

  if (!/^-?[0-9.,]+$/.test(cleaned) || !/[0-9]/.test(cleaned)) {
    return withInvalidFormat(wasNormalizedBase);
  }

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  // Mixed separators: rightmost is decimal, validate US or EU thousands pattern
  if (hasDot && hasComma) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    const decimalIsDot = lastDot > lastComma;
    const valid = decimalIsDot ? isUsMixedValid(cleaned) : isEuMixedValid(cleaned);
    if (!valid) return withAmbiguous(true);

    const normalized = decimalIsDot
      ? cleaned.replace(/,/g, '')
      : cleaned.replace(/\./g, '').replace(/,/g, '.');

    const n = Number(normalized);
    if (!isFiniteNumber(n)) return withInvalidFormat(true);
    return finalize(n, opts, normalized, true, 'HIGH');
  }

  // Only comma exists
  if (!hasDot && hasComma) {
    const parts = cleaned.split(',');

    // Multiple commas: accept as thousands grouping only if valid
    if (parts.length > 2) {
      if (/^-?\d{1,3}(?:,\d{3})+$/.test(cleaned)) {
        const normalized = cleaned.replace(/,/g, '');
        const n = Number(normalized);
        if (!isFiniteNumber(n)) return withInvalidFormat(true);
        return finalize(n, opts, normalized, true, 'HIGH');
      }
      return withAmbiguous(true);
    }

    if (parts.length === 2) {
      const [lhs, rhs] = parts;

      // 2 digits after comma -> decimal comma
      if (rhs.length === 2) {
        if (rhs.length > maxDecimals) return withInvalidFormat(true);
        const normalized = `${lhs}.${rhs}`;
        const n = Number(normalized);
        if (!isFiniteNumber(n)) return withInvalidFormat(true);
        // we had to normalize comma->dot: MEDIUM
        return finalize(n, opts, normalized, true, 'MEDIUM');
      }

      // 3 digits after comma and lhs is 1-3 digits -> thousands comma (1,234)
      if (rhs.length === 3 && /^\d{1,3}$/.test(lhs.replace(/^-/, ''))) {
        const normalized = `${lhs}${rhs}`;
        const n = Number(normalized);
        if (!isFiniteNumber(n)) return withInvalidFormat(true);
        return finalize(n, opts, normalized, true, 'HIGH');
      }

      return withAmbiguous(true);
    }
  }

  // Only dot exists
  if (hasDot && !hasComma) {
    const parts = cleaned.split('.');
    if (parts.length !== 2) return withInvalidFormat(wasNormalizedBase);
    const rhs = parts[1] ?? '';

    // 2 digits after dot -> normal money format
    if (rhs.length === 2) {
      const n = Number(cleaned);
      if (!isFiniteNumber(n)) return withInvalidFormat(wasNormalizedBase);
      return finalize(n, opts, cleaned, wasNormalizedBase, 'HIGH');
    }

    // 3-4 digits after dot:
    // - For money kinds: 3dp is ambiguous (could be thousands-style), 4dp is invalid format.
    // - For UNIT_PRICE: allow up to 4dp (with a "reasonable value" gate for 3dp).
    if (rhs.length >= 3 && rhs.length <= 4) {
      const n = Number(cleaned);
      if (!isFiniteNumber(n)) return withInvalidFormat(wasNormalizedBase);

      // UNIT_PRICE: allow up to 4dp. Apply "reasonable value" gate only for 3dp (most likely to be thousands-style ambiguity).
      if (opts.kind === 'UNIT_PRICE') {
        if (rhs.length === 4) return finalize(n, opts, cleaned, wasNormalizedBase, 'HIGH');
        if (Math.abs(n) <= UNIT_PRICE_MAX_REASONABLE_FOR_DOT_ONLY_4DP) {
          return finalize(n, opts, cleaned, wasNormalizedBase, 'HIGH');
        }
        return withAmbiguous(wasNormalizedBase);
      }

      if (rhs.length === 4) return withInvalidFormat(wasNormalizedBase);
      return withAmbiguous(wasNormalizedBase);
    }

    if (rhs.length > maxDecimals) return withInvalidFormat(wasNormalizedBase);

    // 0-1 digits after dot are acceptable
    const n = Number(cleaned);
    if (!isFiniteNumber(n)) return withInvalidFormat(wasNormalizedBase);
    return finalize(n, opts, cleaned, wasNormalizedBase, 'HIGH');
  }

  // No separators: plain integer
  const n = Number(cleaned);
  if (!isFiniteNumber(n)) return withInvalidFormat(wasNormalizedBase);
  return finalize(n, opts, cleaned, wasNormalizedBase, wasNormalizedBase ? 'MEDIUM' : 'HIGH');
}


