import { and, asc, eq, gte } from 'drizzle-orm';
import type {
  Candle,
  MarketSnapshot,
  Timeframe,
  TokenInfo,
  TokenReport,
} from '../../shared/types.js';
import { TIMEFRAME_MINUTES } from '../../shared/types.js';
import { deriveTimeframe } from '../../engine/candles.js';
import { atr, ema, relativeVolume, rsi, safeDivide, vwap } from '../../engine/indicators.js';
import { analyseLiquidity, type LiquidityObservation } from '../../engine/liquidity.js';
import { analyseMomentum, MOMENTUM_TIMEFRAMES } from '../../engine/momentum.js';
import { analyseTimeframes } from '../../engine/mtf.js';
import { assessRisk } from '../../engine/risk-engine.js';
import { scoreSetup } from '../../engine/setup-score.js';
import { detectLatest } from '../../engine/setups/index.js';
import { analyseStructure } from '../../engine/structure.js';
import { buildTradePlan } from '../../engine/trade-plan.js';
import { assessChasing, resolveTradeStatus } from '../../engine/trade-status.js';
import { analyseVolume } from '../../engine/volume.js';
import { getDb } from '../db/index.js';
import { marketData } from '../db/schema.js';
import { persistResolution } from '../db/seed-watchlist.js';
import { logger } from '../lib/logger.js';
import { getCandles, getTokenInfo, resolveTokenAddress } from '../providers/registry.js';
import { readCandles, storeCandles, storeAgeMs } from './candle-store.js';
import { buildAnnotations, pickPrimary } from './analysis.js';
import { recordSnapshot } from './recorder.js';

export interface TokenReportOptions {
  chain: string;
  tokenAddress: string;
  timeframe: Timeframe;
  /** Momentum needs the full ladder; a card view can skip it to save provider calls. */
  includeMomentumLadder?: boolean;
  /**
   * Fetch the 1-minute series too. Only the detail page does: 1m cannot be
   * aggregated from a coarser series, so it costs an extra request per token.
   */
  includeFineGrained?: boolean;
  candleLimit?: number;
}

/**
 * Builds the complete picture of one token from its CONTRACT address.
 *
 * The flow is: resolve the address to a tradable pair, pull that pair's market
 * data and candles, pull contract/holder facts, then run the analysis engines.
 * Every stage can fail independently and is reported independently - a token
 * whose chart will not load still shows its market data, and a token that
 * resolves but has no contract data still gets a risk score built from what did
 * arrive.
 */
