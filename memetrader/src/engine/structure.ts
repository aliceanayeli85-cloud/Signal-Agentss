import type {
  Bias,
  Candle,
  Level,
  LiquiditySweep,
  StructureAnalysis,
  StructureLabel,
  Swing,
} from '../shared/types.js';
import { atr, isFiniteNumber, mean } from './indicators.js';

/**
 * Market-structure detection.
 *
 * All functions here are strictly causal: given `candles`, they describe only
 * what those candles show. The backtester relies on this - it slices the series
 * and calls the same code, so a look-ahead here would silently corrupt results.
 */

/**
 * Fractal swing points: a swing high is a bar whose high exceeds the `strength`
 * bars either side of it. The last `strength` bars can never be confirmed swings,
 * which is a real property of the market, not a limitation to be papered over.
 */
export function findSwings(candles: Candle[], strength = 2): Swing[] {
  const swings: Swing[] = [];
  if (candles.length < strength * 2 + 1) return swings;
  for (let i = strength; i < candles.length - strength; i += 1) {
    const c = candles[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j += 1) {
      if (j === i) continue;
      const other = candles[j];
      if (!other) continue;
      if (other.high >= c.high) isHigh = false;
      if (other.low <= c.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, kind: 'high' });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, kind: 'low' });
  }
  return swings.sort((a, b) => a.index - b.index);
}

/**
 * Clusters swing points that sit within `tolerancePct` of each other into levels.
 * More touches means more traders have seen the level, so `touches` is surfaced
 * rather than hidden inside a score.
 */
export function buildLevels(
  swings: Swing[],
  tolerancePct = 0.75,
  lastClose: number | null = null,
): Level[] {
  const levels: Level[] = [];
  const groups: { kind: 'high' | 'low'; prices: number[]; times: number[] }[] = [];

  for (const swing of swings) {
    const match = groups.find(
      (g) =>
        g.kind === swing.kind &&
        g.prices.length > 0 &&
        Math.abs(((mean(g.prices) as number) - swing.price) / swing.price) * 100 <= tolerancePct,
    );
    if (match) {
      match.prices.push(swing.price);
      match.times.push(swing.time);
    } else {
      groups.push({ kind: swing.kind, prices: [swing.price], times: [swing.time] });
    }
  }

  for (const group of groups) {
    const price = mean(group.prices);
    if (price === null) continue;
    const times = [...group.times].sort((a, b) => a - b);
    // Relative to current price a swing high above is resistance; below, it has
    // already been broken and typically acts as support (and vice versa).
    let kind: Level['kind'];
    if (lastClose === null) {
      kind = group.kind === 'high' ? 'resistance' : 'support';
    } else if (group.kind === 'high') {
      kind = price >= lastClose ? 'resistance' : 'support';
    } else {
      kind = price <= lastClose ? 'support' : 'resistance';
    }
    levels.push({
      price,
      kind,
      touches: group.prices.length,
      firstTime: times[0] ?? 0,
      lastTime: times[times.length - 1] ?? 0,
    });
  }

  return levels.sort((a, b) => b.touches - a.touches || b.lastTime - a.lastTime);
}

/**
 * Supply and demand zones: the origin of an impulsive move. `impulseAtrMultiple`
 * defines how big a move has to be before the bar that preceded it counts.
 */
export function findSupplyDemandZones(candles: Candle[], impulseAtrMultiple = 2): Level[] {
  const zones: Level[] = [];
  const range = atr(candles, 14);
  if (range === null || range <= 0 || candles.length < 20) return zones;

  for (let i = 1; i < candles.length - 1; i += 1) {
    const origin = candles[i - 1];
    const impulse = candles[i];
    if (!origin || !impulse) continue;
    const move = impulse.close - impulse.open;
    if (Math.abs(move) < range * impulseAtrMultiple) continue;
    zones.push({
      price: (origin.high + origin.low) / 2,
      kind: move > 0 ? 'demand' : 'supply',
      touches: 1,
      firstTime: origin.time,
      lastTime: origin.time,
    });
  }

  // Keep the most recent few - old zones degrade every time price passes through.
  return zones.slice(-6);
}

/**
 * Liquidity sweeps: price trades beyond a prior swing extreme and closes back on
 * the original side within `reclaimBars`. Only identifiable after the reversal,
 * which is why `reclaimed` is part of the record.
 */
export function findLiquiditySweeps(
  candles: Candle[],
  swings: Swing[],
  reclaimBars = 3,
): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  for (const swing of swings) {
    for (let i = swing.index + 1; i < Math.min(candles.length, swing.index + 40); i += 1) {
      const c = candles[i];
      if (!c) continue;
      if (swing.kind === 'high' && c.high > swing.price && c.close < swing.price) {
        let reclaimed = false;
        for (let j = i; j < Math.min(candles.length, i + reclaimBars + 1); j += 1) {
          const later = candles[j];
          if (later && later.close < swing.price) reclaimed = true;
        }
        sweeps.push({ time: c.time, price: c.high, direction: 'above-highs', reclaimed });
        break;
      }
      if (swing.kind === 'low' && c.low < swing.price && c.close > swing.price) {
        let reclaimed = false;
        for (let j = i; j < Math.min(candles.length, i + reclaimBars + 1); j += 1) {
          const later = candles[j];
          if (later && later.close > swing.price) reclaimed = true;
        }
        sweeps.push({ time: c.time, price: c.low, direction: 'below-lows', reclaimed });
        break;
      }
    }
  }
  return sweeps.slice(-5);
}

