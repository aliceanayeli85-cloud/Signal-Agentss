import { FIELDS, FIELD_BY_KEY } from './fields';
import { parseAmount, roundTo } from './parse';
import {
  PROVENANCE_ORDER,
  type AssumptionLevel,
  type CalculationReport,
  type FieldKey,
  type Metric,
  type MetricKey,
  type ProductInputs,
  type Provenance,
  type ResolvedInput,
  type ValidationError,
} from './types';

type Values = Record<FieldKey, number | null>;
/** Values once every dependency of a metric is known. */
type Known = Record<FieldKey, number>;

type Outcome = { value: number; worked: string } | { notApplicable: string };

interface MetricDefinition {
  key: MetricKey;
  label: string;
  unit: 'money' | 'percent';
  formula: string;
  deps: (v: Values) => FieldKey[];
  compute: (v: Known) => Outcome;
  note?: (v: Values) => string | undefined;
}

export const DISCLAIMER =
  'These figures are arithmetic on your inputs. They do not validate product demand, competition or profitability.';

const n = (x: number) => String(roundTo(x, 4));

// --- Shared per-unit arithmetic (unrounded; only final metric values are rounded) ---

const PER_UNIT_COST_FIELDS: readonly FieldKey[] = [
  'productCost',
  'inboundShippingPerUnit',
  'referralFeePercent',
  'fulfillmentFeePerUnit',
  'storageFeePerUnit',
  'prepFeePerUnit',
  'adSpendPerUnit',
];

/** If the return rate is known to be exactly 0%, the loss per return cannot affect the result. */
function returnDeps(v: Values): FieldKey[] {
  return v.returnRatePercent === 0 ? ['returnRatePercent'] : ['returnRatePercent', 'returnLossPerReturn'];
}

function costDeps(v: Values): FieldKey[] {
  return ['salePrice', ...PER_UNIT_COST_FIELDS, ...returnDeps(v)];
}

const referralFee = (v: Known) => (v.salePrice * v.referralFeePercent) / 100;
const returnCost = (v: Known) => (v.returnRatePercent === 0 ? 0 : (v.returnRatePercent / 100) * v.returnLossPerReturn);
const totalCost = (v: Known) =>
  v.productCost +
  v.inboundShippingPerUnit +
  referralFee(v) +
  v.fulfillmentFeePerUnit +
  v.storageFeePerUnit +
  v.prepFeePerUnit +
  v.adSpendPerUnit +
  returnCost(v);
const contribution = (v: Known) => v.salePrice - totalCost(v);
const landedCost = (v: Known) => v.productCost + v.inboundShippingPerUnit + v.prepFeePerUnit;

const returnNote = (v: Values) =>
  v.returnRatePercent === 0 ? 'Return rate is 0%, so loss per returned unit is not needed.' : undefined;

