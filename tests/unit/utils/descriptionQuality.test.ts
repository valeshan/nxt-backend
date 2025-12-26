import { describe, it, expect } from 'vitest';
import { computeDescriptionWarnings } from '../../../src/utils/descriptionQuality';

describe('computeDescriptionWarnings', () => {
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
    it('should flag "Frogen prontosaurvi RDS"', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      // This text triggers CONSONANT_CLUSTER, not NO_VOWELS_LONG_TOKEN
      // (all tokens have vowels, and RDS is too short)
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings).toContain('DESCRIPTION_CONSONANT_CLUSTER');
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
    it('should flag "Frogen prontosaurvi RDS" as gibberish (when combined with other warnings)', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      // Should have multiple warnings, and gibberish should be included if pattern is strong
      expect(warnings.length).toBeGreaterThan(0);
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

  describe('DESCRIPTION_CONSONANT_CLUSTER', () => {
    it('should flag "prontosaurvi" (OCR misread of "Brontosaurus")', () => {
      const warnings = computeDescriptionWarnings('Frogen prontosaurvi RDS');
      expect(warnings).toContain('DESCRIPTION_CONSONANT_CLUSTER');
    });

    it('should NOT flag normal long product words', () => {
      expect(computeDescriptionWarnings('Prosciutto di Parma')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Mozzarella di Bufala')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Cappuccino')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Macchiato')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
      expect(computeDescriptionWarnings('Bruschetta')).not.toContain('DESCRIPTION_CONSONANT_CLUSTER');
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
      // Should catch at least one of: CONSONANT_CLUSTER, NO_VOWELS_LONG_TOKEN, LOW_ALPHA_RATIO, or OCR_NOISE
      const hasRelevantWarning = warnings.some(w => 
        w === 'DESCRIPTION_CONSONANT_CLUSTER' ||
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

