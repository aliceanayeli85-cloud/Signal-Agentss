import { describe, expect, it } from 'vitest';
import type { PaperTradeRecord } from '../src/shared/types.js';
import { bestAndWorst, computePerformance } from '../src/engine/performance.js';
import { computeHistoricalStats, MIN_OBSERVATIONS } from '../src/engine/stats.js';
import { assessFomo, DEFAULT_SETTINGS, evaluateLimits } from '../src/engine/discipline.js';

let nextId = 1;
function trade(overrides: Partial<PaperTradeRecord> = {}): PaperTradeRecord {
  return {
    id: nextId++,
    createdAt: 1_700_000_000_000,
    closedAt: 1_700_000_600_000,
    status: 'closed',
    assetId: 'test:asset',
    symbol: 'TEST',
    assetClass: 'meme',
    timeframe: '15m',
    strategy: 'breakout-retest',
    direction: 'long',
    entry: 100,
    stop: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    positionSize: 20,
    accountSize: 10_000,
    riskPct: 1,
    riskAmount: 100,
    exitPrice: 110,
    exitReason: 'target',
    pnl: 200,
    rMultiple: 2,
    setupScore: 70,
    riskScore: 30,
    marketConditions: null,
    fomoFlagged: 0,
    notes: null,
    ...overrides,
  };
}

describe('performance engine', () => {
  it('reports an empty but valid result with no trades', () => {
    const stats = computePerformance([]);
    expect(stats.sampleSize).toBe(0);
    expect(stats.confidence).toBe('NONE');
    expect(stats.winRatePct).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.totalPnl).toBe(0);
  });

  it('ignores open trades, which have no outcome yet', () => {
    const stats = computePerformance([
      trade(),
      trade({ status: 'open', closedAt: null, pnl: null, rMultiple: null, exitPrice: null }),
    ]);
    expect(stats.sampleSize).toBe(1);
  });

  it('computes win rate, expectancy and profit factor', () => {
    const stats = computePerformance([
      trade({ rMultiple: 2, pnl: 200 }),
      trade({ rMultiple: -1, pnl: -100 }),
      trade({ rMultiple: 2, pnl: 200 }),
      trade({ rMultiple: -1, pnl: -100 }),
    ]);
    expect(stats.winRatePct).toBe(50);
    expect(stats.expectancyR).toBeCloseTo(0.5, 9);
    expect(stats.profitFactor).toBeCloseTo(2, 9);
    expect(stats.totalPnl).toBe(200);
  });

  it('never claims high confidence on a small sample', () => {
    const small = computePerformance(Array.from({ length: 17 }, () => trade()));
    expect(small.sampleSize).toBe(17);
    expect(small.confidence).toBe('LOW');
    expect(small.confidenceNote).toMatch(/substantially more observations/i);
  });

  it('raises confidence only as the sample grows', () => {
    expect(computePerformance(Array.from({ length: 35 }, () => trade())).confidence).toBe('MODERATE');
    expect(computePerformance(Array.from({ length: 120 }, () => trade())).confidence).toBe('REASONABLE');
  });

  it('tracks consecutive wins and losses in chronological order', () => {
    const base = 1_700_000_000_000;
    const stats = computePerformance([
      trade({ rMultiple: -1, closedAt: base + 1 }),
      trade({ rMultiple: -1, closedAt: base + 2 }),
      trade({ rMultiple: -1, closedAt: base + 3 }),
      trade({ rMultiple: 1, closedAt: base + 4 }),
      trade({ rMultiple: 1, closedAt: base + 5 }),
    ]);
    expect(stats.maxConsecutiveLosses).toBe(3);
    expect(stats.maxConsecutiveWins).toBe(2);
  });

  it('handles out-of-order timestamps by sorting before building the curve', () => {
    const base = 1_700_000_000_000;
    const stats = computePerformance([
      trade({ rMultiple: 1, closedAt: base + 5000 }),
      trade({ rMultiple: -1, closedAt: base + 1000 }),
    ]);
    expect(stats.equityCurveR[0]?.cumulativeR).toBeCloseTo(-1, 9);
    expect(stats.equityCurveR[1]?.cumulativeR).toBeCloseTo(0, 9);
  });

  it('refuses to crown a best strategy from tiny groups', () => {
    const stats = computePerformance([
      trade({ strategy: 'breakout-retest' }),
      trade({ strategy: 'support-bounce', rMultiple: -1, pnl: -100 }),
    ]);
    const ranking = bestAndWorst(stats.byStrategy);
    expect(ranking.best).toBeNull();
    expect(ranking.note).toMatch(/at least two groups/i);
  });

  it('ranks groups once each has enough trades', () => {
    const trades = [
      ...Array.from({ length: 12 }, () => trade({ strategy: 'breakout-retest', rMultiple: 1 })),
      ...Array.from({ length: 12 }, () => trade({ strategy: 'support-bounce', rMultiple: -0.5 })),
    ];
    const ranking = bestAndWorst(computePerformance(trades).byStrategy);
    expect(ranking.best?.key).toBe('breakout-retest');
    expect(ranking.worst?.key).toBe('support-bounce');
  });
});

