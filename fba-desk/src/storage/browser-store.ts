import {
  StorageError,
  parseSavedProduct,
  sortNewestFirst,
  toStored,
  type ListResult,
  type ProductStore,
  type SavedProduct,
} from './product';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const PRODUCTS_KEY = 'fba-desk:products:v1';
export const BACKUP_KEY = `${PRODUCTS_KEY}:damaged-backup`;

/** Returns the browser's localStorage if it can actually be written, otherwise null. */
export function usableLocalStorage(candidate: KeyValueStorage | undefined): KeyValueStorage | null {
  if (!candidate) return null;
  try {
    const probe = 'fba-desk:probe';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

/** Keeps all products as one JSON array under a single key. */
export class BrowserProductStore implements ProductStore {
  readonly description = 'Saved in this browser on this device only.';
  readonly persistent = true;

  constructor(private readonly storage: KeyValueStorage) {}

  private readRaw(): string | null {
    try {
      return this.storage.getItem(PRODUCTS_KEY);
    } catch {
      throw new StorageError('This browser is blocking saved data. Check that site data is allowed.');
    }
  }

  /** Parses the stored array. `damaged` means the whole value was unreadable. */
  private readAll(): { entries: unknown[]; damaged: boolean } {
    const raw = this.readRaw();
    if (raw === null) return { entries: [], damaged: false };
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? { entries: parsed, damaged: false } : { entries: [], damaged: true };
    } catch {
      return { entries: [], damaged: true };
    }
  }

  private writeAll(entries: unknown[]): void {
    try {
      this.storage.setItem(PRODUCTS_KEY, JSON.stringify(entries));
    } catch {
      throw new StorageError('Could not save: browser storage is full or blocked. Delete some products and try again.');
    }
  }

  /** Before replacing unreadable data, keep a copy of it so nothing is silently destroyed. */
  private backUpDamaged(): void {
    const raw = this.readRaw();
    if (raw === null) return;
    try {
      this.storage.setItem(BACKUP_KEY, raw);
    } catch {
      throw new StorageError('Saved data is damaged and could not be backed up, so nothing was overwritten.');
    }
  }

  async list(): Promise<ListResult> {
    const { entries, damaged } = this.readAll();
    const products = entries.map(parseSavedProduct).filter((p): p is SavedProduct => p !== null);
    return { products: sortNewestFirst(products), skipped: (damaged ? 1 : 0) + entries.length - products.length };
  }

  async save(product: SavedProduct): Promise<void> {
    const { entries, damaged } = this.readAll();
    if (damaged) this.backUpDamaged();
    // Unreadable individual entries are kept as-is rather than deleted.
    const kept = entries.filter((e) => parseSavedProduct(e)?.id !== product.id);
    this.writeAll([...kept, toStored(product)]);
  }

  async remove(id: string): Promise<void> {
    const { entries, damaged } = this.readAll();
    if (damaged) return;
    this.writeAll(entries.filter((e) => parseSavedProduct(e)?.id !== id));
  }
}

/** Fallback when nothing persistent is available: products last until the page is closed. */
export class MemoryProductStore implements ProductStore {
  readonly description = 'Saving is not available here. Saved products will be lost when you close this page.';
  readonly persistent = false;
  private readonly items = new Map<string, SavedProduct>();

  async list(): Promise<ListResult> {
    return { products: sortNewestFirst([...this.items.values()]), skipped: 0 };
  }

  async save(product: SavedProduct): Promise<void> {
    this.items.set(product.id, structuredClone(product));
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
