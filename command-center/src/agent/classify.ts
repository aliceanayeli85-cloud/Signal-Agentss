import type { Analysis } from '../engine/analysis.js';
import { estimateRoundTripCosts, sizePosition } from '../engine/costs.js';
import type { TradePlan } from '../engine/plan.js';
import { effectiveRiskPerTrade, type RiskSettings } from '../engine/settings.js';
import type { Forecast } from './model.js';
import type { Signal, Technicals } from './signals.js';

export type Classification = 'STRONG BUY SETUP' | 'BUY WATCHLIST' | 'HOLD' | 'SELL WATCH' | 'AVOID' | 'NO TRADE';

export const CLASS_ORDER: Classification[] = ['STRONG BUY SETUP', 'BUY WATCHLIST', 'HOLD', 'SELL WATCH', 'AVOID', 'NO TRADE'];

/** Fixed thresholds. Shown verbatim in the app so every label can be checked. */
export const THRESHOLDS = {
  forecastEdge: 0.05,
  minRewardRisk: 1.5,
  maxRsiForBuy: 75,
  maxCostShareOfReward: 0.1,
  minOrderUsd: 1,
  lowRiskAtr: 0.02,
  mediumRiskAtr: 0.04,
};

export const CLASS_RULES: Record<Classification, string> = {
  'STRONG BUY SETUP': `A VALIDATED 20-day forecast with P(up) at least ${THRESHOLDS.forecastEdge * 100} points above the historical base rate, and expected return more than twice the trading costs; plus a plan with reward-to-risk ≥ ${THRESHOLDS.minRewardRisk}, an uptrend, and a position that fits your capital. While no forecast horizon is validated, nothing can receive this label.`,
  'BUY WATCHLIST': `A concrete plan (pattern setup or 20-day breakout) with reward-to-risk ≥ ${THRESHOLDS.minRewardRisk}, daily uptrend, weekly trend not down, RSI ≤ ${THRESHOLDS.maxRsiForBuy}, and no validated forecast pointing down. Means "conditions met — watch for the entry", not "likely to profit".`,
  HOLD: 'You own it and no exit condition is met.',
  'SELL WATCH': 'You own it and at least one exit condition is met: a 20-day breakdown, a downtrend below the 50-day average, a death cross below the 200-day average, or a validated forecast pointing down.',
  AVOID: 'Downtrend below the 200-day average, a 20-day breakdown, a recent failed breakout, or a validated forecast pointing down.',
  'NO TRADE': 'None of the above, or not enough data. Waiting is a valid decision.',
};

export interface AgentPlan {
  source: 'pattern' | 'breakout';
  label: string;
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  tp2: number;
  rewardRisk: number;
  invalidation: string;
  confirmation: string[];
}

/**
 * Plan checks that depend on YOUR account (cash, budget, kill switch) or on the
 * quote being live are judged separately by sizing. Every other check of the
 * pattern plan — trend, RSI, over-extension, reward-to-risk, chasing, failed
 * breakout — must pass, or the pattern is not used.
 */
const ACCOUNT_CHECKS = new Set(['Market data', 'Position size possible', 'Within risk budget', 'Account risk rules']);

export function technicalChecksPass(p: TradePlan): boolean {
  return p.checks.filter((c) => !ACCOUNT_CHECKS.has(c.name)).every((c) => c.pass);
}

export function planFor(t: Technicals, an: Analysis, pattern: TradePlan | null, signals: Signal[]): AgentPlan | null {
  if (pattern && technicalChecksPass(pattern) && pattern.plannedEntry !== null && pattern.stop !== null && pattern.tp1 && pattern.tp2 && pattern.entryLow !== null && pattern.entryHigh !== null) {
    return {
      source: 'pattern',
      label: pattern.setupLabel ?? 'Pattern setup',
      entryLow: pattern.entryLow,
      entryHigh: pattern.entryHigh,
      stop: pattern.stop,
      tp1: pattern.tp1.price,
      tp2: pattern.tp2.price,
      rewardRisk: pattern.rewardRisk ?? 0,
      invalidation: pattern.invalidation ?? 'A close below the stop.',
      confirmation: pattern.confirmation,
    };
  }
  if (signals.some((s) => s.id === 'breakout_20d') && t.atr14 !== null && t.sma200 !== null && t.close > t.sma200 && t.high20 !== null) {
    const entryHigh = t.close + 0.25 * t.atr14;
    const stop = t.close - 2 * t.atr14;
    const r = entryHigh - stop;
    return {
      source: 'breakout',
      label: '20-day breakout above the 200-day average',
      entryLow: t.close,
      entryHigh,
      stop,
      tp1: entryHigh + 2 * r,
      tp2: entryHigh + 3 * r,
      rewardRisk: 2,
      invalidation: `A close back below the old 20-day high $${t.high20.toFixed(2)} would make it a failed breakout.`,
      confirmation: ['Buy only within the entry range at the next session; do not chase above it.'],
    };
  }
  void an;
  return null;
}

