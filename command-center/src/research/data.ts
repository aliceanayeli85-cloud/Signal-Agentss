import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeCandles, nyParts } from '../engine/time.js';
import type { Candle } from '../engine/types.js';

/** Raw prices are cached locally and git-ignored (Alpaca's terms restrict redistribution). Only fingerprints are committed. */
export const DATA_DIR = resolve(process.cwd(), 'research/data');

export function dataPath(dataset: string, file: string): string {
  return join(DATA_DIR, dataset, `${file}.json`);
}

export function saveSeries(dataset: string, file: string, candles: Candle[]): string {
  const p = dataPath(dataset, file);
  mkdirSync(dirname(p), { recursive: true });
  const json = JSON.stringify(candles);
  writeFileSync(p, json);
  return sha256(json);
}

/**
 * Corporate actions the data vendor does not adjust for. Alpaca's split and
 * dividend adjustments both miss spin-offs, which then look like crashes.
 * Found by scanning every overnight gap > 8% (all others were real events).
 */
export const CORPORATE_ACTIONS = [
  { symbol: 'XLF', date: '2016-09-19', what: 'Real-estate holdings spun off into XLRE; holders received XLRE shares, so the −18% open was not a loss.' },
];

/** Version 1 results were produced before corrections existed; v1.1 applies them. */
let applyCorrections = false;
export function setCorporateActionCorrections(on: boolean) {
  applyCorrections = on;
}

export function loadSeries(dataset: string, file: string): Candle[] {
  const p = dataPath(dataset, file);
  if (!existsSync(p)) throw new Error(`Missing ${p}. Run: npm run research -- fetch`);
  const candles = JSON.parse(readFileSync(p, 'utf8')) as Candle[];
  return applyCorrections && dataset.startsWith('sip-daily') ? adjustCorporateActions(file, candles) : candles;
}

/**
 * Back-adjusts prices before each action by (open on the action day ÷ previous close),
 * i.e. assumes no genuine market move overnight. An approximation, documented as such.
 */
export function adjustCorporateActions(symbol: string, candles: Candle[]): Candle[] {
  let out = candles;
  for (const a of CORPORATE_ACTIONS.filter((x) => x.symbol === symbol)) {
    const i = out.findIndex((c) => day(c.t) === a.date);
    if (i <= 0) continue;
    const f = out[i]!.o / out[i - 1]!.c;
    out = out.map((c, k) => (k < i ? { ...c, o: c.o * f, h: c.h * f, l: c.l * f, c: c.c * f, v: c.v / f } : c));
  }
  return out;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface DataCheck {
  bars: number;
  first: string | null;
  last: string | null;
  duplicatesRemoved: number;
  invalidOhlc: number;
  /** Calendar gaps longer than 5 days between consecutive daily bars (holidays are at most 4). */
  longGaps: { from: string; to: string; days: number }[];
}

/**
 * Sanity checks run on every research series. Problems are reported, and a
 * series with an internal gap is cut to the data after the last gap, so
 * indicators never bridge missing months.
 */
export function cleanDaily(raw: Candle[]): { candles: Candle[]; check: DataCheck } {
  const normalized = normalizeCandles(raw);
  const invalidOhlc = normalized.filter((c) => c.h < Math.max(c.o, c.c) - 1e-9 || c.l > Math.min(c.o, c.c) + 1e-9).length;
  const gaps: DataCheck['longGaps'] = [];
  let cut = 0;
  for (let i = 1; i < normalized.length; i++) {
    const days = (normalized[i]!.t - normalized[i - 1]!.t) / 86_400_000;
    if (days > 5) {
      gaps.push({ from: day(normalized[i - 1]!.t), to: day(normalized[i]!.t), days: Math.round(days) });
      cut = i;
    }
  }
  const candles = normalized.slice(cut);
  return {
    candles,
    check: {
      bars: candles.length,
      first: candles[0] ? day(candles[0].t) : null,
      last: candles.length ? day(candles[candles.length - 1]!.t) : null,
      duplicatesRemoved: raw.length - normalized.length,
      invalidOhlc,
      longGaps: gaps,
    },
  };
}

export const day = (t: number) => nyParts(t).dateKey;
