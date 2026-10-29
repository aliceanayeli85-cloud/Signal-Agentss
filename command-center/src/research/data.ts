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

export function loadSeries(dataset: string, file: string): Candle[] {
  const p = dataPath(dataset, file);
  if (!existsSync(p)) throw new Error(`Missing ${p}. Run: npm run research -- fetch`);
  return JSON.parse(readFileSync(p, 'utf8')) as Candle[];
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
