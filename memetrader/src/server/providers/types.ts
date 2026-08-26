import type {
  AssetClass,
  Candle,
  DataResult,
  MarketSnapshot,
  Timeframe,
} from '../../shared/types.js';

export type ScannerTab =
  | 'meme'
  | 'crypto'
  | 'stocks'
  | 'new-pairs'
  | 'top-momentum'
  | 'unusual-volume'
  | 'potential-breakouts';

/**
 * The adapter contract. Nothing above this layer knows which vendor it is talking
 * to, so a new provider can be added without touching the engines or the UI.
 *
 * A provider that cannot serve a capability returns an `unavailable` DataResult
 * with a human-readable reason. Throwing is reserved for genuine faults.
 */
export interface DataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly assetClasses: AssetClass[];
  /** Documentation URL, so the README's claims about each source are checkable. */
  readonly docsUrl: string;
  /** False when the provider needs a key that has not been supplied. */
  isConfigured(): boolean;
  /** Why it is not configured, shown verbatim in the UI. */
  unavailableReason(): string;

  search(query: string): Promise<DataResult<MarketSnapshot[]>>;
  listing(tab: ScannerTab): Promise<DataResult<MarketSnapshot[]>>;
  snapshot(assetId: string): Promise<DataResult<MarketSnapshot>>;
  candles(assetId: string, timeframe: Timeframe, limit: number): Promise<DataResult<Candle[]>>;
  /** Timeframes this provider can actually serve for the given asset class. */
  supportedTimeframes(): Timeframe[];
}

export function ok<T>(data: T, source: string, fetchedAt = Date.now()): DataResult<T> {
  return { status: 'ok', data, fetchedAt, source };
}

export function unavailable<T>(reason: string, source: string): DataResult<T> {
  return { status: 'unavailable', reason, source, fetchedAt: Date.now() };
}

/** Coerces provider-supplied values to a finite number, or null. Never to zero. */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function intOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}
