import type { Candle, Level } from './types.js';

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

/**
 * A swing high is a candle whose high beats the `width` candles on each side.
 * The right-hand side must already exist, so the newest `width` candles can
 * never be swings — that delay is what stops future data leaking in.
 */
export function findSwings(candles: Candle[], width = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = width; i < candles.length - width; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      const o = candles[j]!;
      if (o.h >= c.h) isHigh = false;
      if (o.l <= c.l) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.t, price: c.h, kind: 'high' });
    if (isLow) swings.push({ index: i, time: c.t, price: c.l, kind: 'low' });
  }
  return swings;
}

/**
 * Groups nearby swing prices into levels. A level touched several times is
 * more meaningful than one touched once, so touches are counted and reported.
 * Levels above the current price are resistance, below are support.
 */
export function findLevels(candles: Candle[], atrValue: number | null, width = 2): Level[] {
  if (candles.length === 0) return [];
  const last = candles[candles.length - 1]!;
  const tolerance = Math.max((atrValue ?? 0) * 0.5, last.c * 0.003);
  const swings = findSwings(candles, width).sort((a, b) => a.price - b.price);

  const clusters: Swing[][] = [];
  for (const s of swings) {
    const current = clusters[clusters.length - 1];
    const anchor = current ? current[0]!.price : null;
    if (current && anchor !== null && s.price - anchor <= tolerance) current.push(s);
    else clusters.push([s]);
  }

  return clusters
    .map((group) => {
      const price = group.reduce((sum, s) => sum + s.price, 0) / group.length;
      return {
        price,
        kind: price >= last.c ? ('resistance' as const) : ('support' as const),
        touches: group.length,
        lastTouchTime: Math.max(...group.map((s) => s.time)),
      };
    })
    .sort((a, b) => a.price - b.price);
}

export function nearestSupport(levels: Level[], price: number): Level | null {
  let best: Level | null = null;
  for (const l of levels) if (l.price < price && (!best || l.price > best.price)) best = l;
  return best;
}

export function resistancesAbove(levels: Level[], price: number): Level[] {
  return levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price);
}
