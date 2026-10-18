import {
  FIELDS,
  PROVENANCE_ORDER,
  calculateProfitability,
  type CalculationReport,
  type FieldKey,
  type Metric,
  type Provenance,
} from '../engine';
import { usableLocalStorage, type KeyValueStorage } from '../storage/browser-store';
import { loadDraft, saveDraft } from '../storage/draft';
import {
  StorageError,
  newProductId,
  validateNotes,
  validateProductName,
  type ProductStore,
  type SavedProduct,
} from '../storage/product';
import { selectProductStore, type ClaudeRuntime } from '../storage/select';
import { DATA_QUALITY_LABEL, buildComparison } from './compare';
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

// --- State ---

let state: FormState = emptyForm();
let productName = '';
let productNotes = '';
/** Id of the saved product currently loaded in the form, or null for a new one. */
let editingId: string | null = null;
/** Form contents at the last save or open, used to warn before discarding changes. */
let savedSnapshot = '';
let store: ProductStore | null = null;
let products: SavedProduct[] = [];
let busy = false;

const valueInputs = {} as Record<FieldKey, HTMLInputElement>;
const sourceSelects = {} as Record<FieldKey, HTMLSelectElement>;
const errorSlots = {} as Record<FieldKey, HTMLElement>;
/** "Show calculation" panels the user opened, kept open across re-renders. */
const openDetails = new Set<string>();

/** localStorage can throw on access in sandboxed or privacy-restricted frames. */
function browserStorage(): KeyValueStorage | null {
  try {
    return usableLocalStorage(window.localStorage);
  } catch {
    return null;
  }
}
const draftStorage = browserStorage();

function snapshotOf(form: FormState, name: string, notes: string): string {
  return JSON.stringify({ form, name, notes });
}

function snapshot(): string {
  return snapshotOf(state, productName, productNotes);
}

function hasUnsavedChanges(): boolean {
  const hasContent =
    productName.trim() !== '' || productNotes.trim() !== '' || FIELDS.some((f) => state[f.key].text.trim() !== '');
  return hasContent && snapshot() !== savedSnapshot;
}

let draftTimer: ReturnType<typeof setTimeout> | undefined;
function flushDraft(): void {
  clearTimeout(draftTimer);
  draftTimer = undefined;
  saveDraft(draftStorage, { form: state, name: productName, notes: productNotes, editingId });
}

/** Typing is saved after a short pause; flushDraft() writes immediately. */
function scheduleDraftSave(): void {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}

// --- Calculator form ---

