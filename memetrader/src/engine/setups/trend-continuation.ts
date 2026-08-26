import type { SetupDetection } from '../../shared/types.js';
import { atr, emaSeries } from '../indicators.js';
import { analyseStructure } from '../structure.js';
import { annotation, lastBar, lowestLow, stopBuffer, validDirectionalStop } from './helpers.js';
import type { Strategy } from './types.js';

/**
 * Strategy 3 - Trend Continuation.
 *
 * Requires an existing uptrend (higher highs and higher lows), a pullback that
 * reached the 20 EMA, and a close back above it. The point is to join a trend on
 * a pullback rather than after an extended run, so an entry far above the EMA is
 * rejected.
 */
export const trendContinuation: Strategy = {
  id: 'trend-continuation',
  name: 'Trend Continuation',
  description:
    'In an established uptrend, price pulls back to the 20 EMA and closes back above it. Entry on that close, stop below the pullback low.',
  minBars: 60,

  detect(window, ctx) {
    const last = lastBar(window);
    if (!last || window.length < this.minBars) return null;

    const structure = analyseStructure(window, 2);
    const trending =
      structure.label === 'higher-highs-higher-lows' || structure.label === 'breakout';
    if (!trending || structure.bias !== 'bullish') return null;

    const closes = window.map((c) => c.close);
    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);
    const fast = ema20[ema20.length - 1];
    const slow = ema50[ema50.length - 1];
    if (fast === null || fast === undefined) return null;
    // Trend filter: fast above slow when we have enough bars for a 50 EMA.
    if (slow !== null && slow !== undefined && fast <= slow) return null;

    const range = atr(window, 14);
    if (range === null || range <= 0) return null;

    // The pullback: some bar in the last 8 must have traded down to the EMA.
    let pullbackIndex = -1;
    for (let i = window.length - 2; i >= Math.max(0, window.length - 9); i -= 1) {
      const c = window[i];
      const emaHere = ema20[i];
      if (!c || emaHere === null || emaHere === undefined) continue;
      if (c.low <= emaHere) {
        pullbackIndex = i;
        break;
      }
    }
    if (pullbackIndex < 0) return null;

    // And the current bar must be back above it, without being extended away from it.
    if (last.close <= fast) return null;
    if (last.close - fast > range * 1.5) return null;

    const pullbackLow = lowestLow(window, pullbackIndex, window.length - 1);
    if (pullbackLow === null) return null;

    const buffer = stopBuffer(window, last.close, ctx.stopRule === 'atr' ? ctx.atrMultiple : 0.4);
    const structureStop = pullbackLow - buffer;
    const atrStop = last.close - range * ctx.atrMultiple;
    const stop = ctx.stopRule === 'atr' ? atrStop : structureStop;
    if (!validDirectionalStop('long', last.close, stop)) return null;

    return {
      strategy: this.id,
      strategyName: this.name,
      direction: 'long',
      triggerIndex: window.length - 1,
      triggerTime: last.time,
      entry: last.close,
      stop,
      invalidation: pullbackLow,
      invalidationReason: `A close below the pullback low at ${pullbackLow.toPrecision(6)} breaks the higher-low sequence that defines this uptrend.`,
      keyLevel: fast,
      annotations: [
        annotation(
          'demand',
          '20 EMA',
          'The moving average the pullback used as a floor.',
          fast,
          last.time,
        ),
        annotation(
          'retest',
          'PULLBACK LOW',
          'The lowest point of the pullback - the higher low this trend depends on.',
          pullbackLow,
          window[pullbackIndex]?.time ?? last.time,
        ),
        annotation(
          'confirmation',
          'CONFIRMATION',
          'Close back above the moving average after the pullback.',
          last.close,
          last.time,
        ),
        annotation('entry', 'ENTRY ZONE', 'Entry at the confirmation close.', last.close, last.time),
        annotation(
          'stop',
          'STOP / INVALIDATION',
          'Below the pullback low. Losing it breaks the trend structure.',
          stop,
          last.time,
        ),
      ],
      notes: [
        `Structure is ${structure.label} - the trend was already established before this entry.`,
        `Entry sits ${(((last.close - fast) / range) * 1).toFixed(2)} ATR above the 20 EMA, so the pullback has not run away yet.`,
        'Trend continuation only works while the higher-low sequence survives.',
      ],
    } satisfies SetupDetection;
  },
};
