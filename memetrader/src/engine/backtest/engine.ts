import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  Candle,
  SetupDetection,
} from '../../shared/types.js';
import { isFiniteNumber } from '../indicators.js';
import { detectAt } from '../setups/index.js';
import { computeMetrics } from './metrics.js';

export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, 'assetId' | 'symbol'> = {
  timeframe: '1h',
  strategies: ['breakout-retest', 'support-bounce', 'trend-continuation', 'range-breakout', 'failed-breakout'],
  stopRule: 'structure',
  atrMultiple: 1.5,
  targetR: 2,
  riskPct: 1,
  accountSize: 10_000,
  feesPct: 0.3,
  slippagePct: 0.2,
  trainFraction: 0.6,
  maxBarsInTrade: 60,
};

export const BACKTEST_DISCLAIMER =
  'Past performance does not establish future profitability. These results describe what these exact rules would have done on this exact historical series, including its survivorship and data-quality flaws. They are not a forecast.';

/**
 * Bar-by-bar backtester.
 *
 * Look-ahead prevention, which is the only thing that makes any of these numbers
 * worth reading:
 *   - Strategies are only ever handed `candles.slice(start, i + 1)`. They cannot
 *     index past the decision bar because those bars are not in the array.
 *   - A signal on bar `i` is filled at the OPEN of bar `i + 1`, never at bar i's
 *     close and never at a favourable price inside bar i.
 *   - Exits are checked bar by bar from the fill bar forwards. When one bar's
 *     range contains both the stop and the target we record the STOP, because
 *     intrabar sequence is unknowable from OHLC data and assuming the favourable
 *     one is the classic way a backtest flatters itself.
 *   - The in-sample / out-of-sample split is by bar index, so no out-of-sample
 *     trade can begin before the split point.
 */
export function runBacktest(candles: Candle[], config: BacktestConfig): BacktestResult {
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];

  const clean = candles
    .filter((c) => isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close))
    .filter((c) => c.high >= c.low && c.open > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);

  if (clean.length !== candles.length) {
    warnings.push(
      `${candles.length - clean.length} bar(s) were dropped for having non-finite prices, an inverted high/low, or a non-positive price.`,
    );
  }

  // Duplicate timestamps mean the series is not a clean time index.
  const seen = new Set<number>();
  const deduped: Candle[] = [];
  let duplicates = 0;
  for (const candle of clean) {
    if (seen.has(candle.time)) {
      duplicates += 1;
      continue;
    }
    seen.add(candle.time);
    deduped.push(candle);
  }
  if (duplicates > 0) {
    warnings.push(`${duplicates} bar(s) with duplicate timestamps were dropped.`);
  }

  const bars = deduped;
  const minBars = 70;

  if (bars.length < minBars + 10) {
    return {
      config,
      barsUsed: bars.length,
      firstBarTime: bars[0]?.time ?? null,
      lastBarTime: bars[bars.length - 1]?.time ?? null,
      splitTime: null,
      trades: [],
      inSample: computeMetrics([]),
      outOfSample: computeMetrics([]),
      combined: computeMetrics([]),
      warnings: [
        ...warnings,
        `Not enough bars to backtest: ${bars.length} usable bars against a minimum of ${minBars + 10}.`,
      ],
      disclaimer: BACKTEST_DISCLAIMER,
    };
  }

  const trainFraction = Math.min(0.9, Math.max(0.1, config.trainFraction));
  const splitIndex = Math.floor(bars.length * trainFraction);
  const splitTime = bars[splitIndex]?.time ?? null;

  const feeRate = Math.max(0, config.feesPct) / 100;
  const slipRate = Math.max(0, config.slippagePct) / 100;
  const riskAmount = config.accountSize * (Math.max(0, config.riskPct) / 100);

  let openTrade:
    | (Omit<BacktestTrade, 'exitTime' | 'exitIndex' | 'exitPrice' | 'exitReason' | 'rMultiple' | 'pnl' | 'barsHeld'> & {
        positionSize: number;
      })
    | null = null;

  for (let i = minBars; i < bars.length - 1; i += 1) {
    // ---- Manage an open position on this bar before considering new entries.
    if (openTrade) {
      const bar = bars[i];
      if (!bar) continue;
      if (i <= openTrade.entryIndex) continue;

      const barsHeld = i - openTrade.entryIndex;
      const exit = resolveExit({
        bar,
        direction: openTrade.direction,
        stop: openTrade.stop,
        target: openTrade.target,
        barsHeld,
        maxBarsInTrade: config.maxBarsInTrade,
      });

      if (exit) {
        trades.push(
          closeTrade(openTrade, i, bar.time, exit.price, exit.reason, feeRate, slipRate, barsHeld),
        );
        openTrade = null;
      } else {
        continue; // One position at a time; do not look for a new signal.
      }
    }

    if (openTrade) continue;

    // ---- Look for a signal using only bars up to and including i.
    const detections = detectAt(bars, i, config.strategies, {
      timeframe: config.timeframe,
      stopRule: config.stopRule,
      atrMultiple: config.atrMultiple,
    });
    const detection = pickBest(detections);
    if (!detection) continue;

    const fillBar = bars[i + 1];
    if (!fillBar) continue;

    const isLong = detection.direction === 'long';
    // Fill at the NEXT bar's open, moved against us by the slippage assumption.
    const fillPrice = isLong ? fillBar.open * (1 + slipRate) : fillBar.open * (1 - slipRate);
    if (!isFiniteNumber(fillPrice) || fillPrice <= 0) continue;

    // The stop travels with the signal; if the gap to the open already invalidated
    // it, there is no trade to take.
    const stop = detection.stop;
    if (isLong && stop >= fillPrice) continue;
    if (!isLong && stop <= fillPrice) continue;

    const riskPerUnit = Math.abs(fillPrice - stop);
    if (riskPerUnit <= 0) continue;
    const target = isLong
      ? fillPrice + riskPerUnit * config.targetR
      : fillPrice - riskPerUnit * config.targetR;
    if (target <= 0) continue;

    const positionSize = riskAmount / riskPerUnit;
    if (!isFiniteNumber(positionSize) || positionSize <= 0) continue;

    openTrade = {
      strategy: detection.strategy,
      direction: detection.direction,
      entryTime: fillBar.time,
      entryIndex: i + 1,
      entryPrice: fillPrice,
      stop,
      target,
      segment: i + 1 <= splitIndex ? 'in-sample' : 'out-of-sample',
      positionSize,
    };
  }

  // Close anything still open at the final bar so the equity curve is complete.
  if (openTrade) {
    const lastIndex = bars.length - 1;
    const lastBar = bars[lastIndex];
    if (lastBar) {
      trades.push(
        closeTrade(
          openTrade,
          lastIndex,
          lastBar.time,
          lastBar.close,
          'end-of-data',
          feeRate,
          slipRate,
          lastIndex - openTrade.entryIndex,
        ),
      );
    }
  }

  const inSampleTrades = trades.filter((t) => t.segment === 'in-sample');
  const outOfSampleTrades = trades.filter((t) => t.segment === 'out-of-sample');

  if (outOfSampleTrades.length === 0) {
    warnings.push(
      'No out-of-sample trades were generated. Any conclusion drawn from the in-sample numbers alone is untested.',
    );
  } else if (outOfSampleTrades.length < 20) {
    warnings.push(
      `Only ${outOfSampleTrades.length} out-of-sample trade(s). That is far too few to distinguish an edge from chance.`,
    );
  }
  if (trades.length > 0 && trades.length < 30) {
    warnings.push(
      `${trades.length} total trades is a small sample. Win rate and profit factor computed over this many trades move dramatically with one or two outcomes.`,
    );
  }

  return {
    config,
    barsUsed: bars.length,
    firstBarTime: bars[0]?.time ?? null,
    lastBarTime: bars[bars.length - 1]?.time ?? null,
    splitTime,
    trades,
    inSample: computeMetrics(inSampleTrades),
    outOfSample: computeMetrics(outOfSampleTrades),
    combined: computeMetrics(trades),
    warnings,
    disclaimer: BACKTEST_DISCLAIMER,
  };
}

