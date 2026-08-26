import type {
  Bias,
  Candle,
  Timeframe,
  TimeframeAlignment,
  TimeframeView,
} from '../shared/types.js';
import { analyseStructure } from './structure.js';

/** Timeframes are ordered high to low so the UI can read "1D down to 5M". */
export const MTF_ORDER: Timeframe[] = ['1d', '4h', '1h', '15m', '5m', '1m'];

export interface TimeframeInput {
  timeframe: Timeframe;
  candles: Candle[] | null;
  /** Present when the provider could not supply this timeframe. */
  unavailableReason?: string;
}

const MIN_BARS_FOR_STRUCTURE = 20;

/**
 * Multi-timeframe alignment.
 *
 * A setup valid on the 5m inside a 1D downtrend is a different trade to the same
 * setup inside a 1D uptrend. This deliberately does NOT propagate a bias from one
 * timeframe to another - each is evaluated on its own bars, and timeframes we
 * could not load are reported as unavailable rather than assumed neutral.
 */
export function analyseTimeframes(inputs: TimeframeInput[]): TimeframeAlignment {
  const views: TimeframeView[] = [];

  for (const input of inputs) {
    if (!input.candles || input.candles.length < MIN_BARS_FOR_STRUCTURE) {
      views.push({
        timeframe: input.timeframe,
        status: 'unavailable',
        reason:
          input.unavailableReason ??
          `Only ${input.candles?.length ?? 0} bars available; at least ${MIN_BARS_FOR_STRUCTURE} are needed.`,
        bias: 'unknown',
        structure: 'insufficient-data',
        candleCount: input.candles?.length ?? 0,
        lastClose: null,
      });
      continue;
    }
    const structure = analyseStructure(input.candles, 2);
    const last = input.candles[input.candles.length - 1];
    views.push({
      timeframe: input.timeframe,
      status: 'ok',
      bias: structure.bias,
      structure: structure.label,
      candleCount: input.candles.length,
      lastClose: last ? last.close : null,
    });
  }

  const evaluated = views.filter((v) => v.status === 'ok' && v.bias !== 'unknown');
  if (evaluated.length === 0) {
    return {
      views,
      alignment: 'UNKNOWN',
      dominantBias: 'unknown',
      detail: 'No timeframe had enough data to determine structure.',
    };
  }

  const counts: Record<Bias, number> = { bullish: 0, bearish: 0, neutral: 0, unknown: 0 };
  for (const view of evaluated) counts[view.bias] += 1;

  const directional = counts.bullish + counts.bearish;
  const dominantBias: Bias =
    counts.bullish > counts.bearish
      ? 'bullish'
      : counts.bearish > counts.bullish
        ? 'bearish'
        : 'neutral';

  let alignment: TimeframeAlignment['alignment'];
  if (directional === 0) {
    alignment = 'MIXED';
  } else if (counts.bullish > 0 && counts.bearish > 0) {
    alignment = 'MIXED';
  } else {
    const agreeing = Math.max(counts.bullish, counts.bearish);
    // Neutral timeframes dilute rather than contradict.
    alignment = agreeing >= evaluated.length ? 'HIGH' : 'MODERATE';
  }

  const detail =
    alignment === 'MIXED'
      ? 'Timeframes disagree. A setup taken here is fighting at least one larger timeframe.'
      : alignment === 'HIGH'
        ? `All ${evaluated.length} evaluated timeframes point ${dominantBias}.`
        : `${Math.max(counts.bullish, counts.bearish)} of ${evaluated.length} evaluated timeframes point ${dominantBias}; the rest are range-bound.`;

  return { views, alignment, dominantBias, detail };
}
