import { parseMoneyLike } from '../../../src/utils/numberParsing';

describe('parseMoneyLike', () => {
  it('824,13 LINE_TOTAL -> 824.13', () => {
    const r = parseMoneyLike('824,13', { kind: 'LINE_TOTAL' });
    expect(r.value).toBe(824.13);
    expect(r.reason).toBeUndefined();
  });

  it('1,234.56 LINE_TOTAL -> 1234.56', () => {
    const r = parseMoneyLike('1,234.56', { kind: 'LINE_TOTAL' });
    expect(r.value).toBe(1234.56);
    expect(r.confidence).toBe('HIGH');
  });

  it('1.234,56 LINE_TOTAL -> 1234.56', () => {
    const r = parseMoneyLike('1.234,56', { kind: 'LINE_TOTAL' });
    expect(r.value).toBe(1234.56);
    expect(r.confidence).toBe('HIGH');
  });

  it('1,234 LINE_TOTAL -> 1234 (HIGH)', () => {
    const r = parseMoneyLike('1,234', { kind: 'LINE_TOTAL' });
    expect(r.value).toBe(1234);
    expect(r.confidence).toBe('HIGH');
  });

  it('1.234 LINE_TOTAL -> null AMBIGUOUS', () => {
    const r = parseMoneyLike('1.234', { kind: 'LINE_TOTAL' });
    expect(r.value).toBeNull();
    expect(r.reason).toBe('AMBIGUOUS_DECIMAL_SEPARATOR');
    expect(r.confidence).toBe('LOW');
  });

  it('1.234 UNIT_PRICE -> 1.234 (HIGH) when <= 100', () => {
    const r = parseMoneyLike('1.234', { kind: 'UNIT_PRICE' });
    expect(r.value).toBe(1.234);
    expect(r.confidence).toBe('HIGH');
    expect(r.cents).toBeNull();
    expect(r.displayText2dp).toBe('1.23');
  });

  it('0.005 UNIT_PRICE -> 0.005 (HIGH)', () => {
    const r = parseMoneyLike('0.005', { kind: 'UNIT_PRICE' });
    expect(r.value).toBe(0.005);
    expect(r.confidence).toBe('HIGH');
    expect(r.displayText2dp).toBe('0.01');
  });

  it('123.4567 UNIT_PRICE -> 123.4567', () => {
    const r = parseMoneyLike('123.4567', { kind: 'UNIT_PRICE' });
    expect(r.value).toBe(123.4567);
    expect(r.cents).toBeNull();
    expect(r.displayText2dp).toBe('123.46');
  });

  it('123.4567 LINE_TOTAL -> null INVALID_FORMAT (too many decimals)', () => {
    const r = parseMoneyLike('123.4567', { kind: 'LINE_TOTAL' });
    expect(r.value).toBeNull();
    expect(r.reason).toBe('INVALID_FORMAT');
  });

  it('$ 1 234,50 LINE_TOTAL -> 1234.50', () => {
    const r = parseMoneyLike('$ 1 234,50', { kind: 'LINE_TOTAL' });
    expect(r.value).toBe(1234.5);
  });

  it('(79,10) DISCOUNT -> -79.10', () => {
    const r = parseMoneyLike('(79,10)', { kind: 'DISCOUNT' });
    expect(r.value).toBe(-79.1);
  });

  it('abc -> null INVALID_FORMAT', () => {
    const r = parseMoneyLike('abc', { kind: 'LINE_TOTAL' });
    expect(r.value).toBeNull();
    expect(r.reason).toBe('INVALID_FORMAT');
  });
});




