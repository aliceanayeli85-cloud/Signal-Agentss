import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aggregate, parseCoinbaseCandles } from '../src/server/providers/coinbase.js';
import { normaliseNetwork, parseOhlcv } from '../src/server/providers/geckoterminal.js';
import { intOrNull, numberOrNull, ok, stringOrNull, unavailable } from '../src/server/providers/types.js';
import { fetchJson } from '../src/server/lib/http.js';
import { UpstreamError } from '../src/server/lib/errors.js';
import { TtlCache } from '../src/server/lib/cache.js';
import { candle } from './helpers.js';

describe('provider value coercion', () => {
  it('never turns a missing value into zero', () => {
    expect(numberOrNull(undefined)).toBeNull();
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull('')).toBeNull();
    expect(numberOrNull('not a number')).toBeNull();
    expect(numberOrNull(Number.NaN)).toBeNull();
    expect(numberOrNull('12.5')).toBe(12.5);
    expect(numberOrNull(0)).toBe(0);
  });

  it('coerces strings and integers predictably', () => {
    expect(stringOrNull('  ')).toBeNull();
    expect(stringOrNull(42)).toBeNull();
    expect(stringOrNull(' solana ')).toBe('solana');
    expect(intOrNull('7.9')).toBe(7);
    expect(intOrNull(undefined)).toBeNull();
  });

  it('wraps results with an explicit status', () => {
    expect(ok([1], 'src').status).toBe('ok');
    const missing = unavailable('nope', 'src');
    expect(missing.status).toBe('unavailable');
    if (missing.status === 'unavailable') expect(missing.reason).toBe('nope');
  });
});

describe('GeckoTerminal OHLCV parsing', () => {
  it('parses well-formed rows and sorts them oldest first', () => {
    const candles = parseOhlcv([
      [200, 2, 3, 1, 2.5, 100],
      [100, 1, 2, 0.5, 1.5, 50],
    ]);
    expect(candles).toHaveLength(2);
    expect(candles[0]?.time).toBe(100);
    expect(candles[1]?.time).toBe(200);
  });

  it('drops malformed rows instead of substituting values', () => {
    const candles = parseOhlcv([
      [100, 1, 2, 0.5, 1.5, 50],
      'not a row',
      [200],
      [300, null, 2, 1, 1.5, 10],
      [400, 1, 0.5, 2, 1.5, 10], // high below low
      [500, 0, 1, 1, 1, 10], // non-positive open
      null,
      {},
    ]);
    expect(candles).toHaveLength(1);
    expect(candles[0]?.time).toBe(100);
  });

  it('keeps a null volume rather than defaulting it to zero', () => {
    const candles = parseOhlcv([[100, 1, 2, 0.5, 1.5]]);
    expect(candles[0]?.volume).toBeNull();
  });

  it('returns an empty array for an empty input', () => {
    expect(parseOhlcv([])).toEqual([]);
  });

  it('maps chain slugs that differ between providers', () => {
    expect(normaliseNetwork('ethereum')).toBe('eth');
    expect(normaliseNetwork('Solana')).toBe('solana');
    expect(normaliseNetwork('polygon')).toBe('polygon_pos');
  });
});

describe('Coinbase candle parsing', () => {
  it('reads the low/high/open/close column order Coinbase actually uses', () => {
    // [time, low, high, open, close, volume]
    const candles = parseCoinbaseCandles([[100, 90, 110, 95, 105, 12]]);
    expect(candles[0]).toEqual({ time: 100, open: 95, high: 110, low: 90, close: 105, volume: 12 });
  });

  it('drops short and malformed rows', () => {
    expect(parseCoinbaseCandles([[100, 90, 110], 'x', null])).toHaveLength(0);
  });

  it('aggregates 1h bars into 4h bars, dropping a partial trailing group', () => {
    const hourly = [
      candle(0, 10, 12, 9, 11, 1),
      candle(3600, 11, 15, 10, 14, 2),
      candle(7200, 14, 16, 13, 13, 3),
      candle(10800, 13, 14, 8, 9, 4),
      candle(14400, 9, 10, 8, 9, 5), // partial group - must be dropped
    ];
    const fourHour = aggregate(hourly, 4);
    expect(fourHour).toHaveLength(1);
    expect(fourHour[0]).toEqual({ time: 0, open: 10, high: 16, low: 8, close: 9, volume: 10 });
  });

  it('reports a null aggregated volume when any constituent bar lacked volume', () => {
    const hourly = [
      candle(0, 10, 12, 9, 11, 1),
      candle(3600, 11, 15, 10, 14, null),
      candle(7200, 14, 16, 13, 13, 3),
      candle(10800, 13, 14, 8, 9, 4),
    ];
    expect(aggregate(hourly, 4)[0]?.volume).toBeNull();
  });
});

describe('fetchJson failure handling', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws UpstreamError on a 429, naming the source', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    ) as unknown as typeof fetch;

    await expect(fetchJson('https://example.test/x', { source: 'TestSource', retries: 0 })).rejects.toThrow(
      /TestSource rate limit reached/i,
    );
  });

  it('does not retry a 4xx, because the request itself was wrong', async () => {
    const spy = vi.fn(async () => new Response('bad', { status: 400 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(fetchJson('https://example.test/x', { source: 'TestSource', retries: 3 })).rejects.toThrow(
      UpstreamError,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx and succeeds when the source recovers', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('oops', { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchJson<{ ok: boolean }>('https://example.test/x', {
      source: 'TestSource',
      retries: 2,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('rejects a body that is not valid JSON rather than returning a partial object', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchJson('https://example.test/x', { source: 'TestSource', retries: 0 })).rejects.toThrow(
      /not valid JSON/i,
    );
  });

  it('rejects an empty body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('   ', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchJson('https://example.test/x', { source: 'TestSource', retries: 0 })).rejects.toThrow(
      /empty body/i,
    );
  });

  it('surfaces a network failure as UpstreamError, never as a silent default', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    await expect(fetchJson('https://example.test/x', { source: 'TestSource', retries: 0 })).rejects.toThrow(
      /could not be reached/i,
    );
  });
});

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves a value within its TTL and reports its age', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('k', 42);
    const hit = cache.get('k');
    expect(hit?.value).toBe(42);
    expect(hit?.ageMs).toBeLessThan(1000);
  });

  it('expires a value past its TTL rather than serving it as current', () => {
    const cache = new TtlCache<number>(1000);
    cache.set('k', 42);
    vi.advanceTimersByTime(1500);
    expect(cache.get('k')).toBeNull();
  });

  it('evicts the oldest entry once the cap is reached', () => {
    const cache = new TtlCache<number>(10_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('c')?.value).toBe(3);
  });
});
