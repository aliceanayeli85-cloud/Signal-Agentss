import type { Analysis } from './analysis.js';
import { estimateRoundTripCosts, sizePosition, type CostBreakdown } from './costs.js';
import { resistancesAbove } from './levels.js';
import type { GuardResult } from './risk.js';
import type { RiskSettings } from './settings.js';
import type { Setup, Timeframe, Trend } from './types.js';

export const NO_TRADE = 'NO TRADE — CONDITIONS NOT MET';

export interface Quote {
  price: number;
  time: number;
  source: string;
}

export interface PlanCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Target {
  price: number;
  basis: 'resistance' | 'measured';
  rewardRisk: number;
  potentialProfit: number;
}

export interface TradePlan {
  status: 'TRADE_PLAN' | 'NO_TRADE';
  headline: string;
  symbol: string;
  timeframe: Timeframe;
  generatedAt: number;
  price: number | null;
  priceTime: number | null;
  dataSource: string | null;
  trend: Trend;
  higherTimeframeTrend: Trend;
  setupType: string | null;
  setupLabel: string | null;
  entryStatus: 'waiting_for_trigger' | 'in_entry_zone' | 'past_entry_zone' | 'below_stop' | null;
  entryLow: number | null;
  entryHigh: number | null;
  /** Price used for sizing: the top of the entry zone, i.e. the worst planned fill. */
  plannedEntry: number | null;
  confirmation: string[];
  stop: number | null;
  invalidationPrice: number | null;
  invalidation: string | null;
  tp1: Target | null;
  tp2: Target | null;
  riskPerShare: number | null;
  shares: number | null;
  positionValue: number | null;
  riskBudgetUsd: number;
  maxPlannedLoss: number | null;
  costs: CostBreakdown | null;
  rewardRisk: number | null;
  reasonsFor: string[];
  reasonsAgainst: string[];
  checks: PlanCheck[];
  warnings: string[];
}

export interface PlanInput {
  symbol: string;
  analysis: Analysis;
  quote: Quote | null;
  settings: RiskSettings;
  cashUsd: number;
  guard: GuardResult;
  now: number;
  marketOpen: boolean | null;
}

export const STANDARD_WARNINGS = [
  'A stop-loss is not a guarantee. If price gaps below the stop (for example overnight or on news), the actual loss can be larger than planned.',
  'This is analysis, not a prediction. Patterns and indicators fail regularly.',
  'Nothing has been ordered. A plan is not an order.',
];

/**
 * Turns the best detected setup into a complete plan, or into NO TRADE with
 * the exact checks that failed. Nothing is invented: without a live quote,
 * no entry, target or size is shown.
 */
