import type { Candle, DataResult, MarketSnapshot, Timeframe } from '../../shared/types.js';
import { TtlCache } from '../lib/cache.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import { numberOrNull, ok, stringOrNull, unavailable, type DataProvider, type ScannerTab } from './types.js';

const BASE = 'https://api.exchange.coinbase.com';
const SOURCE = 'Coinbase Exchange';

/**
 * Coinbase's public market-data endpoints support a fixed set of granularities
 * in seconds. 4h is not one of them, so it is aggregated locally from 1h bars
 * rather than requested.
 */
const GRANULARITY: Partial<Record<Timeframe, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86_400,
};

/** Majors the crypto tab offers by default. Any valid Coinbase product id also works. */
const DEFAULT_PRODUCTS = [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'XRP-USD',
  'DOGE-USD',
  'ADA-USD',
  'AVAX-USD',
  'LINK-USD',
  'LTC-USD',
  'DOT-USD',
  'SHIB-USD',
  'PEPE-USD',
];

interface CoinbaseStats {
  open?: unknown;
  high?: unknown;
  low?: unknown;
  last?: unknown;
  volume?: unknown;
}

const cache = new TtlCache<unknown>();
const candleCache = new TtlCache<unknown>(30_000, 200);

/**
 * Coinbase Exchange adapter - the centralised-crypto source.
 *
 * Public, keyless and documented. Note that Coinbase reports volume in units of
 * the base asset, and reports no liquidity or transaction counts - those fields
 * stay null so the risk engine excludes them rather than scoring a guess.
 */
export class CoinbaseProvider implements DataProvider {
  readonly id = 'coinbase';
  readonly displayName = SOURCE;
  readonly assetClasses = ['crypto' as const];
  readonly docsUrl = 'https://docs.cdp.coinbase.com/exchange/reference';

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string {
    return '';
  }

  supportedTimeframes(): Timeframe[] {
    return ['1m', '5m', '15m', '1h', '4h', '1d'];
  }

