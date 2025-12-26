/**
 * Text quality heuristics for detecting OCR misreads.
 * 
 * These heuristics catch cases where Textract is "confidently wrong" -
 * high confidence scores but the text looks garbled or misread.
 * 
 * Examples:
 * - "Frogen prontosaurvi RDS" (should be "Frozen Brontosaurus Ribs")
 * - "1234 #### ////" (too many symbols)
 * - "prntsrvs" (no vowels in long token)
 */

import { spellCheckService } from './spellcheck';

export type DescriptionWarningReason =
  | 'DESCRIPTION_LOW_ALPHA_RATIO'
  | 'DESCRIPTION_NO_VOWELS_LONG_TOKEN'
  | 'DESCRIPTION_OCR_NOISE'
  | 'DESCRIPTION_GIBBERISH'
  | 'DESCRIPTION_POSSIBLE_TYPO';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

/**
 * Checks if a token has vowels (case-insensitive).
 */
function hasVowels(token: string): boolean {
  return Array.from(token).some(char => VOWELS.has(char));
}

/**
 * Computes the ratio of alphabetic characters to total characters.
 */
function getAlphaRatio(text: string): number {
  if (text.length === 0) return 0;
  const alphaCount = Array.from(text).filter(c => /[A-Za-z]/.test(c)).length;
  return alphaCount / text.length;
}

/**
 * Computes vowel ratio for a token (vowels / total letters).
 */
function vowelRatio(token: string): number {
  const letters = token.replace(/[^a-z]/gi, '');
  if (!letters) return 0;
  const vowels = (letters.match(/[aeiou]/gi) || []).length;
  return vowels / letters.length;
}



/**
 * Checks if text contains repeated odd characters that suggest OCR noise.
 */
function hasOcrNoise(text: string): boolean {
  // Check for repeated punctuation/symbols (3+ consecutive)
  if (/[~|`]{3,}/.test(text)) return true;
  if (/[#]{3,}/.test(text)) return true;
  if (/[/]{3,}/.test(text)) return true;
  
  // Check for excessive consonant clusters (5+ consonants in a row)
  if (/[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{5,}/i.test(text)) return true;
  
  return false;
}

/**
 * Computes a "gibberish score" based on multiple factors.
 * Returns true if the text looks significantly garbled.
 */
function looksGibberish(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return false;
  
  // Count tokens with unusual patterns
  let unusualCount = 0;
  for (const token of tokens) {
    // Long token with no vowels
    if (token.length >= 6 && !hasVowels(token)) {
      unusualCount++;
    }
    // Token with very low alpha ratio (< 0.5)
    if (getAlphaRatio(token) < 0.5 && token.length >= 4) {
      unusualCount++;
    }
  }
  
  // If > 30% of tokens are unusual, consider it gibberish
  return unusualCount / tokens.length > 0.3;
}

/**
 * Computes text quality warnings for a description.
 * 
 * Returns an array of warning reason codes. Empty array means no warnings.
 * 
 * Heuristics (conservative - warnings should be "skim this", not "blocked"):
 * - DESCRIPTION_LOW_ALPHA_RATIO: Too many symbols/numbers relative to letters (< 0.65)
 * - DESCRIPTION_NO_VOWELS_LONG_TOKEN: Token length >= 6 with no vowels
 * - DESCRIPTION_OCR_NOISE: Repeated odd characters or excessive consonant clusters
 * - DESCRIPTION_GIBBERISH: Overall pattern suggests misread (> 30% unusual tokens)
 * 
 * @param description The description text to analyze
 * @returns Array of warning reason codes
 */
export function computeDescriptionWarnings(description: string): DescriptionWarningReason[] {
  if (!description || description.trim().length === 0) {
    return [];
  }
  
  const warnings: DescriptionWarningReason[] = [];
  const trimmed = description.trim();
  
  // Base warnings first
  const alphaRatio = getAlphaRatio(trimmed);
  // Exception: Don't flag short product codes (e.g., "SKU-12345", "ITEM-001")
  // These typically have format: 3-5 letters, dash, numbers
  const isProductCode = /^[A-Z]{2,5}-?\d+$/i.test(trimmed) && trimmed.length <= 15;
  if (alphaRatio < 0.65 && trimmed.length >= 5 && !isProductCode) {
    warnings.push('DESCRIPTION_LOW_ALPHA_RATIO');
  }
  
  const tokens = trimmed.split(/\s+/).filter(t => t.length > 0);
  
  // DESCRIPTION_NO_VOWELS_LONG_TOKEN: Check for long tokens without vowels
  for (const token of tokens) {
    if (token.length >= 6 && !hasVowels(token)) {
      warnings.push('DESCRIPTION_NO_VOWELS_LONG_TOKEN');
      break; // Only flag once per description
    }
  }
  
  // DESCRIPTION_OCR_NOISE: Check for repeated odd characters
  if (hasOcrNoise(trimmed)) {
    warnings.push('DESCRIPTION_OCR_NOISE');
  }
  
  // DESCRIPTION_GIBBERISH: Overall pattern check (only if other warnings exist)
  if (looksGibberish(trimmed) && warnings.length > 0) {
    warnings.push('DESCRIPTION_GIBBERISH');
  }
  
  // ✅ Spellcheck-based typo detection
  // Uses dictionary-backed spellchecking with domain allowlists to detect OCR typos
  // while avoiding false positives on legitimate words.
  // Note: spellCheckService is imported at top of file (initialized at boot time)
  
  let totalEligible = 0;
  let unknownCount = 0;
  let trustedAnchorCount = 0;
  
  for (const token of tokens) {
    // Normalize token
    const normalized = spellCheckService.normalizeToken(token);
    
    // Skip if should be ignored or too short
    if (spellCheckService.shouldIgnoreToken(token) || normalized.length < 4) {
      continue;
    }
    
    totalEligible++;
    
    // Check if token is correct (in allowlist or dictionary)
    const isCorrect = spellCheckService.isCorrect(normalized);
    
    if (!isCorrect) {
      unknownCount++;
    } else if (normalized.length > 4) {
      // Trusted anchor: correct word with length > 4
      trustedAnchorCount++;
    }
  }
  
  // Only evaluate if we have at least 2 eligible tokens
  if (totalEligible >= 2) {
    const unknownRatio = totalEligible > 0 ? unknownCount / totalEligible : 0;
    const hasTrustedAnchor = trustedAnchorCount > 0;
    
    // Standard rule: unknownRatio > 0.5 AND totalEligible >= 2
    // Anchored rule: if hasTrustedAnchor, require unknownRatio >= 0.67 AND totalEligible >= 2
    // Override: if unknownCount >= 3, flag regardless of anchor
    const shouldFlag = 
      unknownCount >= 3 || // Override: 3+ unknown tokens
      (hasTrustedAnchor 
        ? unknownRatio >= 0.67 && totalEligible >= 2  // Anchored threshold
        : unknownRatio > 0.5 && totalEligible >= 2);  // Standard threshold
    
    if (shouldFlag) {
      warnings.push('DESCRIPTION_POSSIBLE_TYPO');
    }
  }
  
  // Deduplicate
  return Array.from(new Set(warnings));
}

