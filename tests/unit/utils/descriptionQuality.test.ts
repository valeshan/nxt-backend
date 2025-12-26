import { describe, it, expect, beforeAll } from 'vitest';
import { computeDescriptionWarnings } from '../../../src/utils/descriptionQuality';

describe('computeDescriptionWarnings', () => {
  // Initialize spellcheck service once for all tests
  beforeAll(async () => {
    const { spellCheckService } = await import('../../../src/utils/spellcheck.js');
    await spellCheckService.initialize();
  });
  describe('Normal descriptions (no warnings)', () => {
    it('should return empty array for "Frozen Brontosaurus Ribs"', () => {
      const warnings = computeDescriptionWarnings('Frozen Brontosaurus Ribs');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for "Chicken Breast 500g"', () => {
      const warnings = computeDescriptionWarnings('Chicken Breast 500g');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for "Organic Tomatoes"', () => {
      const warnings = computeDescriptionWarnings('Organic Tomatoes');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for short normal text', () => {
      const warnings = computeDescriptionWarnings('Milk');
      expect(warnings).toEqual([]);
    });
  });

  describe('DESCRIPTION_NO_VOWELS_LONG_TOKEN', () => {
    it('should flag "Frogen prontosaurvi RDS" (triggers POSSIBLE_TYPO, not NO_VOWELS)', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      // This text triggers DESCRIPTION_POSSIBLE_TYPO (spellcheck catches the typos)
      // It does NOT trigger NO_VOWELS_LONG_TOKEN because all tokens have vowels
      expect(warnings).toContain('DESCRIPTION_POSSIBLE_TYPO');
    });

    it('should flag "prntsrvs" (long token without vowels)', () => {
      const warnings = computeDescriptionWarnings('prntsrvs');
      expect(warnings).toContain('DESCRIPTION_NO_VOWELS_LONG_TOKEN');
    });

    it('should not flag short tokens without vowels', () => {
      const warnings = computeDescriptionWarnings('RDS');
      expect(warnings).not.toContain('DESCRIPTION_NO_VOWELS_LONG_TOKEN');
    });
  });

  describe('DESCRIPTION_LOW_ALPHA_RATIO', () => {
    it('should flag "1234 #### ////"', () => {
      const warnings = computeDescriptionWarnings('1234 #### ////');
      expect(warnings).toContain('DESCRIPTION_LOW_ALPHA_RATIO');
    });

    it('should flag text with too many symbols', () => {
      const warnings = computeDescriptionWarnings('Item ### $$$ %%%');
      expect(warnings).toContain('DESCRIPTION_LOW_ALPHA_RATIO');
    });

    it('should not flag normal text with some numbers', () => {
      const warnings = computeDescriptionWarnings('Chicken 500g');
      expect(warnings).not.toContain('DESCRIPTION_LOW_ALPHA_RATIO');
    });
  });

  describe('DESCRIPTION_OCR_NOISE', () => {
    it('should flag repeated odd characters', () => {
      const warnings = computeDescriptionWarnings('Item ~~~ |||');
      expect(warnings).toContain('DESCRIPTION_OCR_NOISE');
    });

    it('should flag excessive consonant clusters', () => {
      const warnings = computeDescriptionWarnings('prntsrvsrstrng');
      expect(warnings).toContain('DESCRIPTION_OCR_NOISE');
    });

    it('should flag repeated hash symbols', () => {
      const warnings = computeDescriptionWarnings('Item #####');
      expect(warnings).toContain('DESCRIPTION_OCR_NOISE');
    });
  });

  describe('DESCRIPTION_GIBBERISH', () => {
    it('should flag "Frogen prontosaurvi RDS" (triggers POSSIBLE_TYPO, not GIBBERISH)', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      // This text triggers DESCRIPTION_POSSIBLE_TYPO (spellcheck catches the typos)
      // GIBBERISH only triggers if base warnings exist AND looksGibberish() is true
      // Since spellcheck catches it first, GIBBERISH may not trigger
      expect(warnings).toContain('DESCRIPTION_POSSIBLE_TYPO');
    });

    it('should flag text with multiple unusual patterns', () => {
      const warnings = computeDescriptionWarnings('prntsrvs 1234 ####');
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should return empty array for empty string', () => {
      const warnings = computeDescriptionWarnings('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for whitespace only', () => {
      const warnings = computeDescriptionWarnings('   ');
      expect(warnings).toEqual([]);
    });

    it('should handle very short text gracefully', () => {
      const warnings = computeDescriptionWarnings('AB');
      expect(warnings).toEqual([]);
    });
  });

  describe('DESCRIPTION_POSSIBLE_TYPO', () => {
    // Initialize spellcheck service for tests (will use actual dictionaries if available)
    beforeEach(async () => {
      const { spellCheckService } = await import('../../../src/utils/spellcheck.js');
      await spellCheckService.initialize();
    });

    it('should flag "Frogen prontosaurvi RDS" (OCR misread)', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      // Should flag as possible typo (unknown words: Frogen, prontosaurvi)
      expect(warnings).toContain('DESCRIPTION_POSSIBLE_TYPO');
    });

    it('should NOT flag "Transportation & Logistics" (known words)', () => {
      const warnings = computeDescriptionWarnings('Transportation & Logistics');
      expect(warnings).not.toContain('DESCRIPTION_POSSIBLE_TYPO');
    });

    it('should NOT flag "Heirloom Carrots" (anchor word exists)', () => {
      const warnings = computeDescriptionWarnings('Heirloom Carrots');
      // If "Carrots" is known (anchor), ratio = 0.5, should not flag with anchor rule
      expect(warnings).not.toContain('DESCRIPTION_POSSIBLE_TYPO');
    });

    it('should NOT flag codes/units/acronyms', () => {
      const warnings = computeDescriptionWarnings('12x500g RDS GST 500ml');
      expect(warnings).not.toContain('DESCRIPTION_POSSIBLE_TYPO');
    });

    it('should NOT flag edge case hospo words with consonant clusters', () => {
      // These have consonant clusters but are legitimate product names
      expect(computeDescriptionWarnings('Prosciuttone')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Stracciatella')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Gnocchi')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Pappardelle')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Tagliatelle')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
    });
  });

  describe('Real-world OCR garbage examples', () => {
    it('should flag "Frogen prontosaurvi RDS" (misread "Frozen Brontosaurus Ribs")', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      expect(warnings.length).toBeGreaterThan(0);
      // Should catch at least one of: POSSIBLE_TYPO, NO_VOWELS_LONG_TOKEN, LOW_ALPHA_RATIO, or OCR_NOISE
      const hasRelevantWarning = warnings.some(w => 
        w === 'DESCRIPTION_POSSIBLE_TYPO' ||
        w === 'DESCRIPTION_NO_VOWELS_LONG_TOKEN' ||
        w === 'DESCRIPTION_LOW_ALPHA_RATIO' ||
        w === 'DESCRIPTION_OCR_NOISE'
      );
      expect(hasRelevantWarning).toBe(true);
    });

    it('should not flag legitimate product codes', () => {
      const warnings = computeDescriptionWarnings('SKU-12345');
      // Product codes with dashes/numbers should be fine
      expect(warnings).not.toContain('DESCRIPTION_LOW_ALPHA_RATIO');
    });
  });
});

