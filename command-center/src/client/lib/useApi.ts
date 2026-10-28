import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** When the last successful response arrived. */
  updatedAt: number | null;
  reload: () => void;
}

/** Fetches `path`, optionally re-fetching every `pollMs`. Keeps the last good data on error. */
export function useApi<T = any>(path: string | null, pollMs?: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const current = useRef(path);
  current.current = path;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (cancelled || current.current !== path) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((e: ApiError) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  useEffect(() => {
    if (!path || !pollMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, pollMs);
    return () => clearInterval(id);
  }, [path, pollMs]);

  useEffect(() => setData(null), [path]);

  return { data, error, loading, updatedAt, reload: useCallback(() => setTick((t) => t + 1), []) };
}