export async function buildTokenReport(options: TokenReportOptions): Promise<TokenReport> {
  const { chain, tokenAddress, timeframe } = options;
  const limit = options.candleLimit ?? 300;
  const dataNotes: string[] = [];

  // --- 1. Contract address -> tradable pair --------------------------------
  const resolution = await resolveTokenAddress(chain, tokenAddress);
  if (resolution.status !== 'ok') {
    return emptyReport(
      chain,
      tokenAddress,
      timeframe,
      `DATA UNAVAILABLE — ${resolution.reason}`,
    );
  }

  const snapshot = resolution.data;
  const assetId = snapshot.id;
  recordSnapshot([snapshot]);
  try {
    persistResolution(getDb(), tokenAddress, {
      assetId,
      symbol: snapshot.symbol,
      name: snapshot.name,
      pairAddress: snapshot.pairAddress,
    });
  } catch (error) {
    logger.warn('could not persist token resolution', { error, tokenAddress });
  }

  // --- 2. Chart data, contract facts and the momentum ladder ---------------
  //
  // The ladder needs 1m, 5m, 15m, 1h, 4h and 1D. Fetching six series would cost
  // six rate-limited requests per token; instead three are fetched and the rest
  // are aggregated upward from them (5m from 1m, 1h and 4h from 15m). Nothing is
  // interpolated - aggregation only ever combines whole bars.
  // The card view fetches 15m and 1D and derives 1h and 4h from the 15m series.
  // The 1-minute series is fetched only on the detail page: it cannot be derived
  // from anything coarser, and pulling it for every token on every list refresh
  // is what pushes the provider's rate limit over.
  const BASE_TIMEFRAMES: Timeframe[] = options.includeMomentumLadder === false
    ? []
    : options.includeFineGrained
      ? ['1m', '15m', '1d']
      : ['15m', '1d'];
  const fetchList: Timeframe[] = [...new Set<Timeframe>([...BASE_TIMEFRAMES, timeframe])];

  /**
   * Charts come from the local candle store, which the background refresher
   * keeps warm. A provider request is only made when the store has nothing at
   * all for a timeframe - otherwise a page load could be throttled and show
   * DATA UNAVAILABLE for a market whose bars are already on disk.
   */
  const fetched: { timeframe: Timeframe; source: string; reason: string | null; candles: Candle[] }[] = [];
  for (const tf of fetchList) {
    const stored = readCandles(assetId, tf, tf === timeframe ? limit : 300);
    if (stored.length > 0) {
      fetched.push({ timeframe: tf, source: 'local candle store', reason: null, candles: stored });
      continue;
    }
    const live = await getCandles(assetId, tf, tf === timeframe ? limit : 300);
    if (live.status === 'ok') {
      storeCandles(assetId, tf, live.data);
      fetched.push({ timeframe: tf, source: live.source, reason: null, candles: live.data });
    } else {
      fetched.push({ timeframe: tf, source: live.source, reason: live.reason, candles: [] });
    }
  }

  const infoResult = await getTokenInfo(chain, tokenAddress);

  const series = new Map<Timeframe, { candles: Candle[] | null; reason?: string }>();
  for (const entry of fetched) {
    series.set(entry.timeframe, {
      candles: entry.candles.length > 0 ? entry.candles : null,
      ...(entry.reason ? { reason: entry.reason } : {}),
    });
  }

  const candleEntry = series.get(timeframe);
  const candleResult = fetched.find((f) => f.timeframe === timeframe);
  // Age is measured from the newest stored BAR, which is the only honest answer:
  // it is when the market last produced data, not when we last asked for it.
  const ageMs = storeAgeMs(assetId, timeframe);
  const barMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const candleStale = ageMs !== null && ageMs > barMs * 3;
  const candleFetchedAt = ageMs === null ? null : Date.now() - ageMs;
  const candles: Candle[] = candleEntry?.candles ?? [];
  const candleReason = candleEntry?.reason ?? null;
  if (candleReason) {
    dataNotes.push(`Chart data unavailable (${candleResult?.source ?? 'provider'}): ${candleReason}`);
  }
  if (candleStale) {
    dataNotes.push(
      `The newest ${timeframe} bar is ${Math.round((ageMs ?? 0) / 60_000)} minutes old. The background refresher fetches one series at a time to stay inside the provider's rate limit, so charts catch up gradually.`,
    );
  }

  let tokenInfo: TokenInfo | null = null;
  let tokenInfoReason: string | null = null;
  const tokenInfoStale = infoResult.status === 'ok' && infoResult.stale === true;
  if (infoResult.status === 'ok') {
    tokenInfo = infoResult.data;
    if (tokenInfoStale) {
      dataNotes.push(
        'Holder and contract figures are the last good response, not a live fetch — the provider is rate limiting this app.',
      );
    }
  } else {
    tokenInfoReason = infoResult.reason;
    dataNotes.push(`Holder and contract data unavailable: ${infoResult.reason}`);
  }

  /** Serves a timeframe from a fetched series, or aggregates one that can be. */
  const ladderCandles = new Map<Timeframe, { candles: Candle[] | null; reason?: string }>(series);
  if (options.includeMomentumLadder !== false) {
    const derivations: { target: Timeframe; from: Timeframe }[] = [
      { target: '5m', from: '1m' },
      { target: '1h', from: '15m' },
      { target: '4h', from: '15m' },
    ];
    if (!options.includeFineGrained) {
      const note =
        'Fetched on the token detail page only — the 1-minute series cannot be derived from coarser bars, and pulling it for every card would exceed the provider rate limit.';
      for (const tf of ['1m', '5m'] as Timeframe[]) {
        if (!ladderCandles.get(tf)?.candles) ladderCandles.set(tf, { candles: null, reason: note });
      }
    }
    for (const { target, from } of derivations) {
      if (ladderCandles.get(target)?.candles) continue;
      const source = series.get(from);
      if (!source?.candles) {
        ladderCandles.set(target, {
          candles: null,
          reason: source?.reason ?? `The ${from} series it is derived from was unavailable.`,
        });
        continue;
      }
      const derived = deriveTimeframe({ timeframe: from, candles: source.candles }, target);
      ladderCandles.set(target, {
        candles: derived,
        ...(derived ? {} : { reason: `Could not aggregate ${from} bars into ${target}.` }),
      });
    }
  }

  // --- 3. Analysis ---------------------------------------------------------
  const structure = candles.length > 0 ? analyseStructure(candles, 2) : null;

  const momentum = analyseMomentum(
    MOMENTUM_TIMEFRAMES.map((tf) => {
      const entry = ladderCandles.get(tf);
      return {
        timeframe: tf,
        candles: entry?.candles ?? null,
        ...(entry?.reason ? { unavailableReason: entry.reason } : {}),
      };
    }),
  );

  const alignment = analyseTimeframes(
    (['1d', '4h', '1h', '15m'] as Timeframe[]).map((tf) => {
      const entry = ladderCandles.get(tf);
      return {
        timeframe: tf,
        candles: entry?.candles ?? null,
        ...(entry?.reason ? { unavailableReason: entry.reason } : {}),
      };
    }),
  );

  const volume = analyseVolume(candles, snapshot);
  const liquidity = analyseLiquidity(readLiquidityHistory(assetId), snapshot.liquidityUsd);

  const detections = candles.length > 0
    ? detectLatest(candles, undefined, { timeframe, stopRule: 'structure', atrMultiple: 1.5 })
    : [];
  const primary = pickPrimary(detections);

  const plan = primary && structure
    ? buildTradePlan(primary, candles, structure.levels)
    : {
        available: false as const,
        reason:
          candles.length === 0
            ? 'NO VALID TRADE PLAN — no chart data could be loaded for this token.'
            : 'NO VALID TRADE PLAN — none of the five defined setups currently satisfies its conditions on this timeframe.',
      };

  const setupScore = primary && structure
    ? scoreSetup({
        detection: primary,
        candles,
        structure,
        alignment,
        plan,
        snapshot,
        volume,
        momentum,
        liquidity,
      })
    : null;

  const risk = assessRisk({ snapshot, candles, tokenInfo, liquidityTrend: liquidity });

  const tradeStatus = resolveTradeStatus({
    hasMarketData: true,
    hasCandles: candles.length > 0,
    structure,
    detections,
    plan,
    risk,
    liquidity,
    volume,
    setupScore: setupScore?.score ?? null,
  });

  const chasing = assessChasing(snapshot.priceChangePct);

  const annotations = structure
    ? buildAnnotations(primary, plan, structure.levels, structure.sweeps, candles)
    : [];

  const txns = snapshot.txns.h24 ?? snapshot.txns.h6 ?? snapshot.txns.h1 ?? null;
  const buySellRatio = txns && txns.sells > 0 ? safeDivide(txns.buys, txns.sells) : null;
  const pairAgeHours =
    snapshot.pairCreatedAt !== null ? (Date.now() - snapshot.pairCreatedAt) / 3_600_000 : null;

  const closes = candles.map((c) => c.close);

  return {
    requestedAddress: tokenAddress,
    chain,
    resolved: true,
    unavailableReason: null,
    assetId,
    pairAddress: snapshot.pairAddress,
    dex: snapshot.dex,
    snapshot,
    tokenInfo,
    tokenInfoReason,
    timeframe,
    candles,
    candleSource: candleResult?.source ?? 'none',
    candleReason,
    candleStale,
    candleFetchedAt,
    tokenInfoStale,
    structure,
    momentum,
    volume,
    liquidity,
    alignment,
    detections,
    setupScore,
    risk,
    plan,
    annotations,
    indicators: {
      atr14: atr(candles, 14),
      rsi14: rsi(closes, 14),
      vwapSession: vwap(candles),
      relativeVolume: relativeVolume(candles, 20),
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
    },
    tradeStatus,
    chasing,
    buySellRatio,
    pairAgeHours,
    dataNotes,
    generatedAt: Date.now(),
  };
}

