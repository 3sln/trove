// Is the backing store actually usable from a browser?
//
// This exists because of a failure that cost a day. A drive was serving its file list
// fine, and every file opened to a spinner that never resolved. The server was healthy,
// the storage was healthy, the download endpoint returned 200 in 300ms — and the browser
// still could not read a single byte, because the R2 bucket had no CORS policy. Nothing
// in the system knew: CORS is enforced in the browser, so the server's own request to
// the same bucket succeeded, and the only evidence was a console message in one tab.
//
// So the check has to be the browser's check. A CORS preflight is an ordinary OPTIONS
// request that anyone can send, including us — and a preflight never touches the object,
// so it works against a key that does not exist and costs nothing. Sending it against a
// presigned URL and reading the response headers is exactly what a browser does before
// it will hand a response to a page. If it fails for us it fails for them.
//
// The point is not detection for its own sake. Each finding carries the command that
// fixes it: a diagnostic that says "CORS is misconfigured" to someone who did not know
// buckets had a CORS policy has told them nothing they can act on.

/** A key that need not exist — a preflight is answered without looking one up. */
const PROBE_KEY = '.trove-cors-probe';

/**
 * Every code this module can produce.
 *
 * Exported because the caller that raises these as issues also has to CLEAR the ones a
 * later check no longer reports — that is what makes fixing the bucket make the warning
 * go away. Deriving the clear-set from the same list the checks use means a new finding
 * cannot be added without becoming clearable.
 */
export const STORAGE_ISSUE_CODES = [
  'storage-unreachable',
  'cors-missing',
  'cors-origin',
  'cors-headers',
  'cors-expose',
  'cors-unknown',
];

/** Headers the client sends on a download, so a policy that omits them breaks reads. */
const NEEDED_REQUEST_HEADERS = ['range'];

/**
 * Headers the client must be able to READ off the response.
 *
 * Cross-origin responses expose almost nothing by default, and these are not cosmetic:
 * without `content-range` the text viewer cannot tell a truncated file from a whole one,
 * and without `accept-ranges` seeking in audio and video is not offered at all.
 *
 * Checked against a real GET rather than the preflight — see where this is used.
 */
const NEEDED_EXPOSED_HEADERS = ['content-range', 'content-length'];

const csv = (value) => String(value || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Diagnose one collection's backing store.
 *
 * Ordered: an unreachable store short-circuits, because "CORS is not configured" is a
 * misleading thing to say about a bucket whose credentials are wrong.
 *
 * @param {object} deps
 * @param {import('./interface.js').StorageBackend} deps.storage
 * @param {string} [deps.origin]  the browser origin to check against — the drive's own
 *   public URL. Omitted means the CORS check is skipped rather than guessed at: a policy
 *   is allowed to be origin-specific, so checking the wrong origin invents a problem.
 * @param {string} [deps.driver]  store driver key, to word the remedy for it
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<Array<{code: string, severity: string, title: string, detail: string, remedy?: string}>>}
 */
