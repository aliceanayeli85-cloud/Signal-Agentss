import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/engine/settings.js';
import { cleanDaily } from '../src/research/data.js';
import { stage1, stage2 } from '../src/research/decision.js';
import { runStrategy, simulateChannelExit } from '../src/research/harness.js';
import { bootstrapMeanCI, buyAndHoldPct, exposure, summarize, type Summary } from '../src/research/stats.js';
import { buildCtx, CANDIDATES } from '../src/research/strategies.js';
import { candle, DAY, seriesFromCloses } from './helpers.js';

const S = { ...DEFAULT_SETTINGS };

/** Test-only random walk with drift and volume spikes, deterministic. */
function walk(n: number, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const closes: number[] = [];
  let p = 50;
  for (let i = 0; i < n; i++) closes.push((p *= 1 + (rnd() - 0.47) * 0.04));
  return seriesFromCloses(closes).map((c, i) => ({ ...c, h: Math.max(c.o, c.c) * (1 + rnd() * 0.01), l: Math.min(c.o, c.c) * (1 - rnd() * 0.01), v: 1000 * (i % 17 === 0 ? 3 : 1) }));
}

describe('candidate strategies cannot see the future', () => {
  const candles = walk(700);
  for (const strat of CANDIDATES) {
    it(`${strat.id}: the signal at bar i is identical with or without later candles`, () => {
      const full = buildCtx(candles);
      let signals = 0;
      for (let i = strat.warmupBars; i < candles.length - 1; i += 7) {
        const cut = buildCtx(candles.slice(0, i + 1));
        const a = strat.signal(full, i);
        expect(strat.signal(cut, i)).toEqual(a);
        if (a) signals++;
      }
      expect(signals).toBeGreaterThan(0); // otherwise this test proves nothing
    });
    it(`${strat.id}: changing the future does not change earlier trades`, () => {
      const cut = 500;
      const altered = candles.map((c, i) => (i > cut ? { ...c, o: c.o * 1.5, h: c.h * 1.5, l: c.l * 1.5, c: c.c * 1.5 } : c));
      const a = runStrategy('T', candles, strat, S).filter((t) => t.exitTime < candles[cut]!.t);
      const b = runStrategy('T', altered, strat, S).filter((t) => t.exitTime < candles[cut]!.t);
      expect(b).toEqual(a);
    });
  }
  it('every trade respects the budget at a non-gap stop, the position cap and the entry-after-signal rule', () => {
    for (const strat of CANDIDATES) {
      for (const t of runStrategy('T', candles, strat, S)) {
        expect(t.shares * t.entryPrice).toBeLessThanOrEqual(50.0000001);
        expect(t.plannedRisk).toBeLessThanOrEqual(1.0000001);
        if (t.exitReason === 'stop') expect(t.pnl).toBeGreaterThanOrEqual(-1.005);
      }
    }
  });
});

describe('channel exit', () => {
  it('exits at the NEXT open after the close that breaks the channel, not at that close', () => {
    const cs = [candle(0, 10, 10.5, 9.8, 10), candle(1, 10, 10.6, 9.9, 10.4), candle(2, 10.4, 10.5, 10.1, 10.2), candle(3, 10.2, 10.3, 9.5, 9.6), candle(4, 9.4, 9.5, 9.2, 9.3)];
    const r = simulateChannelExit(cs, 1, 10, 1, 8, 2, 50, S);
    expect(r.exitReason).toBe('channel exit (next open)');
    expect(r.exitIdx).toBe(4);
    expect(r.proceeds).toBeLessThan(9.4);
  });
  it('a gap below the stop exits at the open', () => {
    const cs = [candle(0, 10, 10.5, 9.8, 10), candle(1, 8, 8.2, 7.8, 8)];
    expect(simulateChannelExit(cs, 0, 10, 1, 9, 10, 50, S).exitReason).toBe('stop (gap below stop)');
  });
});