const METRICS: readonly MetricDefinition[] = [
  {
    key: 'grossRevenuePerUnit',
    label: 'Gross revenue per unit',
    unit: 'money',
    formula: 'Sale price',
    deps: () => ['salePrice'],
    compute: (v) => ({ value: v.salePrice, worked: `${n(v.salePrice)}` }),
  },
  {
    key: 'referralFeePerUnit',
    label: 'Referral fee per unit',
    unit: 'money',
    formula: 'Sale price × Referral fee % ÷ 100',
    deps: () => ['salePrice', 'referralFeePercent'],
    compute: (v) => ({
      value: referralFee(v),
      worked: `${n(v.salePrice)} × ${n(v.referralFeePercent)} ÷ 100 = ${n(referralFee(v))}`,
    }),
  },
  {
    key: 'returnCostPerUnit',
    label: 'Expected return cost per unit sold',
    unit: 'money',
    formula: 'Return rate % ÷ 100 × Loss per returned unit',
    deps: returnDeps,
    note: returnNote,
    compute: (v) => ({
      value: returnCost(v),
      worked:
        v.returnRatePercent === 0
          ? '0 ÷ 100 × (not needed) = 0'
          : `${n(v.returnRatePercent)} ÷ 100 × ${n(v.returnLossPerReturn)} = ${n(returnCost(v))}`,
    }),
  },
  {
    key: 'totalCostPerUnit',
    label: 'Total variable cost per unit',
    unit: 'money',
    formula:
      'Product cost + Inbound shipping + Referral fee + FBA fulfillment fee + Storage + Prep + Ad spend + Expected return cost',
    deps: costDeps,
    note: returnNote,
    compute: (v) => ({
      value: totalCost(v),
      worked:
        `${n(v.productCost)} + ${n(v.inboundShippingPerUnit)} + ${n(referralFee(v))} + ${n(v.fulfillmentFeePerUnit)}` +
        ` + ${n(v.storageFeePerUnit)} + ${n(v.prepFeePerUnit)} + ${n(v.adSpendPerUnit)} + ${n(returnCost(v))}` +
        ` = ${n(totalCost(v))}`,
    }),
  },
  {
    key: 'contributionProfitPerUnit',
    label: 'Contribution profit per unit',
    unit: 'money',
    formula: 'Sale price − Total variable cost per unit',
    deps: costDeps,
    note: returnNote,
    compute: (v) => ({
      value: contribution(v),
      worked: `${n(v.salePrice)} − ${n(totalCost(v))} = ${n(contribution(v))}`,
    }),
  },
  {
    key: 'contributionMarginPercent',
    label: 'Contribution margin %',
    unit: 'percent',
    formula: 'Contribution profit per unit ÷ Sale price × 100',
    deps: costDeps,
    note: returnNote,
    compute: (v) =>
      v.salePrice === 0
        ? { notApplicable: 'Sale price is 0, so a margin percentage cannot be calculated.' }
        : {
            value: (contribution(v) / v.salePrice) * 100,
            worked: `${n(contribution(v))} ÷ ${n(v.salePrice)} × 100 = ${n((contribution(v) / v.salePrice) * 100)}`,
          },
  },
  {
    key: 'roiPercent',
    label: 'ROI % on landed cost',
    unit: 'percent',
    formula: 'Contribution profit per unit ÷ (Product cost + Inbound shipping + Prep) × 100',
    deps: costDeps,
    note: returnNote,
    compute: (v) =>
      landedCost(v) === 0
        ? { notApplicable: 'Landed cost (product + inbound shipping + prep) is 0, so ROI cannot be calculated.' }
        : {
            value: (contribution(v) / landedCost(v)) * 100,
            worked:
              `${n(contribution(v))} ÷ (${n(v.productCost)} + ${n(v.inboundShippingPerUnit)} + ${n(v.prepFeePerUnit)})` +
              ` × 100 = ${n((contribution(v) / landedCost(v)) * 100)}`,
          },
  },
  {
    key: 'monthlyGrossRevenue',
    label: 'Monthly gross revenue',
    unit: 'money',
    formula: 'Sale price × Units sold per month',
    deps: () => ['salePrice', 'monthlyUnitsSold'],
    compute: (v) => ({
      value: v.salePrice * v.monthlyUnitsSold,
      worked: `${n(v.salePrice)} × ${n(v.monthlyUnitsSold)} = ${n(v.salePrice * v.monthlyUnitsSold)}`,
    }),
  },
  {
    key: 'monthlyContributionProfit',
    label: 'Monthly contribution profit',
    unit: 'money',
    formula: 'Contribution profit per unit × Units sold per month',
    deps: (v) => [...costDeps(v), 'monthlyUnitsSold'],
    note: returnNote,
    compute: (v) => ({
      value: contribution(v) * v.monthlyUnitsSold,
      worked: `${n(contribution(v))} × ${n(v.monthlyUnitsSold)} = ${n(contribution(v) * v.monthlyUnitsSold)}`,
    }),
  },
  {
    key: 'netBusinessProfitMonthly',
    label: 'Net business profit per month',
    unit: 'money',
    formula: 'Monthly contribution profit − Fixed monthly costs',
    deps: (v) => [...costDeps(v), 'monthlyUnitsSold', 'fixedMonthlyCosts'],
    note: returnNote,
    compute: (v) => {
      const monthly = contribution(v) * v.monthlyUnitsSold;
      return {
        value: monthly - v.fixedMonthlyCosts,
        worked: `${n(monthly)} − ${n(v.fixedMonthlyCosts)} = ${n(monthly - v.fixedMonthlyCosts)}`,
      };
    },
  },
];

function weakest(sources: Provenance[]): Provenance {
  return sources.reduce<Provenance>(
    (worst, s) => (PROVENANCE_ORDER.indexOf(s) > PROVENANCE_ORDER.indexOf(worst) ? s : worst),
    'verified',
  );
}

function resolveInputs(input: ProductInputs): { inputs: Record<FieldKey, ResolvedInput>; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const inputs = {} as Record<FieldKey, ResolvedInput>;

  for (const field of FIELDS) {
    const raw = input[field.key];
    const base = { key: field.key, label: field.label, kind: field.kind };

    if (raw === undefined || raw === null) {
      inputs[field.key] = { ...base, value: null, source: 'unknown' };
      continue;
    }
    if (!PROVENANCE_ORDER.includes(raw.source)) {
      errors.push({ field: field.key, message: `${field.label}: source must be one of ${PROVENANCE_ORDER.join(', ')}` });
      inputs[field.key] = { ...base, value: null, source: 'unknown' };
      continue;
    }

    const parsed = parseAmount(raw.value, field.kind);
    if (!parsed.ok) {
      errors.push({ field: field.key, message: `${field.label}: ${parsed.message}` });
      inputs[field.key] = { ...base, value: null, source: 'unknown' };
      continue;
    }
    if (parsed.value !== null && raw.source === 'unknown') {
      errors.push({
        field: field.key,
        message: `${field.label}: has a value but is marked unknown. Mark it verified, user-provided or estimated, or clear the value.`,
      });
      inputs[field.key] = { ...base, value: null, source: 'unknown' };
      continue;
    }

    // A blank value is unknown, whatever source was selected.
    inputs[field.key] = parsed.value === null ? { ...base, value: null, source: 'unknown' } : { ...base, value: parsed.value, source: raw.source };
  }

  return { inputs, errors };
}

