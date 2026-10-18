import { describe, expect, it } from 'vitest';
import { FIELD_KEYS, calculateProfitability, type Metric } from '../src/engine';
import { DEFAULT_SOURCE, FICTIONAL_SAMPLE, emptyForm, sampleForm, toProductInputs } from '../src/ui/form-state';
import { formatMetricValue } from '../src/ui/format';
import { SAMPLE_VALUES } from './helpers';

describe('form state', () => {
  it('starts empty, so every input is unknown and nothing is calculated', () => {
    const form = emptyForm();
    for (const key of FIELD_KEYS) expect(form[key]).toEqual({ text: '', source: DEFAULT_SOURCE });
    const report = calculateProfitability(toProductInputs(form));
    expect(report.ok).toBe(true);
    expect(report.assumptionLevel).toBe('incomplete');
    for (const m of Object.values(report.metrics)) expect(m.value).toBeNull();
  });

  it('labels the fictional sample as estimated, never verified', () => {
    const form = sampleForm();
    for (const key of FIELD_KEYS) expect(form[key].source).toBe('estimated');
    const report = calculateProfitability(toProductInputs(form));
    expect(report.assumptionLevel).toBe('unverified');
    expect(report.warnings.some((w) => w.startsWith('Results depend on unverified assumptions'))).toBe(true);
  });

  it('uses the same fictional numbers as the engine tests', () => {
    for (const key of FIELD_KEYS) expect(Number(FICTIONAL_SAMPLE[key])).toBe(SAMPLE_VALUES[key]);
    const report = calculateProfitability(toProductInputs(sampleForm()));
    expect(report.metrics.contributionProfitPerUnit.value).toBe(7.45);
    expect(report.metrics.netBusinessProfitMonthly.value).toBe(1390);
  });

  it('passes typed text through unchanged so the engine validates it', () => {
    const form = emptyForm();
    form.salePrice = { text: 'abc', source: 'user-provided' };
    const report = calculateProfitability(toProductInputs(form));
    expect(report.errors).toEqual([{ field: 'salePrice', message: 'Sale price: "abc" is not a number' }]);
  });

  it('returns independent copies so editing one form does not change another', () => {
    const a = emptyForm();
    const b = emptyForm();
    a.salePrice.text = '10';
    expect(b.salePrice.text).toBe('');
  });
});

describe('formatMetricValue', () => {
  const base: Metric = {
    key: 'contributionProfitPerUnit',
    label: 'x',
    unit: 'money',
    value: 1234.5,
    status: 'complete',
    formula: 'f',
    workedFormula: 'w',
    inputsUsed: [],
    missingInputs: [],
    basis: 'verified',
  };

  it('formats money with 2 decimals and no currency symbol', () => {
    expect(formatMetricValue(base)).toBe('1,234.50');
    expect(formatMetricValue({ ...base, value: -13.8 })).toBe('-13.80');
    expect(formatMetricValue({ ...base, value: 0 })).toBe('0.00');
  });

  it('formats percentages', () => {
    expect(formatMetricValue({ ...base, unit: 'percent', value: 29.8 })).toBe('29.80%');
  });

  it('shows a dash, not zero, for anything not calculated', () => {
    expect(formatMetricValue({ ...base, status: 'incomplete', value: null })).toBe('—');
    expect(formatMetricValue({ ...base, status: 'not-applicable', value: null })).toBe('—');
    expect(formatMetricValue({ ...base, status: 'invalid', value: null })).toBe('—');
  });
});
