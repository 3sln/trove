// Retry with exponential backoff + full jitter. Only retries errors classified
// retryable (see errors.js), respects an AbortSignal between attempts, and
// surfaces the last error untouched when it gives up — so the caller still sees
// a clean TroveError, not a generic "retries exhausted".

import { isRetryable, wrapError, TroveError } from './errors.js';

const DEFAULTS = {
  retries: 4, // attempts after the first = 5 total tries
  minDelayMs: 250,
  maxDelayMs: 8000,
  factor: 2,
  jitter: true,
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(TroveError.aborted());
    // `{ once: true }` removes the listener when it FIRES — not when the timer wins,
    // which is the normal case. One long-lived signal driving a few retried operations
    // therefore accumulated a listener per attempt and released none of them.
    const done = (fn) => (arg) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const t = setTimeout(() => done(resolve)(), ms);
    const onAbort = () => done(reject)(TroveError.aborted());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries]
 * @param {AbortSignal} [opts.signal]
 * @param {(info: {attempt: number, delayMs: number, error: TroveError}) => void} [opts.onRetry]
 * @param {(err: unknown) => boolean} [opts.shouldRetry] override classification
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const shouldRetry = cfg.shouldRetry ?? isRetryable;
  let attempt = 0;

  for (;;) {
    if (cfg.signal?.aborted) throw TroveError.aborted();
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = wrapError(raw);
      const canRetry = attempt < cfg.retries && shouldRetry(err) && err.code !== 'aborted';
      if (!canRetry) throw err;

      const base = Math.min(cfg.maxDelayMs, cfg.minDelayMs * cfg.factor ** attempt);
      const delayMs = cfg.jitter ? Math.random() * base : base;
      cfg.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs, cfg.signal);
      attempt++;
    }
  }
}

/** Reject after `ms`, unless `promise` settles first. Cleans up its timer. */
export function withTimeout(promise, ms, message = 'Operation timed out') {
  if (!ms || ms <= 0) return promise;
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(TroveError.timeout(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
