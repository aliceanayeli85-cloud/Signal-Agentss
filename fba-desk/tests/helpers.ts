import type { FieldKey, ProductInputs, Provenance, RawInput } from '../src/engine';

/**
 * Fictional sample product. These numbers are made up for testing only;
 * they are not real Amazon fees or supplier prices.
 */
export const SAMPLE_VALUES: Record<FieldKey, number> = {
  salePrice: 25,
  productCost: 5,
  inboundShippingPerUnit: 1,
  referralFeePercent: 15,
  fulfillmentFeePerUnit: 4.5,
  storageFeePerUnit: 0.3,
  prepFeePerUnit: 0.5,
  adSpendPerUnit: 2,
  returnRatePercent: 5,
  returnLossPerReturn: 10,
  fixedMonthlyCosts: 100,
  monthlyUnitsSold: 200,
};

export function sampleInputs(
  source: Provenance = 'verified',
  overrides: Partial<Record<FieldKey, RawInput | null>> = {},
): ProductInputs {
  const inputs: ProductInputs = {};
  for (const [key, value] of Object.entries(SAMPLE_VALUES) as [FieldKey, number][]) {
    inputs[key] = { value, source };
  }
  for (const [key, raw] of Object.entries(overrides) as [FieldKey, RawInput | null][]) {
    if (raw === null) delete inputs[key];
    else inputs[key] = raw;
  }
  return inputs;
}