describe('statistical probability engine', () => {
  it('publishes no win rate below the minimum sample', () => {
    const stats = computeHistoricalStats({
      rMultiples: Array.from({ length: MIN_OBSERVATIONS - 1 }, () => 1),
      ruleSetLabel: 'test rules',
    });
    expect(stats.sufficient).toBe(false);
    expect(stats.winRatePct).toBeNull();
    expect(stats.statement).toMatch(/Insufficient observations/i);
  });

  it('phrases a sufficient sample as an observed frequency, never a forecast', () => {
    const rs = [...Array.from({ length: 63 }, () => 1), ...Array.from({ length: 37 }, () => -1)];
    const stats = computeHistoricalStats({ rMultiples: rs, ruleSetLabel: 'breakout-retest / 1h' });

    expect(stats.sufficient).toBe(true);
    expect(stats.winRatePct).toBeCloseTo(63, 6);
    expect(stats.statement).toMatch(/Historically, the rule set/i);
    expect(stats.statement).toMatch(/across 100 matching observations/i);
    expect(stats.statement).toMatch(/not the probability that your next trade wins/i);
    // The forbidden phrasing.
    expect(stats.statement).not.toMatch(/you have a .* chance/i);
  });

  it('buckets the distribution so the shape is visible, not just the mean', () => {
    const stats = computeHistoricalStats({
      rMultiples: [-1, -1, -0.75, -0.25, 0, 0.5, 1.5, 2.5, 4],
      ruleSetLabel: 'test',
    });
    const total = stats.distribution.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(9);
    expect(stats.distribution.find((b) => b.bucket === '<= -1R')?.count).toBe(2);
    expect(stats.distribution.find((b) => b.bucket === '> +3R')?.count).toBe(1);
  });

  it('handles an empty sample without dividing by zero', () => {
    const stats = computeHistoricalStats({ rMultiples: [], ruleSetLabel: 'test' });
    expect(stats.matchingSetups).toBe(0);
    expect(stats.winRatePct).toBeNull();
    expect(stats.worstR).toBeNull();
  });
});

