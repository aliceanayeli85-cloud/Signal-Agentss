/**
 * Where a number came from. Ordered from strongest to weakest evidence.
 * - verified:      checked against a primary source (e.g. the seller's own Amazon fee preview, a supplier invoice)
 * - user-provided: entered by the user but not checked against a source
 * - estimated:     a guess or rough projection
 * - unknown:       no value available; never treated as zero
 */
export type Provenance = 'verified' | 'user-provided' | 'estimated' | 'unknown';

export const PROVENANCE_ORDER: readonly Provenance[] = ['verified', 'user-provided', 'estimated', 'unknown'];

export type FieldKind = 'money' | 'percent' | 'count';

export type FieldKey =
  | 'salePrice'
  | 'productCost'
  | 'inboundShippingPerUnit'
  | 'referralFeePercent'
  | 'fulfillmentFeePerUnit'
  | 'storageFeePerUnit'
  | 'prepFeePerUnit'
  | 'adSpendPerUnit'
  | 'returnRatePercent'
  | 'returnLossPerReturn'
  | 'fixedMonthlyCosts'
  | 'monthlyUnitsSold';

export interface FieldDefinition {
  key: FieldKey;
  label: string;
  kind: FieldKind;
  help: string;
  /** Where to look this value up for free. General guidance only; never a value. */
  lookup: string;
}

/** A value exactly as the user typed it, plus where it came from. */
export interface RawInput {
  value?: string | number | null;
  source: Provenance;
}

export type ProductInputs = Partial<Record<FieldKey, RawInput>>;

export interface ResolvedInput {
  key: FieldKey;
  label: string;
  kind: FieldKind;
  value: number | null;
  source: Provenance;
}

export interface ValidationError {
  field: FieldKey;
  message: string;
}

export type MetricKey =
  | 'grossRevenuePerUnit'
  | 'referralFeePerUnit'
  | 'returnCostPerUnit'
  | 'totalCostPerUnit'
  | 'contributionProfitPerUnit'
  | 'contributionMarginPercent'
  | 'roiPercent'
  | 'monthlyGrossRevenue'
  | 'monthlyContributionProfit'
  | 'netBusinessProfitMonthly';

export type MetricStatus = 'complete' | 'incomplete' | 'not-applicable' | 'invalid';

export interface Metric {
  key: MetricKey;
  label: string;
  unit: 'money' | 'percent';
  /** Rounded to 2 decimal places. null whenever status is not 'complete'. */
  value: number | null;
  status: MetricStatus;
  /** Human-readable formula, always present. */
  formula: string;
  /** The formula with the actual numbers substituted in; null when it could not be computed. */
  workedFormula: string | null;
  inputsUsed: FieldKey[];
  missingInputs: FieldKey[];
  /** Weakest provenance among the inputs used (null when incomplete or invalid). */
  basis: Provenance | null;
  note?: string;
}

export type AssumptionLevel = 'invalid' | 'incomplete' | 'unverified' | 'all-verified';

export interface CalculationReport {
  ok: boolean;
  errors: ValidationError[];
  inputs: Record<FieldKey, ResolvedInput>;
  metrics: Record<MetricKey, Metric>;
  warnings: string[];
  assumptionLevel: AssumptionLevel;
}