export interface Capital {
  cash: number;
  equity: number;
}

export interface Sizing {
  riskBudget: number;
  shares: number;
  notional: number;
  maxLoss: number;
  costs: number;
  rewardAtTp1: number;
  costShareOfReward: number | null;
  /** What a full $1-risk position would need (capped at the $50 position limit). */
  capitalNeededForFullSize: number;
  fit: 'FITS' | 'NO CASH' | 'RISK BUDGET TOO SMALL' | 'COSTS TOO HIGH';
  message: string;
}

/**
 * Small-account sizing: the loss at the stop stays within the risk budget
 * (2% of YOUR equity, so about $0.11 on a $5 account), fractional shares,
 * Robinhood's $1 minimum, estimated spread + slippage + regulatory fees.
 */
export function sizeFor(plan: AgentPlan, cap: Capital, s: RiskSettings, spreadPct: number | null): Sizing {
  const budget = effectiveRiskPerTrade(s, cap.equity);
  const full = sizePosition(plan.entryHigh, plan.stop, s.riskPerTradeUsd, s.maxPositionUsd, s);
  const capitalNeededForFullSize = full.problem === null ? full.notional * (1 + s.slippageBps / 10_000) : 0;
  const base = { riskBudget: budget, capitalNeededForFullSize };
  if (cap.cash < THRESHOLDS.minOrderUsd) {
    return { ...base, shares: 0, notional: 0, maxLoss: 0, costs: 0, rewardAtTp1: 0, costShareOfReward: null, fit: 'NO CASH', message: `You have $${cap.cash.toFixed(2)} available. Robinhood's minimum order is $1. Keep your money, add funds, or sell something first.` };
  }
  const size = sizePosition(plan.entryHigh, plan.stop, budget, cap.cash, s);
  if (size.problem !== null) {
    return { ...base, shares: 0, notional: 0, maxLoss: 0, costs: 0, rewardAtTp1: 0, costShareOfReward: null, fit: 'RISK BUDGET TOO SMALL', message: `${size.problem} Your risk budget is $${budget.toFixed(2)} (2% of $${cap.equity.toFixed(2)}). Keep your money rather than force a trade.` };
  }
  const spreadCost = spreadPct !== null ? size.shares * plan.entryHigh * spreadPct : 0;
  const costs = estimateRoundTripCosts(size.shares, plan.entryHigh, plan.tp1, s).total + spreadCost;
  const reward = size.shares * (plan.tp1 - plan.entryHigh);
  const share = reward > 0 ? costs / reward : null;
  const fit = share === null || share > THRESHOLDS.maxCostShareOfReward ? 'COSTS TOO HIGH' : 'FITS';
  return {
    ...base,
    shares: size.shares,
    notional: size.notional,
    maxLoss: size.maxLossAtStop + spreadCost,
    costs,
    rewardAtTp1: reward,
    costShareOfReward: share,
    fit,
    message:
      fit === 'FITS'
        ? `About $${size.notional.toFixed(2)} for ${size.shares} shares; loses about $${(size.maxLossAtStop + spreadCost).toFixed(2)} at the stop (more on a gap).`
        : `Costs (about $${costs.toFixed(2)}) would eat ${share === null ? 'all' : `${Math.round(share * 100)}%`} of the reward at the first target. Not worth it at this size — keep your money.`,
  };
}

export interface ClassInput {
  held: boolean;
  t: Technicals;
  an: Analysis;
  signals: Signal[];
  plan: AgentPlan | null;
  sizing: Sizing | null;
  f20: Forecast;
  dataOk: boolean;
}

