import type { SetupDetection } from '../../shared/types.js';
import { atr } from '../indicators.js';
import { findSwings } from '../structure.js';
import { annotation, highestHigh, lastBar, lowestLow, stopBuffer, validDirectionalStop } from './helpers.js';
import type { Strategy } from './types.js';

/**
 * Strategy 5 - Failed Breakout.
 *
 * Price pushes beyond a confirmed swing extreme and then closes back inside
 * within a few bars, trapping everyone who took the break. Short when a high
 * fails, long when a low fails (a reclaim). The stop goes beyond the wick that
 * did the trapping, which is the tightest honest invalidation available.
 */
export const failedBreakout: Strategy = {
  id: 'failed-breakout',
  name: 'Failed Breakout',
  description:
    'Price trades beyond a prior swing extreme then closes back inside, trapping the breakout traders. Entry on the close back inside, stop beyond the failed extreme.',
  minBars: 40,

  detect(window, ctx) {
    const last = lastBar(window);
    if (!last || window.length < this.minBars) return null;

    const swings = findSwings(window, 2);
    const atrValue = atr(window, 14);
    if (atrValue === null || atrValue <= 0) return null;

    const highs = swings.filter((s) => s.kind === 'high' && s.index < window.length - 3);
    const lows = swings.filter((s) => s.kind === 'low' && s.index < window.length - 3);
    const priorHigh = highs[highs.length - 1];
    const priorLow = lows[lows.length - 1];

    // Failed high -> short.
    if (priorHigh) {
      let breachIndex = -1;
      for (let i = priorHigh.index + 1; i <= window.length - 1; i += 1) {
        const c = window[i];
        if (c && c.high > priorHigh.price) {
          breachIndex = i;
          break;
        }
      }
      const barsSinceBreach = breachIndex >= 0 ? window.length - 1 - breachIndex : -1;
      if (breachIndex >= 0 && barsSinceBreach <= 5 && last.close < priorHigh.price) {
        const breachHigh = highestHigh(window, breachIndex, window.length - 1);
        if (breachHigh !== null) {
          const buffer = stopBuffer(window, last.close, ctx.stopRule === 'atr' ? ctx.atrMultiple : 0.3);
          const structureStop = breachHigh + buffer;
          const atrStop = last.close + atrValue * ctx.atrMultiple;
          const stop = ctx.stopRule === 'atr' ? atrStop : structureStop;
          if (validDirectionalStop('short', last.close, stop)) {
            return {
              strategy: this.id,
              strategyName: this.name,
              direction: 'short',
              triggerIndex: window.length - 1,
              triggerTime: last.time,
              entry: last.close,
              stop,
              invalidation: priorHigh.price,
              invalidationReason: `A close back above ${priorHigh.price.toPrecision(6)} means the break was real after all and this setup is void.`,
              keyLevel: priorHigh.price,
              annotations: [
                annotation(
                  'resistance',
                  'PRIOR HIGH',
                  'The swing high everyone was watching.',
                  priorHigh.price,
                  priorHigh.time,
                ),
                annotation(
                  'liquidity-sweep',
                  'SWEEP',
                  'Price traded above the high, triggering stops, then could not hold it.',
                  breachHigh,
                  window[breachIndex]?.time ?? last.time,
                ),
                annotation(
                  'confirmation',
                  'CLOSE BACK INSIDE',
                  'The close back below the high traps the breakout buyers.',
                  last.close,
                  last.time,
                ),
                annotation('entry', 'ENTRY ZONE', 'Entry at the close back inside.', last.close, last.time),
                annotation('stop', 'STOP / INVALIDATION', 'Above the sweep high.', stop, last.time),
              ],
              notes: [
                `Price exceeded ${priorHigh.price.toPrecision(6)} ${barsSinceBreach} bars ago and has closed back beneath it.`,
                `Sweep high was ${breachHigh.toPrecision(6)}; the stop sits above it.`,
                'This setup depends on the trapped buyers having to sell. If they do not, it fails fast.',
              ],
            } satisfies SetupDetection;
          }
        }
      }
    }

    // Failed low -> long (a reclaim).
    if (priorLow) {
      let breachIndex = -1;
      for (let i = priorLow.index + 1; i <= window.length - 1; i += 1) {
        const c = window[i];
        if (c && c.low < priorLow.price) {
          breachIndex = i;
          break;
        }
      }
      const barsSinceBreach = breachIndex >= 0 ? window.length - 1 - breachIndex : -1;
      if (breachIndex >= 0 && barsSinceBreach <= 5 && last.close > priorLow.price) {
        const breachLow = lowestLow(window, breachIndex, window.length - 1);
        if (breachLow !== null) {
          const buffer = stopBuffer(window, last.close, ctx.stopRule === 'atr' ? ctx.atrMultiple : 0.3);
          const structureStop = breachLow - buffer;
          const atrStop = last.close - atrValue * ctx.atrMultiple;
          const stop = ctx.stopRule === 'atr' ? atrStop : structureStop;
          if (validDirectionalStop('long', last.close, stop)) {
            return {
              strategy: this.id,
              strategyName: this.name,
              direction: 'long',
              triggerIndex: window.length - 1,
              triggerTime: last.time,
              entry: last.close,
              stop,
              invalidation: priorLow.price,
              invalidationReason: `A close back below ${priorLow.price.toPrecision(6)} means the breakdown was real and the reclaim has failed.`,
              keyLevel: priorLow.price,
              annotations: [
                annotation(
                  'support',
                  'PRIOR LOW',
                  'The swing low everyone was watching.',
                  priorLow.price,
                  priorLow.time,
                ),
                annotation(
                  'liquidity-sweep',
                  'SWEEP',
                  'Price traded below the low, triggering stops, then could not stay there.',
                  breachLow,
                  window[breachIndex]?.time ?? last.time,
                ),
                annotation(
                  'confirmation',
                  'RECLAIM',
                  'The close back above the low traps the breakdown sellers.',
                  last.close,
                  last.time,
                ),
                annotation('entry', 'ENTRY ZONE', 'Entry at the reclaim close.', last.close, last.time),
                annotation('stop', 'STOP / INVALIDATION', 'Below the sweep low.', stop, last.time),
              ],
              notes: [
                `Price lost ${priorLow.price.toPrecision(6)} ${barsSinceBreach} bars ago and has closed back above it.`,
                `Sweep low was ${breachLow.toPrecision(6)}; the stop sits beneath it.`,
                'This setup depends on the trapped sellers having to buy back. If they do not, it fails fast.',
              ],
            } satisfies SetupDetection;
          }
        }
      }
    }

    return null;
  },
};
