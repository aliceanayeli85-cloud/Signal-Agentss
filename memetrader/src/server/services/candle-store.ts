import { and, asc, desc, eq } from 'drizzle-orm';
import type { Candle, Timeframe } from '../../shared/types.js';
import { TIMEFRAME_MINUTES } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { candles as candlesTable } from '../db/schema.js';
import { logger } from '../lib/logger.js';

/**
 * Local OHLCV store.
 *
 * The on-chain OHLCV provider rate-limits aggressively, so bars are persisted
 * and reused rather than refetched on every view. Two consequences worth being
 * explicit about:
 *
 *  - Stored bars are real provider data, not derived or interpolated. Nothing is
 *    written here that did not come back from a provider.
 *  - The newest bar is still forming, so re-fetching overwrites it in place. The
 *    primary key is (asset, timeframe, bar time) precisely so that an updated
 *    high/low/close replaces the earlier partial one instead of duplicating it.
 */
export function storeCandles(assetId: string, timeframe: Timeframe, bars: Candle[]): number {
  if (bars.length === 0) return 0;
  try {
    const db = getDb();
    const now = Date.now();
    const rows = bars
      .filter(
        (bar) =>
          Number.isFinite(bar.time) &&
          Number.isFinite(bar.open) &&
          Number.isFinite(bar.high) &&
          Number.isFinite(bar.low) &&
          Number.isFinite(bar.close) &&
          bar.high >= bar.low &&
          bar.open > 0 &&
          bar.close > 0,
      )
      .map((bar) => ({
        assetId,
        timeframe,
        barTime: Math.trunc(bar.time),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        updatedAt: now,
      }));
    if (rows.length === 0) return 0;

    db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(candlesTable)
          .values(row)
          .onConflictDoUpdate({
            target: [candlesTable.assetId, candlesTable.timeframe, candlesTable.barTime],
            set: {
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
              volume: row.volume,
              updatedAt: row.updatedAt,
            },
          })
          .run();
      }
    });
    return rows.length;
  } catch (error) {
    logger.warn('could not store candles', { error, assetId, timeframe });
    return 0;
  }
}

export function readCandles(assetId: string, timeframe: Timeframe, limit = 300): Candle[] {
  try {
    const rows = getDb()
      .select()
      .from(candlesTable)
      .where(and(eq(candlesTable.assetId, assetId), eq(candlesTable.timeframe, timeframe)))
      .orderBy(desc(candlesTable.barTime))
      .limit(limit)
      .all();
    return rows
      .map((row) => ({
        time: row.barTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }))
      .sort((a, b) => a.time - b.time);
  } catch (error) {
    logger.warn('could not read candles', { error, assetId, timeframe });
    return [];
  }
}

/** Unix seconds of the newest stored bar, or null when nothing is stored. */
export function newestBarTime(assetId: string, timeframe: Timeframe): number | null {
  try {
    const row = getDb()
      .select({ barTime: candlesTable.barTime })
      .from(candlesTable)
      .where(and(eq(candlesTable.assetId, assetId), eq(candlesTable.timeframe, timeframe)))
      .orderBy(desc(candlesTable.barTime))
      .limit(1)
      .get();
    return row?.barTime ?? null;
  } catch {
    return null;
  }
}

export function oldestBarTime(assetId: string, timeframe: Timeframe): number | null {
  try {
    const row = getDb()
      .select({ barTime: candlesTable.barTime })
      .from(candlesTable)
      .where(and(eq(candlesTable.assetId, assetId), eq(candlesTable.timeframe, timeframe)))
      .orderBy(asc(candlesTable.barTime))
      .limit(1)
      .get();
    return row?.barTime ?? null;
  } catch {
    return null;
  }
}

/**
 * True when the stored series is missing the bar that should exist by now.
 *
 * Refreshing more often than one bar duration cannot produce a new bar, so this
 * is what stops the background refresher from spending rate limit on nothing.
 */
export function isStale(assetId: string, timeframe: Timeframe, now = Date.now()): boolean {
  const newest = newestBarTime(assetId, timeframe);
  if (newest === null) return true;
  const barMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  return now - newest * 1000 >= barMs;
}

/** Age of the newest stored bar in ms, for the freshness indicator. */
export function storeAgeMs(assetId: string, timeframe: Timeframe, now = Date.now()): number | null {
  const newest = newestBarTime(assetId, timeframe);
  return newest === null ? null : now - newest * 1000;
}
