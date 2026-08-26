import type { Candle, SetupDetection } from '../../shared/types.js';
import { atr, relativeVolume } from '../indicators.js';
import {
  annotation,
  highestHigh,
  lastBar,
  lowestLow,
  stopBuffer,
  validDirectionalStop,
} from './helpers.js';
import type { Strategy } from './types.js';

const RANGE_LOOKBACK = 30;

/**
 * Strategy 4 - Range Breakout.
 *
 * Detects a genuine range first: over the previous `RANGE_LOOKBACK` bars (not
 * counting the current one) price must have stayed inside a band no wider than
 * 4 ATR, and must have visited both edges at least twice. Only then does a close
 * beyond the band count. Without the range test this degenerates into "buy any
 * new high", which is a different and much worse strategy.
 */
export const rangeBreakout: Strategy = {
  id: 'range-breakout',
  name: 'Range Breakout',
  description:
    'Price consolidates in a defined band, then closes beyond it. Entry on the breakout close, stop back inside the range.',
  minBars: RANGE_LOOKBACK + 15,

  detect(window, ctx) {
    const last = lastBar(window);
    if (!last || window.length < this.minBars) return null;

    const rangeEnd = window.length - 2;
    const rangeStart = rangeEnd - RANGE_LOOKBACK + 1;
    if (rangeStart < 0) return null;

    const rangeHigh = highestHigh(window, rangeStart, rangeEnd);
    const rangeLow = lowestLow(window, rangeStart, rangeEnd);
    if (rangeHigh === null || rangeLow === null || rangeHigh <= rangeLow) return null;

    const atrValue = atr(window, 14);
    if (atrValue === null || atrValue <= 0) return null;

    const width = rangeHigh - rangeLow;
    // Too wide relative to volatility and it is a trend, not a balance area.
    if (width > atrValue * 4) return null;

    const band = window.slice(rangeStart, rangeEnd + 1);
    const upperTouches = band.filter((c) => c.high >= rangeHigh - width * 0.15).length;
    const lowerTouches = band.filter((c) => c.low <= rangeLow + width * 0.15).length;
    if (upperTouches < 2 || lowerTouches < 2) return null;

    const relVol = relativeVolume(window, 20);
    const mid = (rangeHigh + rangeLow) / 2;
    const buffer = stopBuffer(window, last.close, ctx.stopRule === 'atr' ? ctx.atrMultiple : 0.3);
    const triggerIndex = window.length - 1;

    if (last.close > rangeHigh) {
      const structureStop = Math.max(mid, rangeHigh - buffer);
      const atrStop = last.close - atrValue * ctx.atrMultiple;
      const stop = ctx.stopRule === 'atr' ? atrStop : structureStop;
      if (!validDirectionalStop('long', last.close, stop)) return null;
      return build({
        strategy: this,
        direction: 'long',
        last,
        triggerIndex,
        brokenEdge: rangeHigh,
        oppositeEdge: rangeLow,
        stop,
        relVol,
        width,
        atrValue,
      });
    }

    if (last.close < rangeLow) {
      const structureStop = Math.min(mid, rangeLow + buffer);
      const atrStop = last.close + atrValue * ctx.atrMultiple;
      const stop = ctx.stopRule === 'atr' ? atrStop : structureStop;
      if (!validDirectionalStop('short', last.close, stop)) return null;
      return build({
        strategy: this,
        direction: 'short',
        last,
        triggerIndex,
        brokenEdge: rangeLow,
        oppositeEdge: rangeHigh,
        stop,
        relVol,
        width,
        atrValue,
      });
    }

    return null;
  },
};

interface BuildArgs {
  strategy: Pick<Strategy, 'id' | 'name'>;
  direction: 'long' | 'short';
  last: Candle;
  triggerIndex: number;
  brokenEdge: number;
  oppositeEdge: number;
  stop: number;
  relVol: number | null;
  width: number;
  atrValue: number;
}

function build(args: BuildArgs): SetupDetection {
  const { direction, last, brokenEdge, oppositeEdge, stop, relVol, width, atrValue } = args;
  const notes = [
    `Range spanned ${Math.min(brokenEdge, oppositeEdge).toPrecision(6)} to ${Math.max(brokenEdge, oppositeEdge).toPrecision(6)} (${(width / atrValue).toFixed(1)} ATR wide) over the prior ${RANGE_LOOKBACK} bars.`,
    'Both edges were tested at least twice before the break, so the band was a real balance area.',
    relVol !== null
      ? `Breakout bar volume is ${relVol.toFixed(2)}x the 20-bar average.`
      : 'Volume data unavailable for this series - volume confirmation not evaluated.',
  ];

  return {
    strategy: args.strategy.id,
    strategyName: args.strategy.name,
    direction,
    triggerIndex: args.triggerIndex,
    triggerTime: last.time,
    entry: last.close,
    stop,
    invalidation: brokenEdge,
    invalidationReason: `A close back ${direction === 'long' ? 'below' : 'above'} ${brokenEdge.toPrecision(6)} puts price back inside the range and makes this a failed breakout.`,
    keyLevel: brokenEdge,
    annotations: [
      annotation(
        direction === 'long' ? 'resistance' : 'support',
        'RANGE EDGE',
        'The boundary price could not clear while it was consolidating.',
        brokenEdge,
        last.time,
      ),
      annotation(
        direction === 'long' ? 'support' : 'resistance',
        'OTHER RANGE EDGE',
        'The opposite boundary of the balance area.',
        oppositeEdge,
        last.time,
      ),
      annotation('breakout', 'BREAKOUT', 'The close beyond the range boundary.', last.close, last.time),
      annotation('entry', 'ENTRY ZONE', 'Entry at the breakout close.', last.close, last.time),
      annotation(
        'stop',
        'STOP / INVALIDATION',
        'Back inside the range. If price returns here the break failed.',
        stop,
        last.time,
      ),
    ],
    notes,
  };
}
