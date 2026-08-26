import type { Candle, DataResult, MarketSnapshot, Timeframe } from '../../shared/types.js';
import { TtlCache } from '../lib/cache.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchJson } from '../lib/http.js';
import {
  intOrNull,
  numberOrNull,
  ok,
  stringOrNull,
  unavailable,
  type DataProvider,
  type ScannerTab,
} from './types.js';

const BASE = 'https://api.geckoterminal.com/api/v2';
const SOURCE = 'GeckoTerminal';

/** GeckoTerminal expresses timeframes as a resolution plus an aggregate factor. */
const TIMEFRAME_MAP: Record<Timeframe, { path: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '1m': { path: 'minute', aggregate: 1 },
  '5m': { path: 'minute', aggregate: 5 },
  '15m': { path: 'minute', aggregate: 15 },
  '1h': { path: 'hour', aggregate: 1 },
  '4h': { path: 'hour', aggregate: 4 },
  '1d': { path: 'day', aggregate: 1 },
};

interface PoolAttributes {
  address?: unknown;
  name?: unknown;
  pool_created_at?: unknown;
  base_token_price_usd?: unknown;
  fdv_usd?: unknown;
  market_cap_usd?: unknown;
  reserve_in_usd?: unknown;
  volume_usd?: Record<string, unknown>;
  price_change_percentage?: Record<string, unknown>;
  transactions?: Record<string, { buys?: unknown; sells?: unknown }>;
}

interface PoolEntry {
  id?: unknown;
  attributes?: PoolAttributes;
  relationships?: {
    base_token?: { data?: { id?: unknown } };
    dex?: { data?: { id?: unknown } };
  };
}

const cache = new TtlCache<unknown>();
/** OHLCV moves slower than a quote; a separate longer TTL keeps us inside the rate limit. */
const candleCache = new TtlCache<unknown>(45_000, 200);

/**
 * GeckoTerminal adapter.
 *
 * This is the OHLCV source for on-chain pairs - the piece DexScreener does not
 * publish. It also serves the trending/new-pool listings used by the scanner.
 * The public API is documented and keyless but rate limited to roughly 30 calls a
 * minute, which is why both caches here are deliberately generous.
 */
