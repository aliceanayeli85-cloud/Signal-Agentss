import type { SetupDetection } from '../../shared/types.js';
import { atr, relativeVolume } from '../indicators.js';
import { buildLevels, findSwings } from '../structure.js';
import {
  annotation,
  highestHigh,
  lastBar,
  lowestLow,
  stopBuffer,
  validDirectionalStop,
  withinPct,
} from './helpers.js';
import type { Strategy } from './types.js';

/**
 * Strategy 1 - Breakout + Retest.
 *
 * Sequence required, in order:
 *   1. A resistance level with at least two touches.
 *   2. A candle that CLOSED above it (the breakout).
 *   3. A pullback that traded back down into the level (the retest).
 *   4. The current candle closing back above the level (the confirmation).
 *
 * The stop goes below the retest low, which is what makes this setup tighter
 * than buying the breakout candle itself.
 */
export const breakoutRetest: Strategy = {
  id: 'breakout-retest',
  name: 'Breakout + Retest',
  description:
    'Price breaks a level with at least two touches, pulls back into it, and closes back above. Entry on the confirmation close, stop below the retest low.',
  minBars: 40,

  detect(window, ctx) {
    const last = lastBar(window);
    if (!last || window.length < this.minBars) return null;

    const swings = findSwings(window, 2);
    const levels = buildLevels(swings, 0.75, last.close).filter(
      (l) => l.touches >= 2 && l.price < last.close,
    );
    if (levels.length === 0) return null;

    const range = atr(window, 14);

    for (const level of levels) {
      // The breakout must have happened, and not so long ago that it is history.
      let breakoutIndex = -1;
      for (let i = window.length - 2; i >= Math.max(0, window.length - 40); i -= 1) {
        const c = window[i];
        const prev = window[i - 1];
        if (!c || !prev) continue;
        if (c.close > level.price && prev.close <= level.price) {
          breakoutIndex = i;
          break;
        }
      }
      if (breakoutIndex < 0) continue;

      // Between the breakout and now, price must have traded back into the level.
      let retestIndex = -1;
      for (let i = breakoutIndex + 1; i <= window.length - 1; i += 1) {
        const c = window[i];
        if (!c) continue;
        const touched =
          c.low <= level.price ||
          withinPct(c.low, level.price, range && level.price ? (range / level.price) * 50 : 0.5);
        if (touched) {
          retestIndex = i;
          break;
        }
      }
      if (retestIndex < 0) continue;

      // Confirmation: the current bar closes back above the level and is not the retest bar itself.
      if (last.close <= level.price) continue;
      if (retestIndex === window.length - 1) continue;

      const retestLow = lowestLow(window, retestIndex, window.length - 1);
      if (retestLow === null) continue;

      const buffer = stopBuffer(window, level.price, ctx.stopRule === 'atr' ? ctx.atrMultiple : 0.4);
      const structureStop = retestLow - buffer;
      const atrStop = range !== null ? last.close - range * ctx.atrMultiple : structureStop;
      const stop = ctx.stopRule === 'atr' ? atrStop : structureStop;
      if (!validDirectionalStop('long', last.close, stop)) continue;

      const breakoutBar = window[breakoutIndex];
      const retestBar = window[retestIndex];
      const relVol = relativeVolume(window, 20);
      const priorHigh = highestHigh(window, breakoutIndex, window.length - 1);

      const notes = [
        `Level at ${level.price.toPrecision(6)} was touched ${level.touches} times before it broke.`,
        `Breakout close occurred ${window.length - 1 - breakoutIndex} bars ago.`,
        `Retest low was ${retestLow.toPrecision(6)}; the stop sits beneath it.`,
      ];
      if (relVol !== null) {
        notes.push(`Current bar volume is ${relVol.toFixed(2)}x the 20-bar average.`);
      } else {
        notes.push('Volume data unavailable for this series - volume confirmation not evaluated.');
      }

      return {
        strategy: this.id,
        strategyName: this.name,
        direction: 'long',
        triggerIndex: window.length - 1,
        triggerTime: last.time,
        entry: last.close,
        stop,
        invalidation: level.price,
        invalidationReason: `A close back below ${level.price.toPrecision(6)} means the level did not hold and the breakout has failed.`,
        keyLevel: level.price,
        annotations: [
          annotation(
            'resistance',
            'BROKEN RESISTANCE',
            'This level rejected price before. Once broken it often acts as support instead.',
            level.price,
            level.firstTime,
          ),
          annotation(
            'breakout',
            'BREAKOUT',
            'The candle that closed beyond the level.',
            breakoutBar ? breakoutBar.close : null,
            breakoutBar ? breakoutBar.time : null,
          ),
          annotation(
            'retest',
            'RETEST',
            'Price came back to the broken level to see whether it now holds as support.',
            retestLow,
            retestBar ? retestBar.time : null,
          ),
          annotation(
            'confirmation',
            'CONFIRMATION',
            'The close back above the level after the retest - this is the trigger.',
            last.close,
            last.time,
          ),
          annotation(
            'entry',
            'ENTRY ZONE',
            'Where the plan enters, at the confirmation close.',
            last.close,
            last.time,
          ),
          annotation(
            'stop',
            'STOP / INVALIDATION',
            'Below the retest low. If price gets here the setup was wrong.',
            stop,
            last.time,
          ),
          ...(priorHigh !== null && priorHigh > last.close
            ? [
                annotation(
                  'resistance',
                  'NEXT RESISTANCE',
                  'The next place sellers previously showed up.',
                  priorHigh,
                  last.time,
                ),
              ]
            : []),
        ],
        notes,
      } satisfies SetupDetection;
    }

    return null;
  },
};
