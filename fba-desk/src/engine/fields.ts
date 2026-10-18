import type { FieldDefinition, FieldKey } from './types';

/**
 * Every input the calculator uses. No defaults: the app never supplies an Amazon fee,
 * supplier cost or sales estimate of its own. Enter all money values in one currency.
 */
export const FIELDS: readonly FieldDefinition[] = [
  { key: 'salePrice', label: 'Sale price', kind: 'money', help: 'Price the customer pays per unit.' },
  { key: 'productCost', label: 'Product cost', kind: 'money', help: 'Supplier cost per unit.' },
  {
    key: 'inboundShippingPerUnit',
    label: 'Inbound shipping per unit',
    kind: 'money',
    help: 'Freight/shipping to the fulfillment center, divided per unit.',
  },
  {
    key: 'referralFeePercent',
    label: 'Referral fee %',
    kind: 'percent',
    help: 'Percentage of the sale price charged as a referral fee. Check your category in Seller Central.',
  },
  {
    key: 'fulfillmentFeePerUnit',
    label: 'FBA fulfillment fee per unit',
    kind: 'money',
    help: 'Per-unit fulfillment fee for this size/weight tier. Check the current fee in Seller Central.',
  },
  {
    key: 'storageFeePerUnit',
    label: 'Storage fee per unit sold',
    kind: 'money',
    help: 'Storage cost allocated to each unit sold.',
  },
  { key: 'prepFeePerUnit', label: 'Prep / labeling per unit', kind: 'money', help: 'Prep, labeling or bagging per unit.' },
  { key: 'adSpendPerUnit', label: 'Ad spend per unit sold', kind: 'money', help: 'Advertising spend divided by units sold.' },
  {
    key: 'returnRatePercent',
    label: 'Return rate %',
    kind: 'percent',
    help: 'Percentage of sold units that are returned.',
  },
  {
    key: 'returnLossPerReturn',
    label: 'Loss per returned unit',
    kind: 'money',
    help: 'What one return costs you (unrecovered refund, unsellable stock, return fees).',
  },
  {
    key: 'fixedMonthlyCosts',
    label: 'Fixed monthly costs',
    kind: 'money',
    help: 'Costs that do not change with units sold (subscriptions, software, etc.).',
  },
  {
    key: 'monthlyUnitsSold',
    label: 'Units sold per month',
    kind: 'count',
    help: 'Expected monthly unit sales. Usually an estimate — label it honestly.',
  },
];

export const FIELD_BY_KEY: Readonly<Record<FieldKey, FieldDefinition>> = Object.fromEntries(
  FIELDS.map((f) => [f.key, f]),
) as Record<FieldKey, FieldDefinition>;

export const FIELD_KEYS: readonly FieldKey[] = FIELDS.map((f) => f.key);
