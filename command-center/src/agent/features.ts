import { atr, ema, rsi, sma } from '../engine/indicators.js';
import { nyParts } from '../engine/time.js';
import type { Candle } from '../engine/types.js';

/**
 * Model features. Every value at index i uses ONLY candles 0..i (the close of
 * day i is known when the forecast is made after that close). Indicators are
 * causal, so computing them once over a series equals recomputing per day.
 */
export const FEATURE_NAMES = [
  'return 1d',
  'return 5d',
  'return 20d',
  'return 60d',
  'distance from 50-day average',
  'distance from 200-day average',
  'RSI(14)',
  'MACD histogram ÷ price',
  'Bollinger %B',
  'ATR(14) ÷ price (volatility)',
  'log relative volume (vs 20-day average)',
  'relative strength vs SPY (20d)',
  'position in 20-day range',
  'SPY return 20d (market)',
  'SPY above its 200-day average (market regime)',
] as const;

export interface MarketContext {
  /** By New York date: SPY 20-day return and whether SPY closed above its 200-day average. */
  byDate: Map<string, { r20: number; above200: number }>;
}

export const dateKey = (t: number) => nyParts(t).dateKey;

export function marketContext(spy: Candle[]): MarketContext {
  const closes = spy.map((c) => c.c);
  const s200 = sma(closes, 200);
  const byDate = new Map<string, { r20: number; above200: number }>();
  spy.forEach((c, i) => {
    if (i < 20 || s200[i] == null) return;
    byDate.set(dateKey(c.t), { r20: c.c / spy[i - 20]!.c - 1, above200: c.c > s200[i]! ? 1 : 0 });
  });
  return { byDate };
}

export interface FeatureRow {
  index: number;
  date: string;
  x: number[];
}

/** One row per day that has every feature; days without full history are omitted (never filled in). */
export function computeFeatures(candles: Candle[], market: MarketContext): FeatureRow[] {
  const n = candles.length;
  if (n < 201) return [];
  const closes = candles.map((c) => c.c);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r14 = rsi(closes, 14);
  const a14 = atr(candles, 14);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i]! - e26[i]! : null));
  const firstMacd = macd.findIndex((v) => v !== null);
  const sig = new Array<number | null>(n).fill(null);
  if (firstMacd >= 0) {
    const e = ema(macd.slice(firstMacd) as number[], 9);
    e.forEach((v, k) => (sig[firstMacd + k] = v));
  }
  const rows: FeatureRow[] = [];
  for (let i = 200; i < n; i++) {
    const c = candles[i]!;
    const d = dateKey(c.t);
    const m = market.byDate.get(d);
    if (!m || s20[i] == null || s50[i] == null || s200[i] == null || r14[i] == null || a14[i] == null || macd[i] == null || sig[i] == null) continue;
    let sd = 0;
    for (let k = i - 19; k <= i; k++) sd += (closes[k]! - s20[i]!) ** 2;
    sd = Math.sqrt(sd / 20);
    let vol = 0;
    for (let k = i - 20; k < i; k++) vol += candles[k]!.v;
    vol /= 20;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - 19; k <= i; k++) {
      hi = Math.max(hi, candles[k]!.h);
      lo = Math.min(lo, candles[k]!.l);
    }
    const r20 = c.c / closes[i - 20]! - 1;
    rows.push({
      index: i,
      date: d,
      x: [
        c.c / closes[i - 1]! - 1,
        c.c / closes[i - 5]! - 1,
        r20,
        c.c / closes[i - 60]! - 1,
        c.c / s50[i]! - 1,
        c.c / s200[i]! - 1,
        r14[i]! / 100,
        (macd[i]! - sig[i]!) / c.c,
        sd > 0 ? (c.c - (s20[i]! - 2 * sd)) / (4 * sd) : 0.5,
        a14[i]! / c.c,
        vol > 0 && c.v > 0 ? Math.log(c.v / vol) : 0,
        r20 - m.r20,
        hi > lo ? (c.c - lo) / (hi - lo) : 0.5,
        m.r20,
        m.above200,
      ],
    });
  }
  return rows;
}

export interface Label {
  /** Close-to-close return from day i to day i+h. */
  ret: number;
  up: 0 | 1;
  /**
   * Standardised bracket: did price reach +2 ATR BEFORE −1 ATR within h days?
   * If both happen inside one daily candle the order is unknown, and the stop is
   * assumed first (conservative). null = neither was reached.
   */
  targetFirst: 0 | 1 | null;
}

export function label(candles: Candle[], i: number, h: number, atrValue: number): Label | null {
  if (i + h >= candles.length) return null;
  const c0 = candles[i]!.c;
  const ret = candles[i + h]!.c / c0 - 1;
  const up = c0 + 2 * atrValue;
  const down = c0 - atrValue;
  let targetFirst: 0 | 1 | null = null;
  for (let k = i + 1; k <= i + h; k++) {
    const b = candles[k]!;
    if (b.l <= down) {
      targetFirst = 0;
      break;
    }
    if (b.h >= up) {
      targetFirst = 1;
      break;
    }
  }
  return { ret, up: ret > 0 ? 1 : 0, targetFirst };
}
