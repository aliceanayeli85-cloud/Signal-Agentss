import type { RiskSettings } from './settings.js';

export interface CostBreakdown {
  entrySlippage: number;
  exitSlippage: number;
  commissions: number;
  regulatoryFees: number;
  total: number;
}

const ceilCents = (x: number) => (x > 0 ? Math.ceil(x * 100 - 1e-9) / 100 : 0);

/**
 * Estimated cost of buying `shares` at `entry` and later selling at `exit`.
 * Slippage = paying a little more / receiving a little less than the quoted
 * price. Regulatory fees (SEC + FINRA TAF) apply only to the sell and are
 * rounded UP to the cent, as brokers do.
 */
export function estimateRoundTripCosts(shares: number, entry: number, exit: number, s: RiskSettings): CostBreakdown {
  if (shares <= 0) return { entrySlippage: 0, exitSlippage: 0, commissions: 0, regulatoryFees: 0, total: 0 };
  const bps = s.slippageBps / 10_000;
  const entrySlippage = shares * entry * bps;
  const exitSlippage = shares * exit * bps;
  const commissions = s.commissionPerOrderUsd * 2;
  const sec = ceilCents((shares * exit * s.secFeePerMillion) / 1_000_000);
  const taf = ceilCents(Math.min(shares * s.tafPerShareUsd, s.tafMaxUsd));
  const regulatoryFees = sec + taf;
  return { entrySlippage, exitSlippage, commissions, regulatoryFees, total: entrySlippage + exitSlippage + commissions + regulatoryFees };
}

export function sellFees(shares: number, price: number, s: RiskSettings): number {
  if (shares <= 0) return 0;
  return ceilCents((shares * price * s.secFeePerMillion) / 1_000_000) + ceilCents(Math.min(shares * s.tafPerShareUsd, s.tafMaxUsd)) + s.commissionPerOrderUsd;
}

/** Smallest US stock price increment above $1. */
export const TICK = 0.01;

/**
 * A resting limit sell is only counted as filled when price trades at least
 * one tick THROUGH it. Merely touching the price does not guarantee a fill,
 * because other orders at that price may be ahead in the queue.
 */
export function limitSellFilled(high: number, target: number): boolean {
  return high >= target + TICK - 1e-9;
}

export function applySlippage(price: number, side: 'buy' | 'sell', s: RiskSettings): number {
  const bps = s.slippageBps / 10_000;
  return side === 'buy' ? price * (1 + bps) : price * (1 - bps);
}

export interface SizeResult {
  shares: number;
  notional: number;
  /** Loss if the stop fills exactly at the stop price, including costs. */
  maxLossAtStop: number;
  costsAtStop: CostBreakdown;
  limitedBy: 'risk_budget' | 'max_position' | 'cash' | 'none';
  problem: string | null;
}

/**
 * Position size = how many shares keep the loss at the stop within the risk
 * budget, after costs, without exceeding the position cap or available cash.
 */
export function sizePosition(entry: number, stop: number, budgetUsd: number, cashUsd: number, s: RiskSettings): SizeResult {
  const empty = (problem: string): SizeResult => ({
    shares: 0,
    notional: 0,
    maxLossAtStop: 0,
    costsAtStop: estimateRoundTripCosts(0, entry, stop, s),
    limitedBy: 'none',
    problem,
  });
  if (!(entry > 0) || !(stop > 0)) return empty('Entry and stop must be positive prices.');
  if (stop >= entry) return empty('The stop must be below the entry for a long (buy) trade.');
  if (budgetUsd <= 0) return empty('The risk budget is zero.');

  const bps = s.slippageBps / 10_000;
  const lossPerShare = entry - stop + entry * bps + stop * bps;
  // First pass with the fee estimate for the largest possible size, then re-size.
  let shares = budgetUsd / lossPerShare;
  const fees = estimateRoundTripCosts(shares, entry, stop, s);
  shares = Math.max(0, (budgetUsd - fees.regulatoryFees - fees.commissions) / lossPerShare);
  let limitedBy: SizeResult['limitedBy'] = 'risk_budget';

  // Caps apply to the cash actually spent, which includes entry slippage — otherwise slippage is a few cents of borrowing.
  const paid = entry * (1 + bps);
  const byPosition = s.maxPositionUsd / paid;
  if (byPosition < shares) {
    shares = byPosition;
    limitedBy = 'max_position';
  }
  const byCash = cashUsd / paid;
  if (byCash < shares) {
    shares = byCash;
    limitedBy = 'cash';
  }

  shares = s.allowFractional ? Math.floor(shares * 1e6) / 1e6 : Math.floor(shares);
  if (shares <= 0) {
    return empty(
      s.allowFractional
        ? 'Even a tiny fractional position would exceed the limits.'
        : `One whole share risks $${lossPerShare.toFixed(2)}, more than the $${budgetUsd.toFixed(2)} budget. Fractional shares are turned off.`,
    );
  }
  const notional = shares * entry;
  if (notional < s.minOrderUsd) {
    return { ...empty(`The position would be $${notional.toFixed(2)}, below the $${s.minOrderUsd.toFixed(2)} minimum order.`), shares };
  }
  const costsAtStop = estimateRoundTripCosts(shares, entry, stop, s);
  const maxLossAtStop = shares * (entry - stop) + costsAtStop.total;
  return { shares, notional, maxLossAtStop, costsAtStop, limitedBy, problem: null };
}