export interface ExitCheck {
  bar: Candle;
  direction: 'long' | 'short';
  stop: number;
  target: number;
  barsHeld: number;
  maxBarsInTrade: number;
}

/**
 * Decides whether an open position resolves on this bar, and at what price.
 *
 * The rule that matters: when a single bar's range contains BOTH the stop and
 * the target, this returns the stop. OHLC data does not record the order prices
 * were reached within a bar, so assuming the favourable one is how a backtest
 * quietly inflates its own results. Exported so this rule is directly testable.
 */
export function resolveExit(
  check: ExitCheck,
): { price: number; reason: BacktestTrade['exitReason'] } | null {
  const { bar, direction, stop, target, barsHeld, maxBarsInTrade } = check;
  const isLong = direction === 'long';
  const hitStop = isLong ? bar.low <= stop : bar.high >= stop;
  const hitTarget = isLong ? bar.high >= target : bar.low <= target;

  if (hitStop) return { price: stop, reason: 'stop' };
  if (hitTarget) return { price: target, reason: 'target' };
  if (barsHeld >= maxBarsInTrade) return { price: bar.close, reason: 'time' };
  return null;
}

function closeTrade(
  open: {
    strategy: BacktestTrade['strategy'];
    direction: 'long' | 'short';
    entryTime: number;
    entryIndex: number;
    entryPrice: number;
    stop: number;
    target: number;
    segment: BacktestTrade['segment'];
    positionSize: number;
  },
  exitIndex: number,
  exitTime: number,
  rawExitPrice: number,
  exitReason: BacktestTrade['exitReason'],
  feeRate: number,
  slipRate: number,
  barsHeld: number,
): BacktestTrade {
  const isLong = open.direction === 'long';
  // Slippage on the way out works against us too.
  const exitPrice = isLong ? rawExitPrice * (1 - slipRate) : rawExitPrice * (1 + slipRate);
  const move = isLong ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
  const gross = move * open.positionSize;
  const fees = (open.entryPrice + exitPrice) * open.positionSize * feeRate;
  const pnl = gross - fees;
  const riskPerUnit = Math.abs(open.entryPrice - open.stop);
  const riskAmount = riskPerUnit * open.positionSize;
  // R is measured net of costs, so the reported R is what the account actually saw.
  const rMultiple = riskAmount > 0 ? pnl / riskAmount : 0;

  return {
    strategy: open.strategy,
    direction: open.direction,
    entryTime: open.entryTime,
    entryIndex: open.entryIndex,
    entryPrice: open.entryPrice,
    stop: open.stop,
    target: open.target,
    exitTime,
    exitIndex,
    exitPrice,
    exitReason,
    rMultiple,
    pnl,
    barsHeld,
    segment: open.segment,
  };
}

/** When several strategies fire on the same bar, take the one with the tightest stop. */
function pickBest(detections: SetupDetection[]): SetupDetection | null {
  if (detections.length === 0) return null;
  return [...detections].sort((a, b) => {
    const aRisk = Math.abs(a.entry - a.stop) / (a.entry || 1);
    const bRisk = Math.abs(b.entry - b.stop) / (b.entry || 1);
    return aRisk - bRisk;
  })[0] as SetupDetection;
}
