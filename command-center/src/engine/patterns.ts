import type { Candle, CandlePattern } from './types.js';

/**
 * Candlestick patterns describe how buyers and sellers behaved inside one or
 * two candles. They are evidence, never a guarantee: every explanation says
 * what the pattern suggests and that it can fail.
 *
 * Callers must pass COMPLETED candles only. A forming candle can still change
 * shape, so a "hammer" mid-candle may be gone by the close.
 */
export function detectPatterns(candles: Candle[], lookback = 3): CandlePattern[] {
  const found: CandlePattern[] = [];
  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const range = c.h - c.l;
    if (range <= 0) continue;
    const body = Math.abs(c.c - c.o);
    const upper = c.h - Math.max(c.o, c.c);
    const lower = Math.min(c.o, c.c) - c.l;
    const priorDecline = declined(candles, i);
    const priorRise = rose(candles, i);

    if (body <= range * 0.1) {
      found.push({
        name: 'Doji',
        bias: 'neutral',
        time: c.t,
        explanation: 'Open and close were almost equal: buyers and sellers were balanced. Indecision, not a direction.',
      });
    } else if (lower >= body * 2 && upper <= body * 0.5 && priorDecline) {
      found.push({
        name: 'Hammer',
        bias: 'bullish',
        time: c.t,
        explanation: 'After a decline, sellers pushed price down but buyers pulled it back up before the close. Suggests selling may be weakening. Needs a follow-through candle to mean much.',
      });
    } else if (upper >= body * 2 && lower <= body * 0.5 && priorRise) {
      found.push({
        name: 'Shooting star',
        bias: 'bearish',
        time: c.t,
        explanation: 'After a rise, buyers pushed price up but sellers pushed it back down before the close. Suggests buying may be weakening.',
      });
    }

    const pBody = Math.abs(p.c - p.o);
    if (p.c < p.o && c.c > c.o && c.c >= p.o && c.o <= p.c && body > pBody) {
      found.push({
        name: 'Bullish engulfing',
        bias: 'bullish',
        time: c.t,
        explanation: "A green candle's body fully covered the previous red candle's body: buyers overpowered the prior selling. More meaningful at support than in the middle of a range.",
      });
    } else if (p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o && body > pBody) {
      found.push({
        name: 'Bearish engulfing',
        bias: 'bearish',
        time: c.t,
        explanation: "A red candle's body fully covered the previous green candle's body: sellers overpowered the prior buying.",
      });
    }

    if (c.h < p.h && c.l > p.l) {
      found.push({
        name: 'Inside bar',
        bias: 'neutral',
        time: c.t,
        explanation: "The whole candle fit inside the previous one: price is pausing. A break of the previous candle's high or low often shows which side wins.",
      });
    }
  }
  return found;
}

function declined(candles: Candle[], i: number): boolean {
  if (i < 3) return false;
  return candles[i - 1]!.c < candles[i - 3]!.c;
}

function rose(candles: Candle[], i: number): boolean {
  if (i < 3) return false;
  return candles[i - 1]!.c > candles[i - 3]!.c;
}
