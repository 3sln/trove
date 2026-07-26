// S3-compatible storage backend (AWS S3, Cloudflare R2, MinIO, Backblaze B2…).
// Uses fetch + our Web-Crypto SigV4 signer, so it works on any modern runtime
// including Cloudflare Workers. The headline capability is presigning: clients
// upload and download large objects straight to/from S3, never proxied through
// the Trove server.
//
// Path-style vs virtual-host addressing is configurable (`forcePathStyle`);
// MinIO/R2-with-custom-domain want path style, real AWS wants virtual host.

import { StorageBackend, toBytes } from './interface.js';
import { presignUrl, signRequest, sha256Hex, uriEncode } from './s3sigv4.js';
import { TroveError, wrapError } from '../errors.js';
import { withRetry } from '../retry.js';

export class S3Storage extends StorageBackend {
  /**
   * @param {object} cfg
   * @param {string} cfg.bucket
   * @param {string} cfg.region
   * @param {string} cfg.accessKeyId
   * @param {string} cfg.secretAccessKey
   * @param {string} [cfg.sessionToken]
   * @param {string} [cfg.endpoint]  e.g. https://<acct>.r2.cloudflarestorage.com (defaults to AWS)
   * @param {boolean} [cfg.forcePathStyle]
   * @param {number} [cfg.presignExpiry] default seconds for signed URLs
   */
  constructor(cfg) {
    super();
    for (const k of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
      if (!cfg?.[k]) throw TroveError.invalid(`S3Storage requires "${k}"`);
    }
    this.cfg = cfg;
    this.creds = {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      sessionToken: cfg.sessionToken,
      region: cfg.region,
      service: 's3',
    };
    this.presignExpiry = cfg.presignExpiry ?? 900;
    const host = cfg.endpoint
      ? cfg.endpoint.replace(/\/$/, '')
      : `https://s3.${cfg.region}.amazonaws.com`;
    this.forcePathStyle = cfg.forcePathStyle ?? !!cfg.endpoint;
    this.base = this.forcePathStyle ? `${host}/${cfg.bucket}` : insertBucket(host, cfg.bucket);
  }

  get capabilities() {
    return { presignDownload: true, presignUpload: true, multipart: true, range: true, list: true, usage: false };
  }

