/**
 * Typed errors so routes can map failures to honest status codes.
 *
 * The rule for this codebase: when a dependency cannot supply data, the
 * request fails. Nothing is generated, estimated, or filled in. A trading
 * setup built on invented inputs is indistinguishable from a real one, and
 * that is the single most dangerous thing this service could do.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly detail?: unknown;

  constructor(statusCode: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

/** The caller has no Dhan session, or it expired. */
export class NotAuthenticatedError extends AppError {
  constructor(message = 'No active Dhan session. Log in at /auth/dhan/login first.') {
    super(401, 'NOT_AUTHENTICATED', message);
  }
}

/** The server itself is not configured to talk to Dhan. */
export class NotConfiguredError extends AppError {
  constructor(what: string) {
    super(
      503,
      'NOT_CONFIGURED',
      `${what} is not configured. Set it in .env — see .env.example.`
    );
  }
}

/** An upstream provider failed. Never swallowed, never substituted. */
export class UpstreamError extends AppError {
  constructor(provider: string, message: string, detail?: unknown) {
    super(502, 'UPSTREAM_FAILED', `${provider}: ${message}`, detail);
  }
}

/** Data arrived but is unusable — too short, malformed, or self-inconsistent. */
export class DataUnavailableError extends AppError {
  constructor(message: string, detail?: unknown) {
    super(503, 'DATA_UNAVAILABLE', message, detail);
  }
}
