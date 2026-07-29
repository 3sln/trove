// Web Push over VAPID (RFC 8292), built on Web Crypto (crypto.subtle) so it runs
// unchanged on Node ≥20, Bun, Deno, and Cloudflare Workers — no Node crypto, no
// external deps (web-push et al. all pull in Node crypto).
//
// DESIGN — bodyless (no-payload) pushes:
// We deliberately send DATA-LESS web pushes: a VAPID-authenticated POST to the
// subscription endpoint carrying only a TTL (and optional urgency/topic), with
// an empty body. This AVOIDS the whole RFC 8291 payload-encryption stack — the
// ECDH key agreement over the subscription's p256dh key, the HKDF salt/IKM
// derivation, and aes128gcm content encoding. When the browser wakes the
// service worker for a data-less push, the worker calls back to our server to
// fetch whatever notifications are pending. So the subscription's `keys`
// (p256dh/auth) are never used here, and there is NO message encryption in this
// file — only VAPID (RFC 8292) request authorization.
//
// VAPID auth = a P-256 ECDSA (ES256) signed JWT identifying our application
// server, sent as `Authorization: vapid t=<jwt>, k=<appServerPublicKey>`.

import { TroveError } from '../errors.js';
import { withRetry } from '../retry.js';
import { assertPublicUrl } from '../util.js';
import { NotificationChannel } from './channel.js';

const enc = new TextEncoder();

// --- base64url (no padding) ---------------------------------------------------

/** Encode bytes as base64url without padding. */
export function base64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url (padded or not) string to bytes. */
export function base64urlDecode(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- key generation / import --------------------------------------------------

/**
 * Generate a VAPID application-server keypair (P-256 / ES256).
 * @returns {Promise<{publicKey: string, privateKey: string}>}
 *   `publicKey`  — the uncompressed EC point (65 bytes: 0x04 || X || Y),
 *                  base64url-encoded. This is the value browsers expect as
 *                  `applicationServerKey` in PushManager.subscribe().
 *   `privateKey` — the raw 32-byte scalar `d`, base64url-encoded.
 */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  // Reassemble the uncompressed point from the JWK's x/y coordinates.
  const x = base64urlDecode(jwk.x);
  const y = base64urlDecode(jwk.y);
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return {
    publicKey: base64urlEncode(point),
    privateKey: jwk.d, // JWK `d` is already raw base64url of the 32-byte scalar.
  };
}

/**
 * Import a stored `{publicKey, privateKey}` (base64url) as a signing CryptoKey.
 * The private JWK needs the matching public coordinates x/y, which we recover
 * from the stored uncompressed public point.
 * @returns {Promise<CryptoKey>}
 */