  /**
   * The object's URL, encoded the way SigV4 will canonicalize it.
   *
   * `uriEncode`, not `encodeURIComponent`/`URLSearchParams`: the signature is computed
   * over this exact string, so anything that encodes differently here than the signer
   * does there produces a URL we send one way and sign another — a 403 from S3 for any
   * key or parameter containing a space, a `+`, a `!`, or a non-ASCII character.
   */
  #url(key, query) {
    const u = new URL(`${this.base}/${uriEncode(key, false)}`);
    if (query) {
      u.search = Object.entries(query)
        .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
        .join('&');
    }
    return u.toString();
  }

  async #send(method, key, { query, headers, body, signal } = {}) {
    return withRetry(
      async () => {
        const url = this.#url(key, query);
        const payloadHash = body ? await sha256Hex(body) : await sha256Hex('');
        const signed = await signRequest(this.creds, { method, url, headers, body, payloadHash });
        let res;
        try {
          res = await fetch(url, { method, headers: signed, body, signal });
        } catch (err) {
          throw wrapError(err);
        }
        if (!res.ok && res.status >= 500) {
          throw TroveError.transient(`S3 ${method} ${res.status}`, { details: { status: res.status } });
        }
        if (res.status === 429 || res.status === 503) {
          throw TroveError.transient('S3 throttled', { details: { status: res.status } });
        }
        return res;
      },
      { signal },
    );
  }

  async put(key, body, opts = {}) {
    const bytes = await toBytes(body);
    const res = await this.#send('PUT', key, {
      body: bytes,
      headers: opts.contentType ? { 'content-type': opts.contentType } : {},
      signal: opts.signal,
    });
    if (!res.ok) throw await s3Error(res, 'put');
    opts.onProgress?.(bytes.length);
    return { size: bytes.length, contentType: opts.contentType, etag: res.headers.get('etag') || undefined };
  }

  async head(key) {
    const res = await this.#send('HEAD', key);
    if (res.status === 404) throw TroveError.notFound('Object');
    if (!res.ok) throw await s3Error(res, 'head');
    return {
      size: Number(res.headers.get('content-length') || 0),
      contentType: res.headers.get('content-type') || undefined,
      etag: res.headers.get('etag') || undefined,
    };
  }

  async get(key, opts = {}) {
    const headers = {};
    if (opts.range) {
      // S3 understands the suffix form natively, so pass it through rather than
      // resolving it here — we'd need a HEAD to learn the total first.
      if (opts.range.suffix != null) headers.range = `bytes=-${opts.range.suffix}`;
      else headers.range = `bytes=${opts.range.start ?? 0}-${opts.range.end != null ? opts.range.end : ''}`;
    }
    const res = await this.#send('GET', key, { headers, signal: opts.signal });
    if (res.status === 404) throw TroveError.notFound('Object');
    if (!res.ok && res.status !== 206) throw await s3Error(res, 'get');
    let range;
    const cr = res.headers.get('content-range'); // bytes start-end/total
    if (cr) {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
      if (m) range = { start: +m[1], end: +m[2], total: +m[3] };
    }
    return {
      stream: res.body,
      size: Number(res.headers.get('content-length') || 0),
      contentType: res.headers.get('content-type') || undefined,
      etag: res.headers.get('etag') || undefined,
      range,
    };
  }

  async delete(key, opts = {}) {
    const res = await this.#send('DELETE', key, { signal: opts.signal });
    if (!res.ok && res.status !== 404) throw await s3Error(res, 'delete');
  }

  /**
   * ListObjectsV2 — how a scan sees objects that reached the bucket without us.
   *
   * The bucket is shared infrastructure: another tool, another person, or a lifecycle
   * rule can add and remove objects, and this is the only way to find out. Paged on S3's
   * own continuation token rather than a key offset, because that is what the service
   * guarantees is stable across a page boundary.
   */
  async list({ prefix = '', cursor = null, limit = 1000, signal } = {}) {
    const query = { 'list-type': '2', 'max-keys': String(Math.min(limit, 1000)) };
    if (prefix) query.prefix = prefix;
    if (cursor) query['continuation-token'] = cursor;
    // Bucket-level operation: the key is empty, the bucket is in the base URL.
    const res = await this.#send('GET', '', { query, signal });
    if (!res.ok) throw await s3Error(res, 'list');
    const xml = await res.text();
    const objects = [];
    for (const entry of tagAll(xml, 'Contents')) {
      const key = tag(entry, 'Key');
      if (key == null) continue;
      const modified = Date.parse(tag(entry, 'LastModified') || '');
      objects.push({
        key: decodeXml(key),
        size: Number(tag(entry, 'Size') || 0),
        etag: tag(entry, 'ETag') || undefined,
        modifiedAt: Number.isNaN(modified) ? null : modified,
      });
    }
    // Truncated is authoritative: an empty page can still have more behind it.
    const truncated = tag(xml, 'IsTruncated') === 'true';
    return { objects, nextCursor: truncated ? tag(xml, 'NextContinuationToken') : null };
  }

  // --- presigning ------------------------------------------------------------

  async presignGet(key, opts = {}) {
    const query = {};
    if (opts.downloadName) {
      query['response-content-disposition'] = `attachment; filename="${sanitizeFilename(opts.downloadName)}"`;
    }
    if (opts.responseContentType) query['response-content-type'] = opts.responseContentType;
    return presignUrl(this.creds, {
      method: 'GET',
      url: this.#url(key),
      expiresIn: opts.expiresIn ?? this.presignExpiry,
      query,
    });
  }

  async presignPut(key, opts = {}) {
    return presignUrl(this.creds, {
      method: 'PUT',
      url: this.#url(key),
      expiresIn: opts.expiresIn ?? this.presignExpiry,
    });
  }

  // --- multipart -------------------------------------------------------------

  async createMultipart(key, opts = {}) {
    const res = await this.#send('POST', key, {
      query: { uploads: '' },
      headers: opts.contentType ? { 'content-type': opts.contentType } : {},
    });
    if (!res.ok) throw await s3Error(res, 'createMultipart');
    const xml = await res.text();
    const id = tag(xml, 'UploadId');
    if (!id) throw TroveError.internal('S3 did not return an UploadId');
    return id;
  }

  async presignPart(key, uploadId, partNumber, opts = {}) {
    return presignUrl(this.creds, {
      method: 'PUT',
      url: this.#url(key),
      expiresIn: opts.expiresIn ?? this.presignExpiry,
      query: { partNumber: String(partNumber), uploadId },
    });
  }

  async putPart(key, uploadId, partNumber, body, opts = {}) {
    const res = await this.#send('PUT', key, {
      query: { partNumber: String(partNumber), uploadId },
      body: await toBytes(body),
      signal: opts.signal,
    });
    if (!res.ok) throw await s3Error(res, 'putPart');
    const etag = res.headers.get('etag');
    return { partNumber, etag };
  }

  async completeMultipart(key, uploadId, parts) {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const body =
      `<CompleteMultipartUpload>` +
      ordered
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join('') +
      `</CompleteMultipartUpload>`;
    const res = await this.#send('POST', key, { query: { uploadId }, body, headers: { 'content-type': 'application/xml' } });
    if (!res.ok) throw await s3Error(res, 'completeMultipart');
    const xml = await res.text();
    // S3 can return a 200 with an error body — check for that.
    if (xml.includes('<Error>')) throw TroveError.transient('S3 completeMultipart failed', { details: { xml } });
    return { etag: tag(xml, 'ETag') || undefined };
  }

  async abortMultipart(key, uploadId) {
    const res = await this.#send('DELETE', key, { query: { uploadId } });
    if (!res.ok && res.status !== 404) throw await s3Error(res, 'abortMultipart');
  }
}

function insertBucket(host, bucket) {
  const u = new URL(host);
  u.host = `${bucket}.${u.host}`;
  return u.toString().replace(/\/$/, '');
}

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

/** Every occurrence of a repeated element (ListObjectsV2 returns one <Contents> per object). */
function tagAll(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** S3 XML-escapes keys; a key with & or < in it comes back encoded. */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function sanitizeFilename(name) {
  return String(name).replace(/[\r\n"\\]/g, '_');
}

async function s3Error(res, op) {
  let body = '';
  try {
    body = await res.text();
  } catch { /* ignore */ }
  const code = tag(body, 'Code');
  const msg = tag(body, 'Message') || res.statusText;
  if (res.status === 403) return new TroveError('forbidden', `S3 ${op}: ${msg}`, { details: { code } });
  if (res.status === 404) return TroveError.notFound('Object');
  return TroveError.internal(`S3 ${op} failed (${res.status}): ${msg}`, { details: { code } });
}
