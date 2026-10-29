import type { Candle } from '../engine/types.js';
import { BOOTSTRAP } from './config.js';

export interface ResearchTrade {
  symbol: string;
  strategy: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitReason: string;
  shares: number;
  plannedRisk: number;
  pnl: number;
  rMultiple: number;
}

export interface Summary {
  trades: number;
  netPnl: number;
  /** Net P&L as a % of starting capital. */
  netReturnPct: number;
  expectancy: number | null;
  expectancyR: number | null;
  /** Bootstrap confidence interval for the average R per trade. */
  expectancyRci: [number, number] | null;
  profitFactor: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  /** Share of trading days with a position open. */
  exposurePct: number;
}

/** Deterministic PRNG so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap of the mean. Returns null below 5 observations — too few to resample meaningfully. */
export function bootstrapMeanCI(xs: number[], cfg = BOOTSTRAP): [number, number] | null {
  if (xs.length < 5) return null;
  const rnd = mulberry32(cfg.seed);
  const means: number[] = [];
  for (let r = 0; r < cfg.resamples; r++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rnd() * xs.length)]!;
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - cfg.confidence) / 2;
  return [means[Math.floor(tail * (means.length - 1))]!, means[Math.ceil((1 - tail) * (means.length - 1))]!];
}

/**
 * Counts each trading day at most once even if trades overlap, so exposure
 * can never exceed 100% (one of the double-counting checks).
 */
export function exposure(trades: { entryTime: number; exitTime: number }[], bars: Candle[]): number {
  if (!bars.length) return 0;
  let inMarket = 0;
  for (const b of bars) if (trades.some((t) => b.t >= t.entryTime && b.t <= t.exitTime)) inMarket++;
  return inMarket / bars.length;
}

export function summarize(trades: ResearchTrade[], bars: Candle[], startingCapital: number): Summary {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const wins = ordered.filter((t) => t.pnl > 0);
  const losses = ordered.filter((t) => t.pnl <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const grossWin = sum(wins.map((t) => t.pnl));
  const grossLoss = -sum(losses.map((t) => t.pnl));
  let equity = startingCapital;
  let peak = startingCapital;
  let dd = 0;
  let ddPct = 0;
  for (const t of ordered) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    ddPct = Math.max(ddPct, peak > 0 ? (peak - equity) / peak : 0);
  }
  const n = ordered.length;
  const net = sum(ordered.map((t) => t.pnl));
  const rs = ordered.map((t) => t.rMultiple);
  return {
    trades: n,
    netPnl: net,
    netReturnPct: (net / startingCapital) * 100,
    expectancy: n ? net / n : null,
    expectancyR: n ? sum(rs) / n : null,
    expectancyRci: bootstrapMeanCI(rs),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    winRate: n ? wins.length / n : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    maxDrawdownUsd: dd,
    maxDrawdownPct: ddPct * 100,
    exposurePct: exposure(ordered, bars) * 100,
  };
}

export function inRange(t: number, startDate: string, endDate: string): boolean {
  return t >= Date.parse(`${startDate}T00:00:00Z`) && t < Date.parse(`${endDate}T23:59:59Z`);
}

/** Buy at the first open of the period, sell at the last close, on a total-return (dividend-adjusted) series. */
export function buyAndHoldPct(adjusted: Candle[], startDate: string, endDate: string): number | null {
  const bars = adjusted.filter((b) => inRange(b.t, startDate, endDate));
  if (bars.length < 2) return null;
  return (bars[bars.length - 1]!.c / bars[0]!.o - 1) * 100;
}
