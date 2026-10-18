import { calculateProfitability, type AssumptionLevel, type Metric } from '../engine';
import type { SavedProduct } from '../storage/product';
import { toProductInputs } from './form-state';

export interface ComparisonRow {
  id: string;
  name: string;
  savedAt: string;
  contributionProfitPerUnit: Metric;
  contributionMarginPercent: Metric;
  roiPercent: Metric;
  netBusinessProfitMonthly: Metric;
  assumptionLevel: AssumptionLevel;
}

/** Recalculates every saved product from its stored inputs, so results always match current formulas. */
export function buildComparison(products: SavedProduct[]): ComparisonRow[] {
  return products.map((p) => {
    const report = calculateProfitability(toProductInputs(p.form));
    return {
      id: p.id,
      name: p.name,
      savedAt: p.savedAt,
      contributionProfitPerUnit: report.metrics.contributionProfitPerUnit,
      contributionMarginPercent: report.metrics.contributionMarginPercent,
      roiPercent: report.metrics.roiPercent,
      netBusinessProfitMonthly: report.metrics.netBusinessProfitMonthly,
      assumptionLevel: report.assumptionLevel,
    };
  });
}

export const DATA_QUALITY_LABEL: Readonly<Record<AssumptionLevel, string>> = {
  invalid: 'Has invalid inputs',
  incomplete: 'Missing inputs',
  unverified: 'Unverified inputs',
  'all-verified': 'All inputs verified',
};
