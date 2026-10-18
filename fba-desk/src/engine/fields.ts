import type { FieldDefinition, FieldKey } from './types';

/**
 * Every input the calculator uses. No defaults: the app never supplies an Amazon fee,
 * supplier cost or sales estimate of its own. Enter all money values in one currency.
 */
export const FIELDS: readonly FieldDefinition[] = [
  {
    key: 'salePrice',
    label: 'Sale price',
    kind: 'money',
    help: 'Price the customer pays per unit.',
    lookup:
      "Search for the item on Amazon and note the price similar listings sell at. Mark it Estimated until you've decided your own price.",
  },
  {
    key: 'productCost',
    label: 'Product cost',
    kind: 'money',
    help: 'Supplier cost per unit.',
    lookup:
      "Ask suppliers for a written quote for your order quantity (for example through Alibaba or a manufacturer's site). A written quote can be marked Verified; a listed price range is Estimated.",
  },
  {
    key: 'inboundShippingPerUnit',
    label: 'Inbound shipping per unit',
    kind: 'money',
    help: 'Freight/shipping to the fulfillment center, divided per unit.',
    lookup: 'Get a shipping or freight quote for the whole shipment and divide it by the number of units.',
  },
  {
    key: 'referralFeePercent',
    label: 'Referral fee %',
    kind: 'percent',
    help: 'Percentage of the sale price charged as a referral fee. Check your category in Seller Central.',
    lookup:
      'Find your product\'s category in Amazon\'s published referral fee schedule (search "Amazon referral fees"). Fees change, so check the current schedule.',
  },
  {
    key: 'fulfillmentFeePerUnit',
    label: 'FBA fulfillment fee per unit',
    kind: 'money',
    help: 'Per-unit fulfillment fee for this size/weight tier. Check the current fee in Seller Central.',
    lookup:
      'Use Amazon\'s free FBA Revenue Calculator (search "Amazon FBA Revenue Calculator") with the product\'s size and weight. Fees change, so check the current amount.',
  },
  {
    key: 'storageFeePerUnit',
    label: 'Storage fee per unit sold',
    kind: 'money',
    help: 'Storage cost allocated to each unit sold.',
    lookup:
      'Amazon charges storage monthly by volume; the Revenue Calculator can show it. Multiply the monthly cost per unit by how many months a unit is likely to wait before it sells.',
  },
  {
    key: 'prepFeePerUnit',
    label: 'Prep / labeling per unit',
    kind: 'money',
    help: 'Prep, labeling or bagging per unit.',
    lookup: 'Your cost for labels, poly bags or bundling, or a quote from a prep service.',
  },
  {
    key: 'adSpendPerUnit',
    label: 'Ad spend per unit sold',
    kind: 'money',
    help: 'Advertising spend divided by units sold.',
    lookup:
      'Your planned monthly ad budget divided by expected monthly units. Mark it Estimated until you have real ad results.',
  },
  {
    key: 'returnRatePercent',
    label: 'Return rate %',
    kind: 'percent',
    help: 'Percentage of sold units that are returned.',
    lookup:
      'There is no reliable free source for this. Estimate it and mark it Estimated; complaints in reviews of similar products can help.',
  },
  {
    key: 'returnLossPerReturn',
    label: 'Loss per returned unit',
    kind: 'money',
    help: 'What one return costs you (unrecovered refund, unsellable stock, return fees).',
    lookup: "What one return costs you: refund not recovered, stock that can't be resold, and any return fees.",
  },
  {
    key: 'fixedMonthlyCosts',
    label: 'Fixed monthly costs',
    kind: 'money',
    help: 'Costs that do not change with units sold (subscriptions, software, etc.).',
    lookup:
      "Costs that don't change with sales, such as software subscriptions or a seller plan fee if you choose one.",
  },
  {
    key: 'monthlyUnitsSold',
    label: 'Units sold per month',
    kind: 'count',
    help: 'Expected monthly unit sales. Usually an estimate — label it honestly.',
    lookup:
      'Without a seller account there is no free, reliable sales figure. Use a cautious guess and always mark it Estimated.',
  },
];

export const FIELD_BY_KEY: Readonly<Record<FieldKey, FieldDefinition>> = Object.fromEntries(
  FIELDS.map((f) => [f.key, f]),
) as Record<FieldKey, FieldDefinition>;

export const FIELD_KEYS: readonly FieldKey[] = FIELDS.map((f) => f.key);
