import { ema } from './indicators.js';
import { findSwings } from './levels.js';
import type { Candle, Trend } from './types.js';

export interface TrendReading {
  trend: Trend;
  ema9: number | null;
  ema20: number | null;
  structure: 'higher highs & higher lows' | 'lower highs & lower lows' | 'mixed' | 'not enough swings';
  explanation: string;
}

/**
 * Trend = where price sits relative to the 9 and 20 EMAs, whether the 20 EMA
 * is rising or falling, and the order of recent swing points. Needs at least
 * 25 completed candles; otherwise it says "unknown" rather than guessing.
 */
export function readTrend(candles: Candle[]): TrendReading {
  const closes = candles.map((c) => c.c);
  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const n = candles.length;
  const ema9 = e9[n - 1] ?? null;
  const ema20 = e20[n - 1] ?? null;
  const ema20Prev = n > 5 ? (e20[n - 6] ?? null) : null;
  const structure = swingStructure(candles);

  if (n < 25 || ema9 === null || ema20 === null || ema20Prev === null) {
    return { trend: 'unknown', ema9, ema20, structure, explanation: 'Not enough completed candles to judge the trend (need at least 25).' };
  }

  const close = closes[n - 1]!;
  const rising = ema20 > ema20Prev;
  const falling = ema20 < ema20Prev;

  if (close > ema20 && ema9 > ema20 && rising) {
    return {
      trend: 'uptrend',
      ema9,
      ema20,
      structure,
      explanation: `Price is above the 20 EMA, the 9 EMA is above the 20 EMA, and the 20 EMA is rising. Swing structure: ${structure}.`,
    };
  }
  if (close < ema20 && ema9 < ema20 && falling) {
    return {
      trend: 'downtrend',
      ema9,
      ema20,
      structure,
      explanation: `Price is below the 20 EMA, the 9 EMA is below the 20 EMA, and the 20 EMA is falling. Swing structure: ${structure}.`,
    };
  }
  return {
    trend: 'sideways',
    ema9,
    ema20,
    structure,
    explanation: `The EMAs do not agree on a direction (price ${close > ema20 ? 'above' : 'below'} the 20 EMA, 20 EMA ${rising ? 'rising' : falling ? 'falling' : 'flat'}). Swing structure: ${structure}.`,
  };
}

function swingStructure(candles: Candle[]): TrendReading['structure'] {
  const swings = findSwings(candles.slice(-60), 2);
  const highs = swings.filter((s) => s.kind === 'high').slice(-2);
  const lows = swings.filter((s) => s.kind === 'low').slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'not enough swings';
  const hh = highs[1]!.price > highs[0]!.price;
  const hl = lows[1]!.price > lows[0]!.price;
  if (hh && hl) return 'higher highs & higher lows';
  if (!hh && !hl) return 'lower highs & lower lows';
  return 'mixed';
}