export function buildTradePlan(input: PlanInput): TradePlan {
  const { analysis: an, quote, settings: s, guard, now } = input;
  const checks: PlanCheck[] = [];
  const warnings = [...STANDARD_WARNINGS];
  const setup = pickSetup(an.setups);

  const base: TradePlan = {
    status: 'NO_TRADE',
    headline: NO_TRADE,
    symbol: input.symbol,
    timeframe: an.timeframe,
    generatedAt: now,
    price: quote?.price ?? null,
    priceTime: quote?.time ?? null,
    dataSource: quote?.source ?? null,
    trend: an.trend.trend,
    higherTimeframeTrend: an.higherTimeframe?.trend.trend ?? 'unknown',
    setupType: setup?.type ?? null,
    setupLabel: setup?.label ?? null,
    entryStatus: null,
    entryLow: null,
    entryHigh: null,
    plannedEntry: null,
    confirmation: [],
    stop: null,
    invalidationPrice: null,
    invalidation: null,
    tp1: null,
    tp2: null,
    riskPerShare: null,
    shares: null,
    positionValue: null,
    riskBudgetUsd: guard.riskBudgetUsd,
    maxPlannedLoss: null,
    costs: null,
    rewardRisk: null,
    reasonsFor: setup?.reasonsFor ?? [],
    reasonsAgainst: [...(setup?.reasonsAgainst ?? [])],
    checks,
    warnings,
  };

  // --- Data checks: without a current price, nothing else may be computed. ---
  if (!quote) {
    checks.push({ name: 'Market data', pass: false, detail: 'No current price is available from the data source.' });
    return base;
  }
  const ageSec = (now - quote.time) / 1000;
  const fresh = ageSec <= s.maxQuoteAgeSeconds;
  if (input.marketOpen === false) {
    warnings.push('The market is closed. This plan is for the next session; prices can open far from here.');
    checks.push({ name: 'Market data', pass: true, detail: `Market closed. Last price is from ${new Date(quote.time).toISOString()}.` });
  } else {
    checks.push({ name: 'Market data', pass: fresh, detail: fresh ? `Price is ${Math.round(ageSec)}s old.` : `Price is ${Math.round(ageSec)}s old (limit ${s.maxQuoteAgeSeconds}s). Data is STALE.` });
  }
  checks.push({ name: 'Enough history', pass: an.candlesUsed >= 30, detail: `${an.candlesUsed} completed candles analysed.` });

  if (!setup) {
    checks.push({ name: 'Setup', pass: false, detail: 'No setup matches the rules on completed candles.' });
    pushGuard(checks, guard);
    return base;
  }
  checks.push({ name: 'Setup', pass: true, detail: setup.label });

  const entry = setup.entryHigh;
  const stop = setup.stop;
  const riskPerShare = entry - stop;
  const atr = an.atr14 ?? 0;

  let entryStatus: TradePlan['entryStatus'];
  if (quote.price <= stop) entryStatus = 'below_stop';
  else if (quote.price < setup.entryLow) entryStatus = 'waiting_for_trigger';
  else if (quote.price <= setup.entryHigh + atr * 0.25) entryStatus = 'in_entry_zone';
  else entryStatus = 'past_entry_zone';

  checks.push({ name: 'Stop below entry', pass: riskPerShare > 0, detail: `Risk per share $${riskPerShare.toFixed(2)}.` });
  checks.push({
    name: 'Not chasing',
    pass: entryStatus !== 'past_entry_zone' && entryStatus !== 'below_stop',
    detail:
      entryStatus === 'below_stop'
        ? 'Price is already below the stop. The setup is invalid.'
        : entryStatus === 'past_entry_zone'
          ? 'Price has already run past the entry zone. Buying now means a worse entry and a bigger loss if wrong.'
          : entryStatus === 'waiting_for_trigger'
            ? `Waiting: price must trade at $${setup.entryLow.toFixed(2)} or higher to confirm.`
            : 'Price is inside the entry zone.',
  });

  const targets = computeTargets(an, entry, riskPerShare);
  const size = sizePosition(entry, stop, guard.riskBudgetUsd, input.cashUsd, s);
  const rr = targets.tp1.rewardRisk;
  checks.push({ name: `Reward-to-risk ≥ ${s.minRewardRisk}`, pass: rr >= s.minRewardRisk, detail: `TP1 offers ${rr.toFixed(2)}R (${targets.tp1.basis === 'resistance' ? 'limited by resistance' : 'measured target'}).` });
  checks.push({ name: 'Position size possible', pass: size.problem === null, detail: size.problem ?? `${formatShares(size.shares)} shares ($${size.notional.toFixed(2)}), limited by ${size.limitedBy.replace('_', ' ')}.` });

  const trendOk = an.trend.trend !== 'downtrend' || setup.type === 'SUPPORT_REVERSAL';
  checks.push({ name: 'Trend not against the trade', pass: trendOk, detail: `Trend is ${an.trend.trend}.` });
  const htf = an.higherTimeframe?.trend.trend ?? 'unknown';
  checks.push({ name: 'Bigger picture not down', pass: htf !== 'downtrend', detail: htf === 'unknown' ? 'Higher-timeframe trend unknown (not enough history) — treat with extra caution.' : `Higher-timeframe trend is ${htf}.` });
  if (an.rsi14 !== null) checks.push({ name: 'RSI not overheated', pass: an.rsi14 <= 75, detail: `RSI ${an.rsi14.toFixed(0)}.` });
  if (an.ema20 !== null && an.atr14 !== null) {
    const ext = (entry - an.ema20) / an.atr14;
    checks.push({ name: 'Not over-extended', pass: ext <= 2.5, detail: `Entry is ${ext.toFixed(1)} ATR above the 20 EMA.` });
  }
  const failed = an.events.find((e) => e.kind === 'failed_breakout');
  checks.push({ name: 'No recent failed breakout', pass: !failed, detail: failed ? failed.explanation : 'None in the last 3 candles.' });

  if (size.problem === null) {
    checks.push({ name: 'Within risk budget', pass: size.maxLossAtStop <= guard.riskBudgetUsd + 0.005, detail: `Max planned loss $${size.maxLossAtStop.toFixed(2)} vs budget $${guard.riskBudgetUsd.toFixed(2)}.` });
  }
  pushGuard(checks, guard);

  if (s.allowFractional && size.shares > 0 && !Number.isInteger(size.shares)) {
    warnings.push('Fractional share position. Robinhood may not allow a stop order on fractional quantities — check in the app. If not, the stop must be watched and sold manually.');
  }
  if (an.timeframe !== '1Day') warnings.push('Buying and selling on the same day counts as a day trade. Check your Robinhood account type and day-trade rules first.');
  if (entryStatus === 'waiting_for_trigger') base.reasonsAgainst.push('Confirmation has not happened yet. Do not enter before it does.');

  const allPass = checks.every((c) => c.pass);
  const costs = size.problem === null ? estimateRoundTripCosts(size.shares, entry, targets.tp1.price, s) : null;
  const scale = (t: Target): Target => ({ ...t, potentialProfit: size.problem === null ? size.shares * (t.price - entry) - estimateRoundTripCosts(size.shares, entry, t.price, s).total : 0 });

  return {
    ...base,
    status: allPass ? 'TRADE_PLAN' : 'NO_TRADE',
    headline: allPass ? (entryStatus === 'waiting_for_trigger' ? 'TRADE PLAN — WAIT FOR CONFIRMATION' : 'TRADE PLAN — CONDITIONS MET') : NO_TRADE,
    entryStatus,
    entryLow: setup.entryLow,
    entryHigh: setup.entryHigh,
    plannedEntry: entry,
    confirmation: setup.confirmation,
    stop,
    invalidationPrice: setup.invalidationPrice,
    invalidation: setup.invalidation,
    tp1: scale(targets.tp1),
    tp2: scale(targets.tp2),
    riskPerShare,
    shares: size.problem === null ? size.shares : null,
    positionValue: size.problem === null ? size.notional : null,
    maxPlannedLoss: size.problem === null ? size.maxLossAtStop : null,
    costs,
    rewardRisk: rr,
  };
}

