import { describe, expect, it } from 'vitest';
import { analyze } from '../src/engine/analysis.js';
import { computeMetrics, runBacktest, simulateExit } from '../src/engine/backtest.js';
import { alertTriggered, assertTransition, canTransition, evaluatePosition, nearStop, paperBuyFill, type PaperPosition } from '../src/engine/orders.js';
import { buildTradePlan, NO_TRADE, type PlanInput } from '../src/engine/plan.js';
import { checkEntry } from '../src/engine/risk.js';
import { DEFAULT_SETTINGS } from '../src/engine/settings.js';
import { account, analysis, candle, seriesFromCloses, setup, trendingCloses } from './helpers.js';

const S = { ...DEFAULT_SETTINGS };
const NOW = Date.UTC(2026, 2, 2, 16);

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    symbol: 'SPY',
    analysis: analysis(),
    quote: { price: 50, time: NOW - 5000, source: 'test' },
    settings: S,
    cashUsd: 100,
    guard: checkEntry(S, account(), null, NOW),
    now: NOW,
    marketOpen: true,
    ...overrides,
  };
}

describe('trade plan', () => {
  it('produces a complete plan when every rule passes', () => {
    const p = buildTradePlan(input());
    expect(p.checks.filter((c) => !c.pass)).toEqual([]);
    expect(p.status).toBe('TRADE_PLAN');
    expect(p.plannedEntry).toBe(50);
    expect(p.stop).toBe(49);
    expect(p.riskPerShare).toBe(1);
    expect(p.tp1?.price).toBeCloseTo(52 * 0.999, 6); // nearest resistance, within 3R
    expect(p.tp1?.basis).toBe('resistance');
    expect(p.tp2?.price).toBeCloseTo(54 * 0.999, 6);
    expect(p.maxPlannedLoss!).toBeLessThanOrEqual(1.0000001);
    expect(p.shares! * 50).toBeCloseTo(p.positionValue!, 6);
    expect(p.costs!.total).toBeGreaterThan(0);
    expect(p.tp1!.potentialProfit).toBeGreaterThan(0);
    expect(p.warnings.join(' ')).toMatch(/not a guarantee/);
    expect(p.warnings[0]).toMatch(/REJECTED in out-of-sample testing/);
  });
  it('shows NO TRADE and no prices when market data is unavailable', () => {
    const p = buildTradePlan(input({ quote: null }));
    expect(p.headline).toBe(NO_TRADE);
    expect(p.plannedEntry).toBeNull();
    expect(p.stop).toBeNull();
    expect(p.tp1).toBeNull();
    expect(p.shares).toBeNull();
  });
  it('fails on stale data while the market is open', () => {
    const p = buildTradePlan(input({ quote: { price: 50, time: NOW - 10 * 60_000, source: 't' } }));
    expect(p.status).toBe('NO_TRADE');
    expect(p.checks.find((c) => c.name === 'Market data')?.detail).toMatch(/STALE/);
  });
  it('fails when no setup exists', () => {
    const p = buildTradePlan(input({ analysis: analysis({ setups: [] }) }));
    expect(p.status).toBe('NO_TRADE');
    expect(p.checks.find((c) => c.name === 'Setup')?.pass).toBe(false);
  });
  it('fails when reward-to-risk is too low', () => {
    const lv = [{ price: 50.8, kind: 'resistance' as const, touches: 2, lastTouchTime: 0 }];
    const p = buildTradePlan(input({ analysis: analysis({ levels: lv }) }));
    expect(p.status).toBe('NO_TRADE');
    expect(p.checks.find((c) => c.name.startsWith('Reward-to-risk'))?.pass).toBe(false);
  });
  it('refuses to chase a price that ran past the entry zone, and flags a price below the stop', () => {
    expect(buildTradePlan(input({ quote: { price: 51, time: NOW, source: 't' } })).entryStatus).toBe('past_entry_zone');
    const below = buildTradePlan(input({ quote: { price: 48.5, time: NOW, source: 't' } }));
    expect(below.entryStatus).toBe('below_stop');
    expect(below.status).toBe('NO_TRADE');
  });
  it('says WAIT when confirmation has not happened yet', () => {
    const p = buildTradePlan(input({ quote: { price: 49.7, time: NOW, source: 't' } }));
    expect(p.status).toBe('TRADE_PLAN');
    expect(p.headline).toMatch(/WAIT FOR CONFIRMATION/);
  });
  it('fails when an account rule blocks trading (e.g. daily shutdown)', () => {
    const p = buildTradePlan(input({ guard: checkEntry(S, account({ todayRealizedPnl: -3 }), null, NOW) }));
    expect(p.status).toBe('NO_TRADE');
    expect(p.checks.find((c) => c.name === 'Account risk rules')?.pass).toBe(false);
  });
  it('fails against a higher-timeframe downtrend, overheated RSI or a recent failed breakout', () => {
    const down = analyze(seriesFromCloses(trendingCloses(80, 80, -0.3)), '1Day').trend;
    expect(buildTradePlan(input({ analysis: analysis({ higherTimeframe: { label: 'weekly', trend: down } }) })).status).toBe('NO_TRADE');
    expect(buildTradePlan(input({ analysis: analysis({ rsi14: 80 }) })).status).toBe('NO_TRADE');
    expect(buildTradePlan(input({ analysis: analysis({ events: [{ kind: 'failed_breakout', level: 51, time: 0, explanation: 'x' }] }) })).status).toBe('NO_TRADE');
  });
  it('uses a measured 2R target when no resistance is close', () => {
    const p = buildTradePlan(input({ analysis: analysis({ levels: [] }) }));
    expect(p.tp1?.basis).toBe('measured');
    expect(p.tp1?.price).toBeCloseTo(52, 10);
    expect(p.tp2?.price).toBeCloseTo(54, 10);
  });
  it('warns about fractional-share stop limitations', () => {
    expect(buildTradePlan(input()).warnings.join(' ')).toMatch(/fractional/i);
  });
  it('never sizes above the risk budget even with a tiny stop', () => {
    const p = buildTradePlan(input({ analysis: analysis({ setups: [setup({ stop: 49.95 })] }) }));
    expect(p.positionValue!).toBeLessThanOrEqual(50.0000001);
    expect(p.maxPlannedLoss!).toBeLessThanOrEqual(1.0000001);
  });
});

