import type {
  Bias,
  Candle,
  MomentumAnalysis,
  MomentumReading,
  Timeframe,
} from '../shared/types.js';
import { isFiniteNumber, pctChange } from './indicators.js';

/** Bars measured over on each timeframe, and the minimum needed to report at all. */
const LOOKBACK: Record<Timeframe, { bars: number; minimum: number }> = {
  '1m': { bars: 15, minimum: 8 },
  '5m': { bars: 12, minimum: 6 },
  '15m': { bars: 8, minimum: 5 },
  '1h': { bars: 6, minimum: 4 },
  '4h': { bars: 6, minimum: 4 },
  '1d': { bars: 5, minimum: 3 },
};

export const MOMENTUM_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export interface MomentumInput {
  timeframe: Timeframe;
  candles: Candle[] | null;
  /** Set when the fetch itself failed, as opposed to returning few bars. */
  unavailableReason?: string;
}

/**
 * MOMENTUM across the timeframe ladder.
 *
 * Each timeframe is measured on its own bars. A timeframe without enough history
 * is reported as `insufficient-data` and is excluded from the bias entirely -
 * it does NOT fall back to a neighbouring timeframe's value, because a brand-new
 * pair genuinely has no daily momentum and pretending otherwise would generate a
 * signal from nothing.
 */
export function analyseMomentum(inputs: MomentumInput[]): MomentumAnalysis {
  const readings: MomentumReading[] = [];

  for (const input of inputs) {
    const spec = LOOKBACK[input.timeframe];
    const candles = input.candles ?? [];

    if (input.candles === null && input.unavailableReason) {
      readings.push({
        timeframe: input.timeframe,
        status: 'unavailable',
        changePct: null,
        barsUsed: 0,
        reason: input.unavailableReason,
      });
      continue;
    }

    if (candles.length < spec.minimum) {
      readings.push({
        timeframe: input.timeframe,
        status: 'insufficient-data',
        changePct: null,
        barsUsed: candles.length,
        reason: `Only ${candles.length} bars available; at least ${spec.minimum} are needed on ${input.timeframe}.`,
      });
      continue;
    }

    const window = candles.slice(-Math.min(spec.bars, candles.length));
    const first = window[0];
    const last = window[window.length - 1];
    if (!first || !last || !isFiniteNumber(first.open) || !isFiniteNumber(last.close)) {
      readings.push({
        timeframe: input.timeframe,
        status: 'insufficient-data',
        changePct: null,
        barsUsed: candles.length,
        reason: 'The bars returned for this timeframe had unusable prices.',
      });
      continue;
    }

    readings.push({
      timeframe: input.timeframe,
      status: 'ok',
      changePct: pctChange(first.open, last.close),
      barsUsed: window.length,
    });
  }

  const evaluated = readings.filter((r) => r.status === 'ok' && r.changePct !== null);
  if (evaluated.length === 0) {
    return {
      readings,
      bias: 'unknown',
      evaluated: 0,
      detail: 'No timeframe had enough history to measure momentum.',
    };
  }

  // A timeframe counts as directional only past a threshold; tiny drift is noise.
  const up = evaluated.filter((r) => (r.changePct as number) > 1).length;
  const down = evaluated.filter((r) => (r.changePct as number) < -1).length;

  const bias: Bias = up > down ? 'bullish' : down > up ? 'bearish' : 'neutral';
  const detail =
    up > 0 && down > 0
      ? `Momentum is split: ${up} of ${evaluated.length} evaluated timeframes are up, ${down} are down.`
      : bias === 'neutral'
        ? `All ${evaluated.length} evaluated timeframes are within 1% either way — no momentum in any direction.`
        : `${Math.max(up, down)} of ${evaluated.length} evaluated timeframes point ${bias}.`;

  return { readings, bias, evaluated: evaluated.length, detail };
}
