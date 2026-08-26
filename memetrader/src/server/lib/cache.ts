import { env } from './env.js';

interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * Small TTL cache with a hard entry cap.
 *
 * Its job is to keep the app inside third-party rate limits. Crucially, entries
 * carry `storedAt` so the UI can display genuine data age - a cached value shown
 * as if it were live would be a subtler form of fake data.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number = env.cacheTtlMs,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): { value: T; storedAt: number; ageMs: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const ageMs = Date.now() - entry.storedAt;
    if (ageMs > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return { value: entry.value, storedAt: entry.storedAt, ageMs };
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, storedAt: Date.now() });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
