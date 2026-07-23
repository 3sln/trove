// A small, deliberate error taxonomy. Everything that can fail in Trove throws
// (or rejects with) a TroveError subclass so callers — and ultimately the user —
// get a stable `code`, a human `message`, and a `retryable` signal that the
// retry helper and the HTTP layer both key off of. Wrapping a lower-level cause
// (an S3 SDK error, a fetch TypeError) preserves it under `.cause` for logs
// while presenting a clean surface upward.

/** Stable, machine-readable codes. Mirrored by the HTTP layer → status codes. */
export const ErrorCode = Object.freeze({
  NOT_FOUND: 'not_found',
  ALREADY_EXISTS: 'already_exists',
  INVALID: 'invalid', // bad request / validation
  CONFLICT: 'conflict', // version/etag mismatch, concurrent edit
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  UNSUPPORTED: 'unsupported', // backend can't do this (e.g. presign on fs)
  QUOTA: 'quota', // out of space / rate limited by capacity
  TRANSIENT: 'transient', // network blip, 5xx, throttle — safe to retry
  TIMEOUT: 'timeout',
  ABORTED: 'aborted', // caller cancelled (AbortSignal)
  INTERNAL: 'internal', // unexpected; a bug
});

// Which codes are, by default, safe to retry with backoff.
const RETRYABLE = new Set([ErrorCode.TRANSIENT, ErrorCode.TIMEOUT, ErrorCode.QUOTA]);

// HTTP status for each code, so the server layer stays declarative.
const HTTP_STATUS = {
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.ALREADY_EXISTS]: 409,
  [ErrorCode.INVALID]: 400,
  [ErrorCode.CONFLICT]: 412,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.UNSUPPORTED]: 501,
  [ErrorCode.QUOTA]: 429,
  [ErrorCode.TRANSIENT]: 503,
  [ErrorCode.TIMEOUT]: 504,
  [ErrorCode.ABORTED]: 499,
  [ErrorCode.INTERNAL]: 500,
};

export class TroveError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message human-readable, safe to surface to the user
   * @param {{cause?: unknown, retryable?: boolean, details?: object}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'TroveError';
    this.code = code || ErrorCode.INTERNAL;
    // Explicit override wins; otherwise derive from the code.
    this.retryable = opts.retryable ?? RETRYABLE.has(this.code);
    this.details = opts.details ?? null;
    this.status = HTTP_STATUS[this.code] ?? 500;
  }

  /** Shape sent over the wire and logged. Never leaks the raw cause. */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }

  // Ergonomic constructors — read like prose at the call site.
  static notFound(what, opts) {
    return new TroveError(ErrorCode.NOT_FOUND, what ? `${what} not found` : 'Not found', opts);
  }
  static alreadyExists(what, opts) {
    return new TroveError(ErrorCode.ALREADY_EXISTS, `${what} already exists`, opts);
  }
  static invalid(message, opts) {
    return new TroveError(ErrorCode.INVALID, message, opts);
  }
  static conflict(message, opts) {
    return new TroveError(ErrorCode.CONFLICT, message, opts);
  }
  static unsupported(message, opts) {
    return new TroveError(ErrorCode.UNSUPPORTED, message, opts);
  }
  static transient(message, opts) {
    return new TroveError(ErrorCode.TRANSIENT, message, { retryable: true, ...opts });
  }
  static timeout(message, opts) {
    return new TroveError(ErrorCode.TIMEOUT, message, { retryable: true, ...opts });
  }
  static aborted(message = 'Operation aborted', opts) {
    return new TroveError(ErrorCode.ABORTED, message, { retryable: false, ...opts });
  }
  static unauthorized(message = 'Unauthorized', opts) {
    return new TroveError(ErrorCode.UNAUTHORIZED, message, opts);
  }
  static forbidden(message = 'Forbidden', opts) {
    return new TroveError(ErrorCode.FORBIDDEN, message, opts);
  }
  static internal(message = 'Internal error', opts) {
    return new TroveError(ErrorCode.INTERNAL, message, opts);
  }
}

/**
 * Normalize any thrown value into a TroveError. Recognises AbortError, common
 * fetch/network failures, and Node fs errno codes so lower layers can just
 * `throw wrapError(e)` and get sane classification for free.
 */
export function wrapError(err, fallbackMessage = 'Unexpected error') {
  if (err instanceof TroveError) return err;

  // Cancellation.
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return TroveError.aborted(err.message || 'Operation aborted', { cause: err });
  }

  // Node/browser network failures are transient by nature.
  const netCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET',
  ]);
  if (netCodes.has(err?.code) || (err instanceof TypeError && /fetch|network/i.test(err.message || ''))) {
    return TroveError.transient(err.message || 'Network error', { cause: err });
  }

  // Node fs errnos.
  switch (err?.code) {
    case 'ENOENT':
      return TroveError.notFound(null, { cause: err });
    case 'EEXIST':
      return TroveError.alreadyExists('Path', { cause: err });
    case 'EACCES':
    case 'EPERM':
      return new TroveError(ErrorCode.FORBIDDEN, 'Permission denied', { cause: err });
    case 'ENOSPC':
      return new TroveError(ErrorCode.QUOTA, 'No space left on device', { cause: err, retryable: false });
  }

  return TroveError.internal(err?.message || fallbackMessage, { cause: err });
}

/** True if the thrown value should be retried. */
export function isRetryable(err) {
  if (err instanceof TroveError) return err.retryable;
  return wrapError(err).retryable;
}
