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
 * Bounded extraction: only extract when the description contains a simple numeric+unit token
 * like "2kg", "2 kg", "500ml". This avoids pack-size parsing ("2 x 2.5kg") which is deferred.
 */
const SIMPLE_UNIT_IN_DESC = /\b\d+(?:\.\d+)?\s?(KG|G|L|ML)\b/i;
const PACK_PATTERN = /\b\d+\s*x\s*\d+(?:\.\d+)?\s?(KG|G|L|ML)\b/i;

export function extractUnitLabelFromDescription(description: string): string | null {
  const text = String(description || '');
  // Explicitly avoid pack parsing in Sprint A.
  if (PACK_PATTERN.test(text)) return null;
  const match = text.match(SIMPLE_UNIT_IN_DESC);
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

