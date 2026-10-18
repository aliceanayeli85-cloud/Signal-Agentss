import {
  StorageError,
  parseSavedProduct,
  sortNewestFirst,
  toStored,
  type ListResult,
  type ProductStore,
  type SavedProduct,
} from './product';

/** The subset of the claude.ai `db` capability this app uses. */
export interface MinimalDocRef {
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  collection(path: string): MinimalCollection;
}
export interface MinimalCollection {
  doc(id: string): MinimalDocRef;
  get(): Promise<{ docs: { data(): Record<string, unknown> | undefined }[] }>;
}
export interface MinimalDb {
  doc(path: string): MinimalDocRef;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unavailable';
}

function toStorageError(error: unknown, action: 'load' | 'save' | 'delete'): StorageError {
  switch (codeOf(error)) {
    case 'quota_exceeded':
      return new StorageError('Your saved-products storage is full. Delete some products and try again.');
    case 'invalid_argument':
      return new StorageError(`Could not ${action}: this page does not allow you to save data.`);
    case 'revoked':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return new StorageError(`Could not ${action}: saving is no longer available on this page. Reload to try again.`);
    default:
      return new StorageError(`Could not ${action} right now. Check your connection and try again.`);
  }
}

/** Retries once after a short random delay on a transient failure, as the platform recommends. */
async function withRetry<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (codeOf(error) !== 'unavailable') throw error;
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    return op();
  }
}

/**
 * Products stored in the viewer's private area of a claude.ai Artifact database:
 * data/users/<viewer id>/fba/products/<product id>. Only that viewer can read or write it.
 */
export class ClaudeProductStore implements ProductStore {
  readonly description = 'Saved privately to your Claude account. Only you can see these.';
  readonly persistent = true;
  private readonly products: MinimalCollection;

  constructor(db: MinimalDb, viewerId: string) {
    this.products = db.doc(`data/users/${viewerId}/fba`).collection('products');
  }

  async list(): Promise<ListResult> {
    let snapshot;
    try {
      snapshot = await withRetry(() => this.products.get());
    } catch (error) {
      throw toStorageError(error, 'load');
    }
    const parsed = snapshot.docs.map((d) => parseSavedProduct(d.data()));
    const products = parsed.filter((p): p is SavedProduct => p !== null);
    return { products: sortNewestFirst(products), skipped: parsed.length - products.length };
  }

  async save(product: SavedProduct): Promise<void> {
    try {
      await withRetry(() => this.products.doc(product.id).set(toStored(product)));
    } catch (error) {
      throw toStorageError(error, 'save');
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await withRetry(() => this.products.doc(id).delete());
    } catch (error) {
      throw toStorageError(error, 'delete');
    }
  }
}
