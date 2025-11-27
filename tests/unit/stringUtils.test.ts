import { computeNameSimilarity } from '../../src/utils/stringUtils';
import { normalizeSupplierName } from '../../src/utils/normalizeSupplierName';

describe('Fuzzy Matching Logic', () => {
  describe('computeNameSimilarity', () => {
    it('should return 1 for identical strings', () => {
      expect(computeNameSimilarity('Test Supplier', 'Test Supplier')).toBe(1);
      expect(computeNameSimilarity('abc', 'abc')).toBe(1);
    });

    it('should be case insensitive', () => {
      expect(computeNameSimilarity('Test Supplier', 'test supplier')).toBe(1);
    });

    it('should return 0 for completely different strings', () => {
      // "abc" vs "def" -> distance 3, maxLen 3 -> 1 - 3/3 = 0
      expect(computeNameSimilarity('abc', 'def')).toBe(0);
    });

    it('should handle high similarity', () => {
      // "Bakers Delight" vs "Baker's Delight"
      // "Bakers Delight" (14 chars) vs "Baker's Delight" (15 chars)
      // Distance is 1 (apostrophe)
      // 1 - 1/15 = 0.933...
      const sim = computeNameSimilarity('Bakers Delight', "Baker's Delight");
      expect(sim).toBeGreaterThan(0.9);
    });

    it('should handle typos', () => {
      // "Woolworths" vs "Wolworths"
      // "Woolworths" (10), "Wolworths" (9) -> distance 1
      // 1 - 1/10 = 0.9
      expect(computeNameSimilarity('Woolworths', 'Wolworths')).toBeGreaterThan(0.8);
    });
  });

  describe('Tricky Supplier Names', () => {
    // The goal is to see if we can match these correctly using normalize + similarity
    const trickyPairs = [
      ['Woolworths', 'Woolworths Ltd'],
      ['Bunnings Group', 'Bunnings'],
      ['Officeworks Pty Ltd', 'Officeworks'],
      ['Fresh  Fruit  Co', 'Fresh Fruit Co.'],
      ['The Reject Shop', 'Reject Shop'],
    ];

    test.each(trickyPairs)('should match "%s" with "%s" with high confidence', (name1, name2) => {
      // First normalize
      const n1 = normalizeSupplierName(name1);
      const n2 = normalizeSupplierName(name2);
      
      // Then compute similarity on normalized names
      const similarity = computeNameSimilarity(n1, n2);
      
      // We expect normalization to strip "Pty Ltd" etc, so they might be identical or very close
      // "The Reject Shop" vs "Reject Shop" -> normalized: "the reject shop" vs "reject shop"
      
      // If normalized names are identical, similarity is 1.
      // If not, it should be high.
      
      // console.log(`Comparing '${name1}' -> '${n1}' with '${name2}' -> '${n2}' : ${similarity}`);
      
      expect(similarity).toBeGreaterThan(0.8); 
    });

    it('should not match distinct suppliers', () => {
      const n1 = normalizeSupplierName('Woolworths');
      const n2 = normalizeSupplierName('Coles');
      const similarity = computeNameSimilarity(n1, n2);
      expect(similarity).toBeLessThan(0.5);
    });
  });
});

