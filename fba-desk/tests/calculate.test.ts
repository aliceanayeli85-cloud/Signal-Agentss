import { describe, expect, it } from 'vitest';
import { DISCLAIMER, FIELD_KEYS, calculateProfitability } from '../src/engine';
import { sampleInputs } from './helpers';

describe('calculateProfitability: complete verified inputs', () => {
  const report = calculateProfitability(sampleInputs('verified'));
  const m = report.metrics;

  it('has no errors and is fully verified', () => {
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.assumptionLevel).toBe('all-verified');
  });

  // Hand-checked against the fictional sample in tests/helpers.ts:
  // referral 25 × 15% = 3.75; returns 5% × 10 = 0.50
  // total = 5 + 1 + 3.75 + 4.5 + 0.3 + 0.5 + 2 + 0.5 = 17.55
  it('calculates per-unit metrics', () => {
    expect(m.grossRevenuePerUnit.value).toBe(25);
    expect(m.referralFeePerUnit.value).toBe(3.75);
    expect(m.returnCostPerUnit.value).toBe(0.5);
    expect(m.totalCostPerUnit.value).toBe(17.55);
    expect(m.contributionProfitPerUnit.value).toBe(7.45);
    expect(m.contributionMarginPercent.value).toBe(29.8);
    expect(m.roiPercent.value).toBe(114.62); // 7.45 / 6.5
  });

  it('keeps gross revenue, contribution profit and net business profit separate', () => {
    expect(m.monthlyGrossRevenue.value).toBe(5000);
    expect(m.monthlyContributionProfit.value).toBe(1490);
    expect(m.netBusinessProfitMonthly.value).toBe(1390);
  });

  it('shows the formula, worked numbers and inputs for every metric', () => {
    for (const metric of Object.values(m)) {
      expect(metric.status).toBe('complete');
      expect(metric.formula.length).toBeGreaterThan(0);
      expect(metric.workedFormula).not.toBeNull();
      expect(metric.inputsUsed.length).toBeGreaterThan(0);
      expect(metric.basis).toBe('verified');
    }
    expect(m.contributionProfitPerUnit.workedFormula).toBe('25 − 17.55 = 7.45');
    expect(m.netBusinessProfitMonthly.workedFormula).toBe('1490 − 100 = 1390');
  });

  it('still includes the disclaimer and never claims profitability', () => {
    expect(report.warnings).toEqual([DISCLAIMER]);
    expect(JSON.stringify(report).toLowerCase()).not.toMatch(/\bprofitable\b|\bvalidated\b/);
  });
});

describe('unknown inputs are never treated as zero', () => {
  it('reports metrics as incomplete and names the missing input', () => {
    const r = calculateProfitability(sampleInputs('verified', { fulfillmentFeePerUnit: { value: '', source: 'user-provided' } }));
    expect(r.ok).toBe(true);
    expect(r.inputs.fulfillmentFeePerUnit).toMatchObject({ value: null, source: 'unknown' });
    expect(r.metrics.contributionProfitPerUnit).toMatchObject({
      status: 'incomplete',
      value: null,
      missingInputs: ['fulfillmentFeePerUnit'],
    });
    expect(r.metrics.netBusinessProfitMonthly.status).toBe('incomplete');
    // Metrics that don't need the missing input are still calculated.
    expect(r.metrics.referralFeePerUnit.value).toBe(3.75);
    expect(r.metrics.monthlyGrossRevenue.value).toBe(5000);
    expect(r.assumptionLevel).toBe('incomplete');
    expect(r.warnings[0]).toMatch(/Unknown inputs: FBA fulfillment fee per unit.*never treated as zero/);
  });

  it('treats an omitted field the same as unknown', () => {
    const r = calculateProfitability(sampleInputs('verified', { productCost: null }));
    expect(r.metrics.totalCostPerUnit.missingInputs).toEqual(['productCost']);
    expect(r.metrics.contributionProfitPerUnit.value).toBeNull();
  });

  it('treats explicitly unknown fields as missing', () => {
    const r = calculateProfitability(sampleInputs('verified', { monthlyUnitsSold: { value: null, source: 'unknown' } }));
    expect(r.metrics.contributionProfitPerUnit.status).toBe('complete');
    expect(r.metrics.monthlyGrossRevenue.status).toBe('incomplete');
    expect(r.metrics.netBusinessProfitMonthly.missingInputs).toEqual(['monthlyUnitsSold']);
  });

  it('handles a completely empty form without crashing', () => {
    const r = calculateProfitability({});
    expect(r.ok).toBe(true);
    for (const metric of Object.values(r.metrics)) {
      expect(metric.status).toBe('incomplete');
      expect(metric.value).toBeNull();
    }
    for (const key of FIELD_KEYS) expect(r.inputs[key].source).toBe('unknown');
  });

  it('does not need loss per return when the return rate is exactly 0%', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        returnRatePercent: { value: 0, source: 'verified' },
        returnLossPerReturn: { value: '', source: 'unknown' },
      }),
    );
    expect(r.metrics.returnCostPerUnit).toMatchObject({ status: 'complete', value: 0 });
    expect(r.metrics.returnCostPerUnit.note).toMatch(/not needed/);
    expect(r.metrics.contributionProfitPerUnit.value).toBe(7.95);
    expect(r.assumptionLevel).toBe('all-verified');
  });

  it('does need loss per return when the return rate is unknown', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        returnRatePercent: { value: '', source: 'unknown' },
        returnLossPerReturn: { value: '', source: 'unknown' },
      }),
    );
    expect(r.metrics.returnCostPerUnit.missingInputs).toEqual(['returnRatePercent', 'returnLossPerReturn']);
  });
});

