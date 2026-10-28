import { describe, expect, it } from 'vitest';
import { atr, ema, relativeVolume, rsi, sessionVwap, sma } from '../src/engine/indicators.js';
import { findLevels, findSwings } from '../src/engine/levels.js';
import { detectPatterns } from '../src/engine/patterns.js';
import { aggregateCompleted, filterRegularSession, isCandleComplete, normalizeCandles, nyParts, nyWeekKey } from '../src/engine/time.js';
import { readTrend } from '../src/engine/trend.js';
import { candle, DAY, MONDAY_OPEN_UTC, seriesFromCloses, trendingCloses } from './helpers.js';

describe('ema / sma', () => {
  it('seeds with the simple average and returns null before the period', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(2);
    expect(out[3]).toBeCloseTo(3, 10); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4, 10);
  });
  it('returns all nulls when there is not enough data', () => {
    expect(ema([1, 2], 9)).toEqual([null, null]);
  });
  it('sma averages a sliding window', () => {
    expect(sma([2, 4, 6, 8], 2)).toEqual([null, 3, 5, 7]);
  });
});

describe('rsi', () => {
  it('is 100 when price only rises and 0 when it only falls', () => {
    const up = Array.from({ length: 20 }, (_, i) => 10 + i);
    const down = Array.from({ length: 20 }, (_, i) => 30 - i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(down, 14).at(-1)).toBe(0);
  });
  it('is 50 for a flat series and always stays within 0–100', () => {
    expect(rsi(new Array(20).fill(5), 14).at(-1)).toBe(50);
    const noisy = trendingCloses(80, 50, 0.1);
    for (const v of rsi(noisy, 14)) if (v !== null) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });
});

describe('atr', () => {
  it('includes gaps via true range', () => {
    const cs = [candle(0, 10, 11, 9, 10)];
    for (let i = 1; i < 16; i++) cs.push(candle(i, 10, 11, 9, 10));
    expect(atr(cs, 14).at(-1)).toBeCloseTo(2, 10);
    // A gap up: high-low is 1 but distance from prior close is 5.
    cs.push(candle(16, 15, 15.5, 14.5, 15));
    expect(atr(cs, 14).at(-1)!).toBeGreaterThan(2);
  });
});

describe('session VWAP', () => {
  it('resets at each New York day', () => {
    const day1 = [candle(MONDAY_OPEN_UTC, 10, 10, 10, 10, 100), candle(MONDAY_OPEN_UTC + 300_000, 20, 20, 20, 20, 100)];
    const day2 = [candle(MONDAY_OPEN_UTC + DAY, 30, 30, 30, 30, 50)];
    const v = sessionVwap([...day1, ...day2]);
    expect(v[1]).toBeCloseTo(15, 10);
    expect(v[2]).toBeCloseTo(30, 10);
  });
  it('is null when there is no volume', () => {
    expect(sessionVwap([candle(MONDAY_OPEN_UTC, 1, 1, 1, 1, 0)])[0]).toBeNull();
  });
});

describe('relative volume', () => {
  it('compares the last candle with the average of the prior ones', () => {
    const cs = seriesFromCloses(new Array(21).fill(10), 0, DAY, 100);
    cs[20]!.v = 300;
    expect(relativeVolume(cs, 20)).toBeCloseTo(3, 10);
  });
  it('returns null with too little data or zero average', () => {
    expect(relativeVolume(seriesFromCloses([1, 2, 3]), 20)).toBeNull();
    expect(relativeVolume(seriesFromCloses(new Array(21).fill(10), 0, DAY, 0), 20)).toBeNull();
  });
});

