import { eq, sql } from 'drizzle-orm';
import type { Timeframe } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { watchlists } from '../db/schema.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getCandles, getTokenInfo, resolveTokenAddress } from '../providers/registry.js';
import { storeCandles, isStale } from './candle-store.js';
import { persistResolution } from '../db/seed-watchlist.js';
import { recordSnapshot } from './recorder.js';

/**
 * Background market-data refresher.
 *
 * Why this exists: the on-chain OHLCV provider rate-limits hard enough that a
 * page load cannot fetch charts for several tokens at once without being
 * throttled. Doing it inline meant the last tokens in a list always showed
 * DATA UNAVAILABLE - accurate, but useless.
 *
 * So chart data is fetched here instead: one request at a time, slowly, forever,
 * writing into the local candle store. Requests never block a user action, and
 * the UI reads whatever the store currently holds along with its true age.
 *
 * Market data (price, liquidity, volume, transactions) is NOT fetched here -
 * that provider is far more permissive and is read live on each request.
 */

/** Gap between outbound OHLCV requests. Deliberately conservative. */
const REQUEST_GAP_MS = 9_000;
/** Pause after a rate limit before trying again. */
const BACKOFF_MS = 90_000;
/** Timeframes kept warm for every watchlist token, in priority order. */
const TRACKED: Timeframe[] = ['15m', '1d', '1m'];

let running = false;
let timer: NodeJS.Timeout | null = null;
let cursor = 0;

interface Target {
  assetId: string;
  timeframe: Timeframe;
  tokenAddress: string | null;
  chain: string;
}

export interface RefresherStatus {
  running: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  requests: number;
  stored: number;
  gapMs: number;
}

const status: RefresherStatus = {
  running: false,
  lastTickAt: null,
  lastError: null,
  requests: 0,
  stored: 0,
  gapMs: REQUEST_GAP_MS,
};

export function refresherStatus(): RefresherStatus {
  return { ...status };
}

/** Every (token, timeframe) pair the refresher keeps warm. */
function buildTargets(): Target[] {
  try {
    const rows = getDb()
      .select()
      .from(watchlists)
      .where(sql`${watchlists.tokenAddress} IS NOT NULL`)
      .all();
    const targets: Target[] = [];
    for (const row of rows) {
      for (const timeframe of TRACKED) {
        targets.push({
          assetId: row.assetId,
          timeframe,
          tokenAddress: row.tokenAddress,
          chain: row.chain ?? 'solana',
        });
      }
    }
    return targets;
  } catch (error) {
    logger.warn('refresher could not read watchlist', { error });
    return [];
  }
}

let snapshotCursor = 0;
let infoCursor = 0;
/** Holder figures are recomputed by the provider on the order of minutes. */
const INFO_REFRESH_MS = 8 * 60_000;
const lastInfoFetch = new Map<string, number>();

/**
 * Keeps contract and holder data warm in the provider's cache.
 *
 * Fetching it on demand meant a page load could land during a rate limit and
 * show holder concentration as unavailable for a token that has it. One token
 * per tick keeps every entry inside the cache TTL at negligible cost.
 */
async function refreshOneTokenInfo(): Promise<void> {
  try {
    const rows = getDb()
      .select()
      .from(watchlists)
      .where(sql`${watchlists.tokenAddress} IS NOT NULL`)
      .all();
    if (rows.length === 0) return;
    const row = rows[infoCursor % rows.length];
    infoCursor = (infoCursor + 1) % rows.length;
    if (!row?.tokenAddress) return;

    const last = lastInfoFetch.get(row.tokenAddress) ?? 0;
    if (Date.now() - last < INFO_REFRESH_MS) return;

    const result = await getTokenInfo(row.chain ?? 'solana', row.tokenAddress);
    if (result.status === 'ok') lastInfoFetch.set(row.tokenAddress, Date.now());
  } catch (error) {
    logger.warn('token info refresh failed', { error });
  }
}


/**
 * Records one token's market snapshot per tick.
 *
 * This is what makes the liquidity trend possible at all: no provider exposes a
 * liquidity time series, so the app builds one by observing the pool repeatedly
 * and storing what it saw. DexScreener is far more permissive than the OHLCV
 * provider, so this runs on every tick regardless of the chart backoff.
 */