describe('provenance labels and warnings', () => {
  it('flags estimated inputs and unverified assumptions', () => {
    const r = calculateProfitability(sampleInputs('verified', { monthlyUnitsSold: { value: 200, source: 'estimated' } }));
    expect(r.assumptionLevel).toBe('unverified');
    expect(r.inputs.monthlyUnitsSold.source).toBe('estimated');
    expect(r.metrics.contributionProfitPerUnit.basis).toBe('verified');
    expect(r.metrics.netBusinessProfitMonthly.basis).toBe('estimated');
    expect(r.warnings).toContain('Estimated inputs: Units sold per month.');
    expect(r.warnings.some((w) => w.startsWith('Results depend on unverified assumptions'))).toBe(true);
  });

  it('flags user-provided inputs as not verified', () => {
    const r = calculateProfitability(sampleInputs('user-provided'));
    expect(r.assumptionLevel).toBe('unverified');
    expect(r.metrics.grossRevenuePerUnit.basis).toBe('user-provided');
    expect(r.warnings.some((w) => w.startsWith('Not verified against a source: Sale price'))).toBe(true);
  });

  it('reports the weakest source among the inputs a metric uses', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        referralFeePercent: { value: 15, source: 'user-provided' },
        adSpendPerUnit: { value: 2, source: 'estimated' },
      }),
    );
    expect(r.metrics.referralFeePerUnit.basis).toBe('user-provided');
    expect(r.metrics.contributionProfitPerUnit.basis).toBe('estimated');
    expect(r.metrics.monthlyGrossRevenue.basis).toBe('verified');
  });

  it('rejects a value marked unknown instead of guessing which is right', () => {
    const r = calculateProfitability(sampleInputs('verified', { productCost: { value: 5, source: 'unknown' } }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      {
        field: 'productCost',
        message:
          'Product cost: has a value but is marked unknown. Mark it verified, user-provided or estimated, or clear the value.',
      },
    ]);
  });

  it('rejects an invalid source label', () => {
    const bad = { value: 5, source: 'guess' } as unknown as { value: number; source: 'verified' };
    const r = calculateProfitability(sampleInputs('verified', { productCost: bad }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/source must be one of verified, user-provided, estimated, unknown/);
  });
});

