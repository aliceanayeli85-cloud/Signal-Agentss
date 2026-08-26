import { describe, expect, it } from 'vitest';
import type { BacktestConfig, Candle } from '../src/shared/types.js';
import { DEFAULT_BACKTEST_CONFIG, resolveExit, runBacktest } from '../src/engine/backtest/engine.js';
import { computeMetrics, longestLosingStreak, maxDrawdownR } from '../src/engine/backtest/metrics.js';
import { detectAt } from '../src/engine/setups/index.js';
import { candle, ramp } from './helpers.js';

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    assetId: 'test:asset',
    symbol: 'TEST',
    feesPct: 0,
    slippagePct: 0,
    ...overrides,
  };
}

describe('look-ahead prevention', () => {
  it('never shows a strategy a bar beyond the decision index', () => {
    const bars = ramp(200, 100, 0.5);
    // Poison every bar after index 120 so that any strategy which peeked would
    // either see an impossible price or behave differently.
    const poisoned = bars.map((bar, index) =>
      index > 120 ? { ...bar, high: 1e9, low: 1e-9, close: 1e9 } : bar,
    );

    const cleanPrefix = bars.slice(0, 121);
    const fromClean = detectAt(cleanPrefix, 120);
    const fromPoisoned = detectAt(poisoned, 120);

    expect(JSON.stringify(fromPoisoned)).toBe(JSON.stringify(fromClean));
  });

  it('fills entries at the next bar open, never at the signal bar close', () => {
    const bars = buildBreakoutRetestSeries();
    const result = runBacktest(bars, config({ timeframe: '1h', maxBarsInTrade: 200 }));
    for (const trade of result.trades) {
      const fillBar = bars[trade.entryIndex];
      expect(fillBar).toBeDefined();
      expect(trade.entryPrice).toBeCloseTo(fillBar?.open ?? Number.NaN, 9);
      // The signal was on the PREVIOUS bar, so entry index must be strictly later.
      expect(trade.entryIndex).toBeGreaterThan(0);
    }
  });

  it('produces the same trades when future bars are appended after the fact', () => {
    const bars = buildBreakoutRetestSeries();
    const withFuture = [
      ...bars,
      ...ramp(40, bars[bars.length - 1]?.close ?? 100, 5, {
        startTime: (bars[bars.length - 1]?.time ?? 0) + 3600,
      }),
    ];

    const original = runBacktest(bars, config({ maxBarsInTrade: 10 }));
    const extended = runBacktest(withFuture, config({ maxBarsInTrade: 10 }));

    // Every trade that closed before the original series ended must be identical.
    const cutoff = bars[bars.length - 1]?.time ?? 0;
    const originalClosed = original.trades.filter((t) => t.exitTime < cutoff);
    const extendedClosed = extended.trades.filter((t) => t.exitTime < cutoff);
    expect(extendedClosed.length).toBeGreaterThanOrEqual(originalClosed.length);
    for (let i = 0; i < originalClosed.length; i += 1) {
      expect(extendedClosed[i]?.entryTime).toBe(originalClosed[i]?.entryTime);
      expect(extendedClosed[i]?.exitPrice).toBeCloseTo(originalClosed[i]?.exitPrice ?? 0, 9);
    }
  });
});

