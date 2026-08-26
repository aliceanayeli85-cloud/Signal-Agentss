import { env } from './env.js';
import { logger } from './logger.js';
import { UpstreamError } from './errors.js';

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Retries on network failure and 5xx only - never on a 4xx, which is our bug. */
  retries?: number;
  source: string;
  headers?: Record<string, string>;
}

/**
 * JSON fetch with a timeout, bounded retries and explicit rate-limit handling.
 *
 * On any failure this throws UpstreamError. It never returns a partial or
 * synthesised body: a caller that cannot get data must show DATA UNAVAILABLE.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? env.httpTimeoutMs;
  const maxAttempts = (options.retries ?? 2) + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', ...(options.headers ?? {}) },
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        throw new UpstreamError(
          `${options.source} rate limit reached${retryAfter > 0 ? `; retry after ${retryAfter}s` : ''}.`,
          options.source,
        );
      }
      if (response.status >= 500) {
        throw new UpstreamError(
          `${options.source} returned ${response.status}.`,
          options.source,
        );
      }
      if (!response.ok) {
        // 4xx is a request we got wrong; retrying will not help.
        throw new UpstreamError(
          `${options.source} rejected the request with ${response.status}.`,
          options.source,
        );
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new UpstreamError(`${options.source} returned an empty body.`, options.source);
      }
      try {
        return JSON.parse(text) as T;
      } catch (parseError) {
        throw new UpstreamError(
          `${options.source} returned a body that is not valid JSON.`,
          options.source,
          parseError,
        );
      }
    } catch (error) {
      lastError = error;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      // A 429 is the server asking for FEWER requests. Retrying it - especially
      // on a short backoff - makes the situation worse and burns the budget that
      // later requests need, so rate limits are surfaced immediately.
      const isRateLimit = error instanceof UpstreamError && /rate limit/i.test(error.message);
      const retryable =
        !isRateLimit && (isAbort || !(error instanceof UpstreamError) || /returned 5/.test(error.message));

      if (!retryable || attempt === maxAttempts) break;
      const backoff = 250 * 2 ** (attempt - 1);
      logger.warn('upstream retry', { source: options.source, attempt, backoff, url });
      await new Promise((r) => setTimeout(r, backoff));
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof UpstreamError) throw lastError;
  if (lastError instanceof Error && lastError.name === 'AbortError') {
    throw new UpstreamError(
      `${options.source} did not respond within ${timeoutMs}ms.`,
      options.source,
      lastError,
    );
  }
  throw new UpstreamError(
    `${options.source} could not be reached: ${lastError instanceof Error ? lastError.message : 'unknown error'}.`,
    options.source,
    lastError,
  );
}
