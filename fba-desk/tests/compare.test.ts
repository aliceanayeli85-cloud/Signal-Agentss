import { describe, expect, it } from 'vitest';
import type { SavedProduct } from '../src/storage/product';
import { buildComparison, verdictLabel } from '../src/ui/compare';
import { emptyForm, sampleForm } from '../src/ui/form-state';

const base = { notes: '', savedAt: '2026-10-01T00:00:00.000Z' };

describe('buildComparison', () => {
  it('recalculates each saved product from its stored inputs', () => {
    const incomplete = emptyForm();
    incomplete.salePrice = { text: '30', source: 'verified' };
    const invalid = sampleForm();
    invalid.productCost = { text: 'abc', source: 'user-provided' };
    const products: SavedProduct[] = [
      { ...base, id: 'a', name: 'Sample', form: sampleForm() },
      { ...base, id: 'b', name: 'Only price', form: incomplete },
      { ...base, id: 'c', name: 'Typo', form: invalid },
    ];
    const [sample, onlyPrice, typo] = buildComparison(products);

    expect(sample?.contributionProfitPerUnit.value).toBe(7.45);
    expect(sample?.netBusinessProfitMonthly.value).toBe(1390);
    expect(sample?.assumptionLevel).toBe('unverified');

    // Unknown costs never become zero: no profit figure is produced.
    expect(onlyPrice?.contributionProfitPerUnit).toMatchObject({ status: 'incomplete', value: null });
    expect(onlyPrice?.assumptionLevel).toBe('incomplete');

    expect(typo?.contributionProfitPerUnit.status).toBe('invalid');
    expect(typo?.assumptionLevel).toBe('invalid');
  });

  it('handles an empty list', () => {
    expect(buildComparison([])).toEqual([]);
  });
});

describe('buildComparison with rules', () => {
  const weak = sampleForm();
  weak.salePrice = { text: '20', source: 'estimated' }; // lower price → lower profit
  const unknown = emptyForm();
  unknown.salePrice = { text: '40', source: 'verified' };
  const products: SavedProduct[] = [
    { ...base, id: 'u', name: 'Unknown costs', form: unknown, savedAt: '2026-10-03T00:00:00.000Z' },
    { ...base, id: 'w', name: 'Weaker', form: weak, savedAt: '2026-10-02T00:00:00.000Z' },
    { ...base, id: 's', name: 'Sample', form: sampleForm(), savedAt: '2026-10-01T00:00:00.000Z' },
  ];

  it('marks each product against the rules and ranks best first', () => {
    // Sample: contribution 7.45. Weaker at 20: 20 − (5+1+3+4.5+0.3+0.5+2+0.5) = 3.20.
    const rows = buildComparison(products, { minContributionPerUnit: 5 }, 'best');
    expect(rows.map((r) => [r.name, r.screening.verdict])).toEqual([
      ['Sample', 'meets'],
      ['Unknown costs', 'not-enough-data'],
      ['Weaker', 'fails'],
    ]);
    expect(verdictLabel(rows[0]!.screening)).toBe('Meets your rules (unverified inputs)');
    expect(rows[2]!.contributionProfitPerUnit.value).toBe(3.2);
  });

  it('can sort newest first and works with no rules', () => {
    const rows = buildComparison(products, {}, 'newest');
    expect(rows.map((r) => r.name)).toEqual(['Unknown costs', 'Weaker', 'Sample']);
    expect(rows.every((r) => verdictLabel(r.screening) === 'No rules set')).toBe(true);
  });
});