export class GeckoTerminalProvider implements DataProvider {
  readonly id = 'geckoterminal';
  readonly displayName = SOURCE;
  readonly assetClasses = ['meme' as const];
  readonly docsUrl = 'https://www.geckoterminal.com/dex-api';

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
    const trimmed = query.trim();
    if (!trimmed) return unavailable('Empty search query.', SOURCE);
    try {
      const body = await this.get<{ data?: PoolEntry[] }>(
        `${BASE}/search/pools?query=${encodeURIComponent(trimmed)}&page=1`,
      );
      return ok(toSnapshots(body?.data), SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async listing(tab: ScannerTab): Promise<DataResult<MarketSnapshot[]>> {
    const endpoint =
      tab === 'new-pairs'
        ? `${BASE}/networks/trending_pools?page=1`
        : `${BASE}/networks/trending_pools?page=1`;
    try {
      const body = await this.get<{ data?: PoolEntry[] }>(endpoint);
      const snapshots = toSnapshots(body?.data);
      if (snapshots.length === 0) {
        return unavailable('GeckoTerminal returned no pools for this listing.', SOURCE);
      }
      return ok(snapshots, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async snapshot(assetId: string): Promise<DataResult<MarketSnapshot>> {
    const parsed = parseAssetId(assetId);
    if (!parsed) return unavailable(`"${assetId}" is not a GeckoTerminal asset id.`, SOURCE);
    try {
      const body = await this.get<{ data?: PoolEntry }>(
        `${BASE}/networks/${encodeURIComponent(parsed.network)}/pools/${encodeURIComponent(parsed.address)}`,
      );
      const snapshot = body?.data ? toSnapshot(body.data, parsed.network) : null;
      if (!snapshot) return unavailable(`GeckoTerminal has no pool at ${assetId}.`, SOURCE);
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
    const parsed = parseAssetId(assetId);
    if (!parsed) {
      return unavailable(
        `Chart data needs a chain and pool address; "${assetId}" does not provide them.`,
        SOURCE,
      );
    }
    const mapped = TIMEFRAME_MAP[timeframe];
    const capped = Math.min(Math.max(limit, 20), 1000);
    const url = `${BASE}/networks/${encodeURIComponent(parsed.network)}/pools/${encodeURIComponent(parsed.address)}/ohlcv/${mapped.path}?aggregate=${mapped.aggregate}&limit=${capped}&currency=usd`;

    try {
      const cached = candleCache.get(url);
      const body = cached
        ? (cached.value as { data?: { attributes?: { ohlcv_list?: unknown } } })
        : await fetchJson<{ data?: { attributes?: { ohlcv_list?: unknown } } }>(url, {
            source: SOURCE,
            retries: 1,
          });
      if (!cached) candleCache.set(url, body);

      const list = body?.data?.attributes?.ohlcv_list;
      if (!Array.isArray(list) || list.length === 0) {
        return unavailable(
          `GeckoTerminal has no ${timeframe} history for this pool. Very new pairs often have none.`,
          SOURCE,
        );
      }

      const candles = parseOhlcv(list);
      if (candles.length === 0) {
        return unavailable('GeckoTerminal returned OHLCV rows that could not be parsed.', SOURCE);
      }
      return ok(candles, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  private async get<T>(url: string): Promise<T> {
    const cached = cache.get(url);
    if (cached) return cached.value as T;
    const body = await fetchJson<T>(url, { source: SOURCE, retries: 1 });
    cache.set(url, body);
    return body;
  }
}

/** GeckoTerminal rows are `[unixSeconds, open, high, low, close, volume]`, newest first. */
export function parseOhlcv(list: unknown[]): Candle[] {
  const candles: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const time = numberOrNull(row[0]);
    const open = numberOrNull(row[1]);
    const high = numberOrNull(row[2]);
    const low = numberOrNull(row[3]);
    const close = numberOrNull(row[4]);
    const volume = row.length > 5 ? numberOrNull(row[5]) : null;
    if (time === null || open === null || high === null || low === null || close === null) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    if (high < low) continue;
    candles.push({ time: Math.trunc(time), open, high, low, close, volume });
  }
  return candles.sort((a, b) => a.time - b.time);
}

function parseAssetId(assetId: string): { network: string; address: string } | null {
  const parts = assetId.split(':');
  if (parts.length !== 3) return null;
  const [prefix, network, address] = parts;
  if (!network || !address) return null;
  // Accept DexScreener ids too: the chain slugs line up for the major networks and
  // a DEX pair address is the same address on both services.
  if (prefix !== 'geckoterminal' && prefix !== 'dexscreener') return null;
  return { network: normaliseNetwork(network), address };
}

/** DexScreener and GeckoTerminal disagree on a handful of network slugs. */
const NETWORK_ALIASES: Record<string, string> = {
  ethereum: 'eth',
  binancesmartchain: 'bsc',
  arbitrum: 'arbitrum',
  polygon: 'polygon_pos',
  avalanche: 'avax',
  optimism: 'optimism',
};

export function normaliseNetwork(network: string): string {
  const lower = network.toLowerCase();
  return NETWORK_ALIASES[lower] ?? lower;
}

function toSnapshots(entries: PoolEntry[] | undefined): MarketSnapshot[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => toSnapshot(entry, null))
    .filter((s): s is MarketSnapshot => s !== null);
}

function toSnapshot(entry: PoolEntry, fallbackNetwork: string | null): MarketSnapshot | null {
  const attributes = entry.attributes;
  if (!attributes) return null;

  // Ids look like `solana_7WNu...`; the network is everything before the first `_`.
  const rawId = stringOrNull(entry.id) ?? '';
  const separator = rawId.indexOf('_');
  const network = separator > 0 ? rawId.slice(0, separator) : fallbackNetwork;
  const address = stringOrNull(attributes.address) ?? (separator > 0 ? rawId.slice(separator + 1) : null);
  if (!network || !address) return null;

  const name = stringOrNull(attributes.name) ?? '';
  const symbol = name.split('/')[0]?.trim() || 'UNKNOWN';
  const price = numberOrNull(attributes.base_token_price_usd);
  if (price === null || price <= 0) return null;

  const volume: MarketSnapshot['volume'] = {};
  for (const [key, window] of [
    ['m5', 'm5'],
    ['h1', 'h1'],
    ['h6', 'h6'],
    ['h24', 'h24'],
  ] as const) {
    const value = numberOrNull(attributes.volume_usd?.[key]);
    if (value !== null) volume[window] = value;
  }

  const priceChangePct: MarketSnapshot['priceChangePct'] = {};
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const value = numberOrNull(attributes.price_change_percentage?.[window]);
    if (value !== null) priceChangePct[window] = value;
  }

  const txns: MarketSnapshot['txns'] = {};
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const entryTx = attributes.transactions?.[window];
    const buys = intOrNull(entryTx?.buys);
    const sells = intOrNull(entryTx?.sells);
    if (buys !== null && sells !== null) txns[window] = { buys, sells };
  }

  const createdRaw = stringOrNull(attributes.pool_created_at);
  const created = createdRaw ? Date.parse(createdRaw) : Number.NaN;
  const baseTokenId = stringOrNull(entry.relationships?.base_token?.data?.id);

  return {
    id: `geckoterminal:${network}:${address}`,
    provider: 'geckoterminal',
    assetClass: 'meme',
    symbol,
    name: name || null,
    chain: network,
    pairAddress: address,
    baseTokenAddress: baseTokenId ? (baseTokenId.split('_')[1] ?? null) : null,
    quoteSymbol: name.split('/')[1]?.trim() ?? null,
    dex: stringOrNull(entry.relationships?.dex?.data?.id),
    url: `https://www.geckoterminal.com/${network}/pools/${address}`,
    priceUsd: price,
    liquidityUsd: numberOrNull(attributes.reserve_in_usd),
    marketCapUsd: numberOrNull(attributes.market_cap_usd),
    fdvUsd: numberOrNull(attributes.fdv_usd),
    volume,
    priceChangePct,
    txns,
    pairCreatedAt: Number.isFinite(created) ? created : null,
    fetchedAt: Date.now(),
  };
}

function toUnavailable<T>(error: unknown): DataResult<T> {
  if (error instanceof UpstreamError) return unavailable(error.message, SOURCE);
  return unavailable(
    `${SOURCE} request failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    SOURCE,
  );
}
