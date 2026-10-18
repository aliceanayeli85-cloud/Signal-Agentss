import {
  FIELDS,
  PROVENANCE_ORDER,
  calculateProfitability,
  type CalculationReport,
  type FieldKey,
  type Metric,
  type Provenance,
} from '../engine';
import { emptyForm, sampleForm, toProductInputs, type FormState } from './form-state';
import { ASSUMPTION_SUMMARY, SOURCE_LABEL, STATUS_LABEL, formatMetricValue } from './format';

// All user-controlled text is written with textContent, never innerHTML.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id} in index.html`);
  return node as T;
}

let state: FormState = emptyForm();
const valueInputs = {} as Record<FieldKey, HTMLInputElement>;
const sourceSelects = {} as Record<FieldKey, HTMLSelectElement>;
const errorSlots = {} as Record<FieldKey, HTMLElement>;
/** "Show calculation" panels the user opened, kept open across re-renders. */
const openDetails = new Set<string>();

function buildForm(container: HTMLElement): void {
  for (const field of FIELDS) {
    const inputId = `in-${field.key}`;
    const input = el('input', {
      attrs: {
        id: inputId,
        type: 'text',
        inputmode: field.kind === 'count' ? 'numeric' : 'decimal',
        autocomplete: 'off',
        placeholder: 'unknown',
        'aria-describedby': `help-${field.key} err-${field.key}`,
        'data-field': field.key,
      },
    });
    const select = el(
      'select',
      { attrs: { 'aria-label': `${field.label} source`, 'data-source': field.key } },
      PROVENANCE_ORDER.map((p) => el('option', { text: SOURCE_LABEL[p], attrs: { value: p } })),
    );
    const error = el('p', { className: 'field-error', attrs: { id: `err-${field.key}`, role: 'alert' } });

    input.addEventListener('input', () => {
      state[field.key].text = input.value;
      update();
    });
    select.addEventListener('change', () => {
      state[field.key].source = select.value as Provenance;
      update();
    });

    valueInputs[field.key] = input;
    sourceSelects[field.key] = select;
    errorSlots[field.key] = error;

    container.append(
      el('div', { className: 'field' }, [
        el('label', { text: field.label + (field.kind === 'percent' ? ' (%)' : ''), attrs: { for: inputId } }),
        el('div', { className: 'field-controls' }, [input, select]),
        el('p', { className: 'field-help', text: field.help, attrs: { id: `help-${field.key}` } }),
        error,
      ]),
    );
  }
}

function syncFormControls(): void {
  for (const field of FIELDS) {
    valueInputs[field.key].value = state[field.key].text;
    sourceSelects[field.key].value = state[field.key].source;
  }
}

function renderFieldStatus(report: CalculationReport): void {
  for (const field of FIELDS) {
    const error = report.errors.find((e) => e.field === field.key);
    errorSlots[field.key].textContent = error ? error.message : '';
    valueInputs[field.key].setAttribute('aria-invalid', error ? 'true' : 'false');
    const isUnknown = !error && report.inputs[field.key].source === 'unknown';
    valueInputs[field.key].classList.toggle('is-unknown', isUnknown);
  }
}

function calculationDetails(key: string, children: Node[]): HTMLDetailsElement {
  const node = el('details', {}, [el('summary', { text: 'Show calculation' }), ...children]);
  node.open = openDetails.has(key);
  node.addEventListener('toggle', () => {
    if (node.open) openDetails.add(key);
    else openDetails.delete(key);
  });
  return node;
}

function metricCard(metric: Metric, report: CalculationReport): HTMLElement {
  const details: Node[] = [el('p', { className: 'formula', text: `Formula: ${metric.formula}` })];
  if (metric.workedFormula) details.push(el('p', { className: 'worked', text: `With your numbers: ${metric.workedFormula}` }));
  if (metric.basis && metric.status !== 'invalid') {
    details.push(el('p', { className: 'basis', text: `Weakest input label: ${SOURCE_LABEL[metric.basis]}` }));
  }
  if (metric.note) details.push(el('p', { className: 'note', text: metric.note }));
  const usedText = metric.inputsUsed
    .map((k) => `${report.inputs[k].label} (${SOURCE_LABEL[report.inputs[k].source]})`)
    .join(', ');
  details.push(el('p', { className: 'inputs-used', text: `Inputs: ${usedText}` }));

  return el('article', { className: `metric status-${metric.status}`, attrs: { 'data-metric': metric.key } }, [
    el('div', { className: 'metric-head' }, [
      el('h3', { text: metric.label }),
      el('span', { className: 'badge', text: STATUS_LABEL[metric.status] }),
    ]),
    el('p', { className: 'metric-value', text: formatMetricValue(metric) }),
    calculationDetails(metric.key, details),
  ]);
}

const GROUPS: { title: string; keys: (keyof CalculationReport['metrics'])[] }[] = [
  {
    title: 'Per unit',
    keys: [
      'grossRevenuePerUnit',
      'referralFeePerUnit',
      'returnCostPerUnit',
      'totalCostPerUnit',
      'contributionProfitPerUnit',
      'contributionMarginPercent',
      'roiPercent',
    ],
  },
  { title: 'Per month', keys: ['monthlyGrossRevenue', 'monthlyContributionProfit', 'netBusinessProfitMonthly'] },
];

function renderResults(report: CalculationReport): void {
  mustGet('summary').textContent = ASSUMPTION_SUMMARY[report.assumptionLevel];
  mustGet('summary').className = `summary level-${report.assumptionLevel}`;

  mustGet('warnings').replaceChildren(...report.warnings.map((w) => el('li', { text: w })));

  mustGet('results').replaceChildren(
    ...GROUPS.map((g) =>
      el('section', { className: 'metric-group' }, [
        el('h2', { text: g.title }),
        el(
          'div',
          { className: 'metric-grid' },
          g.keys.map((k) => metricCard(report.metrics[k], report)),
        ),
      ]),
    ),
  );
}

function update(): void {
  const report = calculateProfitability(toProductInputs(state));
  renderFieldStatus(report);
  renderResults(report);
}

function init(): void {
  const form = mustGet<HTMLFormElement>('fields');
  form.addEventListener('submit', (e) => e.preventDefault());
  buildForm(form);
  mustGet('load-sample').addEventListener('click', () => {
    state = sampleForm();
    syncFormControls();
    update();
  });
  mustGet('clear-all').addEventListener('click', () => {
    const hasData = FIELDS.some((f) => state[f.key].text.trim() !== '');
    if (hasData && !window.confirm('Clear all inputs? This cannot be undone.')) return;
    state = emptyForm();
    syncFormControls();
    update();
  });
  syncFormControls();
  update();
}

init();
