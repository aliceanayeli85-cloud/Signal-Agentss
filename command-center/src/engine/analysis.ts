import { atr, ema, lastValue, relativeVolume, rsi, sessionVwap } from './indicators.js';
import { findLevels, nearestSupport, resistancesAbove } from './levels.js';
import { detectPatterns } from './patterns.js';
import { aggregateCompleted, higherTimeframeKey } from './time.js';
import { readTrend, type TrendReading } from './trend.js';
import type { Candle, CandlePattern, Level, Setup, Timeframe } from './types.js';

export const MIN_CANDLES = 30;

export interface BreakoutEvent {
  kind: 'breakout' | 'failed_breakout' | 'breakdown';
  level: number;
  time: number;
  explanation: string;
}

export interface Analysis {
  timeframe: Timeframe;
  candlesUsed: number;
  lastCompletedTime: number | null;
  close: number | null;
  trend: TrendReading;
  higherTimeframe: { label: string; trend: TrendReading } | null;
  ema9: number | null;
  ema20: number | null;
  rsi14: number | null;
  atr14: number | null;
  vwap: number | null;
  relativeVolume: number | null;
  levels: Level[];
  support: Level | null;
  resistance: Level | null;
  patterns: CandlePattern[];
  events: BreakoutEvent[];
  setups: Setup[];
  summary: string[];
  missingEvidence: string[];
}

/**
 * Analyses COMPLETED candles only. The caller strips the forming candle so
 * that nothing here reacts to a candle that has not closed yet. Backtests
 * call this with history sliced to the decision bar, so both paths share code.
 */
export function analyze(completed: Candle[], timeframe: Timeframe): Analysis {
  const missing: string[] = [];
  const n = completed.length;
  const closes = completed.map((c) => c.c);
  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(completed, 14);
  const atr14 = lastValue(atrSeries);
  const intraday = timeframe !== '1Day';
  const vwap = intraday ? lastValue(sessionVwap(completed)) : null;
  const relVol = relativeVolume(completed, 20);
  const trend = readTrend(completed);
  const close = n ? completed[n - 1]!.c : null;

  const htfKey = higherTimeframeKey(timeframe);
  const htfCandles = aggregateCompleted(completed, htfKey.keyOf);
  const htfTrend = htfCandles.length >= 25 ? readTrend(htfCandles) : null;

  const levels = findLevels(completed.slice(-150), atr14);
  const support = close !== null ? nearestSupport(levels, close) : null;
  const resistance = close !== null ? (resistancesAbove(levels, close)[0] ?? null) : null;
  const patterns = detectPatterns(completed, 3);
  const events = detectBreakoutEvents(completed, levels, atr14);

  if (n < MIN_CANDLES) missing.push(`Only ${n} completed candles; at least ${MIN_CANDLES} are needed for reliable indicators.`);
  if (!htfTrend) missing.push(`Not enough history to read the ${htfKey.label} trend, so the bigger-picture filter is unavailable.`);
  if (relVol === null) missing.push('Relative volume unavailable (not enough candles or zero volume).');
  if (intraday && vwap === null) missing.push('VWAP unavailable (no volume in the current session).');
  if (!intraday) missing.push('VWAP is not shown on daily candles; it is a one-session measure.');
  missing.push('Earnings dates and news are not connected. Check them yourself before any trade — a scheduled earnings report can gap price straight through a stop.');

  const ctx: SetupContext = {
    candles: completed,
    ema9: e9,
    ema20: e20,
    rsi: rsiSeries,
    atr: atr14,
    relVol,
    levels,
    support,
    trend: trend.trend,
    htfTrend: htfTrend?.trend ?? 'unknown',
    patterns,
    events,
  };
  const setups = n >= MIN_CANDLES && atr14 !== null ? detectSetups(ctx) : [];

  return {
    timeframe,
    candlesUsed: n,
    lastCompletedTime: n ? completed[n - 1]!.t : null,
    close,
    trend,
    higherTimeframe: htfTrend ? { label: htfKey.label, trend: htfTrend } : null,
    ema9: lastValue(e9),
    ema20: lastValue(e20),
    rsi14: lastValue(rsiSeries),
    atr14,
    vwap,
    relativeVolume: relVol,
    levels,
    support,
    resistance,
    patterns,
    events,
    setups,
    summary: summarize(trend, htfTrend, close, vwap, lastValue(rsiSeries), relVol, support, resistance, events, setups),
    missingEvidence: missing,
  };
}

