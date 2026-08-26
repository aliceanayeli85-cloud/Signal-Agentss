import type { SetupDetection } from '../../shared/types.js';
import { atr } from '../indicators.js';
import { buildLevels, findSwings } from '../structure.js';
import { annotation, lastBar, stopBuffer, validDirectionalStop } from './helpers.js';
import type { Strategy } from './types.js';

/**
 * Strategy 2 - Support Bounce.
 *
 * The current bar must trade INTO a support level with at least two touches and
 * close back above it, leaving a lower wick. Buying a level that price has closed
 * beneath is not a bounce, it is a breakdown, so that case is excluded.
 */
export const supportBounce: Strategy = {
  id: 'support-bounce',
  name: 'Support Bounce',
  description:
    'Price trades into an established support level and closes back above it with a lower wick. Entry on that close, stop below the level.',
  minBars: 40,

  detect(window, ctx) {
    const last = lastBar(window);
    if (!last || window.length < this.minBars) return null;

    const range = atr(window, 14);
    const swings = findSwings(window, 2);
    const levels = buildLevels(swings, 0.75, last.close).filter(
      (l) => l.touches >= 2 && l.kind === 'support' && l.price < last.close,
    );
    if (levels.length === 0) return null;

    // Nearest support beneath the close is the one price actually reacted to.
    const level = levels.sort((a, b) => b.price - a.price)[0];
    if (!level) return null;

    const tolerance = range !== null && range > 0 ? range * 0.5 : Math.abs(level.price) * 0.004;
    const touched = last.low <= level.price + tolerance;
    const closedAbove = last.close > level.price;
    if (!touched || !closedAbove) return null;

    const body = Math.abs(last.close - last.open);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    // A bounce should show rejection: the wick beneath should be a real part of the bar.
    if (lowerWick <= 0 || (body > 0 && lowerWick < body * 0.3)) return null;

    const buffer = stopBuffer(window, level.price, ctx.stopRule === 'atr' ? ctx.atrMultiple : 0.5);
    const structureStop = Math.min(last.low, level.price) - buffer;
    const atrStop = range !== null ? last.close - range * ctx.atrMultiple : structureStop;
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
      invalidation: level.price,
      invalidationReason: `A close below ${level.price.toPrecision(6)} means the level stopped holding and the bounce thesis is gone.`,
      keyLevel: level.price,
      annotations: [
        annotation(
          'support',
          'SUPPORT',
          `Buyers stopped price here ${level.touches} times before.`,
          level.price,
          level.firstTime,
        ),
        annotation(
          'demand',
          'REJECTION WICK',
          'Price traded below the level and was pushed back up inside the same bar.',
          last.low,
          last.time,
        ),
        annotation(
          'confirmation',
          'CONFIRMATION',
          'The close back above support is the trigger.',
          last.close,
          last.time,
        ),
        annotation('entry', 'ENTRY ZONE', 'Entry at the confirmation close.', last.close, last.time),
        annotation(
          'stop',
          'STOP / INVALIDATION',
          'Beneath the level and beneath the rejection wick.',
          stop,
          last.time,
        ),
      ],
      notes: [
        `Support at ${level.price.toPrecision(6)} with ${level.touches} prior touches.`,
        `Lower wick was ${lowerWick.toPrecision(4)} against a body of ${body.toPrecision(4)} - price was rejected below the level.`,
        'A bounce is only a bounce while the level holds on a closing basis.',
      ],
    } satisfies SetupDetection;
  },
};
