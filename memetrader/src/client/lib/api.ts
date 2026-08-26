/**
 * Thin API client. Errors from the server carry a human-readable `message`,
 * which is what the UI displays - the app never replaces a failure with a
 * plausible-looking default.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ApiError(
      `Could not reach the MemeTrader OS API. Is the server running? (${error instanceof Error ? error.message : 'network error'})`,
      0,
      'network_error',
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError('The API returned a response that was not valid JSON.', response.status, 'bad_response');
    }
  }

  if (!response.ok) {
    const record = (body ?? {}) as { message?: string; error?: string; reasons?: string[] };
    throw new ApiError(
      record.message ?? `Request failed with status ${response.status}.`,
      response.status,
      record.error ?? 'unknown_error',
      record.reasons,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, payload?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(payload ?? {}) }),
  put: <T>(path: string, payload: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(payload) }),
  patch: <T>(path: string, payload: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
