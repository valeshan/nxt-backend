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

export type DescriptionWarningReason =
  | 'DESCRIPTION_LOW_ALPHA_RATIO'
  | 'DESCRIPTION_NO_VOWELS_LONG_TOKEN'
  | 'DESCRIPTION_OCR_NOISE'
  | 'DESCRIPTION_GIBBERISH'
  | 'DESCRIPTION_CONSONANT_CLUSTER';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

// Whitelist of legitimate words that might otherwise be flagged as OCR garbage
// These are common product names that have similar patterns to OCR misreads
const LEGITIMATE_WORD_WHITELIST = new Set([
  'prosciutto',
  'prosciuttone',
  'stracciatella',
  'mozzarella',
  'cappuccino',
  'macchiato',
  'bruschetta',
  'gnocchi',
  'pappardelle',
  'tagliatelle',
]);

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
 * Computes maximum consecutive consonants in a token.
 */
function maxConsecutiveConsonants(token: string): number {
  const letters = token.replace(/[^a-z]/gi, '');
  const consonant = /[bcdfghjklmnpqrstvwxyz]/i;
  let max = 0;
  let cur = 0;
  for (const ch of letters) {
    if (consonant.test(ch)) {
      cur++;
      max = Math.max(max, cur);
    } else {
      cur = 0;
    }
  }
  return max;
}

/**
 * Checks if a token looks like OCR word garbage.
 * Targets OCR misreads like "prontosaurvi" without flagging normal words.
 */
function looksLikeOcrWordGarbage(token: string): boolean {
  const t = token.trim();
  if (t.length < 8) return false;
  
  const maxCons = maxConsecutiveConsonants(t);
  const vr = vowelRatio(t);
  
  // Very strong signal: 4+ consecutive consonants (rare in real product words)
  if (maxCons >= 4) return true;
  
  // Medium signal: only when token is long + low vowels
  if (maxCons >= 3 && t.length >= 10 && vr <= 0.25) return true;
  
  // NEW: Catch long tokens with moderate vowel ratio that have multiple consonant clusters
  // Examples: "prontosaurvi" (12 chars, vr ~0.42, maxCons=2, but has multiple clusters: pr, nt, rv)
  if (t.length >= 10 && vr < 0.50) {
    // Count consonant clusters (2+ consecutive consonants)
    const consonant = /[bcdfghjklmnpqrstvwxyz]/i;
    const letters = t.replace(/[^a-z]/gi, '');
    let clusterCount = 0;
    let consecutiveConsonants = 0;
    
    for (const ch of letters) {
      if (consonant.test(ch)) {
        consecutiveConsonants++;
        // Count when we hit 2 consecutive consonants (a cluster)
        if (consecutiveConsonants === 2) {
          clusterCount++;
        }
      } else {
        consecutiveConsonants = 0;
      }
    }
    
    // Flag if has 3+ consonant clusters AND vowel ratio is in a narrow range (0.38-0.45)
    // This catches "prontosaurvi" (vr=0.42) but we'll gate the actual warning behind base warnings
    // to avoid false positives on legitimate words
    if (clusterCount >= 3 && vr >= 0.38 && vr <= 0.45) {
      // Additional check: require max consecutive consonants to be 2 (not 3+)
      // This helps distinguish OCR garbage from legitimate words with natural consonant clusters
      if (maxCons <= 2) return true;
    }
    
    // Also catch very low vowel ratio with 3+ clusters (more conservative)
    if (clusterCount >= 3 && vr < 0.35) return true;
  }
  
  return false;
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
  
  // ✅ Consonant-cluster / OCR-garbage detection
  // Strategy: Allow strong patterns (3+ clusters with moderate vowel ratio) to trigger independently
  // This catches "prontosaurvi" even without other warnings.
  // Weaker patterns are still gated behind base warnings to avoid false positives on "Transportation"
  const hasBaseWarning = warnings.some(w =>
    w === 'DESCRIPTION_LOW_ALPHA_RATIO' ||
    w === 'DESCRIPTION_NO_VOWELS_LONG_TOKEN' ||
    w === 'DESCRIPTION_OCR_NOISE' ||
    w === 'DESCRIPTION_GIBBERISH'
  );
  
  // Check for OCR garbage patterns
  // Strategy: Strong patterns (3+ clusters with moderate vowel ratio) trigger independently
  // This catches "prontosaurvi" even without other warnings.
  // Weaker patterns are gated behind base warnings to avoid false positives on "Transportation"
  for (const token of tokens) {
    const t = token.trim();
    if (t.length < 10) continue; // Skip short tokens
    
    // Skip if word is in whitelist of legitimate words
    if (LEGITIMATE_WORD_WHITELIST.has(t.toLowerCase())) continue;
    
    // Check if token matches OCR garbage pattern
    if (!looksLikeOcrWordGarbage(token)) continue;
    
    // Calculate cluster count, vowel ratio, and max consecutive consonants
    const vr = vowelRatio(t);
    const consonant = /[bcdfghjklmnpqrstvwxyz]/i;
    const letters = t.replace(/[^a-z]/gi, '');
    let clusterCount = 0;
    let consecutiveConsonants = 0;
    let maxCons = 0;
    let curCons = 0;
    
    for (const ch of letters) {
      if (consonant.test(ch)) {
        consecutiveConsonants++;
        curCons++;
        maxCons = Math.max(maxCons, curCons);
        if (consecutiveConsonants === 2) {
          clusterCount++;
        }
      } else {
        consecutiveConsonants = 0;
        curCons = 0;
      }
    }
    
    // Strong pattern: very specific OCR garbage characteristics
    // Require: 3+ clusters, vowel ratio 0.38-0.45, maxCons <= 2, AND cluster density < 0.27
    // This catches "prontosaurvi" (density 0.25) but avoids "Prosciutto" (density 0.30)
    const clusterDensity = clusterCount / letters.length;
    const isVeryStrongPattern = clusterCount >= 3 && vr >= 0.38 && vr <= 0.45 && maxCons <= 2 && clusterDensity < 0.27;
    
    // Trigger if very strong pattern OR if base warnings exist
    // This allows catching clear OCR garbage independently while gating weaker signals
    if (isVeryStrongPattern || hasBaseWarning) {
      warnings.push('DESCRIPTION_CONSONANT_CLUSTER');
      break; // Only flag once per description
    }
  }
  
  // Deduplicate
  return Array.from(new Set(warnings));
}

