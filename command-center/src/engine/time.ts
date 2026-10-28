import { TIMEFRAME_MS, type Candle, type MarkedCandle, type Timeframe } from './types.js';

/**
 * US stock sessions run on New York time. Everything session-related (VWAP
 * resets, regular-hours filtering, "is today's candle finished") is computed
 * in America/New_York so daylight-saving changes are handled by the platform.
 */
const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});

export interface NyParts {
  /** YYYY-MM-DD in New York. */
  dateKey: string;
  /** Minutes since New York midnight. */
  minutes: number;
  weekday: string;
}

export function nyParts(ms: number): NyParts {
  const parts: Record<string, string> = {};
  for (const p of NY.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday ?? '',
  };
}

export const SESSION_OPEN_MIN = 9 * 60 + 30;
export const SESSION_CLOSE_MIN = 16 * 60;
/** Late prints can adjust the daily bar briefly after the bell, so wait a little. */
const DAILY_FINAL_MIN = SESSION_CLOSE_MIN + 15;

export function isCandleComplete(candle: Candle, timeframe: Timeframe, now: number): boolean {
  if (timeframe !== '1Day') return now >= candle.t + TIMEFRAME_MS[timeframe];
  const bar = nyParts(candle.t);
  const current = nyParts(now);
  if (current.dateKey > bar.dateKey) return true;
  return current.dateKey === bar.dateKey && current.minutes >= DAILY_FINAL_MIN;
}

export function markCompleteness(candles: Candle[], timeframe: Timeframe, now: number): MarkedCandle[] {
  return candles.map((c) => ({ ...c, complete: isCandleComplete(c, timeframe, now) }));
}

/**
 * Keeps regular-session bars only. Extended-hours bars are thin, so EMAs and
 * VWAP computed on them mislead. Hourly bars are aligned on the clock hour, so
 * the 9:00 bar (which contains the 9:30 open) is kept.
 */
export function filterRegularSession<T extends Candle>(candles: T[], timeframe: Timeframe): T[] {
  if (timeframe === '1Day') return candles;
  return candles.filter((c) => {
    const { minutes } = nyParts(c.t);
    if (timeframe === '1Hour') return minutes >= 9 * 60 && minutes < SESSION_CLOSE_MIN;
    return minutes >= SESSION_OPEN_MIN && minutes < SESSION_CLOSE_MIN;
  });
}

/** Sorts by time and drops duplicate timestamps (keeping the last copy received). */
export function normalizeCandles<T extends Candle>(candles: T[]): T[] {
  const byTime = new Map<number, T>();
  for (const c of candles) {
    if (![c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)) continue;
    if (c.h < c.l || c.o <= 0 || c.c <= 0) continue;
    byTime.set(c.t, c);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Monday's date key for the New York week containing `ms`. */
export function nyWeekKey(ms: number): string {
  const { dateKey } = nyParts(ms);
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

/**
 * Builds higher-timeframe candles from lower ones. The last group is dropped
 * because, without a trading calendar, we cannot know it has finished — using
 * it would let a half-built weekly candle drive decisions.
 */
export function aggregateCompleted(candles: Candle[], keyOf: (t: number) => string): Candle[] {
  const groups: Candle[] = [];
  let currentKey: string | null = null;
  for (const c of candles) {
    const key = keyOf(c.t);
    const last = groups[groups.length - 1];
    if (key !== currentKey || !last) {
      groups.push({ ...c });
      currentKey = key;
    } else {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    }
  }
  return groups.slice(0, -1);
}

export function higherTimeframeKey(timeframe: Timeframe): { label: string; keyOf: (t: number) => string } {
  switch (timeframe) {
    case '1Day':
      return { label: 'weekly', keyOf: nyWeekKey };
    case '1Hour':
      return { label: 'daily', keyOf: (t) => nyParts(t).dateKey };
    case '15Min':
    case '5Min':
      return {
        label: 'hourly',
        keyOf: (t) => {
          const p = nyParts(t);
          return `${p.dateKey}:${Math.floor(p.minutes / 60)}`;
        },
      };
  }
}