function lastTwo(swings: Swing[], kind: 'high' | 'low'): [Swing, Swing] | null {
  const filtered = swings.filter((s) => s.kind === kind);
  if (filtered.length < 2) return null;
  const a = filtered[filtered.length - 2];
  const b = filtered[filtered.length - 1];
  if (!a || !b) return null;
  return [a, b];
}

/**
 * Classifies the current structure. Order matters: breakout/breakdown and the
 * failure cases are checked against the most recent bars first, because those
 * are the states that change what a trader should do right now.
 */
export function analyseStructure(candles: Candle[], swingStrength = 2): StructureAnalysis {
  const notes: string[] = [];
  const swings = findSwings(candles, swingStrength);
  const last = candles[candles.length - 1];
  const lastClose = last && isFiniteNumber(last.close) ? last.close : null;
  const levels = [
    ...buildLevels(swings, 0.75, lastClose),
    ...findSupplyDemandZones(candles),
  ];
  const sweeps = findLiquiditySweeps(candles, swings);

  if (candles.length < 20 || swings.length < 4 || !last) {
    notes.push(
      `Only ${candles.length} bars available; structure needs at least 20 bars and 4 confirmed swing points.`,
    );
    return { label: 'insufficient-data', bias: 'unknown', swings, levels, sweeps, notes };
  }

  const highs = lastTwo(swings, 'high');
  const lows = lastTwo(swings, 'low');
  const range = atr(candles, 14);

  // Confirmed swings exclude the most recent `swingStrength` bars, so the
  // breakout check looks at closes after the last confirmed swing high/low.
  const priorHigh = highs ? Math.max(highs[0].price, highs[1].price) : null;
  const priorLow = lows ? Math.min(lows[0].price, lows[1].price) : null;
  const recent = candles.slice(-6);

  let label: StructureLabel = 'consolidation';
  let bias: Bias = 'neutral';

  const closedAbovePriorHigh =
    priorHigh !== null && recent.some((c) => c.close > priorHigh);
  const closedBelowPriorLow = priorLow !== null && recent.some((c) => c.close < priorLow);
  const backInsideFromAbove =
    priorHigh !== null && closedAbovePriorHigh && last.close < priorHigh;
  const backInsideFromBelow =
    priorLow !== null && closedBelowPriorLow && last.close > priorLow;

  if (backInsideFromAbove) {
    label = 'failed-breakout';
    bias = 'bearish';
    notes.push(
      `Price closed above ${priorHigh.toPrecision(6)} then closed back beneath it - the break did not hold.`,
    );
  } else if (backInsideFromBelow) {
    label = 'reclaim';
    bias = 'bullish';
    notes.push(
      `Price lost ${priorLow.toPrecision(6)} then closed back above it - sellers who broke it are trapped.`,
    );
  } else if (closedAbovePriorHigh && last.close >= (priorHigh as number)) {
    label = 'breakout';
    bias = 'bullish';
    notes.push(`Closed above the prior swing high at ${(priorHigh as number).toPrecision(6)}.`);
  } else if (closedBelowPriorLow && last.close <= (priorLow as number)) {
    label = 'breakdown';
    bias = 'bearish';
    notes.push(`Closed below the prior swing low at ${(priorLow as number).toPrecision(6)}.`);
  } else if (highs && lows) {
    const higherHighs = highs[1].price > highs[0].price;
    const higherLows = lows[1].price > lows[0].price;
    const lowerHighs = highs[1].price < highs[0].price;
    const lowerLows = lows[1].price < lows[0].price;
    if (higherHighs && higherLows) {
      label = 'higher-highs-higher-lows';
      bias = 'bullish';
      notes.push('Each pullback has bottomed higher and each push has topped higher.');
    } else if (lowerHighs && lowerLows) {
      label = 'lower-highs-lower-lows';
      bias = 'bearish';
      notes.push('Each bounce has topped lower and each drop has bottomed lower.');
    } else {
      label = 'consolidation';
      bias = 'neutral';
      notes.push('Swing highs and lows are not making a consistent sequence - range conditions.');
    }
  }

  if (label === 'consolidation' && range !== null && priorHigh !== null && priorLow !== null) {
    const width = priorHigh - priorLow;
    if (width > 0 && range > 0) {
      notes.push(
        `Range is roughly ${(width / range).toFixed(1)} ATR wide (${priorLow.toPrecision(6)} to ${priorHigh.toPrecision(6)}).`,
      );
    }
  }

  return { label, bias, swings, levels, sweeps, notes };
}

/** Nearest level below the reference price, used for stop placement. */
export function nearestLevelBelow(levels: Level[], price: number): Level | null {
  const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price);
  return below[0] ?? null;
}

/** Nearest level above the reference price, used for target placement. */
export function nearestLevelAbove(levels: Level[], price: number): Level | null {
  const above = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price);
  return above[0] ?? null;
}
