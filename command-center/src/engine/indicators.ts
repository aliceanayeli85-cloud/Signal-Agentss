import { nyParts } from './time.js';
import type { Candle } from './types.js';

/**
 * Every indicator returns an array aligned with its input, holding `null`
 * wherever there is not yet enough data. Nothing is back-filled or guessed.
 */

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder's RSI. 0–100; above ~70 is often called overbought, below ~30 oversold. */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Average True Range: the typical size of a candle, including gaps. */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prevClose = candles[i - 1]!.c;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
  let value = 0;
  for (let i = 1; i <= period; i++) value += tr[i]!;
  value /= period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i]!) / period;
    out[i] = value;
  }
  return out;
}

/**
 * Session VWAP (volume-weighted average price), resetting each New York day.
 * Only meaningful for intraday candles; callers pass regular-session bars.
 */
export function sessionVwap(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let day = '';
  let pv = 0;
  let vol = 0;
  candles.forEach((c, i) => {
    const key = nyParts(c.t).dateKey;
    if (key !== day) {
      day = key;
      pv = 0;
      vol = 0;
    }
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    vol += c.v;
    out[i] = vol > 0 ? pv / vol : null;
  });
  return out;
}

/** Last candle's volume divided by the average of the `period` candles before it. */
export function relativeVolume(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const last = candles[candles.length - 1]!;
  let sum = 0;
  for (let i = candles.length - 1 - period; i < candles.length - 1; i++) sum += candles[i]!.v;
  const avg = sum / period;
  return avg > 0 ? last.v / avg : null;
}

export function lastValue(series: (number | null)[]): number | null {
  return series.length ? (series[series.length - 1] ?? null) : null;
}
