// Plugin package signing + domain verification, on Web Crypto.
//
// A package is a zip of files including manifest.json. Signing binds two things:
//   1. every non-manifest file, via `contentHash` (SHA-256 over the sorted file
//      set) recorded in the manifest — tamper any file and it breaks;
//   2. the manifest itself, via an ECDSA-P256 `signature` over its canonical
//      JSON (with `signature` removed) — tamper the manifest and it breaks.
// The signer's public key (SPKI) travels in the manifest; its fingerprint is
// SHA-256 of that key. A plugin is "domain verified" when the manifest declares
// a `domain` and that domain publishes the signer's fingerprint at
//   https://<domain>/.well-known/trove-assetlinks.json
// (Digital-Asset-Links style), proving the domain owner vouches for the key.
//
// Verification is best-effort and layered: unsigned → "unverified"; signed but
// the domain doesn't list the key → "signed (self)"; signed + listed → "verified
// · <domain>". None of this sandboxes the plugin (the iframe does); it's a trust
// signal for the human deciding whether to install.

const enc = new TextEncoder();

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Stable JSON: recursively sorted keys, `signature` stripped from the top. */
export function canonicalManifest(manifest) {
  const strip = { ...manifest };
  delete strip.signature;
  return JSON.stringify(sortKeys(strip));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** SHA-256 over every file except manifest.json, in sorted-path order. */
export async function contentHash(files) {
  const paths = [...files.keys()].filter((p) => p !== 'manifest.json').sort();
  const chunks = [];
  for (const p of paths) {
    const bytes = files.get(p);
    const pathBytes = enc.encode(p);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    chunks.push(pathBytes, new Uint8Array([0]), len, bytes);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return hex(await sha256(buf));
}

/** SHA-256 fingerprint of an SPKI public key (lowercase hex). */
export async function fingerprintOf(publicKeyB64) {
  return hex(await sha256(b64ToBytes(publicKeyB64)));
}
export function displayFingerprint(hexStr) {
  return (hexStr.match(/.{2}/g) || []).join(':');
}

/**
 * Verify a package's integrity + signature (does NOT check the domain).
 * @returns {Promise<{signed:boolean, valid:boolean, fingerprint?:string, reason?:string}>}
 */
export async function verifyPackage({ manifest, files }) {
  if (!manifest.signature || !manifest.publicKey) return { signed: false, valid: false };
  // 1. content hash binds all other files.
  const expected = await contentHash(files);
  if (manifest.contentHash && manifest.contentHash !== expected) {
    return { signed: true, valid: false, reason: 'File contents do not match the manifest hash' };
  }
  // 2. signature binds the manifest.
  try {
    const key = await crypto.subtle.importKey('spki', b64ToBytes(manifest.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64ToBytes(manifest.signature), enc.encode(canonicalManifest(manifest)));
    if (!ok) return { signed: true, valid: false, reason: 'Signature does not verify' };
    return { signed: true, valid: true, fingerprint: await fingerprintOf(manifest.publicKey) };
  } catch (err) {
    return { signed: true, valid: false, reason: 'Bad key/signature: ' + err.message };
  }
}

/**
 * Given the domain's assetlinks doc, is this key fingerprint vouched for this plugin?
 * Format:
 *   { "version": 1, "keys": [ { "fingerprint": "<hex|colon-hex>", "plugins": ["docs" | "*"] } ] }
 *
 * The doc is served BY the domain, so a plugin is named by its name within that domain
 * ("docs"); the fully-qualified "acme.com/docs" is accepted too, for docs that prefer
 * to be explicit.
 */
export function checkAssetlinks(assetlinks, fingerprint, manifest) {
  const norm = (f) => (f || '').toLowerCase().replace(/:/g, '');
  const want = norm(fingerprint);
  const names = [manifest.name, `${manifest.domain}/${manifest.name}`];
  for (const k of assetlinks?.keys || []) {
    if (norm(k.fingerprint) !== want) continue;
    if ((k.plugins || []).some((p) => p === '*' || names.includes(p))) return true;
  }
  return false;
}

/**
 * Full trust status for a package.
 * @param {(domain:string)=>Promise<object|null>} fetchAssetlinks  resolves the domain's assetlinks doc (or null)
 * @returns {Promise<{status:'unverified'|'invalid'|'signed'|'verified', domain?:string, fingerprint?:string, reason?:string}>}
 */
export async function assessTrust({ manifest, files }, fetchAssetlinks) {
  const sig = await verifyPackage({ manifest, files });
  if (!sig.signed) return { status: 'unverified', reason: 'Package is not signed' };
  // A present-but-failed signature is evidence of tampering — a distinct, alarming
  // status, NOT the same grey "unverified" as an ordinary unsigned package.
  if (!sig.valid) return { status: 'invalid', reason: sig.reason || 'Invalid signature — the package may have been tampered with' };
  let doc = null;
  try {
    doc = await fetchAssetlinks(manifest.domain);
  } catch { /* unreachable domain */ }
  if (doc && checkAssetlinks(doc, sig.fingerprint, manifest)) {
    return { status: 'verified', domain: manifest.domain, fingerprint: sig.fingerprint };
  }
  return { status: 'signed', domain: manifest.domain, fingerprint: sig.fingerprint, reason: doc ? 'Domain does not list this key' : 'Could not reach the domain' };
}

// --- signing (tooling / tests) ---------------------------------------------

export async function generateSigningKey() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

/** Produce a signed manifest for a package. Returns the manifest with
 *  contentHash + publicKey + signature filled in. */
export async function signManifest(manifest, files, keyPair) {
  const withHash = { ...manifest, contentHash: await contentHash(files) };
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  withHash.publicKey = bytesToB64(spki);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, enc.encode(canonicalManifest(withHash))));
  withHash.signature = bytesToB64(sig);
  return withHash;
}

export { b64ToBytes, bytesToB64 };
