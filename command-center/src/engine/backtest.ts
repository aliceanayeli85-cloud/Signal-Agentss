import { analyze } from './analysis.js';
import { applySlippage, estimateRoundTripCosts, limitSellFilled, sellFees, sizePosition } from './costs.js';
import { buildTradePlan } from './plan.js';
import { checkEntry, type AccountState } from './risk.js';
import type { RiskSettings } from './settings.js';
import { nyParts } from './time.js';
import type { Candle, Timeframe } from './types.js';

/** Same window the live analysis uses, so live and backtest see the same amount of history. */
export const ANALYSIS_WINDOW = 300;

export interface BacktestParams {
  timeframe: Timeframe;
  settings: RiskSettings;
  maxHoldBars: number;
  warmupBars: number;
  outOfSampleFraction: number;
}

export interface BacktestTrade {
  setupType: string;
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  stop: number;
  tp1: number;
  tp2: number;
  shares: number;
  plannedRisk: number;
  exitTime: number;
  exitReason: string;
  pnl: number;
  rMultiple: number;
  sample: 'in' | 'out';
}

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgGain: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgR: number | null;
  totalPnl: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
}

export interface BacktestResult {
  bars: number;
  firstBar: number | null;
  lastBar: number | null;
  trades: BacktestTrade[];
  all: Metrics;
  inSample: Metrics;
  outOfSample: Metrics;
  endingEquity: number;
  warnings: string[];
  assumptions: string[];
}

export const BACKTEST_ASSUMPTIONS = [
  'Decisions use only candles that had closed at the time (history is sliced at the decision bar).',
  'Signals fill on a LATER candle: breakouts at the next open, trigger setups only if the next candle trades through the trigger.',
  'If one candle touches both the stop and a target, the stop is assumed to have happened first.',
  'If a candle opens below the stop (a gap), the exit is at that open, not at the stop.',
  'Slippage is applied to every market fill; regulatory sell fees are charged; commission as configured.',
  'One position at a time. Daily loss, consecutive-loss and trade-count limits are applied as in live trading.',
  'Targets are limit orders: they fill at the target price only if price trades at least one cent through it.',
  'Position size is recalculated at the actual fill price, so a worse fill never raises the planned loss above the risk budget.',
];

/**
 * Bar-by-bar simulation using the live analysis and plan code. A trade is
 * taken only when the live plan builder would have said TRADE PLAN.
 */
export function runBacktest(candles: Candle[], p: BacktestParams): BacktestResult {
  const s = p.settings;
  const trades: BacktestTrade[] = [];
  const split = Math.floor(candles.length * (1 - p.outOfSampleFraction));
  let equity = s.startingCapitalUsd;
  const day = { key: '', pnl: 0, trades: 0, consecutive: 0, lossSymbols: [] as string[] };
  let lastLossAt: number | null = null;

  let i = Math.max(p.warmupBars, 30);
  while (i < candles.length - 1) {
    const bar = candles[i]!;
    const dk = nyParts(bar.t).dateKey;
    if (dk !== day.key) Object.assign(day, { key: dk, pnl: 0, trades: 0, consecutive: 0, lossSymbols: [] });

    const hist = candles.slice(Math.max(0, i + 1 - ANALYSIS_WINDOW), i + 1);
    const an = analyze(hist, p.timeframe);
    if (!an.setups.length) {
      i++;
      continue;
    }
    const now = bar.t + 1;
    const account: AccountState = {
      equity,
      cash: equity,
      openRiskUsd: 0,
      openSymbols: [],
      workingOrders: [],
      todayRealizedPnl: day.pnl,
      tradesToday: day.trades,
      consecutiveLossesToday: day.consecutive,
      lastLoss: lastLossAt !== null ? { symbol: 'BT', at: lastLossAt } : null,
      lossSymbolsToday: [],
      killSwitch: false,
    };
    const guard = checkEntry(s, account, null, now);
    const plan = buildTradePlan({ symbol: 'BT', analysis: an, quote: { price: bar.c, time: now, source: 'backtest' }, settings: s, cashUsd: equity, guard, now, marketOpen: null });
    if (plan.status !== 'TRADE_PLAN' || plan.shares === null || plan.stop === null || !plan.tp1 || !plan.tp2 || plan.entryLow === null || plan.entryHigh === null) {
      i++;
      continue;
    }

    const next = candles[i + 1]!;
    const chaseLimit = plan.entryHigh + (an.atr14 ?? 0) * 0.25;
    let rawFill: number | null;
    if (plan.setupType === 'BREAKOUT') rawFill = next.o;
    else rawFill = next.h >= plan.entryLow ? Math.max(next.o, plan.entryLow) : null;
    if (rawFill === null || rawFill > chaseLimit || rawFill <= plan.stop) {
      i++;
      continue;
    }
    const fill = applySlippage(rawFill, 'buy', s);
    // Re-size at the price actually paid: a fill above the planned entry must not push the loss past the budget.
    const atFill = sizePosition(rawFill, plan.stop, guard.riskBudgetUsd, equity, s);
    if (atFill.problem !== null) {
      i++;
      continue;
    }
    const shares = Math.min(plan.shares, atFill.shares);
    const sim = simulateExit(candles, i + 1, fill, shares, { stop: plan.stop, tp1: plan.tp1.price, tp2: plan.tp2.price }, s, p.maxHoldBars);
    const { proceeds, exitReason, exitIdx } = sim;
    const pnl = proceeds - shares * fill - s.commissionPerOrderUsd;
    const plannedRisk = shares * (rawFill - plan.stop) + estimateRoundTripCosts(shares, rawFill, plan.stop, s).total;
    equity += pnl;
    trades.push({
      setupType: plan.setupType ?? 'unknown',
      signalTime: bar.t,
      entryTime: next.t,
      entryPrice: fill,
      stop: plan.stop,
      tp1: plan.tp1.price,
      tp2: plan.tp2.price,
      shares,
      plannedRisk,
      exitTime: candles[exitIdx]!.t,
      exitReason,
      pnl,
      rMultiple: plannedRisk > 0 ? pnl / plannedRisk : 0,
      sample: i < split ? 'in' : 'out',
    });
    const exitDay = nyParts(candles[exitIdx]!.t).dateKey;
    if (exitDay !== day.key) Object.assign(day, { key: exitDay, pnl: 0, trades: 0, consecutive: 0, lossSymbols: [] });
    day.pnl += pnl;
    day.trades += 1;
    if (pnl < 0) {
      day.consecutive += 1;
      lastLossAt = candles[exitIdx]!.t;
    } else day.consecutive = 0;
    i = exitIdx + 1;
  }

  const all = computeMetrics(trades, s.startingCapitalUsd);
  const warnings: string[] = ['Past results do not show that a strategy will be profitable in the future.'];
  if (all.trades < 30) warnings.push(`Only ${all.trades} trades. Fewer than 30 trades is too small a sample to judge a strategy — a few lucky or unlucky trades dominate the numbers.`);
  if (candles.length < 250) warnings.push(`Only ${candles.length} candles of history were available.`);
  return {
    bars: candles.length,
    firstBar: candles[0]?.t ?? null,
    lastBar: candles[candles.length - 1]?.t ?? null,
    trades,
    all,
    inSample: computeMetrics(trades.filter((t) => t.sample === 'in'), s.startingCapitalUsd),
    outOfSample: computeMetrics(trades.filter((t) => t.sample === 'out'), s.startingCapitalUsd),
    endingEquity: equity,
    warnings,
    assumptions: BACKTEST_ASSUMPTIONS,
  };
}

