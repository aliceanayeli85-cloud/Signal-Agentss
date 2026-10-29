import type { Summary } from './stats.js';

/**
 * Pre-registered decision rule (research/PREREGISTRATION.md). Applied
 * mechanically to POOLED results (all tickers' trades together) so no strategy
 * is judged on its single best ticker.
 */
export const RULES = {
  minTrades: 30,
  advance: { minProfitFactor: 1.15 },
  candidate: { minProfitFactor: 1.1, minShareOfTickersPositive: 0.5, minTradesPerTickerForBreadth: 3 },
};

export type Verdict = 'REJECTED' | 'INSUFFICIENT EVIDENCE' | 'CANDIDATE FOR EXTENDED PAPER TESTING';

export interface Stage1Input {
  defects: string[];
  train: Summary;
  validation: Summary;
  validationStressed: Summary;
}

export interface Stage1 {
  advance: boolean;
  rejected: boolean;
  reasons: string[];
}

const pos = (s: Summary) => (s.expectancyR ?? 0) > 0;

/** After training + validation, BEFORE the final test is looked at. */
export function stage1(x: Stage1Input): Stage1 {
  const reasons: string[] = [];
  if (x.defects.length) return { advance: false, rejected: true, reasons: [`Unresolved defects: ${x.defects.join('; ')}`] };
  const v = x.validation;
  if (v.trades >= RULES.minTrades && !pos(v)) return { advance: false, rejected: true, reasons: [`Validation lost money over ${v.trades} trades (avg ${fmtR(v.expectancyR)}).`] };
  if (v.trades >= RULES.minTrades && v.profitFactor !== null && v.profitFactor < 1) return { advance: false, rejected: true, reasons: [`Validation profit factor ${v.profitFactor.toFixed(2)} < 1.`] };

  if (v.trades < RULES.minTrades) reasons.push(`Only ${v.trades} validation trades (< ${RULES.minTrades}).`);
  if (!pos(x.train)) reasons.push(`Training period not positive (avg ${fmtR(x.train.expectancyR)}).`);
  if (!pos(v)) reasons.push('Validation not positive.');
  if ((v.profitFactor ?? Infinity) < RULES.advance.minProfitFactor) reasons.push(`Validation profit factor ${v.profitFactor?.toFixed(2)} < ${RULES.advance.minProfitFactor}.`);
  if (!pos(x.validationStressed)) reasons.push('Validation not positive with slippage tripled to 15 bps.');
  return { advance: reasons.length === 0, rejected: false, reasons: reasons.length ? reasons : ['Positive in training and validation, PF ≥ 1.15, survives 15 bps slippage.'] };
}

export interface Stage2Input {
  stage1: Stage1;
  test: Summary;
  testStressed: Summary;
  /** Average R per ticker over validation + test, for tickers with enough trades. */
  perTickerExpectancyR: { symbol: string; trades: number; expectancyR: number | null }[];
}

/** After the single look at the final test period. */
export function stage2(x: Stage2Input): { verdict: Verdict; reasons: string[] } {
  if (x.stage1.rejected) return { verdict: 'REJECTED', reasons: x.stage1.reasons };
  const t = x.test;
  if (t.trades >= RULES.minTrades && !pos(t)) return { verdict: 'REJECTED', reasons: [...(x.stage1.advance ? [] : x.stage1.reasons), `Final test lost money over ${t.trades} trades (avg ${fmtR(t.expectancyR)}).`] };
  if (!x.stage1.advance) return { verdict: 'INSUFFICIENT EVIDENCE', reasons: [...x.stage1.reasons, 'Did not advance from validation, so the final test cannot promote it.'] };

  const reasons: string[] = [];
  if (t.trades < RULES.minTrades) reasons.push(`Only ${t.trades} final-test trades (< ${RULES.minTrades}).`);
  if (!pos(t)) reasons.push('Final test not positive.');
  if ((t.profitFactor ?? Infinity) < RULES.candidate.minProfitFactor) reasons.push(`Final-test profit factor ${t.profitFactor?.toFixed(2)} < ${RULES.candidate.minProfitFactor}.`);
  if (!pos(x.testStressed)) reasons.push('Final test not positive at 15 bps slippage.');
  const eligible = x.perTickerExpectancyR.filter((p) => p.trades >= RULES.candidate.minTradesPerTickerForBreadth);
  const share = eligible.length ? eligible.filter((p) => (p.expectancyR ?? 0) > 0).length / eligible.length : 0;
  if (share < RULES.candidate.minShareOfTickersPositive) reasons.push(`Positive on only ${Math.round(share * 100)}% of tickers — depends on a few names.`);
  if (reasons.length) return { verdict: 'INSUFFICIENT EVIDENCE', reasons };
  return { verdict: 'CANDIDATE FOR EXTENDED PAPER TESTING', reasons: ['Positive in training, validation and the untouched final test; survives tripled slippage; broad across tickers. This is NOT proof of future profitability.'] };
}

const fmtR = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}R`);
