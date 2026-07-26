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
  QUOTA: 'quota', // out of space (507) / rate limited by capacity (429) — see below
  TOO_LARGE: 'too_large', // this request is bigger than a configured limit allows
  BAD_RANGE: 'bad_range', // the requested byte range doesn't exist in this object (416)
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
  [ErrorCode.TOO_LARGE]: 413,
  [ErrorCode.BAD_RANGE]: 416,
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
    // QUOTA covers two failures that deserve different statuses. A rate limit is 429 —
    // back off and try again. Being out of DISK is 507: retrying changes nothing, and
    // telling a client to retry sends it into a loop against a condition only a human
    // can clear. `retryable` is what tells them apart.
    //
    // "Your file is bigger than we allow" is neither, and has its own code (TOO_LARGE,
    // 413): the store is not full, and nothing about waiting or freeing space helps.
    if (this.code === ErrorCode.QUOTA && !this.retryable) this.status = 507;
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
  static tooLarge(message = 'Too large', opts) {
    return new TroveError(ErrorCode.TOO_LARGE, message, { retryable: false, ...opts });
  }
  /** The requested byte range doesn't exist in this object — 416, not 400 or 500. */
  static badRange(message = 'Range not satisfiable', opts) {
    return new TroveError(ErrorCode.BAD_RANGE, message, { retryable: false, ...opts });
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
    // Out of room. NOT retryable, unlike the rate-limit sense of QUOTA that shares this
    // code — retrying a full disk just burns the user's time to reach the same answer.
    // The message is what someone can act on, rather than the kernel's phrasing.
    case 'ENOSPC':
      return new TroveError(ErrorCode.QUOTA, 'The storage volume is full — free some space and try again', { cause: err, retryable: false });
    case 'EDQUOT':
      return new TroveError(ErrorCode.QUOTA, 'The storage quota for this volume has been reached', { cause: err, retryable: false });
    case 'EFBIG':
      return new TroveError(ErrorCode.QUOTA, 'That file is larger than this filesystem can store', { cause: err, retryable: false });
  }

  return TroveError.internal(err?.message || fallbackMessage, { cause: err });
}

/**
 * Did this fail because the store is out of room?
 *
 * QUOTA covers two different things — "no space left" and "you are being rate limited"
 * — and only the first is a standing condition someone has to go and fix. Callers that
 * want to raise a persistent, actionable problem need to tell them apart, and the
 * distinguishing fact is that a full disk is not retryable.
 */
export function isOutOfSpace(err) {
  return err instanceof TroveError && err.code === ErrorCode.QUOTA && err.retryable === false;
}

/** True if the thrown value should be retried. */
export function isRetryable(err) {
  if (err instanceof TroveError) return err.retryable;
  return wrapError(err).retryable;
}
