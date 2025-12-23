import { UnitCategory } from '@prisma/client';
import { normalizeUnitLabel } from './normalize';

const WEIGHT = new Set(['KG', 'KILO', 'G', 'GM', 'GRAM', 'GRAMS', 'KILOGRAM', 'KILOGRAMS']);
const VOLUME = new Set(['L', 'LT', 'LITRE', 'LITER', 'ML', 'MILLILITRE', 'MILLILITER']);

const SYNONYMS: Record<string, string> = {
  KILOS: 'KG',
  KILO: 'KG',
  KILOGRAM: 'KG',
  KILOGRAMS: 'KG',
  GR: 'G',
  GRAM: 'G',
  GRAMS: 'G',
  LITRE: 'L',
  LITRES: 'L',
  LITER: 'L',
  LITERS: 'L',
  MILLILITRE: 'ML',
  MILLILITRES: 'ML',
  MILLILITER: 'ML',
  MILLILITERS: 'ML',
  EACH: 'EACH',
  EA: 'EACH',
  UNITS: 'UNIT',
};

/**
 * Bounded extraction: only extract when the description contains a numeric+unit token
 * like "2kg", "2 kg", "500ml", "3 LT", or "4x5KG" (matches the inner "5KG").
 *
 * We only need the unit category (WEIGHT/VOLUME/UNIT) for canonical quality gates; parsing pack math
 * is out of scope here, but detecting the unit token is safe and improves coverage.
 */
// Capture common unit tokens (including "KILO" / "KILOGRAM") that appear glued to numbers (e.g. "12KILO").
// We canonicalize via `canonicalizeUnitLabel()` -> `SYNONYMS`, so we can be liberal here.
const UNIT_TOKEN_IN_DESC =
  /\d+(?:\.\d+)?\s?(KG|KGS|KILO|KILOS|KILOGRAM|KILOGRAMS|G|GM|GRAM|GRAMS|L|LT|LTR|LITRE|LITRES|LITER|LITERS|ML|MILLILITRE|MILLILITRES|MILLILITER|MILLILITERS)\b/i;

export function extractUnitLabelFromDescription(description: string): string | null {
  const text = String(description || '');
  const match = text.match(UNIT_TOKEN_IN_DESC);
  if (!match) return null;
  return normalizeUnitLabel(match[1]);
}

export function canonicalizeUnitLabel(unitLabel: string | null | undefined, descriptionForFallback?: string): string | null {
  const normalized = normalizeUnitLabel(unitLabel);
  if (normalized) {
    return SYNONYMS[normalized] ?? normalized;
  }
  if (descriptionForFallback) {
    const extracted = extractUnitLabelFromDescription(descriptionForFallback);
    if (extracted) return SYNONYMS[extracted] ?? extracted;
  }
  return null;
}

export function mapUnitCategory(unitLabel: string | null | undefined): UnitCategory {
  const u = normalizeUnitLabel(unitLabel);
  if (!u) return UnitCategory.UNKNOWN;
  const mapped = SYNONYMS[u] ?? u;
  if (WEIGHT.has(mapped)) return UnitCategory.WEIGHT;
  if (VOLUME.has(mapped)) return UnitCategory.VOLUME;
  return UnitCategory.UNIT;
}

