import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT, parseAmount, roundTo } from '../src/engine';

describe('parseAmount', () => {
  it('treats blank input as no value, never zero', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(parseAmount(raw, 'money')).toEqual({ ok: true, value: null });
    }
  });

  it('accepts zero as a real value', () => {
    expect(parseAmount('0', 'money')).toEqual({ ok: true, value: 0 });
    expect(parseAmount(0, 'percent')).toEqual({ ok: true, value: 0 });
    expect(parseAmount('-0', 'money')).toEqual({ ok: true, value: 0 });
  });

  it('accepts decimals and numbers', () => {
    expect(parseAmount('12.50', 'money')).toEqual({ ok: true, value: 12.5 });
    expect(parseAmount('.75', 'money')).toEqual({ ok: true, value: 0.75 });
    expect(parseAmount('3.', 'money')).toEqual({ ok: true, value: 3 });
    expect(parseAmount(' 7 ', 'money')).toEqual({ ok: true, value: 7 });
    expect(parseAmount(19.99, 'money')).toEqual({ ok: true, value: 19.99 });
  });

  it('allows a leading $ for money and a trailing % for percent', () => {
    expect(parseAmount('$12.50', 'money')).toEqual({ ok: true, value: 12.5 });
    expect(parseAmount('15%', 'percent')).toEqual({ ok: true, value: 15 });
  });

  it('rejects non-numeric text with a message naming the input', () => {
    const r = parseAmount('abc', 'money');
    expect(r).toEqual({ ok: false, message: '"abc" is not a number' });
    for (const raw of ['12abc', '1e5', 'Infinity', 'NaN', '1.2.3', '--5', '$', '15%']) {
      expect(parseAmount(raw, 'money').ok, raw).toBe(false);
    }
  });

  it('rejects comma separators with a helpful message', () => {
    const r = parseAmount('1,234.56', 'money');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/period for decimals/);
  });

  it('rejects negative values', () => {
    expect(parseAmount('-5', 'money')).toEqual({ ok: false, message: 'cannot be negative' });
    expect(parseAmount(-0.01, 'money')).toEqual({ ok: false, message: 'cannot be negative' });
  });

  it('rejects non-finite numbers', () => {
    expect(parseAmount(Number.NaN, 'money').ok).toBe(false);
    expect(parseAmount(Number.POSITIVE_INFINITY, 'money').ok).toBe(false);
  });

  it('limits percentages to 0-100', () => {
    expect(parseAmount('100', 'percent')).toEqual({ ok: true, value: 100 });
    expect(parseAmount('100.01', 'percent')).toEqual({ ok: false, message: 'must be between 0 and 100' });
    expect(parseAmount(150, 'percent').ok).toBe(false);
  });

  it('requires whole numbers for counts', () => {
    expect(parseAmount('200', 'count')).toEqual({ ok: true, value: 200 });
    expect(parseAmount('2.5', 'count')).toEqual({ ok: false, message: 'must be a whole number' });
  });

  it('rejects absurdly large values', () => {
    expect(parseAmount(MAX_AMOUNT, 'money').ok).toBe(true);
    expect(parseAmount(MAX_AMOUNT + 1, 'money').ok).toBe(false);
  });
});

describe('roundTo', () => {
  it('rounds to cents without float artifacts', () => {
    expect(roundTo(1.005)).toBe(1.01);
    expect(roundTo(0.1 + 0.2)).toBe(0.3);
    expect(roundTo(2.675)).toBe(2.68);
    expect(roundTo(114.6153846)).toBe(114.62);
  });

  it('rounds half away from zero for negatives and never returns -0', () => {
    expect(roundTo(-1.005)).toBe(-1.01);
    expect(Object.is(roundTo(-0.001), 0)).toBe(true);
  });

  it('handles tiny values', () => {
    expect(roundTo(1e-7)).toBe(0);
    expect(roundTo(0.004999)).toBe(0);
  });
});
