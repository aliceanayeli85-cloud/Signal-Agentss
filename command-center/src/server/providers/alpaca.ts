import type { Quote } from '../../engine/plan.js';
import type { Candle, Timeframe } from '../../engine/types.js';

export type DataErrorCode = 'NOT_CONFIGURED' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'UPSTREAM' | 'NOT_FOUND' | 'MALFORMED';

export class DataError extends Error {
  constructor(readonly code: DataErrorCode, message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export interface MarketClock {
  isOpen: boolean;
  timestamp: number;
  nextOpen: number | null;
  nextClose: number | null;
}

export interface MarketDataProvider {
  readonly name: string;
  readonly docsUrl: string;
  isConfigured(): boolean;
  notes(): string[];
  quotes(symbols: string[]): Promise<Map<string, Quote>>;
  bars(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  clock(): Promise<MarketClock>;
}

export interface AlpacaConfig {
  keyId: string | null;
  secret: string | null;
  dataUrl: string;
  clockUrl: string;
  feed: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Alpaca Market Data API v2 (https://docs.alpaca.markets/docs/about-market-data-api).
 * A free account gives real-time IEX data and historical bars. Only read-only
 * data and clock endpoints are called; this class has no order methods.
 */
export class AlpacaProvider implements MarketDataProvider {
  readonly name = 'Alpaca Market Data';
  readonly docsUrl = 'https://docs.alpaca.markets/docs/about-market-data-api';

  constructor(private readonly cfg: AlpacaConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.keyId && this.cfg.secret);
  }

  notes(): string[] {
    const n = [`Feed: ${this.cfg.feed.toUpperCase()}.`];
    if (this.cfg.feed === 'iex') {
      n.push('The free IEX feed is real-time but covers only trades on the IEX exchange (a small share of all US volume). Volume and VWAP are therefore IEX-only approximations; compare volume to its own average, not to numbers you see elsewhere.');
    }
    return n;
  }

  async quotes(symbols: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (!symbols.length) return out;
    const url = `${this.cfg.dataUrl}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=${this.cfg.feed}`;
    const body = await this.get(url);
    if (!body || typeof body !== 'object') throw new DataError('MALFORMED', 'Alpaca returned an unexpected snapshot response.');
    for (const sym of symbols) {
      const snap = (body as Record<string, unknown>)[sym] as { latestTrade?: { p?: unknown; t?: unknown } } | null | undefined;
      const p = Number(snap?.latestTrade?.p);
      const t = Date.parse(String(snap?.latestTrade?.t ?? ''));
      if (Number.isFinite(p) && p > 0 && Number.isFinite(t)) out.set(sym, { price: p, time: t, source: `${this.name} (${this.cfg.feed.toUpperCase()} last trade)` });
    }
    return out;
  }

  async bars(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    // Intraday responses include extended hours, which are filtered later, so ask for more.
    const raw = Math.min(10_000, timeframe === '1Day' ? limit : limit * 3);
    const perDay: Record<Timeframe, number> = { '1Day': 1, '1Hour': 16, '15Min': 64, '5Min': 192 };
    const daysBack = Math.ceil((raw / perDay[timeframe]) * 1.5) + 10;
    const start = new Date(Date.now() - daysBack * 86_400_000).toISOString();
    const base = `${this.cfg.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&start=${start}&limit=${raw}&sort=desc&adjustment=split&feed=${this.cfg.feed}`;
    const candles = await this.pagedBars(base, raw, 10);
    if (!candles.length) throw new DataError('NOT_FOUND', `No ${timeframe} candles were returned for ${symbol}. Check the ticker.`);
    return candles.reverse();
  }

  /**
   * A fixed historical range, oldest first. Used by research, where the range
   * must be exact and reproducible. `end` must be in the past: the free plan
   * only allows consolidated (SIP) data older than 15 minutes.
   */
  async historicalBars(symbol: string, timeframe: Timeframe, opts: { start: string; end: string; feed: 'iex' | 'sip'; adjustment: 'split' | 'all' }): Promise<Candle[]> {
    const base = `${this.cfg.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&start=${opts.start}&end=${opts.end}&limit=10000&sort=asc&adjustment=${opts.adjustment}&feed=${opts.feed}`;
    return this.pagedBars(base, Infinity, 100);
  }

  /** Alpaca can return fewer bars than `limit` per page, with a token for the next page. */
  private async pagedBars(base: string, maxBars: number, maxPages: number): Promise<Candle[]> {
    const candles: Candle[] = [];
    let token: string | null = null;
    for (let page = 0; page < maxPages && candles.length < maxBars; page++) {
      const body = (await this.get(token ? `${base}&page_token=${encodeURIComponent(token)}` : base)) as { bars?: unknown; next_page_token?: unknown } | null;
      if (!body || (body.bars !== null && body.bars !== undefined && !Array.isArray(body.bars))) {
        throw new DataError('MALFORMED', 'Alpaca returned an unexpected bars response.');
      }
      for (const b of (body.bars ?? []) as Record<string, unknown>[]) {
        const c = { t: Date.parse(String(b.t)), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) };
        if ([c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)) candles.push(c);
      }
      token = typeof body.next_page_token === 'string' && body.next_page_token ? body.next_page_token : null;
      if (!token) break;
    }
    return candles;
  }

  async clock(): Promise<MarketClock> {
    const body = (await this.get(`${this.cfg.clockUrl}/v2/clock`)) as Record<string, unknown> | null;
    if (!body || typeof body.is_open !== 'boolean') throw new DataError('MALFORMED', 'Alpaca returned an unexpected clock response.');
    const ts = (k: string) => {
      const v = Date.parse(String(body[k] ?? ''));
      return Number.isFinite(v) ? v : null;
    };
    return { isOpen: body.is_open, timestamp: ts('timestamp') ?? Date.now(), nextOpen: ts('next_open'), nextClose: ts('next_close') };
  }

  private async get(url: string, attempt = 0): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new DataError('NOT_CONFIGURED', 'Market data is not connected. Add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (free Alpaca account) — see the README.');
    }
    const f = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(url, {
        headers: { 'APCA-API-KEY-ID': this.cfg.keyId!, 'APCA-API-SECRET-KEY': this.cfg.secret!, accept: 'application/json' },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (attempt === 0) return this.get(url, 1);
      throw new DataError(timeout ? 'TIMEOUT' : 'UPSTREAM', timeout ? 'Alpaca did not respond in time.' : `Could not reach Alpaca: ${(error as Error).message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 500));
      return this.get(url, 1);
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      throw new DataError('AUTH', `Alpaca refused the request (${res.status}). Check the API keys, or that your plan includes the "${this.cfg.feed}" feed. ${text.slice(0, 160)}`);
    }
    if (res.status === 429) throw new DataError('RATE_LIMIT', 'Alpaca rate limit reached. The app will retry on the next check.');
    if (res.status === 404 || res.status === 422) throw new DataError('NOT_FOUND', `Alpaca could not find that data (${res.status}). Check the ticker.`);
    if (!res.ok) throw new DataError('UPSTREAM', `Alpaca returned HTTP ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new DataError('MALFORMED', 'Alpaca returned a response that is not valid JSON.');
    }
  }
}
