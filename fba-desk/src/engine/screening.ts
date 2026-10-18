import { parseAmount, type AmountKind } from './parse';
import type { Metric, MetricKey } from './types';

/**
 * The user's own screening rules: minimum results a product must reach.
 * The app supplies no default thresholds; a blank rule is simply not checked.
 */
export type RuleKey = 'minContributionPerUnit' | 'minMarginPercent' | 'minRoiPercent' | 'minNetMonthly';

export interface RuleDefinition {
  key: RuleKey;
  label: string;
  metric: MetricKey;
  kind: AmountKind;
  unit: 'money' | 'percent';
}

export const RULES: readonly RuleDefinition[] = [
  {
    key: 'minContributionPerUnit',
    label: 'Minimum contribution profit per unit',
    metric: 'contributionProfitPerUnit',
    kind: 'money',
    unit: 'money',
  },
  {
    key: 'minMarginPercent',
    label: 'Minimum contribution margin %',
    metric: 'contributionMarginPercent',
    kind: 'percent',
    unit: 'percent',
  },
  { key: 'minRoiPercent', label: 'Minimum ROI %', metric: 'roiPercent', kind: 'percent-uncapped', unit: 'percent' },
  {
    key: 'minNetMonthly',
    label: 'Minimum net business profit per month',
    metric: 'netBusinessProfitMonthly',
    kind: 'money',
    unit: 'money',
  },
];

/** Rules exactly as typed, so the form can show them back. */
export type RulesForm = Record<RuleKey, string>;
export type ScreeningRules = Partial<Record<RuleKey, number>>;

export function emptyRulesForm(): RulesForm {
  return Object.fromEntries(RULES.map((r) => [r.key, ''])) as RulesForm;
}

export function parseRulesForm(form: RulesForm): { rules: ScreeningRules; errors: Partial<Record<RuleKey, string>> } {
  const rules: ScreeningRules = {};
  const errors: Partial<Record<RuleKey, string>> = {};
  for (const rule of RULES) {
    const parsed = parseAmount(form[rule.key], rule.kind);
    if (!parsed.ok) errors[rule.key] = `${rule.label}: ${parsed.message}`;
    else if (parsed.value !== null) rules[rule.key] = parsed.value;
  }
  return { rules, errors };
}

export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface RuleCheck {
  key: RuleKey;
  label: string;
  unit: 'money' | 'percent';
  threshold: number;
  value: number | null;
  status: CheckStatus;
}

export type Verdict = 'no-rules' | 'meets' | 'fails' | 'not-enough-data';

export interface ScreeningResult {
  verdict: Verdict;
  checks: RuleCheck[];
  /** True when a "meets" verdict depends on inputs that are estimated or not verified. */
  unverified: boolean;
}

/**
 * Compares calculated metrics with the user's rules.
 * - Any rule that is checked and missed → 'fails' (a known shortfall is definitive).
 * - Otherwise, any rule that can't be checked (missing or invalid inputs) → 'not-enough-data'.
 * - Otherwise → 'meets'. That means "meets your rules", never "profitable" or "validated".
 */
export function evaluateRules(metrics: Record<MetricKey, Metric>, rules: ScreeningRules): ScreeningResult {
  const checks: RuleCheck[] = [];
  for (const rule of RULES) {
    const threshold = rules[rule.key];
    if (threshold === undefined) continue;
    const metric = metrics[rule.metric];
    const value = metric.status === 'complete' ? metric.value : null;
    const status: CheckStatus = value === null ? 'unknown' : value >= threshold ? 'pass' : 'fail';
    checks.push({ key: rule.key, label: rule.label, unit: rule.unit, threshold, value, status });
  }

  if (checks.length === 0) return { verdict: 'no-rules', checks, unverified: false };
  const verdict: Verdict = checks.some((c) => c.status === 'fail')
    ? 'fails'
    : checks.some((c) => c.status === 'unknown')
      ? 'not-enough-data'
      : 'meets';
  const unverified =
    verdict === 'meets' &&
    RULES.some((r) => rules[r.key] !== undefined && metrics[r.metric].basis !== 'verified');
  return { verdict, checks, unverified };
}

const VERDICT_ORDER: Record<Verdict, number> = { meets: 0, 'not-enough-data': 1, 'no-rules': 1, fails: 2 };

/**
 * Best first: meets (verified before unverified), then not enough data, then fails.
 * Within a group, higher contribution profit per unit first; unknown profit last.
 */
export function compareByScreening(
  a: { screening: ScreeningResult; contribution: number | null },
  b: { screening: ScreeningResult; contribution: number | null },
): number {
  const group = VERDICT_ORDER[a.screening.verdict] - VERDICT_ORDER[b.screening.verdict];
  if (group !== 0) return group;
  if (a.screening.unverified !== b.screening.unverified) return a.screening.unverified ? 1 : -1;
  if (a.contribution === null && b.contribution === null) return 0;
  if (a.contribution === null) return 1;
  if (b.contribution === null) return -1;
  return b.contribution - a.contribution;
}
