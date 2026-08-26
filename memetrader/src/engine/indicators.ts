import type { Candle } from '../shared/types.js';

/**
 * Indicator primitives.
 *
 * Every function returns `null` rather than a fallback number when there is not
 * enough data to compute an honest value. Callers must handle null; nothing here
 * pads a series or invents a starting value.
 */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Safe division: returns null instead of Infinity/NaN when the divisor is unusable. */
export function safeDivide(numerator: number, denominator: number): number | null {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) return null;
  if (denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

export function mean(values: number[]): number | null {
  const clean = values.filter(isFiniteNumber);
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

export function median(values: number[]): number | null {
  const clean = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid] as number;
  return ((clean[mid - 1] as number) + (clean[mid] as number)) / 2;
}

/** Sample standard deviation (n-1). Returns null for fewer than two points. */
export function stdev(values: number[]): number | null {
  const clean = values.filter(isFiniteNumber);
  if (clean.length < 2) return null;
  const avg = mean(clean);
  if (avg === null) return null;
  const variance = clean.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  return mean(values.slice(values.length - period));
}

/**
 * Exponential moving average over the whole series, seeded with the SMA of the
 * first `period` values. Returns the final EMA value, or null if the series is
 * shorter than `period`.
 */
export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const seed = mean(values.slice(0, period));
  if (seed === null) return null;
  const k = 2 / (period + 1);
  let current = seed;
  for (let i = period; i < values.length; i += 1) {
    const value = values[i];
    if (!isFiniteNumber(value)) continue;
    current = value * k + current * (1 - k);
  }
  return current;
}

/** Full EMA series aligned to the input; entries before `period` bars are null. */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const seed = mean(values.slice(0, period));
  if (seed === null) return out;
  const k = 2 / (period + 1);
  let current = seed;
  out[period - 1] = current;
  for (let i = period; i < values.length; i += 1) {
    const value = values[i];
    if (!isFiniteNumber(value)) {
      out[i] = current;
      continue;
    }
    current = value * k + current * (1 - k);
    out[i] = current;
  }
  return out;
}

export function trueRange(current: Candle, previous: Candle | undefined): number | null {
  if (!isFiniteNumber(current.high) || !isFiniteNumber(current.low)) return null;
  const highLow = current.high - current.low;
  if (!previous || !isFiniteNumber(previous.close)) return highLow;
  return Math.max(
    highLow,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

/**
 * Wilder's ATR at the last bar. Needs `period + 1` bars because the first true
 * range requires a previous close.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    if (!c) continue;
    const tr = trueRange(c, candles[i - 1]);
    if (tr !== null) trs.push(tr);
  }
  if (trs.length < period) return null;
  let value = mean(trs.slice(0, period));
  if (value === null) return null;
  for (let i = period; i < trs.length; i += 1) {
    const tr = trs[i];
    if (!isFiniteNumber(tr)) continue;
    value = (value * (period - 1) + tr) / period;
  }
  return value;
}

/** ATR series aligned to `candles`; null until enough bars exist. */
export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    if (!c) continue;
    trs[i] = trueRange(c, candles[i - 1]);
  }
  const firstWindow = trs.slice(1, period + 1).filter(isFiniteNumber);
  if (firstWindow.length < period) return out;
  let value = mean(firstWindow);
  if (value === null) return out;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i += 1) {
    const tr = trs[i];
    if (!isFiniteNumber(tr)) {
      out[i] = value;
      continue;
    }
    value = (value * (period - 1) + tr) / period;
    out[i] = value;
  }
  return out;
}

/** Wilder-smoothed RSI at the last bar. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!isFiniteNumber(prev) || !isFiniteNumber(curr)) return null;
    const delta = curr - prev;
    if (delta >= 0) gainSum += delta;
    else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!isFiniteNumber(prev) || !isFiniteNumber(curr)) continue;
    const delta = curr - prev;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  // All-gain window: RSI is 100 by definition, not a divide-by-zero.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Session VWAP over the supplied bars. Requires volume; returns null when the
 * provider gave us no volume data, because a VWAP without volume is a lie.
 */
export function vwap(candles: Candle[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    if (!isFiniteNumber(c.volume) || c.volume <= 0) continue;
    const typical = (c.high + c.low + c.close) / 3;
    if (!isFiniteNumber(typical)) continue;
    pv += typical * c.volume;
    vol += c.volume;
  }
  if (vol <= 0) return null;
  return pv / vol;
}

/**
 * Volume of the last bar relative to the average of the `lookback` bars before
 * it. 2.0 means "twice the recent norm".
 */
export function relativeVolume(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1];
  if (!last || !isFiniteNumber(last.volume) || last.volume <= 0) return null;
  const window = candles
    .slice(candles.length - 1 - lookback, candles.length - 1)
    .map((c) => c.volume)
    .filter(isFiniteNumber)
    .filter((v) => v > 0);
  if (window.length < Math.ceil(lookback / 2)) return null;
  const avg = mean(window);
  if (avg === null || avg <= 0) return null;
  return last.volume / avg;
}

/** Relative volume at an arbitrary index - used by the backtester, which must not peek ahead. */
export function relativeVolumeAt(
  candles: Candle[],
  index: number,
  lookback = 20,
): number | null {
  if (index < lookback || index >= candles.length) return null;
  return relativeVolume(candles.slice(index - lookback, index + 1), lookback);
}

/** Percentage change between two prices, or null when the base is unusable. */
export function pctChange(from: number, to: number): number | null {
  const ratio = safeDivide(to - from, Math.abs(from));
  return ratio === null ? null : ratio * 100;
}

/** Normalised ATR: ATR as a percentage of price. The comparable volatility number. */
export function atrPercent(candles: Candle[], period = 14): number | null {
  const value = atr(candles, period);
  const last = candles[candles.length - 1];
  if (value === null || !last || !isFiniteNumber(last.close) || last.close <= 0) return null;
  return (value / last.close) * 100;
}
