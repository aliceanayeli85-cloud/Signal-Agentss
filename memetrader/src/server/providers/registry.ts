import type {
  AssetClass,
  Candle,
  DataResult,
  MarketSnapshot,
  Timeframe,
  TokenInfo,
} from '../../shared/types.js';
import { env } from '../lib/env.js';
import { CoinbaseProvider } from './coinbase.js';
import { DexScreenerProvider } from './dexscreener.js';
import { GeckoTerminalProvider } from './geckoterminal.js';
import { AlphaVantageProvider, PolygonProvider } from './stocks.js';
import { unavailable, type DataProvider, type ScannerTab } from './types.js';

const dexscreener = new DexScreenerProvider();
const geckoterminal = new GeckoTerminalProvider();
const coinbase = new CoinbaseProvider();
const alphaVantage = new AlphaVantageProvider();
const polygon = new PolygonProvider();

export const PROVIDERS: DataProvider[] = [
  dexscreener,
  geckoterminal,
  coinbase,
  alphaVantage,
  polygon,
];

export interface ProviderStatus {
  id: string;
  displayName: string;
  assetClasses: AssetClass[];
  docsUrl: string;
  configured: boolean;
  reason: string;
  timeframes: Timeframe[];
}

export function providerStatuses(): ProviderStatus[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    assetClasses: [...p.assetClasses],
    docsUrl: p.docsUrl,
    configured: p.isConfigured(),
    reason: p.isConfigured() ? '' : p.unavailableReason(),
    timeframes: p.supportedTimeframes(),
  }));
}

export function providerFor(assetId: string): DataProvider | null {
  const prefix = assetId.split(':')[0];
  return PROVIDERS.find((p) => p.id === prefix) ?? null;
}

/**
 * Resolves the provider that can actually serve CANDLES for an asset.
 *
 * On-chain pairs are the interesting case: DexScreener owns the metadata but
 * publishes no OHLCV, so chart requests for a `dexscreener:` id are routed to
 * GeckoTerminal, which addresses the same pool by the same chain and address.
 */
export function candleProviderFor(assetId: string): DataProvider | null {
  const prefix = assetId.split(':')[0];
  if (prefix === 'dexscreener' || prefix === 'geckoterminal') return geckoterminal;
  return providerFor(assetId);
}

export async function getCandles(
  assetId: string,
  timeframe: Timeframe,
  limit = 300,
): Promise<DataResult<Candle[]>> {
  const provider = candleProviderFor(assetId);
  if (!provider) {
    return unavailable(`No data provider is registered for "${assetId}".`, 'registry');
  }
  return provider.candles(assetId, timeframe, limit);
}

export async function getSnapshot(assetId: string): Promise<DataResult<MarketSnapshot>> {
  const provider = providerFor(assetId);
  if (!provider) {
    return unavailable(`No data provider is registered for "${assetId}".`, 'registry');
  }
  const result = await provider.snapshot(assetId);
  // A DexScreener pair that has rotated out of its feeds can still be resolved by
  // GeckoTerminal, so try the sibling before declaring the market unavailable.
  if (result.status === 'unavailable' && provider.id === 'dexscreener') {
    const fallback = await geckoterminal.snapshot(assetId);
    if (fallback.status === 'ok') return fallback;
  }
  return result;
}

/**
 * Resolves a token CONTRACT address to a tradable pair snapshot.
 *
 * The watchlist stores contract addresses because that is what a user actually
 * has; everything downstream needs a pair. Resolution is a provider call every
 * time rather than a stored mapping, because the deepest pair for a token
 * genuinely changes as liquidity migrates between DEXs.
 */
export async function resolveTokenAddress(
  chain: string,
  tokenAddress: string,
): Promise<DataResult<MarketSnapshot>> {
  if (!dexscreener.resolveToken) {
    return unavailable('No configured provider can resolve a token contract address.', 'registry');
  }
  const result = await dexscreener.resolveToken(chain, tokenAddress);
  if (result.status === 'ok') return result;

  // GeckoTerminal indexes some pools DexScreener's token endpoint does not
  // return, so a miss on one is not a miss on the chain.
  //
  // Its search is a fuzzy TEXT search, though: querying a contract address can
  // return a pool merely whose NAME contains those characters. Every candidate
  // is therefore checked against the requested mint, and anything that does not
  // match exactly is discarded. Without this, a mistyped address silently
  // resolves to an unrelated token and the whole screen describes the wrong
  // market.
  const wanted = tokenAddress.trim().toLowerCase();
  const fallback = await geckoterminal.search(tokenAddress);
  if (fallback.status === 'ok') {
    const match = fallback.data
      .filter(
        (snapshot) =>
          snapshot.chain !== null &&
          snapshot.baseTokenAddress !== null &&
          snapshot.baseTokenAddress.toLowerCase() === wanted,
      )
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
    if (match) return { status: 'ok', data: match, fetchedAt: Date.now(), source: 'GeckoTerminal' };
  }
  return result;
}