describe('order state machine', () => {
  it('allows approval paths and forbids changing a terminal order', () => {
    expect(canTransition('preview', 'working')).toBe(true);
    expect(canTransition('working', 'filled')).toBe(true);
    expect(canTransition('filled', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'working')).toBe(false);
    expect(() => assertTransition('filled', 'filled')).toThrow(/cannot move/);
  });
  it('paper limit buys only fill at or below the limit', () => {
    expect(paperBuyFill('limit', 50, 50.5, S)).toBeNull();
    expect(paperBuyFill('limit', 50, 49.9, S)).toBeLessThanOrEqual(50);
    expect(paperBuyFill('market', null, 50, S)).toBeCloseTo(50.025, 10);
  });
});

describe('simulated position management', () => {
  const pos: PaperPosition = { qtyOpen: 2, qtyInitial: 2, entryPrice: 50, stop: 49, tp1: 52, tp2: 54, tp1Done: false, fractional: false };
  it('does nothing between stop and target', () => {
    expect(evaluatePosition(pos, 51, S)).toEqual([]);
  });
  it('a gap below the stop fills below the stop', () => {
    const [a] = evaluatePosition(pos, 47, S);
    expect(a?.kind).toBe('STOP');
    expect(a!.fillPrice).toBeLessThan(49);
    expect(a!.qty).toBe(2);
  });
  it('TP1 sells half, then the stop is breakeven', () => {
    const [a] = evaluatePosition(pos, 52.1, S);
    expect(a?.kind).toBe('TP1');
    expect(a?.qty).toBe(1);
    const after = { ...pos, qtyOpen: 1, tp1Done: true };
    expect(evaluatePosition(after, 50, S)[0]?.kind).toBe('BREAKEVEN_STOP');
  });
  it('a jump through both targets exits everything', () => {
    const acts = evaluatePosition(pos, 55, S);
    expect(acts.map((a) => a.kind)).toEqual(['TP1', 'TP2']);
    expect(acts.reduce((s, a) => s + a.qty, 0)).toBe(2);
  });
  it('a single whole share exits fully at TP1', () => {
    expect(evaluatePosition({ ...pos, qtyOpen: 1, qtyInitial: 1 }, 52.01, S)[0]?.qty).toBe(1);
  });
  it('a target that is only touched does not count as filled (audit fix)', () => {
    expect(evaluatePosition(pos, 52, S)).toEqual([]);
  });
  it('flags price near the stop and evaluates alert crossings', () => {
    expect(nearStop(pos, 49.2)).toBe(true);
    expect(nearStop(pos, 50)).toBe(false);
    expect(alertTriggered({ kind: 'price_above', price: 10 }, 10)).toBe(true);
    expect(alertTriggered({ kind: 'price_below', price: 10 }, 10.01)).toBe(false);
  });
});

