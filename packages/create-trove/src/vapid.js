// A VAPID key pair, made locally.
//
// This is a copy of `generateVapidKeys` from @3sln/trove/core, and the duplication is
// deliberate: create-trove has no dependencies and runs through `npm create`, BEFORE
// the project it is writing has a node_modules. Pointing someone at a function inside a
// package they have not installed yet is not a hint, it is a dead end — which is what
// the first version of the push question did.
//
// The format is fixed by RFC 8292 and the Push API, not by us, so this cannot drift in
// any interesting way. `test/vapid.test.js` checks the pair against core's own
// implementation anyway, because "cannot drift" is a claim and that test is a fact.
//
// Worth being clear about what a VAPID key IS, because it decides how it should be
// handled: it identifies this application server to a push service. It is self-issued —
// no account, no registration, no network — which is what makes generating one here
// legitimate where minting an R2 access key would not be. The public half goes to
// browsers as `applicationServerKey` and ends up baked into every subscription made
// against it; the private half signs the JWT that authorises each push.

/** base64url, no padding. */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * @returns {Promise<{publicKey: string, privateKey: string}>} both base64url.
 *   `publicKey` is the uncompressed EC point (0x04 || X || Y, 65 bytes) that
 *   PushManager.subscribe() wants; `privateKey` is the raw 32-byte scalar.
 */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const x = unb64url(jwk.x);
  const y = unb64url(jwk.y);
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return { publicKey: b64url(point), privateKey: jwk.d };
}
