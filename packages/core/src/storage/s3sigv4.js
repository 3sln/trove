// A compact AWS Signature V4 implementation built on Web Crypto (crypto.subtle),
// so it runs unchanged on Node ≥20, Bun, Deno, and Cloudflare Workers — no
// aws-sdk, no Node crypto. Supports both signed requests (Authorization header)
// and presigned URLs (query-string signing), which is what lets clients GET/PUT
// large objects straight from S3 without proxying through our server.
//
// Scope: exactly what an S3-compatible object store needs (S3, MinIO, R2, B2…).

const enc = new TextEncoder();

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
  return hex(buf);
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * RFC 3986 encoding — the `UriEncode()` SigV4 specifies. Deliberately stricter than
 * `encodeURIComponent`, which leaves `!'()*` literal; S3 percent-encodes those when it
 * recomputes the canonical request, so a URL built with encodeURIComponent gets signed
 * one way and verified another.
 *
 * @param {string} str
 * @param {boolean} [encodeSlash] false for a path (slashes are separators, not data)
 */
export function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else {
      for (const byte of enc.encode(ch)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, date: iso.slice(0, 8) };
}

async function signingKey(secret, date, region, service) {
  const kDate = await hmac(enc.encode('AWS4' + secret), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * @typedef {object} S3Creds
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} region
 * @property {string} [sessionToken]
 * @property {string} service   usually 's3'
 */

/**
 * Build a presigned URL.
 * @param {S3Creds} creds
 * @param {object} o
 * @param {string} o.method  GET|PUT|POST|DELETE
 * @param {string} o.url     full endpoint URL for the object (incl. host + path)
 * @param {number} [o.expiresIn] seconds (default 900, max 604800)
 * @param {Record<string,string>} [o.query] extra query params (e.g. partNumber, uploadId, response-content-disposition)
 * @param {Record<string,string>} [o.signedHeaders] headers to bind (host is always bound)
 */
export async function presignUrl(creds, o) {
  const url = new URL(o.url);
  const { amz, date } = amzDate();
  const expiresIn = Math.min(o.expiresIn ?? 900, 604800);
  const scope = `${date}/${creds.region}/${creds.service}/aws4_request`;

  const headers = { host: url.host, ...(o.signedHeaders || {}) };
  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const q = new URLSearchParams(url.search);
  for (const [k, v] of Object.entries(o.query || {})) q.set(k, v);
  q.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  q.set('X-Amz-Credential', `${creds.accessKeyId}/${scope}`);
  q.set('X-Amz-Date', amz);
  q.set('X-Amz-Expires', String(expiresIn));
  if (creds.sessionToken) q.set('X-Amz-Security-Token', creds.sessionToken);
  q.set('X-Amz-SignedHeaders', signedHeaders);

  // Canonical query string: sorted, RFC3986-encoded.
  const canonicalQuery = [...q.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    o.method,
    // The path VERBATIM. `url.pathname` is already percent-encoded, and S3 (alone among
    // AWS services) single-encodes the canonical URI — re-encoding here would turn the
    // %20 we send into the %2520 we sign, and every key with a space in it would come
    // back 403 SignatureDoesNotMatch. Callers must therefore hand us a URL whose path
    // was built with `uriEncode`, not `encodeURIComponent`.
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amz,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const key = await signingKey(creds.secretAccessKey, date, creds.region, creds.service);
  const signature = hex(await hmac(key, stringToSign));

  url.search = canonicalQuery + `&X-Amz-Signature=${signature}`;
  return url.toString();
}

/**
 * Sign a request with an Authorization header (for server-side S3 calls).
 * @returns {Promise<Record<string,string>>} headers to send.
 */
export async function signRequest(creds, o) {
  const url = new URL(o.url);
  const { amz, date } = amzDate();
  const scope = `${date}/${creds.region}/${creds.service}/aws4_request`;
  const payloadHash = o.payloadHash || (await sha256Hex(o.body ?? ''));

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz,
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
    ...(o.headers || {}),
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    o.method,
    url.pathname, // verbatim — see the note in presignUrl
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonicalRequest)].join('\n');
  const key = await signingKey(creds.secretAccessKey, date, creds.region, creds.service);
  const signature = hex(await hmac(key, stringToSign));

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export { sha256Hex };
