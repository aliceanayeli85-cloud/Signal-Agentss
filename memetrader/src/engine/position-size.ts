import type { PositionSizingResult } from '../shared/types.js';
import { isFiniteNumber, safeDivide } from './indicators.js';

export interface PositionSizeInput {
  accountSize: number;
  riskPct: number;
  entry: number;
  stop: number;
  /** Optional first target, used to report potential profit and R:R. */
  target?: number | null;
  direction?: 'long' | 'short';
  /** Set for meme coins so the warning about volatility-scaled sizing applies. */
  highVolatility?: boolean;
  /** Hard ceiling from settings. Sizing above it still computes but warns loudly. */
  maxRiskPct?: number;
}

export const RISK_PRESETS = [0.25, 0.5, 1, 1.5, 2] as const;
export const DEFAULT_RISK_PCT = 1;

/**
 * Position sizing from account size, risk percentage, entry and stop.
 *
 * Every failure mode returns `available: false` with a reason rather than a
 * number: a zero stop distance, a stop on the wrong side of entry, a non-positive
 * account, or a non-finite input. Sizing is the one calculation where a silently
 * wrong number costs real money, so nothing here is permitted to guess.
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizingResult {
  const warnings: string[] = [];
  const { accountSize, riskPct, entry, stop, target = null, highVolatility = false, maxRiskPct = 2 } = input;

  // The standalone calculator takes only account, risk, entry and stop, so the
  // direction has to come from which side of entry the stop sits on. That
  // inference is reported back rather than applied silently: a user who meant a
  // long and typed the stop too high must see that they were sized as a short.
  const directionInferred = input.direction === undefined;
  const direction: 'long' | 'short' = input.direction ?? (stop < entry ? 'long' : 'short');

  if (!isFiniteNumber(accountSize) || accountSize <= 0) {
    return { available: false, reason: 'Account size must be a positive number.', warnings };
  }
  if (!isFiniteNumber(riskPct) || riskPct <= 0) {
    return { available: false, reason: 'Risk percentage must be greater than zero.', warnings };
  }
  if (!isFiniteNumber(entry) || entry <= 0) {
    return { available: false, reason: 'Entry price must be a positive number.', warnings };
  }
  if (!isFiniteNumber(stop) || stop <= 0) {
    return { available: false, reason: 'Stop price must be a positive number.', warnings };
  }
  if (entry === stop) {
    return {
      available: false,
      reason: 'Entry and stop are the same price, so risk per unit is zero and no size can be computed.',
      warnings,
    };
  }
  if (direction === 'long' && stop >= entry) {
    return {
      available: false,
      reason: 'For a long, the stop must sit below the entry.',
      warnings,
    };
  }
  if (direction === 'short' && stop <= entry) {
    return {
      available: false,
      reason: 'For a short, the stop must sit above the entry.',
      warnings,
    };
  }

  const riskPerUnit = Math.abs(entry - stop);
  const maxDollarRisk = accountSize * (riskPct / 100);
  const positionSize = safeDivide(maxDollarRisk, riskPerUnit);
  if (positionSize === null || positionSize <= 0) {
    return {
      available: false,
      reason: 'Risk per unit is too small relative to the account to produce a usable size.',
      warnings,
    };
  }

  const positionValue = positionSize * entry;
  const potentialLoss = positionSize * riskPerUnit;

  let potentialProfit: number | null = null;
  let rr: number | null = null;
  if (isFiniteNumber(target) && target > 0) {
    const rewardPerUnit = direction === 'long' ? target - entry : entry - target;
    if (rewardPerUnit > 0) {
      potentialProfit = positionSize * rewardPerUnit;
      rr = safeDivide(rewardPerUnit, riskPerUnit);
    } else {
      warnings.push('Target is on the wrong side of entry, so no reward was computed.');
    }
  }

  if (directionInferred) {
    warnings.push(
      `No direction was given, so this was sized as a ${direction.toUpperCase()} because the stop sits ${direction === 'long' ? 'below' : 'above'} the entry.`,
    );
  }
  if (riskPct > 2) {
    warnings.push(
      `Risking ${riskPct}% per trade is above the 2% ceiling. Five losses in a row at this size costs roughly ${(riskPct * 5).toFixed(1)}% of the account.`,
    );
  }
  if (riskPct > maxRiskPct) {
    warnings.push(
      `This exceeds your configured maximum of ${maxRiskPct}% per trade in Settings.`,
    );
  }
  if (highVolatility && riskPct > 0.5) {
    warnings.push(
      'This market is flagged as high volatility. Consider 0.25%-0.5% rather than a larger size - the wider stop already means a bigger price move against you.',
    );
  }
  if (positionValue > accountSize) {
    warnings.push(
      `The position notional (${positionValue.toFixed(2)}) exceeds the account size. Without leverage you cannot take this size; the stop is very tight relative to your risk budget.`,
    );
  }

  return {
    available: true,
    direction,
    directionInferred,
    accountSize,
    riskPct,
    maxDollarRisk,
    positionSize,
    positionValue,
    potentialLoss,
    potentialProfit,
    rr,
    warnings,
  };
}

/**
 * R multiple for a completed trade: how many multiples of the initial risk the
 * result was. Returns null when the initial risk was zero or undefined.
 */
export function rMultiple(
  direction: 'long' | 'short',
  entry: number,
  stop: number,
  exit: number,
): number | null {
  if (![entry, stop, exit].every(isFiniteNumber)) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  const move = direction === 'long' ? exit - entry : entry - exit;
  return safeDivide(move, risk);
}

/** Realised P&L in account currency. Position size is in units of the asset. */
export function realisedPnl(
  direction: 'long' | 'short',
  entry: number,
  exit: number,
  positionSize: number,
): number | null {
  if (![entry, exit, positionSize].every(isFiniteNumber)) return null;
  const move = direction === 'long' ? exit - entry : entry - exit;
  return move * positionSize;
}

/** Unrealised P&L against a live price. Same rules as `realisedPnl`. */
export function unrealisedPnl(
  direction: 'long' | 'short',
  entry: number,
  currentPrice: number,
  positionSize: number,
): number | null {
  return realisedPnl(direction, entry, currentPrice, positionSize);
}

/** Reward-to-risk for a plan. Null when either leg is degenerate. */
export function riskReward(
  direction: 'long' | 'short',
  entry: number,
  stop: number,
  target: number,
): number | null {
  if (![entry, stop, target].every(isFiniteNumber)) return null;
  const risk = Math.abs(entry - stop);
  const reward = direction === 'long' ? target - entry : entry - target;
  if (risk === 0 || reward <= 0) return null;
  return safeDivide(reward, risk);
}