export async function importVapidPrivateKey({ publicKey, privateKey }) {
  const point = base64urlDecode(publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw TroveError.invalid('VAPID publicKey must be a 65-byte uncompressed P-256 point');
  }
  const x = base64urlEncode(point.subarray(1, 33));
  const y = base64urlEncode(point.subarray(33, 65));
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: privateKey, x, y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

// --- service ------------------------------------------------------------------

const GONE_STATUSES = new Set([404, 410]);

export class WebPushService {
  /**
   * @param {object} o
   * @param {string} o.publicKey  base64url uncompressed P-256 point (65 bytes)
   * @param {string} o.privateKey base64url raw 32-byte scalar `d`
   * @param {string} o.subject    VAPID `sub` claim — a `mailto:` or https URL
   */
  constructor({ publicKey, privateKey, subject } = {}) {
    if (!publicKey || !privateKey) {
      throw TroveError.invalid('WebPushService requires publicKey and privateKey');
    }
    if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
      throw TroveError.invalid('WebPushService subject must be a mailto: or https URL');
    }
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.subject = subject;
    this._signingKey = null; // lazily imported, then cached
  }

  async _key() {
    if (!this._signingKey) {
      this._signingKey = await importVapidPrivateKey({
        publicKey: this.publicKey,
        privateKey: this.privateKey,
      });
    }
    return this._signingKey;
  }

  /**
   * Build a VAPID JWT for a given endpoint audience.
   * @param {string} aud  origin of the push endpoint (scheme + host)
   * @param {number} now  epoch millis; exp = now + 12h
   * @returns {Promise<string>} the compact JWS (header.payload.signature)
   */
  async _signJwt(aud, now) {
    const header = base64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const payload = base64urlEncode(
      enc.encode(
        JSON.stringify({
          aud,
          exp: Math.floor(now / 1000) + 12 * 60 * 60, // 12 hours
          sub: this.subject,
        }),
      ),
    );
    const signingInput = `${header}.${payload}`;
    // Web Crypto returns the raw r||s (64 bytes) that JWS ES256 wants — NOT DER.
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      await this._key(),
      enc.encode(signingInput),
    );
    return `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
  }

  /**
   * Send a bodyless web push to a subscription.
   * @param {{endpoint: string, keys?: object}} subscription  standard PushSubscription JSON
   * @param {object} [o]
   * @param {number} [o.ttl=2419200]      seconds the push service holds the message (default 28d)
   * @param {string} [o.urgency='normal'] very-low | low | normal | high
   * @param {string} [o.topic]            optional collapse key
   * @param {number} [o.now=Date.now()]   epoch millis (for JWT exp; injectable for sandboxes/tests)
   * @param {AbortSignal} [o.signal]
   * @returns {Promise<{ok: boolean, status: number, gone?: boolean}>}
   *   `{ ok: false, gone: true }` when the subscription is dead (404/410) — the
   *   caller should delete it. Never throws for `gone`.
   */
  async send(subscription, { ttl = 2419200, urgency = 'normal', topic, now = Date.now(), signal } = {}) {
    const endpoint = subscription?.endpoint;
    if (!endpoint) throw TroveError.invalid('subscription.endpoint is required');

    let aud;
    try {
      aud = new URL(endpoint).origin;
    } catch (e) {
      throw TroveError.invalid('subscription.endpoint is not a valid URL', { cause: e });
    }

    const jwt = await this._signJwt(aud, now);
    const headers = {
      Authorization: `vapid t=${jwt}, k=${this.publicKey}`,
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Length': '0',
    };
    if (topic) headers.Topic = topic;

    return withRetry(
      async () => {
        let res;
        try {
          // `redirect: 'error'` because a push service that 302s us somewhere is either
          // broken or walking us onto an internal host the subscribe-time check refused.
          res = await fetch(endpoint, { method: 'POST', headers, body: '', signal, redirect: 'error' });
        } catch (e) {
          // Network failure — let withRetry classify it (wrapError → transient).
          throw e;
        }

        const status = res.status;
        // Dead subscription: signal the caller to delete it. Never throw.
        if (GONE_STATUSES.has(status)) return { ok: false, gone: true, status };
        // Throttling / server errors are retryable.
        if (status === 429 || status >= 500) {
          throw TroveError.transient(`Push endpoint returned ${status}`, { details: { status } });
        }
        // Any other non-2xx is a permanent client error (bad JWT, bad request…).
        if (status < 200 || status >= 300) {
          throw TroveError.invalid(`Push endpoint returned ${status}`, { details: { status } });
        }
        return { ok: true, status };
      },
      { signal },
    );
  }
}

// --- as a notification channel --------------------------------------------------

const NS_SUBS = 'push-subs'; // userId -> [subscription]

/**
 * Web push, as one way of reaching someone.
 *
 * Owns the subscriptions as well as the sending, because they are the same concern:
 * a subscription is a push endpoint and means nothing to any other channel. It also
 * owns the endpoints a browser uses to register one — the VAPID public key and the
 * subscribe/unsubscribe pair — so a drive with no push configured does not answer on
 * `/api/push/*` at all, rather than answering with a null.
 */
export class WebPushChannel extends NotificationChannel {
  /**
   * @param {object} o
   * @param {import('../kv.js').KeyValueStore} o.kv where subscriptions live
   * @param {WebPushService} [o.service] a ready service; otherwise built from the keys
   * @param {string} [o.publicKey]
   * @param {string} [o.privateKey]
   * @param {string} [o.subject]
   */
  constructor({ kv, service, publicKey, privateKey, subject } = {}) {
    super();
    if (!kv) throw TroveError.invalid('WebPushChannel requires a kv store');
    this.kv = kv;
    this.service = service ?? new WebPushService({ publicKey, privateKey, subject });
  }

  get id() { return 'web-push'; }

  /** The application server key a browser needs to subscribe. */
  get publicKey() { return this.service.publicKey; }

  async deliver(userId, note) {
    const subs = (await this.kv.get(NS_SUBS, userId)) || [];
    const alive = [];
    for (const sub of subs) {
      try {
        const res = await this.service.send(sub, { topic: 'mentions', urgency: 'normal' });
        if (!res.gone) alive.push(sub);
      } catch {
        alive.push(sub); // transient — keep the subscription, retry next drain
      }
    }
    if (alive.length !== subs.length) await this.kv.set(NS_SUBS, userId, alive);
  }

  async subscribe(userId, subscription) {
    if (!subscription?.endpoint) throw TroveError.invalid('Invalid push subscription');
    // The server POSTs to this endpoint, from inside its own network, on every drain.
    // Left unchecked it is a request forgery primitive any user can register — cloud
    // instance metadata being the obvious target. A real push service is on the public
    // internet, so nothing legitimate is lost by refusing the rest.
    assertPublicUrl(subscription.endpoint, 'Push endpoint');
    const subs = (await this.kv.get(NS_SUBS, userId)) || [];
    if (!subs.some((s) => s.endpoint === subscription.endpoint)) {
      subs.push(subscription);
      await this.kv.set(NS_SUBS, userId, subs);
    }
    return { ok: true };
  }

  async unsubscribe(userId, endpoint) {
    const subs = (await this.kv.get(NS_SUBS, userId)) || [];
    await this.kv.set(NS_SUBS, userId, subs.filter((s) => s.endpoint !== endpoint));
    return { ok: true };
  }
}
