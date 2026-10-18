import { describe, expect, it } from 'vitest';
import type { SavedProduct } from '../src/storage/product';
import { buildComparison } from '../src/ui/compare';
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
