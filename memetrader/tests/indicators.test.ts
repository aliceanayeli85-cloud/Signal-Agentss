import { describe, expect, it } from 'vitest';
import {
  atr,
  atrPercent,
  ema,
  mean,
  median,
  pctChange,
  relativeVolume,
  rsi,
  safeDivide,
  sma,
  stdev,
  vwap,
} from '../src/engine/indicators.js';
import { candle, ramp } from './helpers.js';

describe('safeDivide', () => {
  it('returns null instead of Infinity on a zero divisor', () => {
    expect(safeDivide(1, 0)).toBeNull();
    expect(safeDivide(0, 0)).toBeNull();
  });

  it('returns null for non-finite operands', () => {
    expect(safeDivide(Number.NaN, 2)).toBeNull();
    expect(safeDivide(1, Number.POSITIVE_INFINITY)).toBeCloseTo(0, 9);
  });
});

describe('summary statistics', () => {
  it('computes mean, median and sample standard deviation', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it('returns null on empty input rather than zero', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
    expect(stdev([1])).toBeNull();
    expect(sma([1, 2], 5)).toBeNull();
  });
});

describe('ema', () => {
  it('needs at least `period` values', () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
  });

  it('equals the constant when the series is flat', () => {
    expect(ema(new Array(50).fill(10), 20)).toBeCloseTo(10, 9);
  });
});

describe('atr', () => {
  it('returns null without enough bars', () => {
    expect(atr(ramp(10, 100, 1), 14)).toBeNull();
  });

  it('measures the average bar range on a steady series', () => {
    // Each bar rises 1 with a 0.5 wick either side: true range is 2 per bar.
    const value = atr(ramp(60, 100, 1, { range: 0.5 }), 14);
    expect(value).not.toBeNull();
    expect(value as number).toBeCloseTo(2, 6);
  });

  it('expresses volatility as a percentage of price', () => {
    const pct = atrPercent(ramp(60, 100, 0, { range: 1 }), 14);
    expect(pct).not.toBeNull();
    expect(pct as number).toBeGreaterThan(0);
  });
});

describe('rsi', () => {
  it('returns 100 for an unbroken advance rather than dividing by zero', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBe(100);
  });

  it('returns 50 for a perfectly flat series', () => {
    expect(rsi(new Array(30).fill(100), 14)).toBe(50);
  });

  it('returns null when there are not enough closes', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it('sits below 50 on a declining series', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 200 - i * 2);
    const value = rsi(closes, 14);
    expect(value).not.toBeNull();
    expect(value as number).toBeLessThan(50);
  });
});

describe('vwap', () => {
  it('returns null when no bar carries volume', () => {
    expect(vwap(ramp(30, 100, 1, { volume: null }))).toBeNull();
    expect(vwap(ramp(30, 100, 1, { volume: 0 }))).toBeNull();
  });

  it('weights price by volume', () => {
    const bars = [
      candle(1, 10, 10, 10, 10, 1),
      candle(2, 20, 20, 20, 20, 3),
    ];
    // (10*1 + 20*3) / 4 = 17.5
    expect(vwap(bars)).toBeCloseTo(17.5, 9);
  });
});

describe('relativeVolume', () => {
  it('returns null when volume is missing', () => {
    expect(relativeVolume(ramp(40, 100, 1, { volume: null }), 20)).toBeNull();
  });

  it('reports 1.0 for a series with constant volume', () => {
    const value = relativeVolume(ramp(40, 100, 1, { volume: 500 }), 20);
    expect(value).toBeCloseTo(1, 9);
  });

  it('detects a spike on the final bar', () => {
    const bars = ramp(40, 100, 1, { volume: 500 });
    const last = bars[bars.length - 1];
    if (last) last.volume = 5000;
    const value = relativeVolume(bars, 20);
    expect(value).toBeCloseTo(10, 6);
  });
});

describe('pctChange', () => {
  it('returns null when the base price is zero', () => {
    expect(pctChange(0, 10)).toBeNull();
  });

  it('computes a percentage move', () => {
    expect(pctChange(100, 150)).toBeCloseTo(50, 9);
  });
});
