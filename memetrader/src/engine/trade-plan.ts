import type { Candle, Level, SetupDetection, TradePlanResult } from '../shared/types.js';
import { atr, isFiniteNumber } from './indicators.js';
import { riskReward } from './position-size.js';
import { nearestLevelAbove, nearestLevelBelow } from './structure.js';

export interface TradePlanOptions {
  /** R multiples used when no structural target is available. */
  fallbackTargetR: [number, number, number];
  /** Minimum reward-to-risk at TP1 before the plan is considered worth taking. */
  minRR: number;
}

export const DEFAULT_PLAN_OPTIONS: TradePlanOptions = {
  fallbackTargetR: [1, 2, 3],
  minRR: 1,
};

/**
 * Turns a detected setup into a full trade plan.
 *
 * Targets prefer real structure - the next level price has actually reacted to -
 * and only fall back to fixed R multiples when no such level exists above (or
 * below) the entry. When a usable stop cannot be established the function returns
 * `available: false`; it never invents one to make the UI look complete.
 */
export function buildTradePlan(
  detection: SetupDetection,
  candles: Candle[],
  levels: Level[],
  options: TradePlanOptions = DEFAULT_PLAN_OPTIONS,
): TradePlanResult {
  const { direction, entry, stop } = detection;

  if (!isFiniteNumber(entry) || entry <= 0) {
    return { available: false, reason: 'No valid trade plan available: entry price is not usable.' };
  }
  if (!isFiniteNumber(stop) || stop <= 0) {
    return { available: false, reason: 'No valid trade plan available: no valid stop could be determined.' };
  }
  if (direction === 'long' && stop >= entry) {
    return { available: false, reason: 'No valid trade plan available: the stop is not below the entry.' };
  }
  if (direction === 'short' && stop <= entry) {
    return { available: false, reason: 'No valid trade plan available: the stop is not above the entry.' };
  }

  const riskPerUnit = Math.abs(entry - stop);
  if (riskPerUnit === 0) {
    return { available: false, reason: 'No valid trade plan available: risk per unit is zero.' };
  }

  const atrValue = atr(candles, 14);
  const notes: string[] = [];

  // Sanity check: a stop tighter than a fraction of one ATR gets hit by noise.
  if (atrValue !== null && atrValue > 0 && riskPerUnit < atrValue * 0.35) {
    notes.push(
      `The stop is only ${(riskPerUnit / atrValue).toFixed(2)} ATR away. Normal bar-to-bar movement is likely to hit it even if the idea is right.`,
    );
  }
  if (atrValue !== null && atrValue > 0 && riskPerUnit > atrValue * 5) {
    notes.push(
      `The stop is ${(riskPerUnit / atrValue).toFixed(1)} ATR away, which is a wide invalidation. Position size must shrink accordingly.`,
    );
  }

  const [r1, r2, r3] = options.fallbackTargetR;
  let tp1: number;
  let tp2: number;
  let tp3: number;

  if (direction === 'long') {
    const structural = nearestLevelAbove(
      levels.filter((l) => l.kind === 'resistance' || l.kind === 'supply'),
      entry,
    );
    // A level closer than half the risk is not worth targeting - costs and noise
    // eat the whole move - so it is skipped rather than used.
    const usable = structural !== null && structural.price > entry + riskPerUnit * 0.5;
    tp1 = usable ? (structural as Level).price : entry + riskPerUnit * r1;
    tp2 = Math.max(entry + riskPerUnit * r2, tp1 + riskPerUnit * 0.5);
    tp3 = Math.max(entry + riskPerUnit * r3, tp2 + riskPerUnit * 0.5);
    if (usable && structural) {
      notes.push(
        `TP1 uses the next resistance at ${structural.price.toPrecision(6)} (${structural.touches} prior touches) rather than an arbitrary multiple.`,
      );
    } else if (structural) {
      notes.push(
        `The nearest resistance at ${structural.price.toPrecision(6)} is closer than 0.5R, so it was skipped and targets use fixed R multiples instead.`,
      );
    } else {
      notes.push('No resistance level above the entry was found, so targets use fixed R multiples.');
    }
  } else {
    const structural = nearestLevelBelow(
      levels.filter((l) => l.kind === 'support' || l.kind === 'demand'),
      entry,
    );
    const usable = structural !== null && structural.price < entry - riskPerUnit * 0.5;
    tp1 = usable ? (structural as Level).price : entry - riskPerUnit * r1;
    tp2 = Math.min(entry - riskPerUnit * r2, tp1 - riskPerUnit * 0.5);
    tp3 = Math.min(entry - riskPerUnit * r3, tp2 - riskPerUnit * 0.5);
    if (usable && structural) {
      notes.push(
        `TP1 uses the next support at ${structural.price.toPrecision(6)} (${structural.touches} prior touches) rather than an arbitrary multiple.`,
      );
    } else if (structural) {
      notes.push(
        `The nearest support at ${structural.price.toPrecision(6)} is closer than 0.5R, so it was skipped and targets use fixed R multiples instead.`,
      );
    } else {
      notes.push('No support level below the entry was found, so targets use fixed R multiples.');
    }
  }

  // Shorts cannot target a negative price.
  if (direction === 'short' && tp3 <= 0) {
    return {
      available: false,
      reason: 'No valid trade plan available: the third target would fall at or below zero.',
    };
  }

  const rr1 = riskReward(direction, entry, stop, tp1);
  const rr2 = riskReward(direction, entry, stop, tp2);
  const rr3 = riskReward(direction, entry, stop, tp3);
  if (rr1 === null || rr2 === null || rr3 === null) {
    return {
      available: false,
      reason: 'No valid trade plan available: reward could not be computed from these levels.',
    };
  }

  if (rr1 < options.minRR) {
    notes.push(
      `TP1 is only ${rr1.toFixed(2)}R away. Below ${options.minRR}R the setup needs a high win rate just to break even.`,
    );
  }

  return {
    available: true,
    direction,
    entry,
    stop,
    invalidation: detection.invalidation,
    invalidationReason: detection.invalidationReason,
    targets: { tp1, tp2, tp3 },
    rr: { tp1: rr1, tp2: rr2, tp3: rr3 },
    riskPerUnit,
    notes,
  };
}
