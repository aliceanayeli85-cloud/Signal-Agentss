import type {
  AnalysisReport,
  Candle,
  ChartAnnotation,
  MarketSnapshot,
  SetupDetection,
  Timeframe,
} from '../../shared/types.js';
import { atr, atrPercent, ema, relativeVolume, rsi, vwap } from '../../engine/indicators.js';
import { analyseTimeframes } from '../../engine/mtf.js';
import { assessRisk } from '../../engine/risk-engine.js';
import { scoreSetup } from '../../engine/setup-score.js';
import { detectLatest } from '../../engine/setups/index.js';
import { analyseStructure } from '../../engine/structure.js';
import { buildTradePlan } from '../../engine/trade-plan.js';
import { getCandles, getSnapshot } from '../providers/registry.js';

/** The higher-timeframe ladder evaluated for alignment on every analysis. */
const MTF_LADDER: Timeframe[] = ['1d', '4h', '1h', '15m'];

export interface AnalyseOptions {
  assetId: string;
  timeframe: Timeframe;
  /** Multi-timeframe costs extra provider calls; callers can opt out. */
  includeMtf?: boolean;
  candleLimit?: number;
}

/**
 * Produces the full analysis report for one market on one timeframe.
 *
 * Where a piece of the report cannot be produced it is returned as null with a
 * note in `dataNotes`, and the UI renders DATA UNAVAILABLE for that panel. The
 * report is never partially fabricated to keep the layout tidy.
 */
export async function analyseAsset(options: AnalyseOptions): Promise<AnalysisReport> {
  const { assetId, timeframe } = options;
  const limit = options.candleLimit ?? 300;
  const dataNotes: string[] = [];

  const [snapshotResult, candleResult] = await Promise.all([
    getSnapshot(assetId),
    getCandles(assetId, timeframe, limit),
  ]);

  let snapshot: MarketSnapshot | null = null;
  if (snapshotResult.status === 'ok') {
    snapshot = snapshotResult.data;
  } else {
    dataNotes.push(`Market snapshot unavailable (${snapshotResult.source}): ${snapshotResult.reason}`);
  }

  const candles: Candle[] = candleResult.status === 'ok' ? candleResult.data : [];
  const candleSource = candleResult.source;
  if (candleResult.status === 'unavailable') {
    dataNotes.push(`Chart data unavailable (${candleResult.source}): ${candleResult.reason}`);
  } else if (candles.length < 40) {
    dataNotes.push(
      `Only ${candles.length} bars of ${timeframe} history were returned. Structure, indicators and setup detection all degrade sharply below about 60 bars.`,
    );
  }

  const structure = analyseStructure(candles, 2);

  // Multi-timeframe --------------------------------------------------------
  const ladder = options.includeMtf === false ? [timeframe] : uniqueLadder(timeframe);
  const mtfResults = await Promise.all(
    ladder.map(async (tf) => {
      if (tf === timeframe) {
        return {
          timeframe: tf,
          candles: candles.length > 0 ? candles : null,
          unavailableReason:
            candleResult.status === 'unavailable' ? candleResult.reason : undefined,
        };
      }
      const result = await getCandles(assetId, tf, 200);
      return {
        timeframe: tf,
        candles: result.status === 'ok' ? result.data : null,
        unavailableReason: result.status === 'unavailable' ? result.reason : undefined,
      };
    }),
  );
  const alignment = analyseTimeframes(mtfResults);

  // Setups -----------------------------------------------------------------
  const detections = candles.length > 0 ? detectLatest(candles, undefined, {
    timeframe,
    stopRule: 'structure',
    atrMultiple: 1.5,
  }) : [];
  const primary = pickPrimary(detections);

  const plan = primary
    ? buildTradePlan(primary, candles, structure.levels)
    : {
        available: false as const,
        reason:
          candles.length === 0
            ? 'No valid trade plan available: no chart data could be loaded for this market.'
            : 'No valid trade plan available: none of the five defined setups currently satisfies its conditions on this timeframe.',
      };

  const setupScore = primary
    ? scoreSetup({ detection: primary, candles, structure, alignment, plan, snapshot })
    : null;

  const risk = candles.length > 0 || snapshot ? assessRisk({ snapshot, candles }) : null;
  if (risk === null) {
    dataNotes.push('Risk assessment unavailable: neither market data nor chart data could be loaded.');
  }

  const annotations = buildAnnotations(primary, plan, structure.levels, structure.sweeps, candles);

  const closes = candles.map((c) => c.close);

  return {
    snapshot,
    timeframe,
    candles,
    candleSource,
    structure,
    alignment,
    detections,
    setupScore,
    risk,
    plan,
    annotations,
    indicators: {
      atr14: atr(candles, 14),
      rsi14: rsi(closes, 14),
      vwapSession: vwap(sessionSlice(candles, timeframe)),
      relativeVolume: relativeVolume(candles, 20),
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
    },
    dataNotes,
    generatedAt: Date.now(),
  };
}

