import type { BacktestMetrics, BacktestTrade } from '../../shared/types.js';
import { mean, median, safeDivide, stdev } from '../indicators.js';

/** Sample size below which a Sharpe ratio is noise rather than a measurement. */
export const MIN_TRADES_FOR_SHARPE = 30;

/** Peak-to-trough decline of a cumulative-R equity curve. Always >= 0. */
export function maxDrawdownR(rMultiples: number[]): number | null {
  if (rMultiples.length === 0) return null;
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  for (const r of rMultiples) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > worst) worst = drawdown;
  }
  return worst;
}

export function longestLosingStreak(rMultiples: number[]): number {
  let current = 0;
  let longest = 0;
  for (const r of rMultiples) {
    if (r < 0) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function computeMetrics(trades: BacktestTrade[]): BacktestMetrics {
  const rs = trades.map((t) => t.rMultiple);
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple < 0);

  const grossProfit = wins.reduce((acc, t) => acc + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.rMultiple, 0));

  const winRatePct = trades.length > 0 ? (wins.length / trades.length) * 100 : null;
  const averageR = mean(rs);
  const returnPcts = trades.map((t) => {
    const move = t.direction === 'long' ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice;
    const pct = safeDivide(move, t.entryPrice);
    return pct === null ? 0 : pct * 100;
  });

  // Expectancy is the mean R per trade - the same number, named for what it means.
  const expectancyR = averageR;

  let sharpe: number | null = null;
  let sharpeNote: string;
  if (trades.length < MIN_TRADES_FOR_SHARPE) {
    sharpeNote = `Not reported: ${trades.length} trades is below the ${MIN_TRADES_FOR_SHARPE}-trade minimum this app requires before a Sharpe ratio means anything.`;
  } else {
    const sd = stdev(rs);
    const avg = mean(rs);
    if (sd === null || sd === 0 || avg === null) {
      sharpeNote = 'Not reported: the dispersion of returns was zero or could not be computed.';
    } else {
      sharpe = avg / sd;
      sharpeNote =
        'Per-trade Sharpe: mean R divided by the standard deviation of R. Not annualised - trades are not evenly spaced in time, so annualising would be arbitrary.';
    }
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct,
    averageReturnPct: mean(returnPcts),
    averageR,
    expectancyR,
    // With no losing trades there is no denominator; reporting Infinity would
    // imply a certainty the sample cannot support.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownR: maxDrawdownR(rs),
    sharpe,
    sharpeNote,
    largestWinR: wins.length > 0 ? Math.max(...wins.map((t) => t.rMultiple)) : null,
    largestLossR: losses.length > 0 ? Math.min(...losses.map((t) => t.rMultiple)) : null,
    longestLosingStreak: longestLosingStreak(rs),
    totalR: rs.reduce((acc, r) => acc + r, 0),
    totalPnl: trades.reduce((acc, t) => acc + t.pnl, 0),
  };
}

export function medianR(trades: BacktestTrade[]): number | null {
  return median(trades.map((t) => t.rMultiple));
}
