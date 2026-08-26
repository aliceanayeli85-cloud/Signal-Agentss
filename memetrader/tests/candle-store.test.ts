import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candle } from './helpers.js';

process.env.LOG_LEVEL = 'error';

const { closeDb, initDb } = await import('../src/server/db/index.js');
const { storeCandles, readCandles, newestBarTime, isStale, storeAgeMs } = await import(
  '../src/server/services/candle-store.js'
);

const dirs: string[] = [];
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'memetrader-candles-'));
  dirs.push(dir);
  return initDb(join(dir, 'app.db'));
}

afterEach(() => {
  closeDb();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('candle store', () => {
  it('round-trips bars in chronological order', () => {
    freshDb();
    storeCandles('a:b', '15m', [
      candle(300, 2, 3, 1, 2.5, 10),
      candle(100, 1, 2, 0.5, 1.5, 5),
      candle(200, 1.5, 2.5, 1, 2, 7),
    ]);
    const read = readCandles('a:b', '15m');
    expect(read.map((c) => c.time)).toEqual([100, 200, 300]);
    expect(newestBarTime('a:b', '15m')).toBe(300);
  });

  it('updates the still-forming newest bar in place instead of duplicating it', () => {
    freshDb();
    storeCandles('a:b', '15m', [candle(100, 1, 2, 0.5, 1.5, 5)]);
    // Same bar, later fetch: its high and close have moved on.
    storeCandles('a:b', '15m', [candle(100, 1, 9, 0.5, 8, 50)]);
    const read = readCandles('a:b', '15m');
    expect(read).toHaveLength(1);
    expect(read[0]?.high).toBe(9);
    expect(read[0]?.close).toBe(8);
    expect(read[0]?.volume).toBe(50);
  });

  it('keeps timeframes and assets separate', () => {
    freshDb();
    storeCandles('a:b', '15m', [candle(100, 1, 2, 0.5, 1.5, 5)]);
    storeCandles('a:b', '1h', [candle(100, 9, 9, 9, 9, 5)]);
    storeCandles('c:d', '15m', [candle(100, 7, 7, 7, 7, 5)]);
    expect(readCandles('a:b', '15m')[0]?.open).toBe(1);
    expect(readCandles('a:b', '1h')[0]?.open).toBe(9);
    expect(readCandles('c:d', '15m')[0]?.open).toBe(7);
  });

  it('rejects malformed bars rather than storing them', () => {
    freshDb();
    const stored = storeCandles('a:b', '15m', [
      candle(100, 1, 2, 0.5, 1.5, 5),
      candle(200, Number.NaN, 2, 1, 1.5, 5),
      candle(300, 1, 0.5, 2, 1.5, 5), // high below low
      candle(400, 0, 1, 1, 1, 5), // non-positive open
    ]);
    expect(stored).toBe(1);
    expect(readCandles('a:b', '15m')).toHaveLength(1);
  });

  it('reports an empty series as stale so the refresher fetches it', () => {
    freshDb();
    expect(newestBarTime('a:b', '15m')).toBeNull();
    expect(isStale('a:b', '15m')).toBe(true);
    expect(storeAgeMs('a:b', '15m')).toBeNull();
  });

  it('is stale only once a full bar period has passed', () => {
    freshDb();
    const now = 1_800_000_000_000;
    const barTime = Math.floor(now / 1000) - 60; // one minute ago
    storeCandles('a:b', '15m', [candle(barTime, 1, 2, 0.5, 1.5, 5)]);
    // A 15m series one minute old cannot have produced a new bar yet.
    expect(isStale('a:b', '15m', now)).toBe(false);
    expect(isStale('a:b', '1m', now)).toBe(true);
    expect(isStale('a:b', '15m', now + 20 * 60_000)).toBe(true);
  });

  it('returns the newest bars when more are stored than requested', () => {
    freshDb();
    storeCandles(
      'a:b',
      '15m',
      Array.from({ length: 50 }, (_, i) => candle(i * 900, 1, 2, 0.5, 1.5, 1)),
    );
    const read = readCandles('a:b', '15m', 10);
    expect(read).toHaveLength(10);
    expect(read[read.length - 1]?.time).toBe(49 * 900);
  });
});