export interface ExitLevels {
  stop: number;
  tp1: number;
  tp2: number;
}

export interface ExitResult {
  proceeds: number;
  exitReason: string;
  exitIdx: number;
}

/**
 * Walks forward from the fill candle until the trade is closed. Conservative
 * on purpose: stop before target when both are inside one candle, gap exits at
 * the open, and the breakeven stop only starts on the candle after TP1.
 */
export function simulateExit(candles: Candle[], fillIdx: number, fill: number, shares: number, lv: ExitLevels, s: RiskSettings, maxHoldBars: number): ExitResult {
  let qty = shares;
  let stop = lv.stop;
  let tp1Done = false;
  let proceeds = 0;
  let exitReason = 'time exit';
  let exitIdx = fillIdx;
  const sell = (q: number, px: number) => {
    proceeds += q * px - sellFees(q, px, s);
    qty -= q;
  };

  for (let j = fillIdx; j < candles.length && qty > 1e-9; j++) {
    const c = candles[j]!;
    exitIdx = j;
    // A gap below the stop exits at the open (not on the fill candle, where we bought at or after the open).
    if (j !== fillIdx && c.o <= stop) {
      sell(qty, applySlippage(c.o, 'sell', s));
      exitReason = tp1Done ? 'breakeven stop (gap)' : 'stop (gap below stop)';
      break;
    }
    if (c.l <= stop) {
      sell(qty, applySlippage(stop, 'sell', s));
      exitReason = tp1Done ? 'breakeven stop' : 'stop';
      break;
    }
    if (!tp1Done && limitSellFilled(c.h, lv.tp1)) {
      let half = s.allowFractional ? Math.floor((shares / 2) * 1e6) / 1e6 : Math.floor(shares / 2);
      if (half <= 0) half = qty;
      sell(half, lv.tp1);
      tp1Done = true;
      exitReason = 'take-profit 1';
    }
    if (qty > 1e-9 && limitSellFilled(c.h, lv.tp2)) {
      sell(qty, lv.tp2);
      exitReason = 'take-profit 2';
      break;
    }
    if (tp1Done) stop = Math.max(stop, fill);
    if (qty > 1e-9 && j - fillIdx >= maxHoldBars) {
      sell(qty, applySlippage(c.c, 'sell', s));
      exitReason = tp1Done ? 'time exit after take-profit 1' : 'time exit';
      break;
    }
  }
  if (qty > 1e-9) {
    // Data ran out while the trade was open: mark it at the last close.
    const last = candles.length - 1;
    sell(qty, applySlippage(candles[last]!.c, 'sell', s));
    exitReason = 'open at end of data (marked at last close)';
    exitIdx = last;
  }
  return { proceeds, exitReason, exitIdx };
}

export function computeMetrics(trades: { pnl: number; rMultiple: number }[], startingCapital: number): Metrics {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const grossWin = sum(wins.map((t) => t.pnl));
  const grossLoss = -sum(losses.map((t) => t.pnl));
  let equity = startingCapital;
  let peak = startingCapital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  const n = trades.length;
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : null,
    avgGain: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: n ? sum(trades.map((t) => t.pnl)) / n : null,
    avgR: n ? sum(trades.map((t) => t.rMultiple)) / n : null,
    totalPnl: sum(trades.map((t) => t.pnl)),
    maxDrawdownUsd: maxDd,
    maxDrawdownPct: maxDdPct,
  };
}
