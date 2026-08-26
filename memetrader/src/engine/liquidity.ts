import type { LiquidityTrend } from '../shared/types.js';
import { isFiniteNumber, safeDivide } from './indicators.js';

/** One recorded observation of a market's liquidity, oldest first. */
export interface LiquidityObservation {
  capturedAt: number;
  liquidityUsd: number | null;
}

/** Below this many observations there is no trend, only a single reading. */
export const MIN_LIQUIDITY_OBSERVATIONS = 3;

/**
 * LIQUIDITY ANALYSIS.
 *
 * No connected provider exposes a liquidity time series, so this is built from
 * snapshots THIS APP recorded while you used it. That has one honest
 * consequence: on a market the app has just seen for the first time the answer
 * is `insufficient-history`, not `stable`. A freshly-added token cannot have a
 * trend, and claiming one would be the exact kind of invented reassurance this
 * app exists to avoid.
 *
 * `rapid-loss` is the state that matters. Liquidity leaving quickly is how a
 * position becomes unexitable, so it sets `highRisk` and the caller refuses to
 * recommend entry.
 */
export function analyseLiquidity(
  observations: LiquidityObservation[],
  currentUsd: number | null,
): LiquidityTrend {
  const usable = observations
    .filter((o) => isFiniteNumber(o.liquidityUsd) && (o.liquidityUsd as number) > 0)
    .sort((a, b) => a.capturedAt - b.capturedAt);

  const latest = currentUsd ?? usable[usable.length - 1]?.liquidityUsd ?? null;

  if (usable.length < MIN_LIQUIDITY_OBSERVATIONS) {
    return {
      label: 'insufficient-history',
      changePct: null,
      observations: usable.length,
      firstObservedAt: usable[0]?.capturedAt ?? null,
      lastObservedAt: usable[usable.length - 1]?.capturedAt ?? null,
      currentUsd: latest,
      detail: `Liquidity trend needs at least ${MIN_LIQUIDITY_OBSERVATIONS} recorded observations; this market has ${usable.length}. The app records one each time it loads this market, so the trend appears as you use it.`,
      highRisk: false,
    };
  }

  const first = usable[0] as LiquidityObservation;
  const last = usable[usable.length - 1] as LiquidityObservation;
  const from = first.liquidityUsd as number;
  const to = (latest ?? last.liquidityUsd) as number;

  const ratio = safeDivide(to - from, from);
  const changePct = ratio === null ? null : ratio * 100;
  const spanMinutes = Math.max(1, (last.capturedAt - first.capturedAt) / 60_000);

  if (changePct === null) {
    return {
      label: 'insufficient-history',
      changePct: null,
      observations: usable.length,
      firstObservedAt: first.capturedAt,
      lastObservedAt: last.capturedAt,
      currentUsd: latest,
      detail: 'The earliest recorded liquidity was zero, so a percentage change cannot be computed.',
      highRisk: false,
    };
  }

  // Rate matters as much as size: -20% over a week is ordinary, -20% in an hour
  // is a pool being pulled.
  const pctPerHour = changePct / (spanMinutes / 60);

  let label: LiquidityTrend['label'];
  let highRisk = false;
  if (changePct <= -25 && pctPerHour <= -10) {
    label = 'rapid-loss';
    highRisk = true;
  } else if (changePct <= -10) {
    label = 'falling';
    highRisk = pctPerHour <= -15;
  } else if (changePct >= 10) {
    label = 'increasing';
  } else {
    label = 'stable';
  }

  const window =
    spanMinutes < 90
      ? `${Math.round(spanMinutes)} minutes`
      : `${(spanMinutes / 60).toFixed(1)} hours`;

  const detail =
    label === 'rapid-loss'
      ? `HIGH RISK — LIQUIDITY DETERIORATION: the pool has fallen ${Math.abs(changePct).toFixed(1)}% over the last ${window} (${pctPerHour.toFixed(1)}%/hour). Do not enter while liquidity is leaving this fast.`
      : label === 'falling'
        ? `Liquidity is down ${Math.abs(changePct).toFixed(1)}% over the last ${window}. Slippage on both entry and exit is getting worse.`
        : label === 'increasing'
          ? `Liquidity is up ${changePct.toFixed(1)}% over the last ${window} across ${usable.length} observations.`
          : `Liquidity has held within ${Math.abs(changePct).toFixed(1)}% over the last ${window} across ${usable.length} observations.`;

  return {
    label,
    changePct,
    observations: usable.length,
    firstObservedAt: first.capturedAt,
    lastObservedAt: last.capturedAt,
    currentUsd: latest,
    detail,
    highRisk,
  };
}