function pushGuard(checks: PlanCheck[], guard: GuardResult) {
  // Order-specific duplicate checks happen at order time; here we report account-level rules.
  const accountBlocks = guard.blocks.filter((b) => !['RISK_BUDGET', 'POSITION_SIZE', 'INSUFFICIENT_CASH', 'OPEN_RISK'].includes(b.code));
  checks.push({
    name: 'Account risk rules',
    pass: accountBlocks.length === 0,
    detail: accountBlocks.length ? accountBlocks.map((b) => b.message).join(' ') : 'No daily limit, cooldown or kill switch is blocking new trades.',
  });
}

const PRIORITY: Record<string, number> = { PULLBACK_EMA: 0, BREAKOUT: 1, SUPPORT_REVERSAL: 2 };

function pickSetup(setups: Setup[]): Setup | null {
  return [...setups].sort((a, b) => (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9))[0] ?? null;
}

/**
 * TP1 = the nearest resistance above the entry if it is within 3R (the market
 * has to get through it anyway), otherwise a measured 2R. TP2 = the next
 * resistance above TP1, otherwise TP1 plus the same distance again.
 */
export function computeTargets(an: Analysis, entry: number, riskPerShare: number): { tp1: Target; tp2: Target } {
  const r = Math.max(riskPerShare, 1e-9);
  const above = resistancesAbove(an.levels, entry * 1.001);
  const first = above[0];
  const tp1Price = first && first.price - entry <= 3 * r ? first.price * 0.999 : entry + 2 * r;
  const tp1Basis: Target['basis'] = first && first.price - entry <= 3 * r ? 'resistance' : 'measured';
  const next = above.find((l) => l.price > tp1Price * 1.002);
  const tp2Price = next ? next.price * 0.999 : tp1Price + (tp1Price - entry);
  const mk = (price: number, basis: Target['basis']): Target => ({ price, basis, rewardRisk: (price - entry) / r, potentialProfit: 0 });
  return { tp1: mk(tp1Price, tp1Basis), tp2: mk(tp2Price, next ? 'resistance' : 'measured') };
}

export function formatShares(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(6).replace(/0+$/, '');
}
