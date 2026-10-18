import { describe, expect, it } from 'vitest';
import {
  BACKUP_KEY,
  BrowserProductStore,
  MemoryProductStore,
  PRODUCTS_KEY,
  usableLocalStorage,
  type KeyValueStorage,
} from '../src/storage/browser-store';
import { ClaudeProductStore, type MinimalDb } from '../src/storage/claude-store';
import { DRAFT_KEY, loadDraft, saveDraft } from '../src/storage/draft';
import {
  MAX_NAME_LENGTH,
  StorageError,
  newProductId,
  parseSavedProduct,
  toStored,
  validateNotes,
  validateProductName,
  type SavedProduct,
} from '../src/storage/product';
import { selectProductStore } from '../src/storage/select';
import { emptyForm, sampleForm } from '../src/ui/form-state';

class FakeStorage implements KeyValueStorage {
  data = new Map<string, string>();
  failWrites = false;
  failReads = false;
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('SecurityError');
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function product(overrides: Partial<SavedProduct> = {}): SavedProduct {
  return {
    id: newProductId(),
    name: 'Fictional garlic press',
    notes: '',
    form: sampleForm(),
    savedAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('product validation', () => {
  it('round-trips a product through storage format', () => {
    const p = product({ notes: 'Supplier quote pending' });
    expect(parseSavedProduct(JSON.parse(JSON.stringify(toStored(p))))).toEqual(p);
  });

  it('generates ids that are safe as storage path segments', () => {
    const ids = new Set(Array.from({ length: 50 }, newProductId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('requires a product name within limits', () => {
    expect(validateProductName('')).toBe('Enter a product name before saving.');
    expect(validateProductName('   ')).toBe('Enter a product name before saving.');
    expect(validateProductName('x'.repeat(MAX_NAME_LENGTH))).toBeNull();
    expect(validateProductName('x'.repeat(MAX_NAME_LENGTH + 1))).toMatch(/at most 100/);
    expect(validateNotes('x'.repeat(2001))).toMatch(/at most 2000/);
  });

  it('rejects malformed saved data instead of crashing', () => {
    const good = toStored(product());
    const bad: unknown[] = [
      null,
      'text',
      [],
      { ...good, id: '../../etc' },
      { ...good, id: '' },
      { ...good, name: '' },
      { ...good, savedAt: 'not a date' },
      { ...good, notes: 5 },
      { ...good, form: null },
      { ...good, form: { ...(good.form as object), salePrice: { text: 5, source: 'verified' } } },
      { ...good, form: { ...(good.form as object), salePrice: { text: '5', source: 'guess' } } },
    ];
    for (const raw of bad) expect(parseSavedProduct(raw)).toBeNull();
  });

  it('treats fields missing from older saves as blank, never as zero', () => {
    const stored = toStored(product()) as { form: Record<string, unknown> };
    delete stored.form.monthlyUnitsSold;
    const parsed = parseSavedProduct(stored);
    expect(parsed?.form.monthlyUnitsSold).toEqual({ text: '', source: 'user-provided' });
  });
});

describe('BrowserProductStore', () => {
  it('saves, lists newest first, updates and deletes', async () => {
    const storage = new FakeStorage();
    const store = new BrowserProductStore(storage);
    expect(await store.list()).toEqual({ products: [], skipped: 0 });

    const older = product({ name: 'Older', savedAt: '2026-10-01T00:00:00.000Z' });
    const newer = product({ name: 'Newer', savedAt: '2026-10-05T00:00:00.000Z' });
    await store.save(older);
    await store.save(newer);
    expect((await store.list()).products.map((p) => p.name)).toEqual(['Newer', 'Older']);

    await store.save({ ...older, name: 'Older renamed', savedAt: '2026-10-09T00:00:00.000Z' });
    const listed = (await store.list()).products;
    expect(listed.map((p) => p.name)).toEqual(['Older renamed', 'Newer']);
    expect(listed).toHaveLength(2);

    await store.remove(newer.id);
    expect((await store.list()).products.map((p) => p.name)).toEqual(['Older renamed']);
  });

  it('survives a new store instance (data persists in storage)', async () => {
    const storage = new FakeStorage();
    const p = product();
    await new BrowserProductStore(storage).save(p);
    expect((await new BrowserProductStore(storage).list()).products).toEqual([p]);
  });

  it('skips unreadable entries, reports them, and keeps them on later saves', async () => {
    const storage = new FakeStorage();
    const good = product();
    storage.setItem(PRODUCTS_KEY, JSON.stringify([toStored(good), { junk: true }, 42]));
    const store = new BrowserProductStore(storage);
    expect(await store.list()).toEqual({ products: [good], skipped: 2 });

    await store.save(product({ name: 'Another' }));
    const raw = JSON.parse(storage.getItem(PRODUCTS_KEY) as string) as unknown[];
    expect(raw).toContainEqual({ junk: true });
    expect(raw).toContain(42);
  });

  it('backs up completely damaged data before overwriting it', async () => {
    const storage = new FakeStorage();
    storage.setItem(PRODUCTS_KEY, '{not json');
    const store = new BrowserProductStore(storage);
    expect(await store.list()).toEqual({ products: [], skipped: 1 });

    const p = product();
    await store.save(p);
    expect(storage.getItem(BACKUP_KEY)).toBe('{not json');
    expect((await store.list()).products).toEqual([p]);
  });

  it('refuses to overwrite damaged data it cannot back up', async () => {
    const storage = new FakeStorage();
    storage.setItem(PRODUCTS_KEY, '{not json');
    storage.failWrites = true;
    await expect(new BrowserProductStore(storage).save(product())).rejects.toThrow(/could not be backed up/);
    storage.failWrites = false;
    expect(storage.getItem(PRODUCTS_KEY)).toBe('{not json');
  });

  it('reports a full storage with a useful message', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const error = await new BrowserProductStore(storage).save(product()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as Error).message).toMatch(/full or blocked/);
  });

  it('reports blocked storage with a useful message', async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    await expect(new BrowserProductStore(storage).list()).rejects.toThrow(/blocking saved data/);
  });

  it('detects whether localStorage is usable', () => {
    expect(usableLocalStorage(undefined)).toBeNull();
    const blocked = new FakeStorage();
    blocked.failWrites = true;
    expect(usableLocalStorage(blocked)).toBeNull();
    const ok = new FakeStorage();
    expect(usableLocalStorage(ok)).toBe(ok);
    expect(ok.data.size).toBe(0);
  });
});

describe('MemoryProductStore', () => {
  it('works but is flagged as not persistent', async () => {
    const store = new MemoryProductStore();
    expect(store.persistent).toBe(false);
    expect(store.description).toMatch(/lost when you close/);
    const p = product();
    await store.save(p);
    expect((await store.list()).products).toEqual([p]);
    await store.remove(p.id);
    expect((await store.list()).products).toEqual([]);
  });
});

/** In-memory stand-in for the claude.ai db capability, recording paths used. */
function fakeDb(opts: { failWith?: string[] } = {}) {
  const docs = new Map<string, Record<string, unknown>>();
  const failures = [...(opts.failWith ?? [])];
  const paths: string[] = [];
  const maybeFail = async () => {
    const code = failures.shift();
    if (code) throw { code, message: code };
  };
  const collection = (base: string) => ({
    doc: (id: string) => docRef(`${base}/${id}`),
    get: async () => {
      await maybeFail();
      const prefix = `${base}/`;
      return {
        docs: [...docs.entries()]
          .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map(([, v]) => ({ data: () => v })),
      };
    },
  });
  const docRef = (path: string) => {
    paths.push(path);
    return {
      set: async (data: Record<string, unknown>) => {
        await maybeFail();
        docs.set(path, structuredClone(data));
      },
      delete: async () => {
        await maybeFail();
        docs.delete(path);
      },
      collection: (sub: string) => collection(`${path}/${sub}`),
    };
  };
  const db: MinimalDb = { doc: docRef };
  return { db, docs, paths };
}

describe('ClaudeProductStore', () => {
  it('keeps products under the viewer’s private path', async () => {
    const { db, docs } = fakeDb();
    const store = new ClaudeProductStore(db, 'u_viewer1');
    const p = product();
    await store.save(p);
    expect([...docs.keys()]).toEqual([`data/users/u_viewer1/fba/products/${p.id}`]);
    expect((await store.list()).products).toEqual([p]);
    await store.remove(p.id);
    expect(docs.size).toBe(0);
  });

  it('skips unreadable documents', async () => {
    const { db, docs } = fakeDb();
    const store = new ClaudeProductStore(db, 'u_viewer1');
    const p = product();
    await store.save(p);
    docs.set('data/users/u_viewer1/fba/products/broken', { name: 7 });
    expect(await store.list()).toEqual({ products: [p], skipped: 1 });
  });

  it('retries once on a transient failure', async () => {
    const { db } = fakeDb({ failWith: ['unavailable'] });
    const store = new ClaudeProductStore(db, 'u1');
    await expect(store.save(product())).resolves.toBeUndefined();
    expect((await store.list()).products).toHaveLength(1);
  });

  it('gives useful messages for permanent failures', async () => {
    const cases: [string, RegExp][] = [
      ['quota_exceeded', /storage is full/],
      ['invalid_argument', /does not allow you to save/],
      ['revoked', /no longer available/],
    ];
    for (const [code, message] of cases) {
      const { db } = fakeDb({ failWith: [code] });
      await expect(new ClaudeProductStore(db, 'u1').save(product())).rejects.toThrow(message);
    }
    const { db } = fakeDb({ failWith: ['unavailable', 'unavailable'] });
    await expect(new ClaudeProductStore(db, 'u1').list()).rejects.toThrow(/Could not load right now/);
  });
});

describe('selectProductStore', () => {
  it('uses private Claude storage when running as a signed-in claude.ai page', async () => {
    const { db } = fakeDb();
    const store = await selectProductStore({
      claude: { use: async (name) => (name === 'db' ? db : { id: async () => 'u_abc' }) },
      localStorage: new FakeStorage(),
    });
    expect(store).toBeInstanceOf(ClaudeProductStore);
  });

  it('falls back to browser storage when Claude storage is unavailable or signed out', async () => {
    const { db } = fakeDb();
    const noDb = await selectProductStore({ claude: { use: async () => null }, localStorage: new FakeStorage() });
    expect(noDb).toBeInstanceOf(BrowserProductStore);
    const signedOut = await selectProductStore({
      claude: { use: async (name) => (name === 'db' ? db : { id: async () => null }) },
      localStorage: new FakeStorage(),
    });
    expect(signedOut).toBeInstanceOf(BrowserProductStore);
    const throws = await selectProductStore({
      claude: { use: async () => Promise.reject(new Error('boom')) },
      localStorage: new FakeStorage(),
    });
    expect(throws).toBeInstanceOf(BrowserProductStore);
  });

  it('uses browser storage locally and memory as a last resort', async () => {
    expect(await selectProductStore({ localStorage: new FakeStorage() })).toBeInstanceOf(BrowserProductStore);
    const blocked = new FakeStorage();
    blocked.failWrites = true;
    expect(await selectProductStore({ localStorage: blocked })).toBeInstanceOf(MemoryProductStore);
    expect(await selectProductStore({})).toBeInstanceOf(MemoryProductStore);
  });
});

describe('draft autosave', () => {
  it('round-trips the unsaved form', () => {
    const storage = new FakeStorage();
    const draft = { form: sampleForm(), name: 'Draft name', notes: 'n', editingId: 'abc' };
    saveDraft(storage, draft);
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('ignores storage failures and damaged drafts', () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    expect(() => saveDraft(storage, { form: emptyForm(), name: '', notes: '', editingId: null })).not.toThrow();
    storage.failWrites = false;
    storage.setItem(DRAFT_KEY, '{oops');
    expect(loadDraft(storage)).toBeNull();
    storage.setItem(DRAFT_KEY, JSON.stringify({ form: { salePrice: { text: 1, source: 'x' } } }));
    expect(loadDraft(storage)).toBeNull();
    storage.failReads = true;
    expect(loadDraft(storage)).toBeNull();
    expect(loadDraft(null)).toBeNull();
  });
});
