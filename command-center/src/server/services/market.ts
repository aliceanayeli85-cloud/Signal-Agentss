import type { Quote } from '../../engine/plan.js';
import { filterRegularSession, markCompleteness, normalizeCandles } from '../../engine/time.js';
import type { Candle, MarkedCandle, Timeframe } from '../../engine/types.js';
import type { Db } from '../db.js';
import { DataError, type MarketClock, type MarketDataProvider } from '../providers/alpaca.js';

const BAR_TTL: Record<Timeframe, number> = { '5Min': 30_000, '15Min': 60_000, '1Hour': 120_000, '1Day': 300_000 };
const QUOTE_TTL = 10_000;
const CLOCK_TTL = 60_000;

export interface CandleSet {
  all: MarkedCandle[];
  completed: Candle[];
  forming: MarkedCandle | null;
}

/**
 * Wraps the provider with short caches and records every successful quote
 * (with the time of the trade, not just the time we fetched it) so the UI can
 * show exactly how old each price is.
 */
export class MarketService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    readonly provider: MarketDataProvider,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private cached<T>(key: string, ttl: number): T | undefined {
    const hit = this.cache.get(key);
    return hit && this.now() - hit.at < ttl ? (hit.value as T) : undefined;
  }

  private store(key: string, value: unknown) {
    this.cache.set(key, { at: this.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
  }

  async quotes(symbols: string[], { fresh = false } = {}): Promise<Map<string, Quote>> {
    const want = [...new Set(symbols.map((s) => s.toUpperCase()))];
    const out = new Map<string, Quote>();
    const missing: string[] = [];
    for (const s of want) {
      const hit = fresh ? undefined : this.cached<Quote>(`q:${s}`, QUOTE_TTL);
      if (hit) out.set(s, hit);
      else missing.push(s);
    }
    if (missing.length) {
      const got = await this.provider.quotes(missing);
      const upsert = this.db.prepare('INSERT INTO quotes (symbol, price, price_at, fetched_at, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, price_at = excluded.price_at, fetched_at = excluded.fetched_at, source = excluded.source');
      for (const [s, q] of got) {
        this.store(`q:${s}`, q);
        upsert.run(s, q.price, q.time, this.now(), q.source);
        out.set(s, q);
      }
    }
    return out;
  }

  async quote(symbol: string, opts?: { fresh?: boolean }): Promise<Quote> {
    const q = (await this.quotes([symbol], opts)).get(symbol.toUpperCase());
    if (!q) throw new DataError('NOT_FOUND', `No current price for ${symbol.toUpperCase()}. Check the ticker.`);
    return q;
  }

  async candles(symbol: string, timeframe: Timeframe, limit = 320): Promise<CandleSet> {
    const key = `b:${symbol}:${timeframe}:${limit}`;
    let raw = this.cached<Candle[]>(key, BAR_TTL[timeframe]);
    if (!raw) {
      raw = await this.provider.bars(symbol.toUpperCase(), timeframe, limit);
      this.store(key, raw);
    }
    const all = markCompleteness(filterRegularSession(normalizeCandles(raw), timeframe), timeframe, this.now()).slice(-limit);
    const last = all[all.length - 1];
    return {
      all,
      completed: all.filter((c) => c.complete).map(({ complete: _c, ...rest }) => rest),
      forming: last && !last.complete ? last : null,
    };
  }

  /** The market clock, or null when it cannot be read (callers must then not assume either state). */
  async clock(): Promise<MarketClock | null> {
    const hit = this.cached<MarketClock>('clock', CLOCK_TTL);
    if (hit) return hit;
    try {
      const c = await this.provider.clock();
      this.store('clock', c);
      return c;
    } catch {
      return null;
    }
  }
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof DataError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
}