function uniqueLadder(timeframe: Timeframe): Timeframe[] {
  const set = new Set<Timeframe>([...MTF_LADDER, timeframe]);
  const order: Timeframe[] = ['1d', '4h', '1h', '15m', '5m', '1m'];
  return order.filter((tf) => set.has(tf));
}

/** When several setups fire at once, the one with the tightest defined risk wins. */
export function pickPrimary(detections: SetupDetection[]): SetupDetection | null {
  if (detections.length === 0) return null;
  return [...detections].sort((a, b) => {
    const aRisk = Math.abs(a.entry - a.stop) / (a.entry || 1);
    const bRisk = Math.abs(b.entry - b.stop) / (b.entry || 1);
    return aRisk - bRisk;
  })[0] as SetupDetection;
}

/** VWAP is a session measure; for intraday frames use the most recent day of bars. */
function sessionSlice(candles: Candle[], timeframe: Timeframe): Candle[] {
  if (candles.length === 0) return candles;
  if (timeframe === '1d' || timeframe === '4h') return candles;
  const last = candles[candles.length - 1];
  if (!last) return candles;
  const dayStart = last.time - 86_400;
  return candles.filter((c) => c.time >= dayStart);
}

/**
 * Assembles the chart overlay: the setup's own markers, the levels that matter
 * near current price, identifiable liquidity sweeps, and the plan's targets.
 */
export function buildAnnotations(
  detection: SetupDetection | null,
  plan: AnalysisReport['plan'],
  levels: AnalysisReport['structure']['levels'],
  sweeps: AnalysisReport['structure']['sweeps'],
  candles: Candle[],
): ChartAnnotation[] {
  const annotations: ChartAnnotation[] = [];
  const last = candles[candles.length - 1];
  const range = atr(candles, 14);

  // Nearby levels only: a level ten ATR away is not information, it is clutter.
  if (last && range !== null && range > 0) {
    const nearby = levels
      .filter((l) => Math.abs(l.price - last.close) < range * 12)
      .sort((a, b) => b.touches - a.touches)
      .slice(0, 4);
    for (const level of nearby) {
      annotations.push({
        kind: level.kind,
        label: `${level.kind.toUpperCase()}${level.touches > 1 ? ` (${level.touches} touches)` : ''}`,
        explain:
          level.kind === 'support'
            ? 'Buyers have stopped price falling here before.'
            : level.kind === 'resistance'
              ? 'Sellers have stopped price rising here before.'
              : level.kind === 'demand'
                ? 'A sharp rally started here - unfilled buy orders may remain.'
                : 'A sharp drop started here - unfilled sell orders may remain.',
        price: level.price,
        time: level.lastTime,
      });
    }
  }

  for (const sweep of sweeps.slice(-2)) {
    annotations.push({
      kind: 'liquidity-sweep',
      label: sweep.direction === 'above-highs' ? 'SWEEP ABOVE HIGHS' : 'SWEEP BELOW LOWS',
      explain:
        'Price traded past an obvious extreme, triggering stops, then closed back on the original side. Only identifiable after that close.',
      price: sweep.price,
      time: sweep.time,
    });
  }

  if (detection) annotations.push(...detection.annotations);

  if (plan.available) {
    annotations.push(
      {
        kind: 'tp1',
        label: 'TP1',
        explain: `First target at ${plan.rr.tp1.toFixed(2)}R. Reaching it means the trade made ${plan.rr.tp1.toFixed(2)} times what it risked.`,
        price: plan.targets.tp1,
        time: last?.time ?? null,
      },
      {
        kind: 'tp2',
        label: 'TP2',
        explain: `Second target at ${plan.rr.tp2.toFixed(2)}R.`,
        price: plan.targets.tp2,
        time: last?.time ?? null,
      },
      {
        kind: 'tp3',
        label: 'TP3',
        explain: `Third target at ${plan.rr.tp3.toFixed(2)}R.`,
        price: plan.targets.tp3,
        time: last?.time ?? null,
      },
    );
  }

  return annotations;
}

/** Convenience used by the scanner to attach a volatility figure to a row. */
export function volatilityPct(candles: Candle[]): number | null {
  return atrPercent(candles, 14);
}
