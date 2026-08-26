import type { Candle, DataResult, MarketSnapshot, Timeframe } from '../../shared/types.js';
import { TtlCache } from '../lib/cache.js';
import { env } from '../lib/env.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import { numberOrNull, ok, unavailable, type DataProvider, type ScannerTab } from './types.js';

const cache = new TtlCache<unknown>(60_000, 200);

/**
 * Stock data is not free the way on-chain data is. Rather than pretend otherwise,
 * both stock adapters are key-gated: with no key configured they report exactly
 * why they are unavailable, and the Day Trade tab shows DATA UNAVAILABLE instead
 * of an empty chart that looks like a loading state.
 */

const AV_INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '60min',
};

export class AlphaVantageProvider implements DataProvider {
  readonly id = 'alphavantage';
  readonly displayName = 'Alpha Vantage';
  readonly assetClasses = ['stock' as const];
  readonly docsUrl = 'https://www.alphavantage.co/documentation/';

  isConfigured(): boolean {
    return env.alphaVantageApiKey !== null;
  }

  unavailableReason(): string {
    return 'Alpha Vantage is not configured. Set ALPHA_VANTAGE_API_KEY in .env to enable stock and ETF data. Free keys are rate limited (typically 25 requests/day), which is enough for research but not for a live scanner.';
  }

  supportedTimeframes(): Timeframe[] {
    return this.isConfigured() ? ['1m', '5m', '15m', '1h', '1d'] : [];
  }

  async search(query: string): Promise<DataResult<MarketSnapshot[]>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    const symbol = query.trim().toUpperCase();
    if (!symbol) return unavailable('Empty search query.', this.displayName);
    const single = await this.snapshot(`alphavantage:${symbol}`);
    if (single.status === 'unavailable') return unavailable(single.reason, this.displayName);
    return ok([single.data], this.displayName);
  }

  async listing(_tab: ScannerTab): Promise<DataResult<MarketSnapshot[]>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    return unavailable(
      'Alpha Vantage has no bulk screener on the free tier, so the stock scanner works by symbol lookup rather than a market-wide listing. Search for a ticker or add one to the watchlist.',
      this.displayName,
    );
  }

  async snapshot(assetId: string): Promise<DataResult<MarketSnapshot>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    const symbol = parseSymbol(assetId, 'alphavantage');
    if (!symbol) return unavailable(`"${assetId}" is not an Alpha Vantage asset id.`, this.displayName);

    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${env.alphaVantageApiKey}`;
    try {
      const body = await this.get<Record<string, unknown>>(url);
      const guard = rateLimitNote(body);
      if (guard) return unavailable(guard, this.displayName);

      const quote = body['Global Quote'] as Record<string, unknown> | undefined;
      const price = numberOrNull(quote?.['05. price']);
      if (!quote || price === null || price <= 0) {
        return unavailable(`Alpha Vantage returned no quote for ${symbol}.`, this.displayName);
      }
      const changePct = numberOrNull(String(quote['10. change percent'] ?? '').replace('%', ''));
      const volumeShares = numberOrNull(quote['06. volume']);

      return ok(
        {
          id: `alphavantage:${symbol}`,
          provider: this.id,
          assetClass: 'stock',
          symbol,
          name: symbol,
          chain: null,
          pairAddress: null,
          baseTokenAddress: null,
          quoteSymbol: 'USD',
          dex: null,
          url: `https://www.alphavantage.co/documentation/`,
          priceUsd: price,
          liquidityUsd: null,
          marketCapUsd: null,
          fdvUsd: null,
          volume: volumeShares !== null ? { h24: volumeShares * price } : {},
          priceChangePct: changePct !== null ? { h24: changePct } : {},
          txns: {},
          pairCreatedAt: null,
          fetchedAt: Date.now(),
        },
        this.displayName,
      );
    } catch (error) {
      return toUnavailable(error, this.displayName);
    }
  }

  async candles(assetId: string, timeframe: Timeframe, limit: number): Promise<DataResult<Candle[]>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    const symbol = parseSymbol(assetId, 'alphavantage');
    if (!symbol) return unavailable(`"${assetId}" is not an Alpha Vantage asset id.`, this.displayName);

    if (timeframe === '4h') {
      return unavailable(
        'Alpha Vantage does not publish a 4h series. Use 1h or 1D for stocks.',
        this.displayName,
      );
    }

    const isDaily = timeframe === '1d';
    const interval = AV_INTERVAL[timeframe];
    if (!isDaily && !interval) {
      return unavailable(`Alpha Vantage does not offer a ${timeframe} interval.`, this.displayName);
    }

    const url = isDaily
      ? `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${env.alphaVantageApiKey}`
      : `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=full&extended_hours=true&apikey=${env.alphaVantageApiKey}`;

    try {
      const body = await this.get<Record<string, unknown>>(url);
      const guard = rateLimitNote(body);
      if (guard) return unavailable(guard, this.displayName);

      const seriesKey = Object.keys(body).find((k) => k.startsWith('Time Series'));
      const series = seriesKey ? (body[seriesKey] as Record<string, Record<string, unknown>>) : null;
      if (!series) {
        return unavailable(`Alpha Vantage returned no ${timeframe} series for ${symbol}.`, this.displayName);
      }

      const candles: Candle[] = [];
      for (const [stamp, values] of Object.entries(series)) {
        // Alpha Vantage timestamps are US/Eastern wall clock; append the zone so
        // Date.parse does not silently reinterpret them as local time.
        const parsedTime = Date.parse(stamp.includes(':') ? `${stamp.replace(' ', 'T')}-05:00` : `${stamp}T00:00:00Z`);
        const open = numberOrNull(values['1. open']);
        const high = numberOrNull(values['2. high']);
        const low = numberOrNull(values['3. low']);
        const close = numberOrNull(values['4. close']);
        const volume = numberOrNull(values['5. volume']);
        if (!Number.isFinite(parsedTime) || open === null || high === null || low === null || close === null) continue;
        if (open <= 0 || close <= 0 || high < low) continue;
        candles.push({ time: Math.floor(parsedTime / 1000), open, high, low, close, volume });
      }

      if (candles.length === 0) {
        return unavailable('Alpha Vantage returned rows that could not be parsed into candles.', this.displayName);
      }
      candles.sort((a, b) => a.time - b.time);
      return ok(candles.slice(-limit), this.displayName);
    } catch (error) {
      return toUnavailable(error, this.displayName);
    }
  }

  private async get<T>(url: string): Promise<T> {
    const cached = cache.get(url);
    if (cached) return cached.value as T;
    const body = await fetchJson<T>(url, { source: this.displayName, retries: 1 });
    cache.set(url, body);
    return body;
  }
}