  async search(query: string): Promise<DataResult<MarketSnapshot[]>> {
    const needle = query.trim().toUpperCase();
    if (!needle) return unavailable('Empty search query.', SOURCE);
    try {
      const products = await this.products();
      const matches = products
        .filter((id) => id.includes(needle))
        .slice(0, 12);
      if (matches.length === 0) {
        return unavailable(`Coinbase has no product matching "${query}".`, SOURCE);
      }
      const snapshots = await this.snapshotsFor(matches);
      return ok(snapshots, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async listing(tab: ScannerTab): Promise<DataResult<MarketSnapshot[]>> {
    try {
      const snapshots = await this.snapshotsFor(DEFAULT_PRODUCTS);
      if (snapshots.length === 0) {
        return unavailable('Coinbase returned no usable statistics for the default product list.', SOURCE);
      }
      if (tab === 'top-momentum') {
        return ok(
          [...snapshots].sort((a, b) => (b.priceChangePct.h24 ?? 0) - (a.priceChangePct.h24 ?? 0)),
          SOURCE,
        );
      }
      if (tab === 'unusual-volume') {
        return unavailable(
          'Coinbase publishes 24h and 30d volume but no shorter window, so a relative-volume ranking cannot be computed from it.',
          SOURCE,
        );
      }
      return ok(snapshots, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async snapshot(assetId: string): Promise<DataResult<MarketSnapshot>> {
    const product = parseAssetId(assetId);
    if (!product) return unavailable(`"${assetId}" is not a Coinbase asset id.`, SOURCE);
    try {
      const snapshot = await this.snapshotFor(product);
      if (!snapshot) return unavailable(`Coinbase returned no statistics for ${product}.`, SOURCE);
      return ok(snapshot, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async candles(
    assetId: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<DataResult<Candle[]>> {
    const product = parseAssetId(assetId);
    if (!product) return unavailable(`"${assetId}" is not a Coinbase asset id.`, SOURCE);

    // 4h is built from 1h bars because Coinbase does not offer that granularity.
    const sourceTimeframe: Timeframe = timeframe === '4h' ? '1h' : timeframe;
    const granularity = GRANULARITY[sourceTimeframe];
    if (!granularity) {
      return unavailable(`Coinbase does not offer a ${timeframe} granularity.`, SOURCE);
    }

    const needed = timeframe === '4h' ? Math.min(limit * 4, 300) : Math.min(limit, 300);
    const end = Math.floor(Date.now() / 1000);
    const start = end - needed * granularity;
    const url = `${BASE}/products/${encodeURIComponent(product)}/candles?granularity=${granularity}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;

    try {
      const cached = candleCache.get(url);
      const body = cached
        ? (cached.value as unknown[])
        : await fetchJson<unknown[]>(url, { source: SOURCE, retries: 1 });
      if (!cached) candleCache.set(url, body);

      if (!Array.isArray(body) || body.length === 0) {
        return unavailable(`Coinbase returned no ${timeframe} candles for ${product}.`, SOURCE);
      }
      const parsed = parseCoinbaseCandles(body);
      if (parsed.length === 0) {
        return unavailable('Coinbase returned candle rows that could not be parsed.', SOURCE);
      }
      const candles = timeframe === '4h' ? aggregate(parsed, 4) : parsed;
      return ok(candles.slice(-limit), SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  private async products(): Promise<string[]> {
    const cached = cache.get('coinbase:products');
    if (cached) return cached.value as string[];
    const body = await fetchJson<unknown[]>(`${BASE}/products`, { source: SOURCE, retries: 1 });
    const ids = Array.isArray(body)
      ? body
          .map((entry) =>
            typeof entry === 'object' && entry !== null
              ? stringOrNull((entry as { id?: unknown }).id)
              : null,
          )
          .filter((id): id is string => id !== null)
      : [];
    cache.set('coinbase:products', ids);
    return ids;
  }

  private async snapshotsFor(products: string[]): Promise<MarketSnapshot[]> {
    const results = await Promise.all(
      products.map(async (product) => {
        try {
          return await this.snapshotFor(product);
        } catch {
          return null;
        }
      }),
    );
    return results.filter((s): s is MarketSnapshot => s !== null);
  }

  private async snapshotFor(product: string): Promise<MarketSnapshot | null> {
    const url = `${BASE}/products/${encodeURIComponent(product)}/stats`;
    const cached = cache.get(url);
    const stats = cached
      ? (cached.value as CoinbaseStats)
      : await fetchJson<CoinbaseStats>(url, { source: SOURCE, retries: 1 });
    if (!cached) cache.set(url, stats);

    const last = numberOrNull(stats.last);
    const open = numberOrNull(stats.open);
    if (last === null || last <= 0) return null;

    const priceChangePct: MarketSnapshot['priceChangePct'] = {};
    if (open !== null && open > 0) {
      priceChangePct.h24 = ((last - open) / open) * 100;
    }

    const baseVolume = numberOrNull(stats.volume);
    const volume: MarketSnapshot['volume'] = {};
    // Coinbase quotes volume in base units; convert to USD with the last price so
    // it is comparable to the on-chain figures elsewhere in the app.
    if (baseVolume !== null) volume.h24 = baseVolume * last;

    const [base, quote] = product.split('-');

    return {
      id: `coinbase:${product}`,
      provider: 'coinbase',
      assetClass: 'crypto',
      symbol: base ?? product,
      name: product,
      chain: null,
      pairAddress: null,
      baseTokenAddress: null,
      quoteSymbol: quote ?? null,
      dex: null,
      url: `https://exchange.coinbase.com/trade/${product}`,
      priceUsd: last,
      // A central limit order book has no "pool liquidity"; leaving this null keeps
      // the risk engine from scoring a number that does not exist here.
      liquidityUsd: null,
      marketCapUsd: null,
      fdvUsd: null,
      volume,
      priceChangePct,
      txns: {},
      pairCreatedAt: null,
      fetchedAt: Date.now(),
    };
  }
}

/** Coinbase rows are `[time, low, high, open, close, volume]` - not the usual order. */
export function parseCoinbaseCandles(rows: unknown[]): Candle[] {
  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const time = numberOrNull(row[0]);
    const low = numberOrNull(row[1]);
    const high = numberOrNull(row[2]);
    const open = numberOrNull(row[3]);
    const close = numberOrNull(row[4]);
    const volume = numberOrNull(row[5]);
    if (time === null || low === null || high === null || open === null || close === null) continue;
    if (open <= 0 || close <= 0 || high < low) continue;
    candles.push({ time: Math.trunc(time), open, high, low, close, volume });
  }
  return candles.sort((a, b) => a.time - b.time);
}

/** Folds `factor` consecutive bars into one. Partial trailing groups are dropped. */
export function aggregate(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    const volumes = group.map((c) => c.volume).filter((v): v is number => v !== null);
    out.push({
      time: first.time,
      open: first.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: last.close,
      volume: volumes.length === group.length ? volumes.reduce((a, b) => a + b, 0) : null,
    });
  }
  return out;
}

function parseAssetId(assetId: string): string | null {
  if (!assetId.startsWith('coinbase:')) return null;
  const product = assetId.slice('coinbase:'.length);
  return /^[A-Z0-9]+-[A-Z0-9]+$/.test(product) ? product : null;
}

function toUnavailable<T>(error: unknown): DataResult<T> {
  if (error instanceof UpstreamError) return unavailable(error.message, SOURCE);
  return unavailable(
    `${SOURCE} request failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    SOURCE,
  );
}
