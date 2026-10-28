/**
 * Shared engine types. Every price is in US dollars, every timestamp is Unix
 * milliseconds UTC. A candle's `t` is the moment its interval OPENS.
 */

export type Timeframe = '5Min' | '15Min' | '1Hour' | '1Day';

export const TIMEFRAMES: Timeframe[] = ['1Day', '1Hour', '15Min', '5Min'];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '5Min': 5 * 60_000,
  '15Min': 15 * 60_000,
  '1Hour': 60 * 60_000,
  '1Day': 24 * 60 * 60_000,
};

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** A candle plus whether its interval has finished. Forming candles can still change. */
export interface MarkedCandle extends Candle {
  complete: boolean;
}

export type Trend = 'uptrend' | 'downtrend' | 'sideways' | 'unknown';

export type SetupType = 'PULLBACK_EMA' | 'BREAKOUT' | 'SUPPORT_REVERSAL';

export interface Level {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  lastTouchTime: number;
}

export interface CandlePattern {
  name: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  time: number;
  explanation: string;
}

export interface Setup {
  type: SetupType;
  label: string;
  signalTime: number;
  /** Price that must trade for the setup to trigger (buy stop concept). */
  trigger: number;
  entryLow: number;
  entryHigh: number;
  stop: number;
  /** A level that, if a candle CLOSES beyond it, means the idea is wrong. */
  invalidationPrice: number;
  invalidation: string;
  confirmation: string[];
  reasonsFor: string[];
  reasonsAgainst: string[];
}