const POLYGON_TIMESPAN: Record<Timeframe, { multiplier: number; timespan: string }> = {
  '1m': { multiplier: 1, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '1d': { multiplier: 1, timespan: 'day' },
};

export class PolygonProvider implements DataProvider {
  readonly id = 'polygon';
  readonly displayName = 'Polygon.io';
  readonly assetClasses = ['stock' as const];
  readonly docsUrl = 'https://polygon.io/docs/stocks';

  isConfigured(): boolean {
    return env.polygonApiKey !== null;
  }

  unavailableReason(): string {
    return 'Polygon.io is not configured. Set POLYGON_API_KEY in .env to enable stock and ETF data. The free tier is delayed and rate limited; real-time data requires a paid plan.';
  }

  supportedTimeframes(): Timeframe[] {
    return this.isConfigured() ? ['1m', '5m', '15m', '1h', '4h', '1d'] : [];
  }

  async search(query: string): Promise<DataResult<MarketSnapshot[]>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    const symbol = query.trim().toUpperCase();
    if (!symbol) return unavailable('Empty search query.', this.displayName);
    const single = await this.snapshot(`polygon:${symbol}`);
    if (single.status === 'unavailable') return unavailable(single.reason, this.displayName);
    return ok([single.data], this.displayName);
  }

  async listing(): Promise<DataResult<MarketSnapshot[]>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    return unavailable(
      'Market-wide stock screening is not implemented against Polygon in this version. Look symbols up individually or add them to the watchlist.',
      this.displayName,
    );
  }

  async snapshot(assetId: string): Promise<DataResult<MarketSnapshot>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    const symbol = parseSymbol(assetId, 'polygon');
    if (!symbol) return unavailable(`"${assetId}" is not a Polygon asset id.`, this.displayName);

    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true&apiKey=${env.polygonApiKey}`;
    try {
      const body = await fetchJson<{ results?: { c?: unknown; o?: unknown; v?: unknown }[] }>(url, {
        source: this.displayName,
        retries: 1,
      });
      const row = body.results?.[0];
      const close = numberOrNull(row?.c);
      const open = numberOrNull(row?.o);
      const volumeShares = numberOrNull(row?.v);
      if (close === null || close <= 0) {
        return unavailable(`Polygon returned no previous close for ${symbol}.`, this.displayName);
      }
      const priceChangePct: MarketSnapshot['priceChangePct'] = {};
      if (open !== null && open > 0) priceChangePct.h24 = ((close - open) / open) * 100;

      return ok(
        {
          id: `polygon:${symbol}`,
          provider: this.id,
          assetClass: 'stock',
          symbol,
          name: symbol,
          chain: null,
          pairAddress: null,
          baseTokenAddress: null,
          quoteSymbol: 'USD',
          dex: null,
          url: `https://polygon.io/quote/${symbol}`,
          priceUsd: close,
          liquidityUsd: null,
          marketCapUsd: null,
          fdvUsd: null,
          volume: volumeShares !== null ? { h24: volumeShares * close } : {},
          priceChangePct,
          txns: {},
          pairCreatedAt: null,
          fetchedAt: Date.now(),
        },
        this.displayName,
      );
    } catch (error) {
      return toUnavailable(error, this.displayName);
    }
  }

  async candles(assetId: string, timeframe: Timeframe, limit: number): Promise<DataResult<Candle[]>> {
    if (!this.isConfigured()) return unavailable(this.unavailableReason(), this.displayName);
    const symbol = parseSymbol(assetId, 'polygon');
    if (!symbol) return unavailable(`"${assetId}" is not a Polygon asset id.`, this.displayName);

    const spec = POLYGON_TIMESPAN[timeframe];
    const to = new Date();
    const from = new Date(to.getTime() - lookbackMs(timeframe, limit));
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${spec.multiplier}/${spec.timespan}/${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}?adjusted=true&sort=asc&limit=50000&apiKey=${env.polygonApiKey}`;

    try {
      const body = await fetchJson<{
        results?: { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown }[];
      }>(url, { source: this.displayName, retries: 1 });
      const rows = body.results ?? [];
      const candles: Candle[] = [];
      for (const row of rows) {
        const ms = numberOrNull(row.t);
        const open = numberOrNull(row.o);
        const high = numberOrNull(row.h);
        const low = numberOrNull(row.l);
        const close = numberOrNull(row.c);
        const volume = numberOrNull(row.v);
        if (ms === null || open === null || high === null || low === null || close === null) continue;
        if (open <= 0 || close <= 0 || high < low) continue;
        candles.push({ time: Math.floor(ms / 1000), open, high, low, close, volume });
      }
      if (candles.length === 0) {
        return unavailable(`Polygon returned no ${timeframe} bars for ${symbol}.`, this.displayName);
      }
      candles.sort((a, b) => a.time - b.time);
      return ok(candles.slice(-limit), this.displayName);
    } catch (error) {
      return toUnavailable(error, this.displayName);
    }
  }
}

function lookbackMs(timeframe: Timeframe, limit: number): number {
  const minutes: Record<Timeframe, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
  };
  // Generous multiplier: markets are closed most of the week, so calendar span
  // must exceed bar count for intraday requests to return `limit` bars.
  return minutes[timeframe] * limit * 60_000 * 3;
}

function parseSymbol(assetId: string, prefix: string): string | null {
  if (!assetId.startsWith(`${prefix}:`)) return null;
  const symbol = assetId.slice(prefix.length + 1).toUpperCase();
  return /^[A-Z.\-]{1,10}$/.test(symbol) ? symbol : null;
}

/** Alpha Vantage signals throttling in the body with a 200 status. */
function rateLimitNote(body: Record<string, unknown>): string | null {
  const note = body['Note'] ?? body['Information'] ?? body['Error Message'];
  if (typeof note === 'string' && note.trim()) {
    return `Alpha Vantage responded: ${note.trim()}`;
  }
  return null;
}

function toUnavailable<T>(error: unknown, source: string): DataResult<T> {
  if (error instanceof UpstreamError) return unavailable(error.message, source);
  return unavailable(
    `${source} request failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    source,
  );
}
