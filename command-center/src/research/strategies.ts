import { atr, ema, sma } from '../engine/indicators.js';
import type { Candle } from '../engine/types.js';

/**
 * Pre-registered candidate strategies (see research/PREREGISTRATION.md).
 * Parameters are conventional textbook values chosen BEFORE any result was
 * seen; none are fitted. Changing them requires a new version and a new,
 * untouched test period.
 */

export type Entry = { type: 'next_open' } | { type: 'trigger'; price: number; maxFill: number };
export type Exit = { type: 'targets'; tp1R: number; tp2R: number; maxHoldBars: number } | { type: 'channel'; lookback: number; maxHoldBars: number };

export interface Signal {
  entry: Entry;
  stop: number;
  exit: Exit;
}

/** Indicators are causal (value at i uses only candles 0..i), so computing them once over the series is equivalent to recomputing on each slice. */
export interface Ctx {
  candles: Candle[];
  atr14: (number | null)[];
  ema20: (number | null)[];
  sma50: (number | null)[];
  sma100: (number | null)[];
  sma200: (number | null)[];
  avgVol20: (number | null)[];
}

export function buildCtx(candles: Candle[]): Ctx {
  const closes = candles.map((c) => c.c);
  return {
    candles,
    atr14: atr(candles, 14),
    ema20: ema(closes, 20),
    sma50: sma(closes, 50),
    sma100: sma(closes, 100),
    sma200: sma(closes, 200),
    avgVol20: sma(candles.map((c) => c.v), 20),
  };
}

export interface Strategy {
  id: string;
  name: string;
  family: string;
  rules: string[];
  warmupBars: number;
  /** Decide using ONLY candles[0..i]. Must not read index > i. */
  signal(ctx: Ctx, i: number): Signal | null;
}

const highestHigh = (cs: Candle[], from: number, to: number) => {
  let h = -Infinity;
  for (let k = from; k <= to; k++) h = Math.max(h, cs[k]!.h);
  return h;
};
const lowestLow = (cs: Candle[], from: number, to: number) => {
  let l = Infinity;
  for (let k = from; k <= to; k++) l = Math.min(l, cs[k]!.l);
  return l;
};

export const TREND_FOLLOW: Strategy = {
  id: 'C1_TREND_FOLLOW',
  name: 'Trend following: 20-day breakout, 10-day exit',
  family: 'trend-following',
  rules: [
    'Filter: close above its 100-day simple moving average.',
    'Signal: close above the highest high of the previous 20 days.',
    'Entry: next day\'s open (market on open).',
    'Initial stop: signal close − 2 × ATR(14).',
    'Exit: when a day closes below the lowest low of the previous 10 days, sell at the next open; or the stop; or after 120 days.',
    'No profit target — winners are allowed to run.',
  ],
  warmupBars: 120,
  signal(ctx, i) {
    const cs = ctx.candles;
    const c = cs[i]!;
    const a = ctx.atr14[i];
    const s100 = ctx.sma100[i];
    if (i < 21 || a == null || s100 == null) return null;
    if (!(c.c > s100 && c.c > highestHigh(cs, i - 20, i - 1))) return null;
    return { entry: { type: 'next_open' }, stop: c.c - 2 * a, exit: { type: 'channel', lookback: 10, maxHoldBars: 120 } };
  },
};

export const BREAKOUT_CONFIRMED: Strategy = {
  id: 'C2_BREAKOUT_CONFIRMED',
  name: 'Breakout with volume and next-day confirmation',
  family: 'breakout',
  rules: [
    'Level: highest high of the previous 20 days.',
    'Signal day: closes above the level, on volume ≥ 1.5 × its 20-day average, closing in the top 25% of its range.',
    'Trend filter: close above the 50-day SMA, and the 50-day SMA higher than 10 days earlier.',
    'Confirmation: the next day must trade above the signal day\'s high; entry there (no fill more than 0.25 ATR above it; otherwise skipped).',
    'Stop: signal day\'s low − 0.1 ATR.',
    'Exits: sell half at +1.5R and move the stop to breakeven; sell the rest at +3R; or after 20 days.',
  ],
  warmupBars: 60,
  signal(ctx, i) {
    const cs = ctx.candles;
    const c = cs[i]!;
    const a = ctx.atr14[i];
    const s50 = ctx.sma50[i];
    const s50prev = ctx.sma50[i - 10];
    const vol = ctx.avgVol20[i - 1];
    if (i < 21 || a == null || s50 == null || s50prev == null || vol == null || vol <= 0) return null;
    const range = c.h - c.l;
    if (range <= 0) return null;
    const level = highestHigh(cs, i - 20, i - 1);
    if (!(c.c > level && c.v >= 1.5 * vol && (c.c - c.l) / range >= 0.75 && c.c > s50 && s50 > s50prev)) return null;
    return { entry: { type: 'trigger', price: c.h, maxFill: c.h + 0.25 * a }, stop: c.l - 0.1 * a, exit: { type: 'targets', tp1R: 1.5, tp2R: 3, maxHoldBars: 20 } };
  },
};

export const PULLBACK_IN_TREND: Strategy = {
  id: 'C3_PULLBACK_IN_TREND',
  name: 'Pullback to the 20 EMA in a long-term uptrend',
  family: 'pullback',
  rules: [
    'Broad trend: close above the 200-day SMA, and the 50-day SMA above the 200-day SMA.',
    'Pullback: the day\'s low touches or goes below the 20-day EMA, but it closes back above the 20-day EMA, as a green candle (close > open).',
    'Confirmation: the next day must trade above the signal day\'s high; entry there (no fill more than 0.25 ATR above it; otherwise skipped).',
    'Stop: lowest low of the last 5 days − 0.1 ATR.',
    'Exits: sell half at +1.5R and move the stop to breakeven; sell the rest at +3R; or after 20 days.',
  ],
  warmupBars: 210,
  signal(ctx, i) {
    const cs = ctx.candles;
    const c = cs[i]!;
    const a = ctx.atr14[i];
    const e20 = ctx.ema20[i];
    const s50 = ctx.sma50[i];
    const s200 = ctx.sma200[i];
    if (i < 5 || a == null || e20 == null || s50 == null || s200 == null) return null;
    if (!(c.c > s200 && s50 > s200 && c.l <= e20 && c.c > e20 && c.c > c.o)) return null;
    return { entry: { type: 'trigger', price: c.h, maxFill: c.h + 0.25 * a }, stop: lowestLow(cs, i - 4, i) - 0.1 * a, exit: { type: 'targets', tp1R: 1.5, tp2R: 3, maxHoldBars: 20 } };
  },
};

export const CANDIDATES: Strategy[] = [TREND_FOLLOW, BREAKOUT_CONFIRMED, PULLBACK_IN_TREND];