describe('exit handling', () => {
  it('takes the stop when one bar contains both the stop and the target', () => {
    // A bar whose range spans both levels. Which came first is unknowable from
    // OHLC, so the unfavourable one must win in both directions.
    const wide = candle(1, 100, 130, 70, 105);

    expect(resolveExit({ bar: wide, direction: 'long', stop: 90, target: 120, barsHeld: 1, maxBarsInTrade: 50 })).toEqual({
      price: 90,
      reason: 'stop',
    });
    expect(resolveExit({ bar: wide, direction: 'short', stop: 120, target: 80, barsHeld: 1, maxBarsInTrade: 50 })).toEqual({
      price: 120,
      reason: 'stop',
    });
  });

  it('takes the target when only the target was reached', () => {
    const bar = candle(1, 100, 125, 98, 120);
    expect(resolveExit({ bar, direction: 'long', stop: 90, target: 120, barsHeld: 1, maxBarsInTrade: 50 })).toEqual({
      price: 120,
      reason: 'target',
    });
  });

  it('exits on time only once neither level was touched and the bar cap is reached', () => {
    const bar = candle(1, 100, 105, 98, 103);
    expect(resolveExit({ bar, direction: 'long', stop: 90, target: 130, barsHeld: 5, maxBarsInTrade: 50 })).toBeNull();
    expect(resolveExit({ bar, direction: 'long', stop: 90, target: 130, barsHeld: 50, maxBarsInTrade: 50 })).toEqual({
      price: 103,
      reason: 'time',
    });
  });

  it('honours the same rule end to end through the backtester', () => {
    const bars = buildBreakoutRetestSeries();
    const result = runBacktest(bars, config({ maxBarsInTrade: 200 }));
    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      for (let i = trade.entryIndex + 1; i <= trade.exitIndex; i += 1) {
        const bar = bars[i];
        if (!bar) continue;
        const expected = resolveExit({
          bar,
          direction: trade.direction,
          stop: trade.stop,
          target: trade.target,
          barsHeld: i - trade.entryIndex,
          maxBarsInTrade: 200,
        });
        if (expected) {
          // The first bar that resolves must be the bar the trade exited on.
          expect(i).toBe(trade.exitIndex);
          expect(trade.exitReason).toBe(expected.reason);
          break;
        }
      }
    }
  });

  it('closes an unresolved position at the end of the data', () => {
    const bars = buildBreakoutRetestSeries();
    const result = runBacktest(bars, config({ maxBarsInTrade: 100_000 }));
    const last = result.trades[result.trades.length - 1];
    if (last) {
      expect(['target', 'stop', 'time', 'end-of-data']).toContain(last.exitReason);
    }
    // No trade may remain open once the run finishes.
    expect(result.trades.every((t) => Number.isFinite(t.exitPrice))).toBe(true);
  });

  it('applies fees and slippage against the trader, never in their favour', () => {
    const bars = buildBreakoutRetestSeries();
    const free = runBacktest(bars, config({ feesPct: 0, slippagePct: 0, maxBarsInTrade: 200 }));
    const costly = runBacktest(bars, config({ feesPct: 0.2, slippagePct: 0.1, maxBarsInTrade: 200 }));
    if (free.trades.length > 0 && costly.trades.length > 0) {
      expect(costly.combined.totalR).toBeLessThan(free.combined.totalR);
    }
  });
});

describe('data hygiene', () => {
  it('drops malformed bars and reports how many', () => {
    const bars: Candle[] = [
      ...ramp(120, 100, 0.4),
      candle(9_999_999, Number.NaN, 1, 1, 1, 1),
      candle(9_999_998, 10, 1, 100, 5, 1), // high below low
      candle(9_999_997, -5, 1, 1, 1, 1), // negative price
    ];
    const result = runBacktest(bars, config());
    expect(result.warnings.some((w) => /dropped/i.test(w))).toBe(true);
    expect(result.barsUsed).toBe(120);
  });

  it('drops duplicate timestamps', () => {
    const base = ramp(120, 100, 0.4);
    const duplicated = [...base, ...base.slice(0, 5)];
    const result = runBacktest(duplicated, config());
    expect(result.barsUsed).toBe(120);
    expect(result.warnings.some((w) => /duplicate timestamps/i.test(w))).toBe(true);
  });

  it('refuses to run on too few bars instead of producing a thin result', () => {
    const result = runBacktest(ramp(30, 100, 1), config());
    expect(result.trades).toHaveLength(0);
    expect(result.warnings.some((w) => /Not enough bars/i.test(w))).toBe(true);
  });

  it('survives extreme price values without producing NaN', () => {
    const bars = ramp(200, 1e-9, 1e-11, { range: 1e-12 });
    const result = runBacktest(bars, config());
    for (const trade of result.trades) {
      expect(Number.isFinite(trade.rMultiple)).toBe(true);
      expect(Number.isFinite(trade.pnl)).toBe(true);
    }
    expect(Number.isFinite(result.combined.totalR)).toBe(true);
  });
});

describe('in-sample / out-of-sample split', () => {
  it('never starts an out-of-sample trade before the split bar', () => {
    const bars = buildBreakoutRetestSeries();
    const result = runBacktest(bars, config({ trainFraction: 0.5, maxBarsInTrade: 30 }));
    const splitIndex = Math.floor(result.barsUsed * 0.5);
    for (const trade of result.trades) {
      if (trade.segment === 'out-of-sample') {
        expect(trade.entryIndex).toBeGreaterThan(splitIndex);
      } else {
        expect(trade.entryIndex).toBeLessThanOrEqual(splitIndex);
      }
    }
  });

  it('warns when there is little or no out-of-sample evidence', () => {
    const bars = buildBreakoutRetestSeries();
    const result = runBacktest(bars, config({ trainFraction: 0.9 }));
    expect(
      result.warnings.some((w) => /out-of-sample/i.test(w)),
    ).toBe(true);
  });

  it('always carries the past-performance disclaimer', () => {
    const result = runBacktest(buildBreakoutRetestSeries(), config());
    expect(result.disclaimer).toMatch(/Past performance does not establish future profitability/i);
  });
});

