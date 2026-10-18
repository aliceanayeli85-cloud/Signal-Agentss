import { FIELDS, type FieldKey, type ProductInputs, type Provenance } from '../engine';

export interface FieldState {
  text: string;
  source: Provenance;
}

export type FormState = Record<FieldKey, FieldState>;

/** Source preselected for a field the user hasn't labeled yet. A blank value is always unknown regardless. */
export const DEFAULT_SOURCE: Provenance = 'user-provided';

export function emptyForm(): FormState {
  return Object.fromEntries(FIELDS.map((f) => [f.key, { text: '', source: DEFAULT_SOURCE }])) as FormState;
}

/**
 * Fictional example product so the page can be tried without real data.
 * Every value is labeled "estimated" because none of it comes from a real source.
 */
export const FICTIONAL_SAMPLE: Readonly<Record<FieldKey, string>> = {
  salePrice: '25.00',
  productCost: '5.00',
  inboundShippingPerUnit: '1.00',
  referralFeePercent: '15',
  fulfillmentFeePerUnit: '4.50',
  storageFeePerUnit: '0.30',
  prepFeePerUnit: '0.50',
  adSpendPerUnit: '2.00',
  returnRatePercent: '5',
  returnLossPerReturn: '10.00',
  fixedMonthlyCosts: '100.00',
  monthlyUnitsSold: '200',
};

export function sampleForm(): FormState {
  return Object.fromEntries(
    FIELDS.map((f) => [f.key, { text: FICTIONAL_SAMPLE[f.key], source: 'estimated' as Provenance }]),
  ) as FormState;
}

export function toProductInputs(state: FormState): ProductInputs {
  return Object.fromEntries(FIELDS.map((f) => [f.key, { value: state[f.key].text, source: state[f.key].source }]));
}
