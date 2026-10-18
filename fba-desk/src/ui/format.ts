import type { AssumptionLevel, Metric, MetricStatus, Provenance } from '../engine';

const numberFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money is shown without a currency symbol: the app doesn't know which currency the user entered. */
export function formatNumber(value: number, unit: 'money' | 'percent'): string {
  const text = numberFormat.format(value);
  return unit === 'percent' ? `${text}%` : text;
}

export function formatMetricValue(metric: Metric): string {
  if (metric.status !== 'complete' || metric.value === null) return '—';
  return formatNumber(metric.value, metric.unit);
}

export const STATUS_LABEL: Readonly<Record<MetricStatus, string>> = {
  complete: 'Calculated',
  incomplete: 'Incomplete',
  'not-applicable': 'Not applicable',
  invalid: 'Invalid input',
};

export const SOURCE_LABEL: Readonly<Record<Provenance, string>> = {
  verified: 'Verified',
  'user-provided': 'User-provided',
  estimated: 'Estimated',
  unknown: 'Unknown',
};

export const ASSUMPTION_SUMMARY: Readonly<Record<AssumptionLevel, string>> = {
  invalid: 'Some inputs are invalid. Fix the highlighted fields.',
  incomplete: 'Some results are incomplete because inputs are unknown.',
  unverified: 'All results calculated, but they rely on unverified or estimated inputs.',
  'all-verified': 'All results calculated from inputs you marked as verified.',
};
