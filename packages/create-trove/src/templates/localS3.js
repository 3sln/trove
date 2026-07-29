// The local S3 bucket that goes into a scaffolded Workers project, as source.
//
// Vendored as a string rather than pulled from npm on purpose. The only maintained
// options that mock S3 mock the AWS SDK CLIENT, which is no use here — Trove signs its
// own requests with SigV4 and talks to the endpoint over fetch, so what a local run
// needs is a SERVER. The one package that is a server (s3rver) last shipped in 2021 and
// brings four advisories, three of them high, into a project that otherwise has none.
//
// It is a template, so it lives here as text. Kept in its own module to stay out of
// render.js, which is otherwise readable end to end.

/* eslint-disable */
export const LOCAL_S3 = `// A tiny S3-compatible server, for local development only.
//
// WHY THIS EXISTS
//
// On Workers the object store is R2 reached over the S3 API, and there is no local R2.
// \`TROVE_STORAGE=memory\` gets \`wrangler dev\` running, but it is not the same drive in
// one important way: memory storage lives INSIDE ONE ISOLATE, and scans and reindexes
// run in the TroveTasks Durable Object, which is a different isolate with a different
// memory. Every indexed item comes back "Object not found" and search stays empty —
// a failure that exists only because of the stand-in, and that would send you hunting
// for a bug in the indexer.
//
// Pointing TROVE_S3_ENDPOINT at this process instead gives every isolate one shared
// bucket over HTTP, which is what R2 is. It exercises the real code path: SigV4
// signing, multipart uploads, ranged reads, ListObjectsV2 paging.
//
// WHAT IT IS NOT
//
// It does not verify signatures. It accepts whatever Authorization header it is sent
// and serves the request. That is fine for a bucket of test files on loopback and
// unacceptable anywhere else, so it binds to 127.0.0.1 and refuses to start otherwise.
// Objects are held in memory and vanish when it stops.
//
//   node dev/local-s3.js          # or: npm run dev:s3
//
// Run it alongside \`npm run dev\`, with the settings in .dev.vars.example.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT || 9000);
const HOST = '127.0.0.1';
const BUCKET = process.env.BUCKET || 'trove';

/** key -> { body: Buffer, contentType, modifiedAt, etag } */
const objects = new Map();
/** uploadId -> { key, contentType, parts: Map<number, Buffer> } */
const uploads = new Map();

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const quoted = (etag) => \`"\${etag}"\`;
const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function sendXml(res, status, xml) {
  const body = \`<?xml version="1.0" encoding="UTF-8"?>\\n\${xml}\`;
  res.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendXml(res, status, \`<Error><Code>\${code}</Code><Message>\${xmlEscape(message)}</Message></Error>\`);
}

/**
 * ListObjectsV2.
 *
 * Paged on a continuation token that is just the key to resume after — the contract
 * the client relies on is that the token is opaque and stable, not how it is built.
 */
function listObjects(res, query) {
  const prefix = query.get('prefix') || '';
  const maxKeys = Math.min(Number(query.get('max-keys') || 1000), 1000);
  const after = query.get('continuation-token');

  let keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  if (after) keys = keys.filter((k) => k > after);

  const page = keys.slice(0, maxKeys);
  const truncated = keys.length > page.length;

  const contents = page.map((key) => {
    const o = objects.get(key);
    return \`<Contents>\`
      + \`<Key>\${xmlEscape(key)}</Key>\`
      + \`<LastModified>\${new Date(o.modifiedAt).toISOString()}</LastModified>\`
      // Escaped, exactly as S3 does it: the quotes around an ETag come back as &quot;.
      + \`<ETag>\${xmlEscape(quoted(o.etag))}</ETag>\`
      + \`<Size>\${o.body.length}</Size>\`
      + \`<StorageClass>STANDARD</StorageClass>\`
      + \`</Contents>\`;
  }).join('');

  sendXml(res, 200,
    \`<ListBucketResult>\`
    + \`<Name>\${xmlEscape(BUCKET)}</Name>\`
    + \`<Prefix>\${xmlEscape(prefix)}</Prefix>\`
    + \`<KeyCount>\${page.length}</KeyCount>\`
    + \`<MaxKeys>\${maxKeys}</MaxKeys>\`
    + \`<IsTruncated>\${truncated}</IsTruncated>\`
    + (truncated ? \`<NextContinuationToken>\${xmlEscape(page[page.length - 1])}</NextContinuationToken>\` : '')
    + contents
    + \`</ListBucketResult>\`);
}

/** GET/HEAD an object, honouring a single byte range. */
function getObject(req, res, key, head) {
  const o = objects.get(key);
  if (!o) return sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.');

  const headers = {
    'content-type': o.contentType || 'application/octet-stream',
    etag: quoted(o.etag),
    'last-modified': new Date(o.modifiedAt).toUTCString(),
    'accept-ranges': 'bytes',
  };

  const range = /^bytes=(\\d*)-(\\d*)$/.exec(req.headers.range || '');
  if (range) {
    const total = o.body.length;
    // A suffix range ("bytes=-500") counts back from the end; the other two forms
    // count forward, with an absent end meaning "to the last byte".
    let start = range[1] === '' ? total - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' ? total - 1 : (range[2] === '' ? total - 1 : Number(range[2]));
    start = Math.max(0, start);
    end = Math.min(total - 1, end);
    if (start > end) {
      res.writeHead(416, { 'content-range': \`bytes */\${total}\` });
      return res.end();
    }
    const slice = o.body.subarray(start, end + 1);
    res.writeHead(206, {
      ...headers,
      'content-range': \`bytes \${start}-\${end}/\${total}\`,
      'content-length': slice.length,
    });
    return res.end(head ? undefined : slice);
  }

  res.writeHead(200, { ...headers, 'content-length': o.body.length });
  return res.end(head ? undefined : o.body);
}

async function handle(req, res) {
  const url = new URL(req.url, \`http://\${HOST}:\${PORT}\`);
  const query = url.searchParams;

  // Path-style addressing: /<bucket>/<key...>. Virtual-host style would need
  // <bucket>.localhost to resolve, which it does not reliably — hence
  // TROVE_S3_PATH_STYLE=true in .dev.vars.example.
  const segments = url.pathname.replace(/^\\//, '').split('/');
  const bucket = segments.shift();
  const key = decodeURIComponent(segments.join('/'));

  if (bucket !== BUCKET) {
    return sendError(res, 404, 'NoSuchBucket', \`No bucket named "\${bucket}".\`);
  }

  // --- bucket-level ---------------------------------------------------------
  if (!key) {
    if (req.method === 'GET' && query.get('list-type') === '2') return listObjects(res, query);
    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    return sendError(res, 400, 'InvalidRequest', 'Only ListObjectsV2 is supported at the bucket level.');
  }

  // --- multipart ------------------------------------------------------------
  if (req.method === 'POST' && query.has('uploads')) {
    const uploadId = \`mp_\${md5(key + Date.now() + Math.random())}\`;
    uploads.set(uploadId, { key, contentType: req.headers['content-type'], parts: new Map() });
    return sendXml(res, 200,
      \`<InitiateMultipartUploadResult>\`
      + \`<Bucket>\${xmlEscape(BUCKET)}</Bucket><Key>\${xmlEscape(key)}</Key>\`
      + \`<UploadId>\${uploadId}</UploadId>\`
      + \`</InitiateMultipartUploadResult>\`);
  }

  if (req.method === 'PUT' && query.has('uploadId')) {
    const upload = uploads.get(query.get('uploadId'));
    if (!upload) return sendError(res, 404, 'NoSuchUpload', 'Unknown uploadId.');
    const body = await readBody(req);
    upload.parts.set(Number(query.get('partNumber')), body);
    res.writeHead(200, { etag: quoted(md5(body)), 'content-length': 0 });
    return res.end();
  }

  if (req.method === 'POST' && query.has('uploadId')) {
    const uploadId = query.get('uploadId');
    const upload = uploads.get(uploadId);
    if (!upload) return sendError(res, 404, 'NoSuchUpload', 'Unknown uploadId.');
    // The client's list is authoritative about ORDER; it sorts by part number before
    // sending, and a part it never mentions is not part of the object.
    const body = await readBody(req);
    const numbers = [...body.toString().matchAll(/<PartNumber>(\\d+)<\\/PartNumber>/g)].map((m) => Number(m[1]));
    const missing = numbers.filter((n) => !upload.parts.has(n));
    if (missing.length) return sendError(res, 400, 'InvalidPart', \`No such part(s): \${missing.join(', ')}\`);
    const assembled = Buffer.concat(numbers.map((n) => upload.parts.get(n)));
    uploads.delete(uploadId);
    // A real multipart ETag is "<md5-of-part-md5s>-<count>"; the shape matters to the
    // scanner's change detection, so it is reproduced rather than faked as a plain md5.
    const etag = \`\${md5(Buffer.concat(numbers.map((n) => Buffer.from(md5(upload.parts.get(n)), 'hex'))))}-\${numbers.length}\`;
    objects.set(upload.key, {
      body: assembled, contentType: upload.contentType, modifiedAt: Date.now(), etag,
    });
    return sendXml(res, 200,
      \`<CompleteMultipartUploadResult>\`
      + \`<Bucket>\${xmlEscape(BUCKET)}</Bucket><Key>\${xmlEscape(upload.key)}</Key>\`
      + \`<ETag>\${xmlEscape(quoted(etag))}</ETag>\`
      + \`</CompleteMultipartUploadResult>\`);
  }

  if (req.method === 'DELETE' && query.has('uploadId')) {
    uploads.delete(query.get('uploadId'));
    res.writeHead(204);
    return res.end();
  }

  // --- single object --------------------------------------------------------
  if (req.method === 'PUT') {
    const body = await readBody(req);
    const etag = md5(body);
    objects.set(key, {
      body, contentType: req.headers['content-type'], modifiedAt: Date.now(), etag,
    });
    res.writeHead(200, { etag: quoted(etag), 'content-length': 0 });
    return res.end();
  }

  if (req.method === 'GET') return getObject(req, res, key, false);
  if (req.method === 'HEAD') return getObject(req, res, key, true);

  if (req.method === 'DELETE') {
    objects.delete(key);
    res.writeHead(204);
    return res.end();
  }

  return sendError(res, 405, 'MethodNotAllowed', \`\${req.method} is not supported.\`);
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[local-s3]', err);
    if (!res.headersSent) sendError(res, 500, 'InternalError', err.message);
    else res.end();
  });
}).listen(PORT, HOST, () => {
  console.log(\`[local-s3] bucket "\${BUCKET}" on http://\${HOST}:\${PORT} — in memory, signatures NOT checked\`);
});
`;
