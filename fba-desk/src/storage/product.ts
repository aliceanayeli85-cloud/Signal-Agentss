import { FIELDS, PROVENANCE_ORDER, RULES, emptyRulesForm, type Provenance, type RulesForm } from '../engine';
import { DEFAULT_SOURCE, type FormState } from '../ui/form-state';

export const SCHEMA_VERSION = 1;
export const MAX_NAME_LENGTH = 100;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_VALUE_LENGTH = 50;

/** Ids are used as storage path segments, so they are restricted to a safe alphabet. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface SavedProduct {
  id: string;
  name: string;
  notes: string;
  form: FormState;
  /** ISO 8601 timestamp of the last save. */
  savedAt: string;
}

/** Thrown by stores; `message` is written for the person using the app. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export function newProductId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Returns an error message for a product name, or null when it is acceptable. */
export function validateProductName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a product name before saving.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Product name must be at most ${MAX_NAME_LENGTH} characters.`;
  return null;
}

export function validateNotes(notes: string): string | null {
  return notes.length > MAX_NOTES_LENGTH ? `Notes must be at most ${MAX_NOTES_LENGTH} characters.` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates form data read from storage. Returns null if any part is malformed. */
export function parseForm(raw: unknown): FormState | null {
  if (!isRecord(raw)) return null;
  const form = {} as FormState;
  for (const field of FIELDS) {
    const entry = raw[field.key];
    // A field added in a later version is simply blank in older saves.
    if (entry === undefined) {
      form[field.key] = { text: '', source: DEFAULT_SOURCE };
      continue;
    }
    if (!isRecord(entry)) return null;
    const { text, source } = entry;
    if (typeof text !== 'string' || text.length > MAX_VALUE_LENGTH) return null;
    if (typeof source !== 'string' || !PROVENANCE_ORDER.includes(source as Provenance)) return null;
    form[field.key] = { text, source: source as Provenance };
  }
  return form;
}

/** Validates one saved product read from storage. Returns null if it is malformed. */
export function parseSavedProduct(raw: unknown): SavedProduct | null {
  if (!isRecord(raw)) return null;
  const { id, name, notes, form, savedAt } = raw;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (typeof name !== 'string' || validateProductName(name) !== null) return null;
  if (typeof notes !== 'string' || validateNotes(notes) !== null) return null;
  if (typeof savedAt !== 'string' || Number.isNaN(Date.parse(savedAt))) return null;
  const parsedForm = parseForm(form);
  if (!parsedForm) return null;
  return { id, name: name.trim(), notes, form: parsedForm, savedAt };
}

/** Plain JSON object written to storage. */
export function toStored(product: SavedProduct): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: product.id,
    name: product.name,
    notes: product.notes,
    savedAt: product.savedAt,
    form: Object.fromEntries(FIELDS.map((f) => [f.key, { ...product.form[f.key] }])),
  };
}

export function sortNewestFirst(products: SavedProduct[]): SavedProduct[] {
  return [...products].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** Validates screening rules read from storage. Returns null if malformed. */
export function parseStoredRules(raw: unknown): RulesForm | null {
  if (!isRecord(raw)) return null;
  const form = emptyRulesForm();
  for (const rule of RULES) {
    const value = raw[rule.key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) return null;
    form[rule.key] = value;
  }
  return form;
}

export interface ListResult {
  products: SavedProduct[];
  /** Number of stored entries that were unreadable and left out. */
  skipped: number;
}

export interface ProductStore {
  /** Where products are kept, in words for the person using the app. */
  readonly description: string;
  readonly persistent: boolean;
  list(): Promise<ListResult>;
  save(product: SavedProduct): Promise<void>;
  remove(id: string): Promise<void>;
  /** The user's screening rules, or null if none were saved yet. */
  loadRules(): Promise<RulesForm | null>;
  saveRules(rules: RulesForm): Promise<void>;
}