describe('FOMO detection', () => {
  const base = {
    recentTrades: [] as PaperTradeRecord[],
    detection: null,
    riskPct: 1,
    baselineRiskPct: 1,
    assetId: 'test:asset',
    now: 1_700_000_000_000,
  };

  it('flags entering after a vertical move', () => {
    const result = assessFomo({ ...base, recentMovePct: 80 });
    expect(result.triggered).toBe(true);
    expect(result.flags.some((f) => f.key === 'vertical-move')).toBe(true);
    expect(result.message).toMatch(/does not currently satisfy your predefined rules/i);
  });

  it('flags re-entering something exited within the last two hours', () => {
    const result = assessFomo({
      ...base,
      recentMovePct: 0,
      recentTrades: [
        {
          ...tradeRecord(),
          assetId: 'test:asset',
          status: 'closed',
          closedAt: base.now - 30 * 60_000,
        },
      ],
    });
    expect(result.flags.some((f) => f.key === 're-entry')).toBe(true);
  });

  it('flags trading through a losing streak', () => {
    const result = assessFomo({
      ...base,
      recentMovePct: 0,
      recentTrades: [
        { ...tradeRecord(), rMultiple: -1, assetId: 'other' },
        { ...tradeRecord(), rMultiple: -1, assetId: 'other' },
      ],
    });
    expect(result.flags.some((f) => f.key === 'losing-streak')).toBe(true);
  });

  it('flags increasing risk above the baseline', () => {
    const result = assessFomo({ ...base, recentMovePct: 0, riskPct: 3, baselineRiskPct: 1 });
    expect(result.flags.some((f) => f.key === 'size-increase')).toBe(true);
  });

  it('flags an entry with no defined setup', () => {
    const result = assessFomo({ ...base, recentMovePct: 0 });
    expect(result.flags.some((f) => f.key === 'no-setup')).toBe(true);
  });

  it('raises nothing when the entry matches the rules', () => {
    const result = assessFomo({
      ...base,
      recentMovePct: 3,
      detection: {
        strategy: 'breakout-retest',
        strategyName: 'Breakout + Retest',
        direction: 'long',
        triggerIndex: 1,
        triggerTime: 1,
        entry: 100,
        stop: 95,
        invalidation: 96,
        invalidationReason: '',
        keyLevel: 96,
        annotations: [],
        notes: [],
      },
    });
    expect(result.triggered).toBe(false);
  });

  function tradeRecord(): PaperTradeRecord {
    return trade();
  }
});

describe('daily trading limits', () => {
  const settings = { ...DEFAULT_SETTINGS, maxTradesPerDay: 3, maxDailyLossPct: 3, maxConsecutiveLosses: 3 };

  it('does not lock when nothing has been breached', () => {
    const state = evaluateLimits({
      settings,
      tradesOpenedToday: [],
      tradesClosedToday: [],
      recentClosedTrades: [],
    });
    expect(state.locked).toBe(false);
    expect(state.reasons).toHaveLength(0);
  });

  it('locks on the maximum trades per day', () => {
    const state = evaluateLimits({
      settings,
      tradesOpenedToday: [trade(), trade(), trade()],
      tradesClosedToday: [],
      recentClosedTrades: [],
    });
    expect(state.locked).toBe(true);
    expect(state.reasons.some((r) => /Maximum trades per day/i.test(r))).toBe(true);
  });

  it('locks on the daily loss limit', () => {
    const state = evaluateLimits({
      settings: { ...settings, accountSize: 10_000 },
      tradesOpenedToday: [],
      tradesClosedToday: [trade({ pnl: -200 }), trade({ pnl: -150 })],
      recentClosedTrades: [],
    });
    expect(state.dailyLossPct).toBeCloseTo(3.5, 6);
    expect(state.locked).toBe(true);
    expect(state.reasons.some((r) => /Daily loss limit/i.test(r))).toBe(true);
  });

  it('locks on consecutive losses', () => {
    const state = evaluateLimits({
      settings,
      tradesOpenedToday: [],
      tradesClosedToday: [],
      recentClosedTrades: [
        trade({ rMultiple: -1 }),
        trade({ rMultiple: -1 }),
        trade({ rMultiple: -1 }),
      ],
    });
    expect(state.consecutiveLosses).toBe(3);
    expect(state.locked).toBe(true);
  });

  it('reports the breach but does not lock while the simulation override is on', () => {
    const state = evaluateLimits({
      settings: { ...settings, simulationOverride: 1 },
      tradesOpenedToday: [trade(), trade(), trade(), trade()],
      tradesClosedToday: [],
      recentClosedTrades: [],
    });
    expect(state.reasons.length).toBeGreaterThan(0);
    expect(state.overrideActive).toBe(true);
    expect(state.locked).toBe(false);
  });

  it('does not count profitable days toward the loss limit', () => {
    const state = evaluateLimits({
      settings,
      tradesOpenedToday: [],
      tradesClosedToday: [trade({ pnl: 500 })],
      recentClosedTrades: [],
    });
    expect(state.dailyLossPct).toBe(0);
    expect(state.locked).toBe(false);
  });
});
