import type { Candle, Timeframe } from '../shared/types.js';

/**
 * Folds `factor` consecutive bars into one. A trailing partial group is dropped,
 * because a half-formed higher-timeframe bar has a high and low that will still
 * change - treating it as closed would put a value on the chart that is not real
 * yet.
 *
 * Volume is summed only when EVERY constituent bar carried volume; otherwise the
 * aggregate would understate the true figure, so it is reported as null instead.
 */
export function aggregateCandles(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    const volumes = group.map((c) => c.volume).filter((v): v is number => v !== null);
    out.push({
      time: first.time,
      open: first.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: last.close,
      volume: volumes.length === group.length ? volumes.reduce((a, b) => a + b, 0) : null,
    });
  }
  return out;
}

/** How many bars of `from` make one bar of `to`, or null when it does not divide. */
export function aggregationFactor(from: Timeframe, to: Timeframe): number | null {
  const minutes: Record<Timeframe, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
  };
  const ratio = minutes[to] / minutes[from];
  if (!Number.isInteger(ratio) || ratio < 1) return null;
  return ratio;
}

/**
 * Derives a timeframe from a coarser-grained series already in hand.
 *
 * This exists to spend fewer provider requests: one 15m series answers 15m, 1h
 * and 4h, so a six-timeframe ladder costs three fetches instead of six. It only
 * ever aggregates upward - a finer timeframe cannot be invented from a coarser
 * one, and this returns null rather than interpolating.
 */
export function deriveTimeframe(
  source: { timeframe: Timeframe; candles: Candle[] },
  target: Timeframe,
): Candle[] | null {
  if (source.timeframe === target) return source.candles;
  const factor = aggregationFactor(source.timeframe, target);
  if (factor === null) return null;
  const derived = aggregateCandles(source.candles, factor);
  return derived.length > 0 ? derived : null;
}