describe('metrics', () => {
  it('computes win rate, expectancy and profit factor from R multiples', () => {
    const metrics = computeMetrics([
      trade(2), trade(-1), trade(2), trade(-1),
    ]);
    expect(metrics.trades).toBe(4);
    expect(metrics.winRatePct).toBe(50);
    expect(metrics.expectancyR).toBeCloseTo(0.5, 9);
    expect(metrics.profitFactor).toBeCloseTo(2, 9);
  });

  it('reports no profit factor when there were no losses, rather than Infinity', () => {
    const metrics = computeMetrics([trade(1), trade(2)]);
    expect(metrics.profitFactor).toBeNull();
  });

  it('withholds Sharpe below the minimum sample and says why', () => {
    const metrics = computeMetrics([trade(1), trade(-1), trade(2)]);
    expect(metrics.sharpe).toBeNull();
    expect(metrics.sharpeNote).toMatch(/below the 30-trade minimum/i);
  });

  it('reports Sharpe once the sample is large enough', () => {
    const trades = Array.from({ length: 40 }, (_, i) => trade(i % 2 === 0 ? 1.5 : -1));
    const metrics = computeMetrics(trades);
    expect(metrics.sharpe).not.toBeNull();
    expect(metrics.sharpeNote).toMatch(/Not annualised/i);
  });

  it('measures peak-to-trough drawdown in R', () => {
    expect(maxDrawdownR([1, 1, -3, 1])).toBeCloseTo(3, 9);
    expect(maxDrawdownR([1, 2, 3])).toBe(0);
    expect(maxDrawdownR([])).toBeNull();
  });

  it('measures the longest losing streak', () => {
    expect(longestLosingStreak([-1, -1, 1, -1, -1, -1, 2])).toBe(3);
    expect(longestLosingStreak([1, 2, 3])).toBe(0);
  });

  it('returns empty-but-valid metrics for no trades', () => {
    const metrics = computeMetrics([]);
    expect(metrics.trades).toBe(0);
    expect(metrics.winRatePct).toBeNull();
    expect(metrics.maxDrawdownR).toBeNull();
    expect(metrics.totalR).toBe(0);
  });
});

function trade(rMultiple: number) {
  return {
    strategy: 'breakout-retest' as const,
    direction: 'long' as const,
    entryTime: 0,
    entryIndex: 0,
    entryPrice: 100,
    stop: 95,
    target: 110,
    exitTime: 1,
    exitIndex: 1,
    exitPrice: 100 + rMultiple * 5,
    exitReason: 'target' as const,
    rMultiple,
    pnl: rMultiple * 100,
    barsHeld: 1,
    segment: 'in-sample' as const,
  };
}

/**
 * A deterministic series that repeatedly produces breakout / pullback structure,
 * so the backtester has real signals to work with without touching the network.
 */
function buildBreakoutRetestSeries(): Candle[] {
  const bars: Candle[] = [];
  let time = 1_700_000_000;
  let price = 100;

  const push = (open: number, close: number, volume = 1000) => {
    bars.push(candle(time, open, Math.max(open, close) + 0.4, Math.min(open, close) - 0.4, close, volume));
    time += 3600;
  };

  // Warm-up so indicators have history.
  for (let i = 0; i < 60; i += 1) {
    const drift = i % 2 === 0 ? 0.3 : -0.2;
    push(price, price + drift);
    price += drift;
  }

  // Repeated cycle: range, break, pull back, push on.
  for (let cycle = 0; cycle < 8; cycle += 1) {
    for (let i = 0; i < 10; i += 1) {
      const wobble = i % 2 === 0 ? 0.6 : -0.6;
      push(price, price + wobble);
      price += wobble;
    }
    for (let i = 0; i < 3; i += 1) {
      push(price, price + 1.6, 2500);
      price += 1.6;
    }
    for (let i = 0; i < 3; i += 1) {
      push(price, price - 0.9);
      price -= 0.9;
    }
    for (let i = 0; i < 5; i += 1) {
      push(price, price + 1.1, 1800);
      price += 1.1;
    }
    for (let i = 0; i < 6; i += 1) {
      push(price, price - 0.8);
      price -= 0.8;
    }
  }

  return bars;
}