/** Looks at the last three completed candles for breaks of a known level. */
export function detectBreakoutEvents(candles: Candle[], levels: Level[], atrValue: number | null): BreakoutEvent[] {
  const events: BreakoutEvent[] = [];
  const n = candles.length;
  if (n < 4 || atrValue === null) return events;
  // Only levels formed BEFORE the recent window count, otherwise a candle could "break" a level it created.
  const windowStart = candles[n - 3]!.t;
  const prior = levels.filter((l) => l.lastTouchTime < windowStart && l.touches >= 2);
  for (const level of prior) {
    for (let i = n - 3; i < n; i++) {
      const c = candles[i]!;
      const p = candles[i - 1]!;
      if (p.c <= level.price && c.c > level.price + atrValue * 0.1) {
        events.push({ kind: 'breakout', level: level.price, time: c.t, explanation: `Closed above $${level.price.toFixed(2)}, a level touched ${level.touches} times.` });
      } else if (c.h > level.price && c.c < level.price && p.c <= level.price) {
        events.push({ kind: 'failed_breakout', level: level.price, time: c.t, explanation: `Traded above $${level.price.toFixed(2)} but closed back below it. Buyers could not hold the break.` });
      } else if (p.c > level.price && c.c < level.price - atrValue * 0.1) {
        const brokeEarlier = events.some((e) => e.kind === 'breakout' && e.level === level.price);
        events.push({
          kind: brokeEarlier ? 'failed_breakout' : 'breakdown',
          level: level.price,
          time: c.t,
          explanation: brokeEarlier
            ? `Broke above $${level.price.toFixed(2)} then closed back below it — a failed breakout.`
            : `Closed below $${level.price.toFixed(2)}, which had been acting as support.`,
        });
      }
    }
  }
  return events;
}

interface SetupContext {
  candles: Candle[];
  ema9: (number | null)[];
  ema20: (number | null)[];
  rsi: (number | null)[];
  atr: number | null;
  relVol: number | null;
  levels: Level[];
  support: Level | null;
  trend: string;
  htfTrend: string;
  patterns: CandlePattern[];
  events: BreakoutEvent[];
}

/**
 * Long-only setups. Short selling is excluded on purpose: it needs a margin
 * account and its losses are not capped by the amount invested.
 */