function labels(keys: Iterable<FieldKey>): string {
  return [...keys].map((k) => FIELD_BY_KEY[k].label).join(', ');
}

/**
 * Calculates profitability metrics from user inputs. Unknown inputs are never treated as zero:
 * any metric that depends on one is reported as incomplete, with the missing inputs listed.
 */
export function calculateProfitability(input: ProductInputs): CalculationReport {
  const { inputs, errors } = resolveInputs(input);
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, inputs[f.key].value])) as Values;
  const ok = errors.length === 0;

  const metrics = {} as Record<MetricKey, Metric>;
  for (const def of METRICS) {
    const inputsUsed = def.deps(values);
    const missingInputs = inputsUsed.filter((k) => values[k] === null);
    const base = { key: def.key, label: def.label, unit: def.unit, formula: def.formula, inputsUsed };
    const note = def.note?.(values);

    if (!ok) {
      metrics[def.key] = { ...base, value: null, status: 'invalid', workedFormula: null, missingInputs, basis: null, note: 'Fix the invalid inputs first.' };
      continue;
    }
    if (missingInputs.length > 0) {
      metrics[def.key] = {
        ...base,
        value: null,
        status: 'incomplete',
        workedFormula: null,
        missingInputs,
        basis: null,
        note: `Needs: ${labels(missingInputs)}.`,
      };
      continue;
    }

    const outcome = def.compute(values as Known);
    const basis = weakest(inputsUsed.map((k) => inputs[k].source));
    if ('notApplicable' in outcome) {
      metrics[def.key] = { ...base, value: null, status: 'not-applicable', workedFormula: null, missingInputs, basis, note: outcome.notApplicable };
    } else {
      metrics[def.key] = {
        ...base,
        value: roundTo(outcome.value, 2),
        status: 'complete',
        workedFormula: outcome.worked,
        missingInputs,
        basis,
        ...(note ? { note } : {}),
      };
    }
  }

  return { ok, errors, inputs, metrics, warnings: buildWarnings(ok, inputs, metrics), assumptionLevel: assumptionLevel(ok, metrics) };
}

function assumptionLevel(ok: boolean, metrics: Record<MetricKey, Metric>): AssumptionLevel {
  if (!ok) return 'invalid';
  const all = Object.values(metrics);
  if (all.some((m) => m.status === 'incomplete')) return 'incomplete';
  if (all.some((m) => m.basis !== null && m.basis !== 'verified')) return 'unverified';
  return 'all-verified';
}

function buildWarnings(ok: boolean, inputs: Record<FieldKey, ResolvedInput>, metrics: Record<MetricKey, Metric>): string[] {
  if (!ok) return ['Some inputs are invalid. Fix them before any result can be calculated.', DISCLAIMER];

  const warnings: string[] = [];
  const all = Object.values(metrics);

  const missing = new Set(all.flatMap((m) => m.missingInputs));
  if (missing.size > 0) {
    warnings.push(
      `Unknown inputs: ${labels(missing)}. Results that depend on them are not calculated — unknown costs are never treated as zero.`,
    );
  }

  const used = new Set(all.filter((m) => m.status !== 'incomplete').flatMap((m) => m.inputsUsed));
  const bySource = (s: Provenance) => [...used].filter((k) => inputs[k].source === s);
  const estimated = bySource('estimated');
  const unverified = bySource('user-provided');
  if (estimated.length > 0) warnings.push(`Estimated inputs: ${labels(estimated)}.`);
  if (unverified.length > 0) warnings.push(`Not verified against a source: ${labels(unverified)}.`);
  if (estimated.length > 0 || unverified.length > 0) {
    warnings.push(
      'Results depend on unverified assumptions. Check fees in Seller Central and costs with your supplier before relying on them.',
    );
  }

  const profit = metrics.contributionProfitPerUnit;
  if (profit.status === 'complete' && profit.value !== null && profit.value < 0) {
    warnings.push('Contribution profit per unit is negative: each sale loses money before fixed costs.');
  }
  const net = metrics.netBusinessProfitMonthly;
  if (net.status === 'complete' && net.value !== null && net.value < 0) {
    warnings.push('Net business profit per month is negative at these inputs.');
  }

  warnings.push(DISCLAIMER);
  return warnings;
}
