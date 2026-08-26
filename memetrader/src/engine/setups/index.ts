import type { Candle, SetupDetection, StrategyId } from '../../shared/types.js';
import { breakoutRetest } from './breakout-retest.js';
import { failedBreakout } from './failed-breakout.js';
import { rangeBreakout } from './range-breakout.js';
import { supportBounce } from './support-bounce.js';
import { trendContinuation } from './trend-continuation.js';
import { DEFAULT_CONTEXT, STRATEGY_WINDOW, type Strategy, type StrategyContext } from './types.js';

export const STRATEGIES: Strategy[] = [
  breakoutRetest,
  supportBounce,
  trendContinuation,
  rangeBreakout,
  failedBreakout,
];

export const STRATEGY_IDS: StrategyId[] = STRATEGIES.map((s) => s.id);

export function getStrategy(id: StrategyId): Strategy | null {
  return STRATEGIES.find((s) => s.id === id) ?? null;
}

/**
 * Runs the requested strategies against the bars up to and including `index`.
 *
 * Only a bounded window is passed to each strategy, so cost per bar is constant
 * and - more importantly - a strategy physically cannot see a future bar.
 */
export function detectAt(
  candles: Candle[],
  index: number,
  strategies: StrategyId[] = STRATEGY_IDS,
  ctx: StrategyContext = DEFAULT_CONTEXT,
): SetupDetection[] {
  if (index < 0 || index >= candles.length) return [];
  const start = Math.max(0, index + 1 - STRATEGY_WINDOW);
  const window = candles.slice(start, index + 1);
  const out: SetupDetection[] = [];
  for (const id of strategies) {
    const strategy = getStrategy(id);
    if (!strategy) continue;
    let detection: SetupDetection | null = null;
    try {
      detection = strategy.detect(window, ctx);
    } catch {
      // A single misbehaving strategy must not take down the whole scan.
      detection = null;
    }
    if (detection) {
      // Translate the window-relative trigger index into an absolute one.
      out.push({ ...detection, triggerIndex: index });
    }
  }
  return out;
}

/** Convenience wrapper for live analysis: evaluate the most recent bar. */
export function detectLatest(
  candles: Candle[],
  strategies: StrategyId[] = STRATEGY_IDS,
  ctx: StrategyContext = DEFAULT_CONTEXT,
): SetupDetection[] {
  return detectAt(candles, candles.length - 1, strategies, ctx);
}

export { DEFAULT_CONTEXT, STRATEGY_WINDOW };
export type { Strategy, StrategyContext };
