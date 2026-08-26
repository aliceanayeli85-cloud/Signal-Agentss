import type { Candle, DataResult, MarketSnapshot, Timeframe } from '../../shared/types.js';
import { TtlCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { UpstreamError } from '../lib/errors.js';
import {
  intOrNull,
  numberOrNull,
  ok,
  stringOrNull,
  unavailable,
  type DataProvider,
  type ScannerTab,
} from './types.js';

const BASE = 'https://api.dexscreener.com';
const SOURCE = 'DexScreener';

/** Shape of the pair objects DexScreener returns. Every field is optional by design. */
interface DexPair {
  chainId?: unknown;
  dexId?: unknown;
  url?: unknown;
  pairAddress?: unknown;
  baseToken?: { address?: unknown; name?: unknown; symbol?: unknown };
  quoteToken?: { symbol?: unknown };
  priceUsd?: unknown;
  txns?: Record<string, { buys?: unknown; sells?: unknown }>;
  volume?: Record<string, unknown>;
  priceChange?: Record<string, unknown>;
  liquidity?: { usd?: unknown };
  fdv?: unknown;
  marketCap?: unknown;
  pairCreatedAt?: unknown;
}

const cache = new TtlCache<unknown>();

/**
 * DexScreener adapter - the on-chain market data source.
 *
 * DexScreener's public API serves pair metadata (price, liquidity, volume,
 * transaction counts, pair age). It does NOT serve OHLCV candles, so `candles()`
 * here reports unavailable and the registry routes chart requests to
 * GeckoTerminal instead. Pretending otherwise would mean inventing bars.
 */
export class DexScreenerProvider implements DataProvider {
  readonly id = 'dexscreener';
  readonly displayName = SOURCE;
  readonly assetClasses = ['meme' as const];
  readonly docsUrl = 'https://docs.dexscreener.com/api/reference';

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): string {
    return '';
  }

  supportedTimeframes(): Timeframe[] {
    return [];
  }

  async search(query: string): Promise<DataResult<MarketSnapshot[]>> {
    const trimmed = query.trim();
    if (!trimmed) return unavailable('Empty search query.', SOURCE);
    try {
      const body = await this.get<{ pairs?: DexPair[] }>(
        `${BASE}/latest/dex/search?q=${encodeURIComponent(trimmed)}`,
      );
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      return ok(pairs.map((p) => toSnapshot(p)).filter(isUsable), SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  /**
   * DexScreener has no "top gainers" endpoint. The scanner tabs are therefore
   * built by pulling the boosted/profile token feeds it does document, resolving
   * each to its pairs, and then filtering LOCALLY on real returned fields.
   */
  async listing(tab: ScannerTab): Promise<DataResult<MarketSnapshot[]>> {
    try {
      const snapshots = await this.candidatePool();
      if (snapshots.length === 0) {
        return unavailable(
          'DexScreener returned no pairs for the token feeds this app queries.',
          SOURCE,
        );
      }
      return ok(filterForTab(snapshots, tab), SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async snapshot(assetId: string): Promise<DataResult<MarketSnapshot>> {
    const parsed = parseAssetId(assetId);
    if (!parsed) {
      return unavailable(`"${assetId}" is not a DexScreener asset id.`, SOURCE);
    }
    try {
      const body = await this.get<{ pairs?: DexPair[] } | DexPair[]>(
        `${BASE}/latest/dex/pairs/${encodeURIComponent(parsed.chain)}/${encodeURIComponent(parsed.address)}`,
      );
      const pairs = Array.isArray(body) ? body : Array.isArray(body?.pairs) ? body.pairs : [];
      const first = pairs[0];
      if (!first) {
        return unavailable(`DexScreener has no pair at ${parsed.chain}/${parsed.address}.`, SOURCE);
      }
      const snapshot = toSnapshot(first);
      if (!isUsable(snapshot)) {
        return unavailable('DexScreener returned a pair with no usable price.', SOURCE);
      }
      return ok(snapshot, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  /**
   * Resolves a token CONTRACT address to its deepest-liquidity pair.
   *
   * A meme token usually trades in several pools at once (pumpswap, raydium,
   * meteora...) at slightly different prices. Picking the deepest is not a
   * cosmetic choice: it is the only one where the quoted price, the levels and a
   * stop are backed by enough liquidity to mean anything.
   */
  async resolveToken(chain: string, tokenAddress: string): Promise<DataResult<MarketSnapshot>> {
    const cleanChain = chain.trim();
    const cleanAddress = tokenAddress.trim();
    if (!cleanChain || !cleanAddress) {
      return unavailable('A chain and a token address are both required.', SOURCE);
    }
    try {
      const body = await this.get<DexPair[] | { pairs?: DexPair[] }>(
        `${BASE}/token-pairs/v1/${encodeURIComponent(cleanChain)}/${encodeURIComponent(cleanAddress)}`,
      );
      const pairs = Array.isArray(body) ? body : Array.isArray(body?.pairs) ? body.pairs : [];
      const candidates = pairs
        .map((pair) => toSnapshot(pair))
        .filter(isUsable)
        // Only pairs whose BASE token is the one asked for. A pair where the
        // address is the quote side would chart the wrong asset entirely.
        .filter(
          (snapshot) =>
            snapshot.baseTokenAddress !== null &&
            snapshot.baseTokenAddress.toLowerCase() === cleanAddress.toLowerCase(),
        )
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

      const best = candidates[0];
      if (!best) {
        return unavailable(
          `DexScreener returned no tradable pair on ${cleanChain} where ${cleanAddress} is the base token.`,
          SOURCE,
        );
      }
      return ok(best, SOURCE);
    } catch (error) {
      return toUnavailable(error);
    }
  }

  async candles(): Promise<DataResult<Candle[]>> {
    return unavailable(
      "DexScreener's public API does not expose OHLCV history. Chart data for on-chain pairs comes from GeckoTerminal instead.",
      SOURCE,
    );
  }

  /** Pulls the two documented discovery feeds and resolves them into pair snapshots. */
  private async candidatePool(): Promise<MarketSnapshot[]> {
    const cached = cache.get('dexscreener:pool');
    if (cached) return cached.value as MarketSnapshot[];

    const feeds = [`${BASE}/token-boosts/latest/v1`, `${BASE}/token-profiles/latest/v1`];
    const tokens = new Map<string, string>();

    for (const feed of feeds) {
      try {
        const body = await fetchJson<unknown>(feed, { source: SOURCE, retries: 1 });
        const list = Array.isArray(body) ? body : [];
        for (const entry of list) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as { chainId?: unknown; tokenAddress?: unknown };
          const chain = stringOrNull(record.chainId);
          const address = stringOrNull(record.tokenAddress);
          if (chain && address) tokens.set(`${chain}:${address}`, chain);
        }
      } catch {
        // One feed failing is survivable; both failing is reported by the caller.
      }
    }

    const keys = [...tokens.keys()].slice(0, 24);
    const snapshots: MarketSnapshot[] = [];

    // Sequential with a small gap: DexScreener rate-limits token-pairs endpoints.
    for (const key of keys) {
      const [chain, address] = key.split(':');
      if (!chain || !address) continue;
      try {
        const body = await fetchJson<DexPair[] | { pairs?: DexPair[] }>(
          `${BASE}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
          { source: SOURCE, retries: 0 },
        );
        const pairs = Array.isArray(body) ? body : Array.isArray(body?.pairs) ? body.pairs : [];
        // Only the deepest pair per token: the rest are duplicates of the same asset.
        const best = pairs
          .map((p) => toSnapshot(p))
          .filter(isUsable)
          .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
        if (best) snapshots.push(best);
      } catch {
        // Skip this token; a partial pool is still useful and honest about its size.
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    cache.set('dexscreener:pool', snapshots);
    return snapshots;
  }

  private async get<T>(url: string): Promise<T> {
    const cached = cache.get(url);
    if (cached) return cached.value as T;
    const body = await fetchJson<T>(url, { source: SOURCE, retries: 1 });
    cache.set(url, body);
    return body;
  }
}

function parseAssetId(assetId: string): { chain: string; address: string } | null {
  const parts = assetId.split(':');
  if (parts.length !== 3 || parts[0] !== 'dexscreener') return null;
  const [, chain, address] = parts;
  if (!chain || !address) return null;
  return { chain, address };
}

function toSnapshot(pair: DexPair): MarketSnapshot {
  const chain = stringOrNull(pair.chainId);
  const pairAddress = stringOrNull(pair.pairAddress);
  const symbol = stringOrNull(pair.baseToken?.symbol) ?? 'UNKNOWN';

  const volume: MarketSnapshot['volume'] = {};
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const value = numberOrNull(pair.volume?.[window]);
    if (value !== null) volume[window] = value;
  }

  const priceChangePct: MarketSnapshot['priceChangePct'] = {};
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const value = numberOrNull(pair.priceChange?.[window]);
    if (value !== null) priceChangePct[window] = value;
  }

  const txns: MarketSnapshot['txns'] = {};
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const entry = pair.txns?.[window];
    const buys = intOrNull(entry?.buys);
    const sells = intOrNull(entry?.sells);
    if (buys !== null && sells !== null) txns[window] = { buys, sells };
  }

  return {
    id: chain && pairAddress ? `dexscreener:${chain}:${pairAddress}` : `dexscreener:unknown:${symbol}`,
    provider: 'dexscreener',
    assetClass: 'meme',
    symbol,
    name: stringOrNull(pair.baseToken?.name),
    chain,
    pairAddress,
    baseTokenAddress: stringOrNull(pair.baseToken?.address),
    quoteSymbol: stringOrNull(pair.quoteToken?.symbol),
    dex: stringOrNull(pair.dexId),
    url: stringOrNull(pair.url),
    priceUsd: numberOrNull(pair.priceUsd),
    liquidityUsd: numberOrNull(pair.liquidity?.usd),
    marketCapUsd: numberOrNull(pair.marketCap),
    fdvUsd: numberOrNull(pair.fdv),
    volume,
    priceChangePct,
    txns,
    pairCreatedAt: intOrNull(pair.pairCreatedAt),
    fetchedAt: Date.now(),
  };
}

/** A pair with no price is not a market we can analyse, so it is dropped entirely. */
function isUsable(snapshot: MarketSnapshot): boolean {
  return snapshot.priceUsd !== null && snapshot.priceUsd > 0 && snapshot.pairAddress !== null;
}

function filterForTab(snapshots: MarketSnapshot[], tab: ScannerTab): MarketSnapshot[] {
  const now = Date.now();
  switch (tab) {
    case 'new-pairs':
      return snapshots
        .filter((s) => s.pairCreatedAt !== null && now - s.pairCreatedAt < 72 * 3_600_000)
        .sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0));
    case 'top-momentum':
      return snapshots
        .filter((s) => s.priceChangePct.h24 !== undefined)
        .sort((a, b) => (b.priceChangePct.h24 ?? 0) - (a.priceChangePct.h24 ?? 0));
    case 'unusual-volume':
      // Compare the last hour against the 24h average hour, using only real figures.
      return snapshots
        .filter((s) => s.volume.h1 !== undefined && (s.volume.h24 ?? 0) > 0)
        .map((s) => ({ s, ratio: (s.volume.h1 as number) / ((s.volume.h24 as number) / 24) }))
        .filter((entry) => entry.ratio > 1.5)
        .sort((a, b) => b.ratio - a.ratio)
        .map((entry) => entry.s);
    case 'potential-breakouts':
      // Without candles here this can only be a shortlist: markets rising on the
      // hour with liquidity worth trading. The chart decides whether it is a real
      // breakout - the label says "potential" for exactly that reason.
      return snapshots
        .filter(
          (s) =>
            (s.priceChangePct.h1 ?? 0) > 3 &&
            (s.priceChangePct.h24 ?? 0) > 0 &&
            (s.liquidityUsd ?? 0) > 25_000,
        )
        .sort((a, b) => (b.priceChangePct.h1 ?? 0) - (a.priceChangePct.h1 ?? 0));
    case 'meme':
    default:
      return [...snapshots].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  }
}

function toUnavailable<T>(error: unknown): DataResult<T> {
  if (error instanceof UpstreamError) return unavailable(error.message, SOURCE);
  return unavailable(
    `${SOURCE} request failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    SOURCE,
  );
}
