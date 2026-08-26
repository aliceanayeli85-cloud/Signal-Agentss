import type { Candle, ChartAnnotation } from '../../shared/types.js';
import { atr, isFiniteNumber } from '../indicators.js';

export function lastBar(window: Candle[]): Candle | null {
  return window[window.length - 1] ?? null;
}

/**
 * Buffer to place a stop beyond a level so ordinary noise does not take it out.
 * Uses ATR when available and falls back to a small percentage of price - never
 * to a hardcoded absolute number, which would be meaningless across assets whose
 * prices differ by ten orders of magnitude.
 */
export function stopBuffer(window: Candle[], price: number, atrMultiple = 0.5): number {
  const range = atr(window, 14);
  if (range !== null && range > 0) return range * atrMultiple;
  return Math.abs(price) * 0.005;
}

export function withinPct(a: number, b: number, pct: number): boolean {
  if (!isFiniteNumber(a) || !isFiniteNumber(b) || b === 0) return false;
  return Math.abs((a - b) / b) * 100 <= pct;
}

export function lowestLow(window: Candle[], from: number, to: number): number | null {
  let low: number | null = null;
  for (let i = Math.max(0, from); i <= Math.min(window.length - 1, to); i += 1) {
    const c = window[i];
    if (!c || !isFiniteNumber(c.low)) continue;
    if (low === null || c.low < low) low = c.low;
  }
  return low;
}

export function highestHigh(window: Candle[], from: number, to: number): number | null {
  let high: number | null = null;
  for (let i = Math.max(0, from); i <= Math.min(window.length - 1, to); i += 1) {
    const c = window[i];
    if (!c || !isFiniteNumber(c.high)) continue;
    if (high === null || c.high > high) high = c.high;
  }
  return high;
}

export function annotation(
  kind: ChartAnnotation['kind'],
  label: string,
  explain: string,
  price: number | null,
  time: number | null,
): ChartAnnotation {
  return { kind, label, explain, price, time };
}

/** Guards every detection: a stop on the wrong side of entry is not a trade. */
export function validDirectionalStop(
  direction: 'long' | 'short',
  entry: number,
  stop: number,
): boolean {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop)) return false;
  if (entry <= 0 || stop <= 0) return false;
  if (direction === 'long') return stop < entry;
  return stop > entry;
}
