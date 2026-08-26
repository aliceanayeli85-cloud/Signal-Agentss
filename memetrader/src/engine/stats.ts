import type { HistoricalSetupStats } from '../shared/types.js';
import { mean, median } from './indicators.js';
import { maxDrawdownR } from './backtest/metrics.js';

/**
 * Minimum matching observations before this app will publish a win rate for a
 * rule set. Below it the numbers are shown as insufficient rather than rendered
 * as a percentage a reader will inevitably treat as a probability.
 */
export const MIN_OBSERVATIONS = 30;

export interface StatsInput {
  /** R multiples of every historical observation that matched the rule set. */
  rMultiples: number[];
  /** Human description of the rule set these observations came from. */
  ruleSetLabel: string;
}

/**
 * STATISTICAL PROBABILITY ENGINE.
 *
 * The single most important line in this file is `statement`. This app reports
 * an observed historical frequency under a stated rule set. It never converts
 * that frequency into a probability for the next trade, because doing so would
 * assume the future is drawn from the same distribution as the sample - which
 * nothing about markets guarantees.
 */
export function computeHistoricalStats(input: StatsInput): HistoricalSetupStats {
  const rs = input.rMultiples.filter((r) => Number.isFinite(r));
  const wins = rs.filter((r) => r > 0).length;
  const sufficient = rs.length >= MIN_OBSERVATIONS;

  const winRatePct = rs.length > 0 ? (wins / rs.length) * 100 : null;
  const avg = mean(rs);
  const med = median(rs);

  const statement = !sufficient
    ? `Insufficient observations: ${rs.length} matching setups recorded against a minimum of ${MIN_OBSERVATIONS}. No historical frequency is published for "${input.ruleSetLabel}" yet.`
    : `Historically, the rule set "${input.ruleSetLabel}" produced a ${(winRatePct as number).toFixed(1)}% win rate across ${rs.length} matching observations. This is a measurement of what already happened under those rules - it is not the probability that your next trade wins.`;

  return {
    matchingSetups: rs.length,
    winRatePct: sufficient ? winRatePct : null,
    averageR: sufficient ? avg : null,
    medianR: sufficient ? med : null,
    worstR: rs.length > 0 ? Math.min(...rs) : null,
    bestR: rs.length > 0 ? Math.max(...rs) : null,
    maxDrawdownR: sufficient ? maxDrawdownR(rs) : null,
    distribution: buildDistribution(rs),
    statement,
    sufficient,
  };
}

/** Buckets outcomes so the shape of the distribution is visible, not just the mean. */
export function buildDistribution(rs: number[]): { bucket: string; count: number }[] {
  const buckets: { bucket: string; test: (r: number) => boolean }[] = [
    { bucket: '<= -1R', test: (r) => r <= -1 },
    { bucket: '-1R to -0.5R', test: (r) => r > -1 && r <= -0.5 },
    { bucket: '-0.5R to 0R', test: (r) => r > -0.5 && r < 0 },
    { bucket: '0R', test: (r) => r === 0 },
    { bucket: '0R to +1R', test: (r) => r > 0 && r <= 1 },
    { bucket: '+1R to +2R', test: (r) => r > 1 && r <= 2 },
    { bucket: '+2R to +3R', test: (r) => r > 2 && r <= 3 },
    { bucket: '> +3R', test: (r) => r > 3 },
  ];
  return buckets.map((b) => ({ bucket: b.bucket, count: rs.filter(b.test).length }));
}