describe('time and candle completeness', () => {
  it('handles New York time across daylight saving', () => {
    expect(nyParts(Date.UTC(2026, 0, 15, 14, 30)).minutes).toBe(9 * 60 + 30); // EST
    expect(nyParts(Date.UTC(2026, 6, 15, 13, 30)).minutes).toBe(9 * 60 + 30); // EDT
  });
  it('an intraday candle is complete only after its interval ends', () => {
    const c = candle(MONDAY_OPEN_UTC, 1, 1, 1, 1);
    expect(isCandleComplete(c, '5Min', MONDAY_OPEN_UTC + 299_999)).toBe(false);
    expect(isCandleComplete(c, '5Min', MONDAY_OPEN_UTC + 300_000)).toBe(true);
  });
  it("today's daily candle is forming until after the close", () => {
    const dailyBar = candle(Date.UTC(2026, 2, 2, 5, 0), 1, 1, 1, 1); // midnight NY
    expect(isCandleComplete(dailyBar, '1Day', Date.UTC(2026, 2, 2, 18, 0))).toBe(false); // 1pm NY
    expect(isCandleComplete(dailyBar, '1Day', Date.UTC(2026, 2, 2, 21, 20))).toBe(true); // 4:20pm NY
    expect(isCandleComplete(dailyBar, '1Day', Date.UTC(2026, 2, 3, 15, 0))).toBe(true); // next day
  });
  it('filters extended-hours bars out of intraday series', () => {
    const pre = candle(MONDAY_OPEN_UTC - 30 * 60_000, 1, 1, 1, 1);
    const open = candle(MONDAY_OPEN_UTC, 1, 1, 1, 1);
    const after = candle(MONDAY_OPEN_UTC + 6.5 * 3600_000, 1, 1, 1, 1);
    expect(filterRegularSession([pre, open, after], '5Min')).toEqual([open]);
  });
  it('sorts, de-duplicates and drops invalid candles', () => {
    const out = normalizeCandles([candle(2, 1, 2, 1, 2), candle(1, 1, 2, 1, 1), candle(2, 1, 3, 1, 3), candle(3, 1, 0.5, 1, 1), candle(4, NaN, 1, 1, 1)]);
    expect(out.map((c) => c.t)).toEqual([1, 2]);
    expect(out[1]!.c).toBe(3);
  });
  it('aggregation drops the last (possibly unfinished) group', () => {
    const daily = seriesFromCloses([1, 2, 3, 4, 5, 6, 7, 8], Date.UTC(2026, 2, 2, 5), DAY);
    const weeks = aggregateCompleted(daily, nyWeekKey);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.c).toBe(7); // Mon–Sun of the first week; the 8th day starts a new, dropped group
  });
});

/** Candles whose high is exactly the given value, so swing points are unambiguous. */
const fromHighs = (highs: number[]) => highs.map((h, i) => candle(i, h - 0.5, h, h - 1, h - 0.4));

describe('levels', () => {
  it('only confirms a swing once candles exist on both sides', () => {
    const cs = fromHighs([10, 11, 12, 15, 12, 11]);
    expect(findSwings(cs, 2).some((s) => s.kind === 'high' && s.index === 3)).toBe(true);
    expect(findSwings(cs.slice(0, 5), 2).some((s) => s.index === 3)).toBe(false);
  });
  it('clusters repeated swing highs into one resistance with a touch count', () => {
    const closes = [10, 11, 12, 11, 10, 11, 12.01, 11, 10, 11, 12.02, 11, 10, 9.5];
    const lv = findLevels(fromHighs(closes), 0.5);
    const res = lv.find((l) => l.kind === 'resistance');
    expect(res?.touches).toBe(3);
  });
});

describe('candlestick patterns', () => {
  it('detects a bullish engulfing candle', () => {
    const cs = [candle(0, 10, 10.1, 9.9, 10), candle(1, 10, 10.1, 9.5, 9.6), candle(2, 9.8, 9.9, 9.3, 9.4), candle(3, 9.3, 10.2, 9.2, 10.1)];
    expect(detectPatterns(cs).map((p) => p.name)).toContain('Bullish engulfing');
  });
  it('detects a hammer only after a decline', () => {
    const decline = [candle(0, 12, 12, 11, 11.5), candle(1, 11.5, 11.5, 11, 11), candle(2, 11, 11, 10.5, 10.6), candle(3, 10.3, 10.65, 9.5, 10.6)];
    expect(detectPatterns(decline).map((p) => p.name)).toContain('Hammer');
  });
  it('detects doji and inside bar, and every pattern carries an explanation', () => {
    const cs = [candle(0, 10, 11, 9, 10.5), candle(1, 10, 10.8, 9.2, 10.01)];
    const names = detectPatterns(cs).map((p) => p.name);
    expect(names).toContain('Doji');
    expect(names).toContain('Inside bar');
    for (const p of detectPatterns(cs)) expect(p.explanation.length).toBeGreaterThan(20);
  });
});

describe('trend', () => {
  it('reads an uptrend, a downtrend, and unknown with too little data', () => {
    expect(readTrend(seriesFromCloses(trendingCloses(60, 40, 0.3))).trend).toBe('uptrend');
    expect(readTrend(seriesFromCloses(trendingCloses(60, 60, -0.3))).trend).toBe('downtrend');
    expect(readTrend(seriesFromCloses([1, 2, 3])).trend).toBe('unknown');
  });
});
