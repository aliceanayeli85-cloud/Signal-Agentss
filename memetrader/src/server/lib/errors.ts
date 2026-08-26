/** Thrown for client mistakes; surfaces as a 400 with the message shown to the user. */
export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when a resource genuinely does not exist. */
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown when an upstream data source failed. Never converted into placeholder data. */
export class UpstreamError extends Error {
  readonly status = 502;
  constructor(message: string, readonly source: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** Thrown when the user's own risk limits block an action. */
export class RiskLimitError extends Error {
  readonly status = 423;
  constructor(message: string, readonly reasons: string[]) {
    super(message);
    this.name = 'RiskLimitError';
  }
}

export function statusOf(error: unknown): number {
  if (
    error instanceof ValidationError ||
    error instanceof NotFoundError ||
    error instanceof UpstreamError ||
    error instanceof RiskLimitError
  ) {
    return error.status;
  }
  return 500;
}
