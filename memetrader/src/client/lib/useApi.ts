import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api.js';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** When the currently held data was fetched, for the freshness indicator. */
  fetchedAt: number | null;
  reload: () => void;
}

/**
 * GET-and-hold hook with optional polling.
 *
 * On error it clears `data` rather than leaving the previous values on screen:
 * stale numbers presented as current are the exact failure mode this app exists
 * to avoid.
 */
export function useApi<T>(path: string | null, pollMs?: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const active = useRef(true);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    active.current = true;
    if (!path) {
      setData(null);
      setError(null);
      setLoading(false);
      return () => {
        active.current = false;
      };
    }

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const result = await api.get<T>(path);
        if (cancelled || !active.current) return;
        setData(result);
        setError(null);
        setFetchedAt(Date.now());
      } catch (err) {
        if (cancelled || !active.current) return;
        setData(null);
        setError(err instanceof ApiError ? err : new ApiError(String(err), 0, 'unknown_error'));
      } finally {
        if (!cancelled && active.current) setLoading(false);
      }
    };

    void run();
    const timer = pollMs && pollMs > 0 ? setInterval(run, pollMs) : null;
    return () => {
      cancelled = true;
      active.current = false;
      if (timer) clearInterval(timer);
    };
  }, [path, pollMs, nonce]);

  return { data, error, loading, fetchedAt, reload };
}

/** Ticks once a second so "4 seconds ago" labels stay honest without a refetch. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