export function classify(x: ClassInput): { classification: Classification; reasons: string[] } {
  const has = (id: string) => x.signals.some((s) => s.id === id);
  const trend = x.an.trend.trend;
  const htf = x.an.higherTimeframe?.trend.trend ?? 'unknown';
  const validated = x.f20.status === 'OK' && x.f20.pUp !== null;
  const fDown = validated && x.f20.pUp! <= x.f20.baseRate - THRESHOLDS.forecastEdge;
  const fUp = validated && x.f20.pUp! >= x.f20.baseRate + THRESHOLDS.forecastEdge;
  const below = (a: number | null) => a !== null && x.t.close < a;
  if (!x.dataOk) return { classification: 'NO TRADE', reasons: ['Not enough clean data to judge.'] };

  if (x.held) {
    const exits: string[] = [];
    if (has('breakdown_20d')) exits.push('closed below its 20-day low');
    if (trend === 'downtrend' && below(x.t.sma50)) exits.push('is in a downtrend below its 50-day average');
    if (has('death_cross') && below(x.t.sma200)) exits.push('had a death cross and trades below its 200-day average');
    if (fDown) exits.push('has a validated forecast pointing down');
    return exits.length ? { classification: 'SELL WATCH', reasons: [`It ${exits.join('; ')}.`] } : { classification: 'HOLD', reasons: ['No exit condition is met.'] };
  }

  const avoid: string[] = [];
  if (trend === 'downtrend' && below(x.t.sma200)) avoid.push('downtrend below the 200-day average');
  if (has('breakdown_20d')) avoid.push('20-day breakdown');
  if (has('failed_breakout')) avoid.push('recent failed breakout');
  if (fDown) avoid.push('validated forecast pointing down');
  if (avoid.length) return { classification: 'AVOID', reasons: [`Avoid: ${avoid.join('; ')}.`] };

  const p = x.plan;
  const buyOk = p !== null && p.rewardRisk >= THRESHOLDS.minRewardRisk && trend === 'uptrend' && htf !== 'downtrend' && (x.t.rsi14 ?? 0) <= THRESHOLDS.maxRsiForBuy && !fDown;
  if (buyOk && fUp && x.sizing?.fit === 'FITS' && x.f20.expectedReturn !== null && x.sizing.notional > 0 && x.f20.expectedReturn > (2 * x.sizing.costs) / x.sizing.notional) {
    return { classification: 'STRONG BUY SETUP', reasons: [`Validated 20-day forecast ${(x.f20.pUp! * 100).toFixed(0)}% vs base ${(x.f20.baseRate * 100).toFixed(0)}%, plan reward-to-risk ${p!.rewardRisk.toFixed(1)}, fits your capital.`] };
  }
  if (buyOk) {
    const why = [`${p!.label}; reward-to-risk ${p!.rewardRisk.toFixed(1)}; uptrend${htf === 'uptrend' ? ' on daily and weekly' : ''}.`];
    if (!validated) why.push('Not STRONG BUY: no forecast horizon has passed validation, so there is no evidence it is more likely to rise than an average stock.');
    return { classification: 'BUY WATCHLIST', reasons: why };
  }
  const missing: string[] = [];
  if (!p) missing.push('no pattern setup or breakout');
  else if (p.rewardRisk < THRESHOLDS.minRewardRisk) missing.push(`reward-to-risk ${p.rewardRisk.toFixed(1)} < ${THRESHOLDS.minRewardRisk}`);
  if (trend !== 'uptrend') missing.push(`trend is ${trend}`);
  if (htf === 'downtrend') missing.push('weekly trend is down');
  if ((x.t.rsi14 ?? 0) > THRESHOLDS.maxRsiForBuy) missing.push(`RSI ${x.t.rsi14!.toFixed(0)} > ${THRESHOLDS.maxRsiForBuy}`);
  return { classification: 'NO TRADE', reasons: [`Conditions not met: ${missing.join('; ') || 'see analysis'}.`] };
}

export function stanceOf(signals: Signal[], trend: string): 'bullish' | 'bearish' | 'neutral' {
  const score = signals.filter((s) => s.direction === 'bullish').length - signals.filter((s) => s.direction === 'bearish').length + (trend === 'uptrend' ? 1 : trend === 'downtrend' ? -1 : 0);
  return score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';
}

export function riskOf(t: Technicals, plan: AgentPlan | null): 'LOW' | 'MEDIUM' | 'HIGH' {
  const stopDist = plan ? (plan.entryHigh - plan.stop) / plan.entryHigh : 0;
  if ((t.atrPct ?? 1) >= THRESHOLDS.mediumRiskAtr || stopDist > 0.1) return 'HIGH';
  return (t.atrPct ?? 1) < THRESHOLDS.lowRiskAtr ? 'LOW' : 'MEDIUM';
}

/**
 * Risk-adjusted ranking score. With a validated forecast: (expected return − cost%) ÷ |10th-percentile outcome|.
 * Without one (today): cost-adjusted planned reward-to-risk — the plan's own numbers, not a prediction.
 */
export function rankScore(plan: AgentPlan | null, f20: Forecast, costPctOfNotional: number): number {
  if (f20.status === 'OK' && f20.expectedReturn !== null && f20.downside !== null) return (f20.expectedReturn - costPctOfNotional) / Math.max(Math.abs(f20.downside), 0.01);
  if (!plan) return -Infinity;
  const cost = plan.entryHigh * costPctOfNotional;
  return (plan.tp1 - plan.entryHigh - cost) / (plan.entryHigh - plan.stop + cost);
}
