import { applySlippage, estimateRoundTripCosts, sellFees, sizePosition } from '../engine/costs.js';
import { simulateExit, type ExitResult } from '../engine/backtest.js';
import { checkEntry, type AccountState } from '../engine/risk.js';
import type { RiskSettings } from '../engine/settings.js';
import { nyParts } from '../engine/time.js';
import type { Candle } from '../engine/types.js';
import type { ResearchTrade } from './stats.js';
import { buildCtx, type Strategy } from './strategies.js';

/**
 * Runs a pre-registered strategy through the SAME risk machinery as the live
 * app: $1 budget (2% equity cap), sizing at the actual fill, $50 position cap,
 * daily loss / losing-streak / trade-count limits, costs and slippage, and the
 * audited conservative exit simulation.
 */
export function runStrategy(symbol: string, candles: Candle[], strat: Strategy, s: RiskSettings): ResearchTrade[] {
  const ctx = buildCtx(candles);
  const trades: ResearchTrade[] = [];
  let equity = s.startingCapitalUsd;
  const day = { key: '', pnl: 0, trades: 0, consecutive: 0 };
  let lastLossAt: number | null = null;

  let i = Math.max(strat.warmupBars, 30);
  while (i < candles.length - 1) {
    const bar = candles[i]!;
    const dk = nyParts(bar.t).dateKey;
    if (dk !== day.key) Object.assign(day, { key: dk, pnl: 0, trades: 0, consecutive: 0 });
    const sig = strat.signal(ctx, i);
    if (!sig) {
      i++;
      continue;
    }
    const account: AccountState = {
      equity,
      cash: equity,
      openRiskUsd: 0,
      openSymbols: [],
      workingOrders: [],
      todayRealizedPnl: day.pnl,
      tradesToday: day.trades,
      consecutiveLossesToday: day.consecutive,
      lastLoss: lastLossAt !== null ? { symbol, at: lastLossAt } : null,
      lossSymbolsToday: [],
      killSwitch: false,
    };
    const guard = checkEntry(s, account, null, bar.t + 1);
    const next = candles[i + 1]!;
    let raw: number | null = null;
    if (sig.entry.type === 'next_open') raw = next.o;
    else if (next.h >= sig.entry.price) raw = Math.max(next.o, sig.entry.price);
    if (!guard.allowed || raw === null || raw <= sig.stop || (sig.entry.type === 'trigger' && raw > sig.entry.maxFill)) {
      i++;
      continue;
    }
    const size = sizePosition(raw, sig.stop, guard.riskBudgetUsd, equity, s);
    if (size.problem !== null) {
      i++;
      continue;
    }
    const fill = applySlippage(raw, 'buy', s);
    const r = raw - sig.stop;
    const sim =
      sig.exit.type === 'targets'
        ? simulateExit(candles, i + 1, fill, size.shares, { stop: sig.stop, tp1: raw + sig.exit.tp1R * r, tp2: raw + sig.exit.tp2R * r }, s, sig.exit.maxHoldBars)
        : simulateChannelExit(candles, i + 1, fill, size.shares, sig.stop, sig.exit.lookback, sig.exit.maxHoldBars, s);
    const pnl = sim.proceeds - size.shares * fill - s.commissionPerOrderUsd;
    const plannedRisk = size.shares * r + estimateRoundTripCosts(size.shares, raw, sig.stop, s).total;
    equity += pnl;
    const exitT = candles[sim.exitIdx]!.t;
    trades.push({ symbol, strategy: strat.id, entryTime: next.t, exitTime: exitT, entryPrice: fill, exitReason: sim.exitReason, shares: size.shares, plannedRisk, pnl, rMultiple: plannedRisk > 0 ? pnl / plannedRisk : 0 });

    const exitDay = nyParts(exitT).dateKey;
    if (exitDay !== day.key) Object.assign(day, { key: exitDay, pnl: 0, trades: 0, consecutive: 0 });
    day.pnl += pnl;
    day.trades += 1;
    if (pnl < 0) {
      day.consecutive += 1;
      lastLossAt = exitT;
    } else day.consecutive = 0;
    i = sim.exitIdx + 1;
  }
  return trades;
}

/**
 * Trend-following exit: a protective stop, plus a channel exit decided on a
 * completed candle's CLOSE and executed at the NEXT open (never at the close
 * that revealed it — that would be look-ahead).
 */
export function simulateChannelExit(candles: Candle[], fillIdx: number, _fill: number, shares: number, stop: number, lookback: number, maxHoldBars: number, s: RiskSettings): ExitResult {
  let pendingExit = false;
  const sell = (px: number) => shares * px - sellFees(shares, px, s);
  for (let j = fillIdx; j < candles.length; j++) {
    const c = candles[j]!;
    if (pendingExit) return { proceeds: sell(applySlippage(c.o, 'sell', s)), exitReason: 'channel exit (next open)', exitIdx: j };
    if (j !== fillIdx && c.o <= stop) return { proceeds: sell(applySlippage(c.o, 'sell', s)), exitReason: 'stop (gap below stop)', exitIdx: j };
    if (c.l <= stop) return { proceeds: sell(applySlippage(stop, 'sell', s)), exitReason: 'stop', exitIdx: j };
    if (j - fillIdx >= maxHoldBars) return { proceeds: sell(applySlippage(c.c, 'sell', s)), exitReason: 'time exit', exitIdx: j };
    if (j > fillIdx && j >= lookback) {
      let low = Infinity;
      for (let k = j - lookback; k < j; k++) low = Math.min(low, candles[k]!.l);
      if (c.c < low) pendingExit = true;
    }
  }
  const last = candles.length - 1;
  return { proceeds: sell(applySlippage(candles[last]!.c, 'sell', s)), exitReason: 'open at end of data (marked at last close)', exitIdx: last };
}