/**
 * Liquidity observations this app recorded for a market, oldest first.
 * Capped to the last 7 days so an old, long-abandoned market does not compare
 * today's pool against one from months ago.
 */
function readLiquidityHistory(assetId: string): LiquidityObservation[] {
  try {
    const since = Date.now() - 7 * 24 * 3_600_000;
    return getDb()
      .select({ capturedAt: marketData.capturedAt, liquidityUsd: marketData.liquidityUsd })
      .from(marketData)
      .where(and(eq(marketData.assetId, assetId), gte(marketData.capturedAt, since)))
      .orderBy(asc(marketData.capturedAt))
      .all();
  } catch (error) {
    logger.warn('could not read liquidity history', { error, assetId });
    return [];
  }
}

function emptyReport(
  chain: string,
  tokenAddress: string,
  timeframe: Timeframe,
  reason: string,
): TokenReport {
  return {
    requestedAddress: tokenAddress,
    chain,
    resolved: false,
    unavailableReason: reason,
    assetId: null,
    pairAddress: null,
    dex: null,
    snapshot: null,
    tokenInfo: null,
    tokenInfoReason: reason,
    timeframe,
    candles: [],
    candleSource: 'none',
    candleReason: reason,
    candleStale: false,
    candleFetchedAt: null,
    tokenInfoStale: false,
    structure: null,
    momentum: { readings: [], bias: 'unknown', evaluated: 0, detail: 'No market data.' },
    volume: {
      relativeVolume: null,
      acceleration: null,
      trend: 'unavailable',
      priceVolumeDivergence: null,
      flag: 'unavailable',
      headline: 'VOLUME DATA UNAVAILABLE',
      reasons: [reason],
    },
    liquidity: {
      label: 'insufficient-history',
      changePct: null,
      observations: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      currentUsd: null,
      detail: reason,
      highRisk: false,
    },
    alignment: { views: [], alignment: 'UNKNOWN', dominantBias: 'unknown', detail: reason },
    detections: [],
    setupScore: null,
    risk: null,
    plan: { available: false, reason: 'NO VALID TRADE PLAN — the token address could not be resolved.' },
    annotations: [],
    indicators: {
      atr14: null,
      rsi14: null,
      vwapSession: null,
      relativeVolume: null,
      ema20: null,
      ema50: null,
      ema200: null,
    },
    tradeStatus: { status: 'DATA UNAVAILABLE', reasons: [reason] },
    chasing: {
      triggered: false,
      movePct: null,
      window: null,
      headline: '',
      message: 'No price data to assess.',
    },
    buySellRatio: null,
    pairAgeHours: null,
    dataNotes: [reason],
    generatedAt: Date.now(),
  };
}

/** Unpins nothing and deletes nothing - a MarketSnapshot for the paper-trade ticket. */
export function snapshotOf(report: TokenReport): MarketSnapshot | null {
  return report.snapshot;
}