describe('research statistics', () => {
  it('bootstrap interval is reproducible and brackets the mean', () => {
    const xs = [1, -1, 2, -1, 0.5, -1, 3, -1, -1, 1.5];
    const a = bootstrapMeanCI(xs)!;
    expect(bootstrapMeanCI(xs)).toEqual(a);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(a[0]).toBeLessThan(mean);
    expect(a[1]).toBeGreaterThan(mean);
    expect(bootstrapMeanCI([1, 2])).toBeNull();
  });
  it('exposure counts each day once even if trades overlap', () => {
    const bars = seriesFromCloses([1, 2, 3, 4]);
    expect(exposure([{ entryTime: bars[0]!.t, exitTime: bars[1]!.t }, { entryTime: bars[1]!.t, exitTime: bars[1]!.t }], bars)).toBe(0.5);
  });
  it('summary and buy-and-hold', () => {
    const bars = seriesFromCloses([10, 11, 12], Date.UTC(2020, 0, 2, 5));
    expect(buyAndHoldPct(bars, '2020-01-01', '2020-12-31')).toBeCloseTo((12 / 10 - 1) * 100, 6);
    const t = (pnl: number) => ({ symbol: 'X', strategy: 'S', entryTime: bars[0]!.t, exitTime: bars[1]!.t, entryPrice: 10, exitReason: 'x', shares: 1, plannedRisk: 1, pnl, rMultiple: pnl });
    const s = summarize([t(2), t(-1)], bars, 100);
    expect(s.profitFactor).toBe(2);
    expect(s.netReturnPct).toBeCloseTo(1, 10);
  });
  it('data cleaning cuts the series after an internal gap', () => {
    const c = [candle(Date.UTC(2018, 10, 1, 4), 1, 1, 1, 1), candle(Date.UTC(2020, 6, 27, 4), 2, 2, 2, 2), candle(Date.UTC(2020, 6, 28, 4), 2, 2, 2, 2)];
    const r = cleanDaily(c);
    expect(r.candles).toHaveLength(2);
    expect(r.check.longGaps).toHaveLength(1);
    expect(DAY).toBe(86_400_000);
  });
});

describe('pre-registered decision rule', () => {
  const sum = (o: Partial<Summary>): Summary => ({ trades: 40, netPnl: 1, netReturnPct: 1, expectancy: 0.1, expectancyR: 0.1, expectancyRci: null, profitFactor: 1.3, winRate: 0.5, avgWin: 1, avgLoss: -1, maxDrawdownUsd: 1, maxDrawdownPct: 1, exposurePct: 10, ...o });
  const breadth = [{ symbol: 'A', trades: 10, expectancyR: 0.2 }, { symbol: 'B', trades: 10, expectancyR: 0.1 }, { symbol: 'C', trades: 10, expectancyR: -0.1 }];
  it('rejects a strategy that lost money in validation with enough trades', () => {
    const s1 = stage1({ defects: [], train: sum({}), validation: sum({ expectancyR: -0.05 }), validationStressed: sum({}) });
    expect(s1.rejected).toBe(true);
    expect(stage2({ stage1: s1, test: sum({}), testStressed: sum({}), perTickerExpectancyR: breadth }).verdict).toBe('REJECTED');
  });
  it('too few validation trades is insufficient evidence, and a good final test cannot promote it', () => {
    const s1 = stage1({ defects: [], train: sum({}), validation: sum({ trades: 12 }), validationStressed: sum({}) });
    expect(s1.advance).toBe(false);
    expect(stage2({ stage1: s1, test: sum({ expectancyR: 0.5 }), testStressed: sum({}), perTickerExpectancyR: breadth }).verdict).toBe('INSUFFICIENT EVIDENCE');
  });
  it('a candidate must be positive everywhere, survive stressed costs and be broad', () => {
    const s1 = stage1({ defects: [], train: sum({}), validation: sum({}), validationStressed: sum({}) });
    expect(s1.advance).toBe(true);
    expect(stage2({ stage1: s1, test: sum({}), testStressed: sum({}), perTickerExpectancyR: breadth }).verdict).toBe('CANDIDATE FOR EXTENDED PAPER TESTING');
    expect(stage2({ stage1: s1, test: sum({}), testStressed: sum({ expectancyR: -0.01 }), perTickerExpectancyR: breadth }).verdict).toBe('INSUFFICIENT EVIDENCE');
    expect(stage2({ stage1: s1, test: sum({ expectancyR: -0.01 }), testStressed: sum({}), perTickerExpectancyR: breadth }).verdict).toBe('REJECTED');
    const narrow = [{ symbol: 'A', trades: 10, expectancyR: 0.5 }, { symbol: 'B', trades: 10, expectancyR: -0.1 }, { symbol: 'C', trades: 10, expectancyR: -0.1 }];
    expect(stage2({ stage1: s1, test: sum({}), testStressed: sum({}), perTickerExpectancyR: narrow }).verdict).toBe('INSUFFICIENT EVIDENCE');
  });
  it('defects reject immediately', () => {
    expect(stage1({ defects: ['x'], train: sum({}), validation: sum({}), validationStressed: sum({}) }).rejected).toBe(true);
  });
});