/** Contract- and holder-level facts, or an explicit reason they are unavailable. */
export async function getTokenInfo(
  chain: string,
  tokenAddress: string,
): Promise<DataResult<TokenInfo>> {
  if (!geckoterminal.tokenInfo) {
    return unavailable(
      'No configured provider publishes holder or contract data.',
      'registry',
    );
  }
  return geckoterminal.tokenInfo(chain, tokenAddress);
}

export interface ScanResult {
  tab: ScannerTab;
  assetClass: AssetClass;
  results: MarketSnapshot[];
  sources: { source: string; status: 'ok' | 'unavailable'; reason?: string; count: number }[];
  fetchedAt: number;
}

/**
 * Runs a scanner tab across every provider that serves the relevant asset class
 * and merges the results. Each source reports its own status, so a tab where one
 * provider failed shows partial results plus an explicit note - never a silently
 * shortened list.
 */
export async function scan(tab: ScannerTab): Promise<ScanResult> {
  const assetClass: AssetClass =
    tab === 'crypto' ? 'crypto' : tab === 'stocks' ? 'stock' : 'meme';
  const providers = PROVIDERS.filter((p) => p.assetClasses.includes(assetClass));

  const settled = await Promise.all(
    providers.map(async (provider) => {
      if (!provider.isConfigured()) {
        return {
          source: provider.displayName,
          status: 'unavailable' as const,
          reason: provider.unavailableReason(),
          count: 0,
          results: [] as MarketSnapshot[],
        };
      }
      try {
        const result = await provider.listing(tab);
        if (result.status === 'unavailable') {
          return {
            source: provider.displayName,
            status: 'unavailable' as const,
            reason: result.reason,
            count: 0,
            results: [] as MarketSnapshot[],
          };
        }
        return {
          source: provider.displayName,
          status: 'ok' as const,
          count: result.data.length,
          results: result.data,
        };
      } catch (error) {
        return {
          source: provider.displayName,
          status: 'unavailable' as const,
          reason: error instanceof Error ? error.message : 'Unknown provider failure.',
          count: 0,
          results: [] as MarketSnapshot[],
        };
      }
    }),
  );

  // Deduplicate by pair address so the same pool from two providers appears once.
  const seen = new Set<string>();
  const merged: MarketSnapshot[] = [];
  for (const entry of settled) {
    for (const snapshot of entry.results) {
      const key = snapshot.pairAddress
        ? `${snapshot.chain ?? ''}:${snapshot.pairAddress.toLowerCase()}`
        : snapshot.id;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(snapshot);
    }
  }

  return {
    tab,
    assetClass,
    results: merged.slice(0, 60),
    sources: settled.map(({ source, status, reason, count }) => ({ source, status, reason, count })),
    fetchedAt: Date.now(),
  };
}

export async function search(query: string): Promise<ScanResult> {
  const providers = PROVIDERS.filter((p) => p.isConfigured());
  const settled = await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await provider.search(query);
        if (result.status === 'unavailable') {
          return {
            source: provider.displayName,
            status: 'unavailable' as const,
            reason: result.reason,
            count: 0,
            results: [] as MarketSnapshot[],
          };
        }
        return {
          source: provider.displayName,
          status: 'ok' as const,
          count: result.data.length,
          results: result.data,
        };
      } catch (error) {
        return {
          source: provider.displayName,
          status: 'unavailable' as const,
          reason: error instanceof Error ? error.message : 'Unknown provider failure.',
          count: 0,
          results: [] as MarketSnapshot[],
        };
      }
    }),
  );

  const merged = settled
    .flatMap((entry) => entry.results)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

  return {
    tab: 'meme',
    assetClass: 'meme',
    results: merged.slice(0, 40),
    sources: settled.map(({ source, status, reason, count }) => ({ source, status, reason, count })),
    fetchedAt: Date.now(),
  };
}

/** Exposed so the UI can state plainly that live execution is not wired up. */
export const EXECUTION_STATUS = {
  liveTradingEnabled: env.liveTradingEnabled,
  note: 'This application has no wallet connection, no transaction signing and no exchange execution code. Paper trading is the only trading it performs.',
} as const;
