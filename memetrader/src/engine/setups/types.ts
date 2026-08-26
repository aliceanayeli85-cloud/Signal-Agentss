import type { Candle, SetupDetection, StrategyId, Timeframe } from '../../shared/types.js';

export interface StrategyContext {
  timeframe: Timeframe;
  /** How the stop is derived when the strategy has a choice. */
  stopRule: 'structure' | 'atr';
  atrMultiple: number;
}

export const DEFAULT_CONTEXT: StrategyContext = {
  timeframe: '15m',
  stopRule: 'structure',
  atrMultiple: 1.5,
};

/**
 * A strategy inspects a window of bars and decides whether its conditions are
 * satisfied *on the final bar of that window*. It never sees anything after it.
 *
 * `triggerIndex` on the returned detection is always `window.length - 1`; callers
 * that work in absolute indices (the backtester) translate it themselves.
 */
export interface Strategy {
  id: StrategyId;
  name: string;
  description: string;
  /** Minimum bars required before the strategy will make any decision. */
  minBars: number;
  detect(window: Candle[], ctx: StrategyContext): SetupDetection | null;
}

/** Bars of history each strategy is allowed to look back over. Keeps cost constant per bar. */
export const STRATEGY_WINDOW = 160;
