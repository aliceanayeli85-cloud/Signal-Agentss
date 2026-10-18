import { describe, expect, it } from 'vitest';
import {
  calculateProfitability,
  compareByScreening,
  emptyRulesForm,
  evaluateRules,
  parseAmount,
  parseRulesForm,
  type RulesForm,
  type ScreeningResult,
} from '../src/engine';
import { sampleInputs } from './helpers';

// Fictional sample results: contribution 7.45, margin 29.8%, ROI 114.62%, net 1390.
const verified = calculateProfitability(sampleInputs('verified')).metrics;
const estimated = calculateProfitability(sampleInputs('estimated')).metrics;

function rules(partial: Partial<RulesForm>) {
  return parseRulesForm({ ...emptyRulesForm(), ...partial });
}

describe('parseRulesForm', () => {
  it('treats blank rules as not set (no built-in thresholds)', () => {
    expect(parseRulesForm(emptyRulesForm())).toEqual({ rules: {}, errors: {} });
  });

  it('parses money, percent and ROI above 100%', () => {
    expect(rules({ minContributionPerUnit: '$5.50', minMarginPercent: '25%', minRoiPercent: '150' }).rules).toEqual({
      minContributionPerUnit: 5.5,
      minMarginPercent: 25,
      minRoiPercent: 150,
    });
  });

  it('reports invalid rules with the rule name', () => {
    expect(rules({ minMarginPercent: '120', minNetMonthly: 'lots', minContributionPerUnit: '-1' }).errors).toEqual({
      minMarginPercent: 'Minimum contribution margin %: must be between 0 and 100',
      minNetMonthly: 'Minimum net business profit per month: "lots" is not a number',
      minContributionPerUnit: 'Minimum contribution profit per unit: cannot be negative',
    });
  });

  it('accepts uncapped percentages only for ROI', () => {
    expect(parseAmount('250%', 'percent-uncapped')).toEqual({ ok: true, value: 250 });
    expect(parseAmount('250', 'percent').ok).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('returns no-rules when nothing is set', () => {
    expect(evaluateRules(verified, {}).verdict).toBe('no-rules');
  });

  it('meets when every rule passes, including exactly at the threshold', () => {
    const r = evaluateRules(verified, rules({ minContributionPerUnit: '7.45', minMarginPercent: '29.8', minRoiPercent: '100' }).rules);
    expect(r.verdict).toBe('meets');
    expect(r.unverified).toBe(false);
    expect(r.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('fails when any rule is missed, and says by how much', () => {
    const r = evaluateRules(verified, rules({ minContributionPerUnit: '5', minMarginPercent: '30' }).rules);
    expect(r.verdict).toBe('fails');
    expect(r.checks[1]).toEqual({
      key: 'minMarginPercent',
      label: 'Minimum contribution margin %',
      unit: 'percent',
      threshold: 30,
      value: 29.8,
      status: 'fail',
    });
  });

  it('flags a pass that relies on estimated inputs', () => {
    const r = evaluateRules(estimated, rules({ minContributionPerUnit: '1' }).rules);
    expect(r.verdict).toBe('meets');
    expect(r.unverified).toBe(true);
  });

  it('reports not enough data when a needed input is unknown', () => {
    const metrics = calculateProfitability(sampleInputs('verified', { monthlyUnitsSold: null })).metrics;
    const r = evaluateRules(metrics, rules({ minContributionPerUnit: '1', minNetMonthly: '500' }).rules);
    expect(r.verdict).toBe('not-enough-data');
    expect(r.checks.find((c) => c.key === 'minNetMonthly')).toMatchObject({ status: 'unknown', value: null });
  });

  it('a known failure outranks missing data', () => {
    const metrics = calculateProfitability(sampleInputs('verified', { monthlyUnitsSold: null })).metrics;
    const r = evaluateRules(metrics, rules({ minContributionPerUnit: '100', minNetMonthly: '500' }).rules);
    expect(r.verdict).toBe('fails');
  });

  it('treats invalid inputs and zero sale price as not checkable', () => {
    const invalid = calculateProfitability(sampleInputs('verified', { salePrice: { value: 'abc', source: 'verified' } }));
    expect(evaluateRules(invalid.metrics, rules({ minContributionPerUnit: '0' }).rules).verdict).toBe('not-enough-data');
    const zero = calculateProfitability(sampleInputs('verified', { salePrice: { value: 0, source: 'verified' } }));
    // Margin is not applicable at a 0 price, so the margin rule can't be checked; contribution is negative.
    expect(evaluateRules(zero.metrics, rules({ minMarginPercent: '10' }).rules).verdict).toBe('not-enough-data');
    expect(evaluateRules(zero.metrics, rules({ minContributionPerUnit: '0' }).rules).verdict).toBe('fails');
  });
});

describe('compareByScreening', () => {
  const s = (verdict: ScreeningResult['verdict'], unverified = false): ScreeningResult => ({ verdict, checks: [], unverified });

  it('orders meets (verified, then unverified), not enough data, then fails', () => {
    const items = [
      { name: 'fails', screening: s('fails'), contribution: 50 },
      { name: 'unknown', screening: s('not-enough-data'), contribution: null },
      { name: 'meets-unverified', screening: s('meets', true), contribution: 20 },
      { name: 'meets-verified', screening: s('meets'), contribution: 5 },
    ];
    expect([...items].sort(compareByScreening).map((i) => i.name)).toEqual([
      'meets-verified',
      'meets-unverified',
      'unknown',
      'fails',
    ]);
  });

  it('within a group, higher contribution first and unknown last', () => {
    const items = [
      { name: 'low', screening: s('no-rules'), contribution: 1 },
      { name: 'none', screening: s('no-rules'), contribution: null },
      { name: 'high', screening: s('no-rules'), contribution: 9 },
      { name: 'negative', screening: s('no-rules'), contribution: -3 },
    ];
    expect([...items].sort(compareByScreening).map((i) => i.name)).toEqual(['high', 'low', 'negative', 'none']);
  });
});
