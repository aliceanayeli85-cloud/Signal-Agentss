import type { FormState } from '../ui/form-state';
import type { KeyValueStorage } from './browser-store';
import { MAX_NAME_LENGTH, MAX_NOTES_LENGTH, parseForm } from './product';

export const DRAFT_KEY = 'fba-desk:draft:v1';

/** The unsaved state of the form, kept so a page refresh doesn't lose typing. */
export interface Draft {
  form: FormState;
  name: string;
  notes: string;
  /** Id of the saved product being edited, or null for a new one. */
  editingId: string | null;
}

/** Best-effort: a draft is a convenience, so storage failures are ignored rather than shown. */
export function saveDraft(storage: KeyValueStorage | null, draft: Draft): void {
  if (!storage) return;
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Ignored on purpose.
  }
}

export function loadDraft(storage: KeyValueStorage | null): Draft | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { form, name, notes, editingId } = parsed as Record<string, unknown>;
    const parsedForm = parseForm(form);
    if (!parsedForm) return null;
    return {
      form: parsedForm,
      name: typeof name === 'string' ? name.slice(0, MAX_NAME_LENGTH) : '',
      notes: typeof notes === 'string' ? notes.slice(0, MAX_NOTES_LENGTH) : '',
      editingId: typeof editingId === 'string' ? editingId : null,
    };
  } catch {
    return null;
  }
}
