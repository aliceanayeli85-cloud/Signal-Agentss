import {
  calculateProfitability,
  compareByScreening,
  evaluateRules,
  type AssumptionLevel,
  type Metric,
  type ScreeningResult,
  type ScreeningRules,
} from '../engine';
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
  screening: ScreeningResult;
}

export type SortMode = 'best' | 'newest';

/**
 * Recalculates every saved product from its stored inputs (so results always match current
 * formulas) and checks it against the user's rules.
 */
export function buildComparison(
  products: SavedProduct[],
  rules: ScreeningRules = {},
  sort: SortMode = 'newest',
): ComparisonRow[] {
  const rows = products.map((p) => {
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
      screening: evaluateRules(report.metrics, rules),
    };
  });
  if (sort === 'newest') return rows.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  return rows.sort((a, b) =>
    compareByScreening(
      { screening: a.screening, contribution: a.contributionProfitPerUnit.value },
      { screening: b.screening, contribution: b.contributionProfitPerUnit.value },
    ),
  );
}

export const DATA_QUALITY_LABEL: Readonly<Record<AssumptionLevel, string>> = {
  invalid: 'Has invalid inputs',
  incomplete: 'Missing inputs',
  unverified: 'Unverified inputs',
  'all-verified': 'All inputs verified',
};

export function verdictLabel(screening: ScreeningResult): string {
  switch (screening.verdict) {
    case 'meets':
      return screening.unverified ? 'Meets your rules (unverified inputs)' : 'Meets your rules';
    case 'fails':
      return 'Fails your rules';
    case 'not-enough-data':
      return 'Not enough data';
    case 'no-rules':
      return 'No rules set';
  }
}