export async function diagnoseStorage({ storage, origin = null, driver = null, fetchImpl = null } = {}) {
  const findings = [];
  if (!storage) return findings;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);

  // --- can we talk to it at all? ---------------------------------------------
  try {
    await storage.list({ limit: 1 });
  } catch (err) {
    findings.push({
      code: 'storage-unreachable',
      severity: 'error',
      title: 'The backing store could not be reached',
      detail: err?.message || String(err),
      remedy:
        'Check the collection’s store settings: the bucket or directory must exist, and '
        + 'for an S3-compatible store the endpoint, region and credentials must all be for '
        + 'that bucket. A wrong endpoint and a wrong key look identical from here.',
    });
    return findings;
  }

  // --- does the browser get to read it? --------------------------------------
  // Only when downloads go straight from the browser to the store. A drive that proxies
  // its bytes through the server is same-origin all the way, and CORS never applies —
  // reporting a bucket policy as missing there would be a problem the admin cannot have.
  const caps = storage.capabilities || {};
  if (!caps.presignDownload) return findings;
  if (!origin || !doFetch) return findings;

  let url;
  try {
    url = await storage.presignGet(PROBE_KEY, { expiresIn: 60 });
  } catch {
    // A store that claims presignDownload and cannot presign is a bug, not a
    // configuration problem, and it will surface far more loudly elsewhere.
    return findings;
  }

  let res;
  try {
    res = await doFetch(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': NEEDED_REQUEST_HEADERS.join(','),
      },
    });
  } catch (err) {
    findings.push({
      code: 'cors-unknown',
      severity: 'warning',
      title: 'Could not check whether the store allows browser access',
      detail: `The preflight request to the store failed: ${err?.message || err}`,
      remedy: 'This is usually a network or endpoint problem rather than a CORS one — '
        + 'confirm the store’s endpoint is reachable from the server.',
    });
    return findings;
  }

  const allowOrigin = res.headers.get('access-control-allow-origin');
  if (!allowOrigin) {
    findings.push({
      code: 'cors-missing',
      severity: 'error',
      title: 'The store does not allow browser access, so files will not open',
      detail:
        `A CORS preflight from ${origin} was answered without an `
        + `Access-Control-Allow-Origin header (HTTP ${res.status}). Browsers will refuse `
        + 'every download, including previews and thumbnails, while the file list and '
        + 'search keep working normally.',
      remedy: corsRemedy(origin, driver),
    });
    return findings;
  }

  if (allowOrigin !== '*' && allowOrigin.toLowerCase() !== origin.toLowerCase()) {
    findings.push({
      code: 'cors-origin',
      severity: 'error',
      title: 'The store allows a different origin than this drive',
      detail: `It allows "${allowOrigin}", but this drive is served from "${origin}". `
        + 'A policy naming the wrong origin is refused exactly like no policy at all.',
      remedy: corsRemedy(origin, driver),
    });
    return findings;
  }

  // Allowed, but possibly not for everything we send or need back. These are warnings:
  // opening a small file will work, so the drive is usable — it is seeking in a video
  // and reading the head of a large file that break.
  const allowHeaders = csv(res.headers.get('access-control-allow-headers'));
  const missingRequest = allowHeaders.includes('*')
    ? []
    : NEEDED_REQUEST_HEADERS.filter((h) => !allowHeaders.includes(h));
  if (missingRequest.length) {
    findings.push({
      code: 'cors-headers',
      severity: 'warning',
      title: 'The store’s CORS policy blocks ranged reads',
      detail: `It does not allow the ${missingRequest.join(', ')} request header, so seeking `
        + 'in audio and video, and previewing the start of a large file, will fail. Whole-file '
        + 'downloads are unaffected.',
      remedy: corsRemedy(origin, driver),
    });
  }

  // Exposed headers are read off the ACTUAL response, not the preflight — that is where
  // the spec puts them and where the browser looks. Some stores echo them on a preflight
  // and some do not, so checking the OPTIONS response reports a correctly configured
  // bucket as broken. A GET for a key that does not exist is answered 404 WITH the CORS
  // headers when a policy matches, which is all this needs.
  let actual;
  try {
    actual = await doFetch(url, { method: 'GET', headers: { origin } });
  } catch {
    // The preflight already passed, so the policy is in place; failing to complete this
    // second request says nothing more about it. Warning here would be guessing.
    return findings;
  }

  const exposed = csv(actual.headers.get('access-control-expose-headers'));
  const missingExposed = exposed.includes('*')
    ? []
    : NEEDED_EXPOSED_HEADERS.filter((h) => !exposed.includes(h));
  if (missingExposed.length) {
    findings.push({
      code: 'cors-expose',
      severity: 'warning',
      title: 'The store hides response headers the viewer needs',
      detail: `${missingExposed.join(', ')} are not in exposeHeaders, so the browser cannot read `
        + 'them. Trove cannot then tell a truncated preview from a complete file, and will '
        + 'not offer seeking.',
      remedy: corsRemedy(origin, driver),
    });
  }

  return findings;
}

/** The policy this drive needs, as something that can be pasted. */
export function corsPolicy(origin) {
  return [{
    AllowedOrigins: [origin],
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['content-type', 'range'],
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges'],
    MaxAgeSeconds: 3600,
  }];
}

function corsRemedy(origin, driver) {
  const json = JSON.stringify(corsPolicy(origin), null, 2);
  // R2 is the common case for a Workers deployment and its tooling is not the AWS CLI,
  // so name it explicitly rather than leaving the admin to translate.
  const r2 = driver === 's3'
    ? '\n\nOn Cloudflare R2, save the JSON above as cors.json and run:\n'
      + '  wrangler r2 bucket cors put <bucket> --file cors.json\n\n'
      + 'On AWS S3:\n'
      + '  aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json'
    : '';
  return `Allow this origin on the bucket. The policy Trove needs:\n\n${json}${r2}`;
}