describe('backtest exits', () => {
  const lv = { stop: 9, tp1: 12, tp2: 14 };
  it('assumes the stop when one candle spans both stop and target', () => {
    const r = simulateExit([candle(0, 10, 13, 8.5, 11)], 0, 10, 1, lv, S, 20);
    expect(r.exitReason).toBe('stop');
  });
  it('exits a gap at the open, below the stop', () => {
    const r = simulateExit([candle(0, 10, 10.5, 9.8, 10.2), candle(1, 8, 8.5, 7.5, 8)], 0, 10, 1, lv, S, 20);
    expect(r.exitReason).toMatch(/gap/);
    expect(r.proceeds).toBeLessThan(8);
  });
  it('takes TP1 then TP2', () => {
    const r = simulateExit([candle(0, 10, 12.5, 9.5, 12), candle(1, 12, 14.5, 11.5, 14)], 0, 10, 2, lv, S, 20);
    expect(r.exitReason).toBe('take-profit 2');
    expect(r.proceeds).toBeCloseTo(12 + 14 - 0.04, 6);
  });
  it('applies the breakeven stop only from the candle after TP1', () => {
    const r = simulateExit([candle(0, 10, 12.5, 9.5, 11), candle(1, 11, 11.2, 9.9, 10)], 0, 10, 2, lv, S, 20);
    expect(r.exitReason).toBe('breakeven stop');
  });
  it('a target touched but not traded through does not fill (audit fix)', () => {
    const r = simulateExit([candle(0, 10, 12, 9.5, 11), candle(1, 11, 11.5, 10.5, 11)], 0, 10, 2, lv, S, 1);
    expect(r.exitReason).toBe('time exit');
  });
  it('time-exits after the max holding period', () => {
    const flat = Array.from({ length: 10 }, (_, i) => candle(i, 10, 10.5, 9.5, 10));
    expect(simulateExit(flat, 0, 10, 1, lv, S, 3).exitIdx).toBe(3);
  });
});

describe('backtest engine', () => {
  const closes = trendingCloses(400, 30, 0.05).map((c, i) => c + Math.sin(i / 3) * 0.8);
  const candles = seriesFromCloses(closes);
  const params = { timeframe: '1Day' as const, settings: S, maxHoldBars: 20, warmupBars: 60, outOfSampleFraction: 0.3 };

  it('runs, and reports metrics with honest warnings', () => {
    const r = runBacktest(candles, params);
    expect(r.bars).toBe(400);
    expect(r.trades.length).toBeGreaterThan(0); // otherwise the look-ahead test below proves nothing
    expect(r.all.trades).toBe(r.trades.length);
    expect(r.warnings.join(' ')).toMatch(/do not show/);
    for (const t of r.trades) {
      expect(t.entryTime).toBeGreaterThan(t.signalTime); // never fills on the signal candle
      expect(t.plannedRisk).toBeLessThanOrEqual(1.0000001);
    }
  });
  it('has no look-ahead: changing the future does not change earlier trades', () => {
    const cut = 300;
    const altered = candles.map((c, i) => (i > cut ? { ...c, o: c.o * 2, h: c.h * 2, l: c.l * 2, c: c.c * 2 } : c));
    const a = runBacktest(candles, params).trades.filter((t) => t.exitTime < candles[cut]!.t);
    expect(a.length).toBeGreaterThan(0);
    const b = runBacktest(altered, params).trades.filter((t) => t.exitTime < candles[cut]!.t);
    expect(b.map((t) => [t.signalTime, t.pnl])).toEqual(a.map((t) => [t.signalTime, t.pnl]));
  });
  it('metrics: win rate, averages, profit factor and drawdown', () => {
    const m = computeMetrics([{ pnl: 2, rMultiple: 2 }, { pnl: -1, rMultiple: -1 }, { pnl: -1, rMultiple: -1 }, { pnl: 3, rMultiple: 3 }], 100);
    expect(m.winRate).toBe(0.5);
    expect(m.avgGain).toBe(2.5);
    expect(m.avgLoss).toBe(-1);
    expect(m.profitFactor).toBe(2.5);
    expect(m.maxDrawdownUsd).toBe(2);
    expect(m.expectancy).toBe(0.75);
    expect(computeMetrics([], 100).winRate).toBeNull();
    expect(computeMetrics([{ pnl: 1, rMultiple: 1 }], 100).profitFactor).toBeNull();
  });
});

describe('analysis', () => {
  it('reports missing evidence honestly with short history', () => {
    const an = analyze(seriesFromCloses([10, 11, 12]), '1Day');
    expect(an.setups).toEqual([]);
    expect(an.missingEvidence.join(' ')).toMatch(/Only 3 completed candles/);
    expect(an.missingEvidence.join(' ')).toMatch(/Earnings/);
  });
  it('produces a full report on a long series', () => {
    const an = analyze(seriesFromCloses(trendingCloses(200, 40, 0.1)), '1Day');
    expect(an.trend.trend).not.toBe('unknown');
    expect(an.rsi14).not.toBeNull();
    expect(an.ema9).not.toBeNull();
    expect(an.vwap).toBeNull(); // daily candles: VWAP not applicable
    expect(an.summary.length).toBeGreaterThan(3);
  });
});
