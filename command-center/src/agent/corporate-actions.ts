import { nyParts } from '../engine/time.js';
import type { Candle } from '../engine/types.js';

/**
 * Corporate actions the data vendor does not adjust for (spin-offs look like
 * crashes). Found by scanning every overnight gap > 15% in the universe and
 * checking each against news; real earnings moves are left alone.
 * Used for both model training and live scanning.
 */
export const AGENT_CORPORATE_ACTIONS: { symbol: string; date: string; kind: 'spin-off' | 'history-start'; note: string }[] = [
  { symbol: 'XLF', date: '2016-09-19', kind: 'spin-off', note: 'Real-estate holdings spun off into XLRE.' },
  { symbol: 'DOW', date: '2019-04-02', kind: 'history-start', note: 'Regular-way trading began; earlier when-issued prints dropped.' },
  { symbol: 'RTX', date: '2020-04-03', kind: 'spin-off', note: 'Raytheon merger with Carrier and Otis spin-offs.' },
  { symbol: 'T', date: '2022-04-11', kind: 'spin-off', note: 'WarnerMedia spin-off.' },
  { symbol: 'GE', date: '2023-01-04', kind: 'spin-off', note: 'GE HealthCare spin-off.' },
  { symbol: 'GE', date: '2024-04-02', kind: 'spin-off', note: 'GE Vernova spin-off.' },
  { symbol: 'HON', date: '2026-06-29', kind: 'spin-off', note: 'Aerospace spin-off and reverse split (confirmed by news).' },
];

/** Back-adjusts prices before each spin-off by (open ÷ previous close); drops candles before a history start. */
export function applyCorporateActions(symbol: string, candles: Candle[]): Candle[] {
  let out = candles;
  for (const a of AGENT_CORPORATE_ACTIONS.filter((x) => x.symbol === symbol)) {
    const i = out.findIndex((c) => nyParts(c.t).dateKey === a.date);
    if (i <= 0) continue;
    if (a.kind === 'history-start') {
      out = out.slice(i);
      continue;
    }
    const f = out[i]!.o / out[i - 1]!.c;
    out = out.map((c, k) => (k < i ? { ...c, o: c.o * f, h: c.h * f, l: c.l * f, c: c.c * f, v: c.v / f, ...(c.vw ? { vw: c.vw * f } : {}) } : c));
  }
  return out;
}