describe('invalid values', () => {
  it('blocks all results and names each bad field', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        salePrice: { value: 'abc', source: 'user-provided' },
        productCost: { value: -3, source: 'user-provided' },
        referralFeePercent: { value: 150, source: 'user-provided' },
        monthlyUnitsSold: { value: '10.5', source: 'estimated' },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.assumptionLevel).toBe('invalid');
    expect(r.errors.map((e) => e.message)).toEqual([
      'Sale price: "abc" is not a number',
      'Product cost: cannot be negative',
      'Referral fee %: must be between 0 and 100',
      'Units sold per month: must be a whole number',
    ]);
    for (const metric of Object.values(r.metrics)) {
      expect(metric.status).toBe('invalid');
      expect(metric.value).toBeNull();
    }
    expect(r.warnings[0]).toMatch(/invalid/);
  });
});

describe('edge cases', () => {
  it('handles a zero sale price without dividing by zero', () => {
    const r = calculateProfitability(sampleInputs('verified', { salePrice: { value: 0, source: 'verified' } }));
    expect(r.ok).toBe(true);
    expect(r.metrics.referralFeePerUnit.value).toBe(0);
    expect(r.metrics.contributionProfitPerUnit.value).toBe(-13.8);
    expect(r.metrics.contributionMarginPercent).toMatchObject({ status: 'not-applicable', value: null });
    expect(r.metrics.contributionMarginPercent.note).toMatch(/Sale price is 0/);
    for (const metric of Object.values(r.metrics)) {
      if (metric.value !== null) expect(Number.isFinite(metric.value)).toBe(true);
    }
  });

  it('handles zero landed cost without dividing by zero', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        productCost: { value: 0, source: 'verified' },
        inboundShippingPerUnit: { value: 0, source: 'verified' },
        prepFeePerUnit: { value: 0, source: 'verified' },
      }),
    );
    expect(r.metrics.roiPercent.status).toBe('not-applicable');
    expect(r.metrics.contributionMarginPercent.status).toBe('complete');
  });

  it('handles a 100% referral fee and reports a loss', () => {
    const r = calculateProfitability(sampleInputs('verified', { referralFeePercent: { value: 100, source: 'verified' } }));
    expect(r.metrics.referralFeePerUnit.value).toBe(25);
    expect(r.metrics.contributionProfitPerUnit.value).toBe(-13.8);
    expect(r.warnings).toContain('Contribution profit per unit is negative: each sale loses money before fixed costs.');
    expect(r.warnings).toContain('Net business profit per month is negative at these inputs.');
  });

  it('warns when fixed costs make net profit negative even with positive contribution', () => {
    const r = calculateProfitability(sampleInputs('verified', { fixedMonthlyCosts: { value: 2000, source: 'verified' } }));
    expect(r.metrics.contributionProfitPerUnit.value).toBe(7.45);
    expect(r.metrics.netBusinessProfitMonthly.value).toBe(-510);
    expect(r.warnings).toContain('Net business profit per month is negative at these inputs.');
    expect(r.warnings).not.toContain('Contribution profit per unit is negative: each sale loses money before fixed costs.');
  });

  it('handles zero units sold', () => {
    const r = calculateProfitability(sampleInputs('verified', { monthlyUnitsSold: { value: 0, source: 'estimated' } }));
    expect(r.metrics.monthlyGrossRevenue.value).toBe(0);
    expect(r.metrics.netBusinessProfitMonthly.value).toBe(-100);
  });

  it('rounds decimal results to cents', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        salePrice: { value: '19.99', source: 'verified' },
        referralFeePercent: { value: '15', source: 'verified' },
      }),
    );
    // 19.99 × 15% = 2.9985 -> 3.00
    expect(r.metrics.referralFeePerUnit.value).toBe(3);
    expect(r.metrics.referralFeePerUnit.workedFormula).toBe('19.99 × 15 ÷ 100 = 2.9985');
    // 19.99 − (5 + 1 + 2.9985 + 4.5 + 0.3 + 0.5 + 2 + 0.5) = 3.1915 -> 3.19
    expect(r.metrics.contributionProfitPerUnit.value).toBe(3.19);
  });

  it('accepts string inputs with $ and %', () => {
    const r = calculateProfitability(
      sampleInputs('verified', {
        salePrice: { value: '$25.00', source: 'verified' },
        referralFeePercent: { value: '15%', source: 'verified' },
      }),
    );
    expect(r.metrics.contributionProfitPerUnit.value).toBe(7.45);
  });
});