function buildForm(container: HTMLElement): void {
  for (const field of FIELDS) {
    const inputId = `in-${field.key}`;
    const input = el('input', {
      attrs: {
        id: inputId,
        type: 'text',
        inputmode: field.kind === 'count' ? 'numeric' : 'decimal',
        autocomplete: 'off',
        maxlength: '50',
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
  mustGet<HTMLInputElement>('product-name').value = productName;
  mustGet<HTMLTextAreaElement>('product-notes').value = productNotes;
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

// --- Results ---

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
  renderEditingState();
  scheduleDraftSave();
}

// --- Saved products ---

function setStatus(message: string, isError = false): void {
  const status = mustGet('save-status');
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function errorMessage(error: unknown): string {
  return error instanceof StorageError ? error.message : 'Something went wrong. Your inputs are still on the page.';
}

function renderEditingState(): void {
  const editing = editingId ? products.find((p) => p.id === editingId) : undefined;
  const label = mustGet('editing-label');
  label.hidden = !editing;
  label.textContent = editing ? `Editing saved product: ${editing.name}` : '';
  mustGet('save-update').hidden = !editing;
  for (const id of ['save-new', 'save-update']) mustGet<HTMLButtonElement>(id).disabled = busy || !store;
}

function setStorageNotice(text: string, warning: boolean): void {
  const notice = mustGet('storage-notice');
  notice.textContent = text;
  notice.classList.toggle('is-warning', warning);
}

/** Inline confirmation for product actions (browser dialogs are blocked inside embedded pages). */
function askProducts(message: string, confirmLabel: string, onConfirm: () => void): void {
  const box = mustGet('products-confirm');
  mustGet('products-confirm-text').textContent = message;
  const yes = mustGet<HTMLButtonElement>('products-confirm-yes');
  yes.textContent = confirmLabel;
  yes.onclick = () => {
    box.hidden = true;
    onConfirm();
  };
  box.hidden = false;
  mustGet('products-confirm-no').focus();
}

function renderProducts(): void {
  const rows = buildComparison(products);
  mustGet('products-empty').hidden = rows.length > 0;
  mustGet('products-table').hidden = rows.length === 0;
  mustGet('products-caption').hidden = rows.length === 0;
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  mustGet('products-body').replaceChildren(
    ...rows.map((row) => {
      const open = el('button', { text: 'Open', className: 'secondary', attrs: { type: 'button', 'data-open': row.id } });
      const remove = el('button', { text: 'Delete', className: 'secondary', attrs: { type: 'button', 'data-delete': row.id } });
      open.addEventListener('click', () => requestOpen(row.id));
      remove.addEventListener('click', () => requestDelete(row.id));
      // data-label is shown beside each value when the table is stacked as cards on narrow screens.
      const metricCell = (m: Metric, label: string) =>
        el('td', { className: 'num', text: formatMetricValue(m), attrs: { 'data-label': label } });
      return el('tr', { className: row.id === editingId ? 'is-editing' : '', attrs: { 'data-product': row.id } }, [
        el('td', {}, [
          el('span', { className: 'product-name', text: row.name }),
          el('span', { className: 'saved-at', text: `Saved ${dateFormat.format(new Date(row.savedAt))}` }),
        ]),
        metricCell(row.contributionProfitPerUnit, 'Contribution / unit'),
        metricCell(row.contributionMarginPercent, 'Margin'),
        metricCell(row.roiPercent, 'ROI'),
        metricCell(row.netBusinessProfitMonthly, 'Net / month'),
        el('td', { text: DATA_QUALITY_LABEL[row.assumptionLevel], attrs: { 'data-label': 'Data quality' } }),
        el('td', {}, [el('div', { className: 'row-actions' }, [open, remove])]),
      ]);
    }),
  );
}

async function refreshProducts(): Promise<void> {
  if (!store) return;
  try {
    const result = await store.list();
    products = result.products;
    const skippedNote =
      result.skipped > 0 ? ` ${result.skipped} saved item(s) could not be read and are not shown.` : '';
    setStorageNotice(store.description + skippedNote, !store.persistent || result.skipped > 0);
  } catch (error) {
    setStorageNotice(errorMessage(error), true);
  }
  if (editingId && !products.some((p) => p.id === editingId)) editingId = null;
  renderProducts();
  renderEditingState();
}

async function saveProduct(asNew: boolean): Promise<void> {
  if (!store || busy) return;
  const nameInput = mustGet<HTMLInputElement>('product-name');
  const problem = validateProductName(productName) ?? validateNotes(productNotes);
  nameInput.setAttribute('aria-invalid', validateProductName(productName) ? 'true' : 'false');
  if (problem) {
    setStatus(problem, true);
    if (validateProductName(productName)) nameInput.focus();
    return;
  }

  const product: SavedProduct = {
    id: !asNew && editingId ? editingId : newProductId(),
    name: productName.trim(),
    notes: productNotes,
    form: structuredClone(state),
    savedAt: new Date().toISOString(),
  };
  busy = true;
  setStatus('Saving…');
  renderEditingState();
  try {
    await store.save(product);
    editingId = product.id;
    productName = product.name;
    savedSnapshot = snapshot();
    setStatus(`Saved “${product.name}”.`);
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    busy = false;
  }
  await refreshProducts();
  flushDraft();
}

function openProduct(product: SavedProduct): void {
  state = structuredClone(product.form);
  productName = product.name;
  productNotes = product.notes;
  editingId = product.id;
  savedSnapshot = snapshot();
  syncFormControls();
  update();
  renderProducts();
  flushDraft();
  setStatus(`Opened “${product.name}”.`);
  mustGet('inputs-title').scrollIntoView({ block: 'start' });
}

function requestOpen(id: string): void {
  const product = products.find((p) => p.id === id);
  if (!product) return;
  if (hasUnsavedChanges()) {
    askProducts(`Open “${product.name}”? Unsaved changes in the form will be lost.`, 'Open product', () =>
      openProduct(product),
    );
  } else {
    openProduct(product);
  }
}

function requestDelete(id: string): void {
  const product = products.find((p) => p.id === id);
  if (!product || !store) return;
  askProducts(`Delete “${product.name}”? This cannot be undone.`, 'Delete product', async () => {
    try {
      await store?.remove(product.id);
      // The form keeps its contents, now as an unsaved new product.
      if (editingId === product.id) editingId = null;
      setStatus(`Deleted “${product.name}”.`);
    } catch (error) {
      setStatus(errorMessage(error), true);
    }
    await refreshProducts();
    flushDraft();
  });
}

// --- Startup ---

function init(): void {
  const form = mustGet<HTMLFormElement>('fields');
  form.addEventListener('submit', (e) => e.preventDefault());
  buildForm(form);

  mustGet<HTMLInputElement>('product-name').addEventListener('input', (e) => {
    productName = (e.target as HTMLInputElement).value;
    (e.target as HTMLInputElement).setAttribute('aria-invalid', 'false');
    scheduleDraftSave();
  });
  mustGet<HTMLTextAreaElement>('product-notes').addEventListener('input', (e) => {
    productNotes = (e.target as HTMLTextAreaElement).value;
    scheduleDraftSave();
  });
  mustGet('save-new').addEventListener('click', () => void saveProduct(true));
  mustGet('save-update').addEventListener('click', () => void saveProduct(false));
  mustGet('products-confirm-no').addEventListener('click', () => {
    mustGet('products-confirm').hidden = true;
  });

  mustGet('load-sample').addEventListener('click', () => {
    mustGet('clear-confirm').hidden = true;
    state = sampleForm();
    productName = 'Fictional sample product';
    productNotes = '';
    editingId = null;
    syncFormControls();
    update();
  });

  // In-page confirmation: browser confirm() dialogs are blocked inside embedded pages.
  const confirmBox = mustGet('clear-confirm');
  const clearInputs = () => {
    confirmBox.hidden = true;
    state = emptyForm();
    productName = '';
    productNotes = '';
    editingId = null;
    savedSnapshot = snapshot();
    syncFormControls();
    update();
    flushDraft();
    setStatus('');
  };
  mustGet('clear-all').addEventListener('click', () => {
    if (!hasUnsavedChanges() && editingId === null) return clearInputs();
    confirmBox.hidden = false;
    mustGet('clear-no').focus();
  });
  mustGet('clear-yes').addEventListener('click', clearInputs);
  mustGet('clear-no').addEventListener('click', () => {
    confirmBox.hidden = true;
    mustGet('clear-all').focus();
  });

  // Don't lose the last keystrokes when the page is closed, reloaded or backgrounded.
  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft();
  });

  const draft = loadDraft(draftStorage);
  if (draft) {
    state = draft.form;
    productName = draft.name;
    productNotes = draft.notes;
    editingId = draft.editingId;
  }
  syncFormControls();
  update();

  const claude = (window as unknown as { claude?: ClaudeRuntime }).claude;
  void selectProductStore({ claude, localStorage: draftStorage ?? undefined }).then(async (selected) => {
    store = selected;
    await refreshProducts();
    // A restored draft counts as unsaved only if it differs from the saved product it came from.
    const original = editingId ? products.find((p) => p.id === editingId) : undefined;
    if (original) savedSnapshot = snapshotOf(original.form, original.name, original.notes);
  });
}

init();
