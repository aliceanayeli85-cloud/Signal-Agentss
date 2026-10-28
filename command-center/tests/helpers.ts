import type { Analysis } from '../src/engine/analysis.js';
import { readTrend } from '../src/engine/trend.js';
import type { AccountState } from '../src/engine/risk.js';
import type { Candle, Setup } from '../src/engine/types.js';

/** TEST-ONLY synthetic candles. Never used by the app. */
export function candle(t: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return { t, o, h, l, c, v };
}

/** 2026-03-02 is a Monday. 14:30 UTC = 9:30 New York (EST). */
export const MONDAY_OPEN_UTC = Date.UTC(2026, 2, 2, 14, 30);
export const DAY = 24 * 60 * 60_000;

/** Daily-style series from a list of closes: open = previous close, small wicks. */
export function seriesFromCloses(closes: number[], start = Date.UTC(2025, 0, 1, 5), step = DAY, volume = 1000): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    return candle(start + i * step, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, volume);
  });
}

export function trendingCloses(n: number, start: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step + Math.sin(i / 2) * step * 3);
}

export function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    equity: 100,
    cash: 100,
    openRiskUsd: 0,
    openSymbols: [],
    workingOrders: [],
    todayRealizedPnl: 0,
    tradesToday: 0,
    consecutiveLossesToday: 0,
    lastLoss: null,
    lossSymbolsToday: [],
    killSwitch: false,
    ...overrides,
  };
}

export function setup(overrides: Partial<Setup> = {}): Setup {
  return {
    type: 'PULLBACK_EMA',
    label: 'Pullback to the 9/20 EMA in an uptrend',
    signalTime: 0,
    trigger: 50,
    entryLow: 50,
    entryHigh: 50,
    stop: 49,
    invalidationPrice: 49.2,
    invalidation: 'Close below the 20 EMA.',
    confirmation: ['Trades above $50.'],
    reasonsFor: ['Uptrend pullback.'],
    reasonsAgainst: [],
    ...overrides,
  };
}

/** A hand-built Analysis so plan rules can be tested one at a time. */
export function analysis(overrides: Partial<Analysis> = {}): Analysis {
  const up = readTrend(seriesFromCloses(trendingCloses(60, 40, 0.2)));
  return {
    timeframe: '1Day',
    candlesUsed: 120,
    lastCompletedTime: 0,
    close: 49.8,
    trend: up,
    higherTimeframe: { label: 'weekly', trend: up },
    ema9: 49.6,
    ema20: 49.2,
    rsi14: 55,
    atr14: 1,
    vwap: null,
    relativeVolume: 1.1,
    levels: [
      { price: 47, kind: 'support', touches: 3, lastTouchTime: 0 },
      { price: 52, kind: 'resistance', touches: 2, lastTouchTime: 0 },
      { price: 54, kind: 'resistance', touches: 2, lastTouchTime: 0 },
    ],
    support: { price: 47, kind: 'support', touches: 3, lastTouchTime: 0 },
    resistance: { price: 52, kind: 'resistance', touches: 2, lastTouchTime: 0 },
    patterns: [],
    events: [],
    setups: [setup()],
    summary: [],
    missingEvidence: [],
    ...overrides,
  };
}
