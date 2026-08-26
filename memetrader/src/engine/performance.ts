import type {
  GroupedPerformance,
  PaperTradeRecord,
  PerformanceStats,
} from '../shared/types.js';
import { mean, median, safeDivide } from './indicators.js';
import { maxDrawdownR } from './backtest/metrics.js';

/**
 * Sample-size thresholds. These are deliberately conservative: a win rate over
 * ten trades tells you almost nothing, and the app says so rather than showing a
 * confident-looking percentage.
 */
const CONFIDENCE_BANDS: { min: number; level: PerformanceStats['confidence']; note: string }[] = [
  {
    min: 100,
    level: 'REASONABLE',
    note: 'Sample is large enough that the headline numbers are meaningful, though markets change and past behaviour still does not guarantee future behaviour.',
  },
  {
    min: 30,
    level: 'MODERATE',
    note: 'Sample is large enough to see a pattern but small enough that a handful of trades still moves every statistic. Keep recording.',
  },
  {
    min: 10,
    level: 'LOW',
    note: 'Need substantially more observations. At this sample size the win rate is dominated by chance.',
  },
  {
    min: 1,
    level: 'LOW',
    note: 'Need substantially more observations. Nothing here should be treated as evidence of an edge.',
  },
];

export function computePerformance(trades: PaperTradeRecord[]): PerformanceStats {
  const closed = trades
    .filter((t) => t.status === 'closed' && t.rMultiple !== null)
    .sort((a, b) => (a.closedAt ?? a.createdAt) - (b.closedAt ?? b.createdAt));

  const rs = closed.map((t) => t.rMultiple as number);
  const wins = closed.filter((t) => (t.rMultiple as number) > 0);
  const losses = closed.filter((t) => (t.rMultiple as number) < 0);
  const breakEven = closed.filter((t) => (t.rMultiple as number) === 0);

  const grossProfitR = wins.reduce((acc, t) => acc + (t.rMultiple as number), 0);
  const grossLossR = Math.abs(losses.reduce((acc, t) => acc + (t.rMultiple as number), 0));

  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let winStreak = 0;
  let lossStreak = 0;
  for (const trade of closed) {
    const r = trade.rMultiple as number;
    if (r > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else if (r < 0) {
      lossStreak += 1;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    if (winStreak > maxConsecutiveWins) maxConsecutiveWins = winStreak;
    if (lossStreak > maxConsecutiveLosses) maxConsecutiveLosses = lossStreak;
  }

  const holdingMinutes = closed
    .filter((t) => t.closedAt !== null)
    .map((t) => ((t.closedAt as number) - t.createdAt) / 60_000)
    .filter((m) => Number.isFinite(m) && m >= 0);

  const band = CONFIDENCE_BANDS.find((b) => closed.length >= b.min);

  let cumulative = 0;
  const equityCurveR = closed.map((trade, index) => {
    cumulative += trade.rMultiple as number;
    return { index: index + 1, cumulativeR: cumulative, time: trade.closedAt ?? trade.createdAt };
  });

  return {
    sampleSize: closed.length,
    confidence: band ? band.level : 'NONE',
    confidenceNote: band ? band.note : 'No closed trades recorded yet.',
    wins: wins.length,
    losses: losses.length,
    breakEven: breakEven.length,
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    averageWinner: wins.length > 0 ? mean(wins.map((t) => t.pnl ?? 0)) : null,
    averageLoser: losses.length > 0 ? mean(losses.map((t) => t.pnl ?? 0)) : null,
    expectancyR: mean(rs),
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : null,
    averageR: mean(rs),
    medianR: median(rs),
    maxDrawdownR: maxDrawdownR(rs),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    averageHoldingMinutes: mean(holdingMinutes),
    totalPnl: closed.reduce((acc, t) => acc + (t.pnl ?? 0), 0),
    byStrategy: groupBy(closed, (t) => t.strategy ?? 'unspecified'),
    byTimeframe: groupBy(closed, (t) => t.timeframe),
    equityCurveR,
  };
}

function groupBy(
  trades: PaperTradeRecord[],
  keyOf: (trade: PaperTradeRecord) => string,
): GroupedPerformance[] {
  const buckets = new Map<string, PaperTradeRecord[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const list = buckets.get(key);
    if (list) list.push(trade);
    else buckets.set(key, [trade]);
  }

  return [...buckets.entries()]
    .map(([key, list]) => {
      const rs = list.map((t) => t.rMultiple as number);
      const wins = list.filter((t) => (t.rMultiple as number) > 0).length;
      return {
        key,
        trades: list.length,
        winRatePct: list.length > 0 ? (wins / list.length) * 100 : null,
        averageR: mean(rs),
        expectancyR: mean(rs),
        totalR: rs.reduce((acc, r) => acc + r, 0),
      } satisfies GroupedPerformance;
    })
    .sort((a, b) => b.totalR - a.totalR);
}

/**
 * Best and worst performing group, but only when there is enough data per group
 * to say anything. Returns nulls rather than crowning a winner off three trades.
 */
export function bestAndWorst(
  groups: GroupedPerformance[],
  minTrades = 10,
): { best: GroupedPerformance | null; worst: GroupedPerformance | null; note: string } {
  const eligible = groups.filter((g) => g.trades >= minTrades);
  if (eligible.length < 2) {
    return {
      best: null,
      worst: null,
      note: `Needs at least two groups with ${minTrades}+ trades each before ranking them means anything. Currently ${eligible.length} qualify.`,
    };
  }
  const sorted = [...eligible].sort((a, b) => (b.expectancyR ?? 0) - (a.expectancyR ?? 0));
  return {
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    note: `Ranked by expectancy across groups with at least ${minTrades} trades.`,
  };
}

/** Percentage of the account the trade risked, for display in the journal. */
export function riskPctOf(trade: PaperTradeRecord): number | null {
  if (trade.riskAmount === null || trade.accountSize === null) return null;
  const pct = safeDivide(trade.riskAmount, trade.accountSize);
  return pct === null ? null : pct * 100;
}
