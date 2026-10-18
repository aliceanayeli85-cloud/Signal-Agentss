import { BrowserProductStore, MemoryProductStore, usableLocalStorage, type KeyValueStorage } from './browser-store';
import { ClaudeProductStore, type MinimalDb } from './claude-store';
import type { ProductStore } from './product';

/** The claude.ai page runtime (`window.claude`), present only when the app runs as a claude.ai Artifact. */
export interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

interface MinimalUser {
  id(): Promise<string | null>;
}

export interface StoreEnvironment {
  claude?: ClaudeRuntime;
  localStorage?: KeyValueStorage;
}

function hasMethod<K extends string>(value: unknown, name: K): value is Record<K, (...args: never[]) => unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function';
}

/**
 * Picks where saved products live, best first:
 * 1. the viewer's private claude.ai storage (when running as a claude.ai page and signed in),
 * 2. this browser's localStorage,
 * 3. memory only (lost on close), which the UI must flag clearly.
 */
export async function selectProductStore(env: StoreEnvironment): Promise<ProductStore> {
  if (env.claude && typeof env.claude.use === 'function') {
    try {
      const [db, user] = await Promise.all([env.claude.use('db'), env.claude.use('user')]);
      const viewerId = hasMethod(user, 'id') ? await (user as unknown as MinimalUser).id() : null;
      if (hasMethod(db, 'doc') && typeof viewerId === 'string' && viewerId !== '') {
        return new ClaudeProductStore(db as unknown as MinimalDb, viewerId);
      }
    } catch {
      // Fall through to browser storage.
    }
  }
  const local = usableLocalStorage(env.localStorage);
  if (local) return new BrowserProductStore(local);
  return new MemoryProductStore();
}
