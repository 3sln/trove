// Comparing a credential without saying how nearly you got it right.
//
// `a === b` returns as soon as it finds a difference, so it is fast for a wrong first byte
// and slower for a wrong last one. Over enough attempts that difference is measurable, and
// measuring it recovers the secret one byte at a time — which is why credential comparison
// is never string equality.
//
// One copy, and this file exists because there were two: `signedUrls.js` and `apiKeys.js`
// each grew their own, and the two had already drifted — one guarded its argument types and
// the other trusted the call site. That is the cheapest possible version of the bug where
// two copies of a security rule disagree, and it is worth not having.

/**
 * Do these two strings match, in time that does not depend on where they differ?
 *
 * Length is NOT hidden: returning early on a length mismatch leaks how long the secret is,
 * which for a fixed-width hash or signature is public anyway. Hiding it would mean hashing
 * both sides first, and every caller here compares values that are already digests.
 *
 * A non-string is false rather than a throw. The inputs come off the wire, `undefined` is a
 * perfectly ordinary thing for a missing header to be, and a comparison that throws on it
 * turns a failed auth attempt into a 500.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