async function refreshOneSnapshot(): Promise<void> {
  try {
    const rows = getDb()
      .select()
      .from(watchlists)
      .where(sql`${watchlists.tokenAddress} IS NOT NULL`)
      .all();
    if (rows.length === 0) return;
    const row = rows[snapshotCursor % rows.length];
    snapshotCursor = (snapshotCursor + 1) % rows.length;
    if (!row?.tokenAddress) return;

    const resolved = await resolveTokenAddress(row.chain ?? 'solana', row.tokenAddress);
    if (resolved.status !== 'ok') return;
    recordSnapshot([resolved.data]);
    persistResolution(getDb(), row.tokenAddress, {
      assetId: resolved.data.id,
      symbol: resolved.data.symbol,
      name: resolved.data.name,
      pairAddress: resolved.data.pairAddress,
    });
  } catch (error) {
    logger.warn('snapshot refresh failed', { error });
  }
}

/**
 * One OHLCV request per tick. The cursor walks every (token, timeframe) pair in
 * turn, skipping any whose stored series is already current - so no token is
 * starved the way an inline fan-out starved the last item in the list.
 */
async function tick(): Promise<number> {
  // Always record a snapshot, even while charts are backing off.
  await refreshOneSnapshot();
  await refreshOneTokenInfo();

  const targets = buildTargets();
  if (targets.length === 0) return REQUEST_GAP_MS;

  for (let attempt = 0; attempt < targets.length; attempt += 1) {
    const target = targets[(cursor + attempt) % targets.length];
    if (!target) continue;

    let assetId = target.assetId;
    // A token seeded by contract address has no pair id until it resolves.
    if (!assetId && target.tokenAddress) {
      const resolved = await resolveTokenAddress(target.chain, target.tokenAddress);
      if (resolved.status !== 'ok') continue;
      assetId = resolved.data.id;
      recordSnapshot([resolved.data]);
      try {
        persistResolution(getDb(), target.tokenAddress, {
          assetId,
          symbol: resolved.data.symbol,
          name: resolved.data.name,
          pairAddress: resolved.data.pairAddress,
        });
      } catch {
        // Non-fatal: the next tick will try again.
      }
    }
    if (!assetId) continue;
    if (!isStale(assetId, target.timeframe)) continue;

    cursor = (cursor + attempt + 1) % targets.length;
    status.requests += 1;
    const result = await getCandles(assetId, target.timeframe, 300);
    if (result.status === 'ok') {
      status.stored += storeCandles(assetId, target.timeframe, result.data);
      status.lastError = null;
      return REQUEST_GAP_MS;
    }

    status.lastError = result.reason;
    if (/rate limit/i.test(result.reason)) {
      logger.warn('refresher backing off', { reason: result.reason });
      return BACKOFF_MS;
    }
    return REQUEST_GAP_MS;
  }

  // Everything is current; check again after one gap.
  return REQUEST_GAP_MS;
}

export function startRefresher(): void {
  if (running || env.nodeEnv === 'test') return;
  running = true;
  status.running = true;

  const loop = async () => {
    let delay = REQUEST_GAP_MS;
    try {
      delay = await tick();
      status.lastTickAt = Date.now();
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : 'unknown refresher error';
      logger.warn('refresher tick failed', { error });
    }
    if (running) {
      timer = setTimeout(() => void loop(), delay);
      timer.unref();
    }
  };

  // Start after a short delay so the server finishes booting first.
  timer = setTimeout(() => void loop(), 1_500);
  timer.unref();
  logger.info('market data refresher started', { gapMs: REQUEST_GAP_MS, timeframes: TRACKED });
}

export function stopRefresher(): void {
  running = false;
  status.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Used by tests and by the manual refresh endpoint. */
export async function refreshOnce(): Promise<number> {
  return tick();
}

/** Removes a watchlist row's cached identity so the next tick re-resolves it. */
export function forgetResolution(tokenAddress: string): void {
  try {
    getDb().update(watchlists).set({ assetId: '' }).where(eq(watchlists.tokenAddress, tokenAddress)).run();
  } catch {
    // Best effort.
  }
}