export function detectSetups(ctx: SetupContext): Setup[] {
  const setups: Setup[] = [];
  const n = ctx.candles.length;
  const last = ctx.candles[n - 1]!;
  const a = ctx.atr!;
  const e9 = ctx.ema9[n - 1];
  const e20 = ctx.ema20[n - 1];
  const r = ctx.rsi[n - 1];
  const prevR = ctx.rsi[n - 2];
  if (e9 == null || e20 == null || r == null) return setups;

  const lastPatterns = ctx.patterns.filter((p) => p.time === last.t);
  const bullishPattern = lastPatterns.find((p) => p.bias === 'bullish');
  const recentFailed = ctx.events.find((e) => e.kind === 'failed_breakout');
  const commonAgainst: string[] = [];
  if (ctx.htfTrend === 'downtrend') commonAgainst.push('The bigger-picture (higher timeframe) trend is down.');
  if (recentFailed) commonAgainst.push(`Recent failed breakout near $${recentFailed.level.toFixed(2)}.`);
  if (r > 70) commonAgainst.push(`RSI is ${r.toFixed(0)}, which is stretched; buyers may be exhausted.`);
  if (ctx.relVol !== null && ctx.relVol < 0.7) commonAgainst.push(`Volume is light (${ctx.relVol.toFixed(2)}x average): fewer participants backing the move.`);

  // 1) Pullback to the 9/20 EMA inside an uptrend.
  const touchedEma = last.l <= e9 * 1.002 && last.c >= e20;
  if (ctx.trend === 'uptrend' && touchedEma && (last.c > last.o || bullishPattern)) {
    const trigger = last.h;
    const stop = Math.min(last.l, e20) - a * 0.1;
    setups.push({
      type: 'PULLBACK_EMA',
      label: 'Pullback to the 9/20 EMA in an uptrend',
      signalTime: last.t,
      trigger,
      entryLow: trigger,
      entryHigh: trigger + a * 0.1,
      stop,
      invalidationPrice: e20,
      invalidation: `A candle closing below the 20 EMA (about $${e20.toFixed(2)}) means the pullback has turned into something weaker.`,
      confirmation: [
        `Price trades above the signal candle's high of $${trigger.toFixed(2)}.`,
        'Ideally the breaking candle has at least average volume.',
      ],
      reasonsFor: [
        'Price is in an uptrend and dipped to the moving averages, where buyers have been stepping in.',
        bullishPattern ? `${bullishPattern.name} on the signal candle.` : 'The signal candle closed green (above its open).',
      ],
      reasonsAgainst: [...commonAgainst],
    });
  }

  // 2) Breakout above a level that was tested at least twice.
  const breakout = ctx.events.find((e) => e.kind === 'breakout' && e.time === last.t);
  if (breakout && ctx.trend !== 'downtrend' && (ctx.relVol ?? 0) >= 1.5 && r <= 75) {
    setups.push({
      type: 'BREAKOUT',
      label: 'Breakout above resistance on strong volume',
      signalTime: last.t,
      trigger: last.c,
      entryLow: breakout.level,
      entryHigh: last.c,
      stop: breakout.level - a * 0.5,
      invalidationPrice: breakout.level,
      invalidation: `A candle closing back below $${breakout.level.toFixed(2)} would make this a failed breakout.`,
      confirmation: [
        `The next candle holds above $${breakout.level.toFixed(2)} (the old resistance should now act as support).`,
        'Avoid chasing if price runs far above the entry zone before you can enter.',
      ],
      reasonsFor: [breakout.explanation, `Volume is ${ctx.relVol!.toFixed(2)}x the 20-candle average, showing participation.`],
      reasonsAgainst: [...commonAgainst],
    });
  }

  // 3) Bounce at support with a bullish reversal candle.
  const sup = ctx.support;
  if (sup && sup.touches >= 2 && Math.abs(last.l - sup.price) <= a * 0.5 && bullishPattern && r >= 25 && r <= 50 && prevR != null && r > prevR) {
    const trigger = last.h;
    const stop = Math.min(last.l, sup.price) - a * 0.1;
    setups.push({
      type: 'SUPPORT_REVERSAL',
      label: 'Reversal candle at support',
      signalTime: last.t,
      trigger,
      entryLow: trigger,
      entryHigh: trigger + a * 0.1,
      stop,
      invalidationPrice: sup.price,
      invalidation: `A candle closing below support at $${sup.price.toFixed(2)} means support has failed.`,
      confirmation: [`Price trades above the reversal candle's high of $${trigger.toFixed(2)}.`, 'RSI keeps rising.'],
      reasonsFor: [
        `Price reached support at $${sup.price.toFixed(2)} (touched ${sup.touches} times).`,
        `${bullishPattern.name} formed there.`,
        `RSI turned up from ${prevR.toFixed(0)} to ${r.toFixed(0)}.`,
      ],
      reasonsAgainst: [
        ...commonAgainst,
        ...(ctx.trend === 'downtrend' ? ['This is a counter-trend trade: the main trend is still down, and reversals in downtrends fail often.'] : []),
      ],
    });
  }

  return setups;
}

function summarize(
  trend: TrendReading,
  htf: TrendReading | null,
  close: number | null,
  vwap: number | null,
  r: number | null,
  relVol: number | null,
  support: Level | null,
  resistance: Level | null,
  events: BreakoutEvent[],
  setups: Setup[],
): string[] {
  const out: string[] = [];
  out.push(`Trend: ${trend.trend}. ${trend.explanation}`);
  if (htf) out.push(`Bigger picture: ${htf.trend}.`);
  if (close !== null && vwap !== null) out.push(`Price is ${close >= vwap ? 'above' : 'below'} today's VWAP ($${vwap.toFixed(2)}) — ${close >= vwap ? 'buyers' : 'sellers'} have had the upper hand on average today.`);
  if (r !== null) out.push(`RSI ${r.toFixed(0)}: ${r > 70 ? 'stretched to the upside' : r < 30 ? 'stretched to the downside' : 'not stretched'}.`);
  if (relVol !== null) out.push(`Last candle's volume was ${relVol.toFixed(2)}x its 20-candle average.`);
  if (support) out.push(`Nearest support ≈ $${support.price.toFixed(2)} (${support.touches} touches).`);
  if (resistance) out.push(`Nearest resistance ≈ $${resistance.price.toFixed(2)} (${resistance.touches} touches).`);
  for (const e of events) out.push(e.explanation);
  out.push(setups.length ? `${setups.length} potential setup(s) found. None is a guarantee.` : 'No setup matches the rules right now. Waiting is a valid decision.');
  return out;
}
