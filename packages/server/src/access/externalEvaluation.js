// External policy evaluation — the drive's ACL, answering an identity provider.
//
// WHAT THIS IS FOR
//
// Cloudflare Access can call out to a service mid-login and ask "should this person be let
// in?". Point it here and the answer comes from the collection ACLs: whoever has read on
// at least one collection gets through the front door, and nobody else reaches the drive at
// all. Access stays the single place you edit — the administration screen — and it now
// governs two things instead of one:
//
//   the EDGE       who gets past Cloudflare, decided here
//   the BUCKET     what they may do once inside, decided by the same ACL, as it always was
//
// The second half is unchanged and still authoritative. This does not replace an internal
// check anywhere; letting someone through the door does not grant them a collection. If
// this component is switched off, nothing about the drive's own guarding changes.
//
// OPTIONAL, and off unless configured. Mounted exactly like a notification channel — the
// component contributes routes and `createServer` adds them — so a drive that has not
// configured it has no `/api/access/*` at all rather than endpoints that answer "no".
//
// SETTING IT UP
//
//   1. Make a key pair. It is asymmetric because Cloudflare must be able to CHECK our
//      answer without being able to MINT one:
//
//        node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
//          .then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify(j)))"
//
//   2. TROVE_ACCESS_EVAL_KEY=<that JSON>   (and TROVE_CF_ACCESS_TEAM if not already set)
//   3. In the Access policy, add an External Evaluation rule:
//        Evaluate URL   https://<your drive>/api/access/evaluate
//        Keys URL       https://<your drive>/api/access/keys
//
// WHY IT REFUSES TO RUN UNVERIFIED
//
// This endpoint answers "does this email have access to this drive". That is a question
// worth lying to strangers about, so it will not answer one it cannot attribute: the
// caller's assertion must verify against the configured team's JWKS. Without a team
// configured the component declines to mount rather than mounting an open oracle that
// enumerates your users to anyone who can reach it.
//
// WHAT TO CHECK AGAINST CLOUDFLARE'S DOCS
//
// The transport shape below — a JWT posted in `{ "token": … }`, a signed `{ success }`
// echoed back with the same `nonce` — is written from the External Evaluation contract as
// understood at the time. The DECISION is ours and is well tested; the envelope is theirs
// and may have moved. If Access reports a malformed response, this is the file to check,
// and `parseAssertion` is deliberately generous about where the incoming JWT is found so a
// small change on their side does not break it entirely.

import { TroveError, verifyJwt, signJwt, publicJwkOf, JwksClient } from '@3sln/trove/core';

/** Where Cloudflare publishes the keys for a team's own assertions. */
const teamJwksUrl = (team) => `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;

/**
 * Find the assertion in whatever shape it arrived.
 *
 * Generous on purpose — see the header. The JWT is the only thing that matters and it is
 * self-authenticating, so accepting it from several places costs nothing: a forgery is
 * still a forgery wherever it was found.
 */
export async function parseAssertion(req) {
  const header = req.headers?.get?.('cf-access-jwt-assertion');
  if (header) return header;
  const text = await req.text();
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    return body.token || body.jwt || body.assertion || null;
  } catch {
    // Not JSON: some callers post the bare token.
    return text.trim() || null;
  }
}

/** The identity Cloudflare is asking about, as a principal this drive understands. */
export function principalOf(claims) {
  const email = claims?.email || claims?.identity?.email || claims?.sub || null;
  if (!email) return null;
  return { id: email, email, name: claims?.name || email, roles: claims?.groups || claims?.roles || [] };
}

/**
 * An external-evaluation component, or null when this drive has not configured one.
 *
 * @param {object} cfg
 * @param {object} cfg.privateJwk  EC P-256 private key, the one whose public half we publish
 * @param {string} cfg.team        Cloudflare Access team, for verifying the caller
 * @param {string} [cfg.kid]       key id, so the key can be rotated without an outage
 */
export function externalEvaluation({ privateJwk, team, kid = 'trove-access', jwks, now = Date.now } = {}) {
  if (!privateJwk) return null;
  // Refusing rather than warning: see the header. An oracle nobody authenticated is worse
  // than no oracle.
  if (!team && !jwks) {
    throw TroveError.invalid(
      'External evaluation needs a Cloudflare Access team to verify callers against — set TROVE_CF_ACCESS_TEAM',
    );
  }
  const keys = jwks || new JwksClient(teamJwksUrl(team));

  return {
    name: 'cloudflare-external-evaluation',
    routes() {
      return [
        {
          method: 'POST',
          path: '/api/access/evaluate',
          deps: ['collections'],
          async handler(ctx) {
            const token = await parseAssertion(ctx.req);
            if (!token) throw TroveError.invalid('No access assertion in the request');
            // Verified before it is read. Everything below trusts these claims, so this
            // line is the whole security of the component.
            const claims = await verifyJwt(token, { jwks: keys, now: now() });
            const principal = principalOf(claims);

            // No identity is a "no", not an error: Access is asking about somebody and we
            // cannot say yes about somebody we cannot name.
            const decision = principal && ctx.collections
              ? await ctx.collections.accessFor(principal)
              : { allowed: false, admin: false, collections: [] };

            const answer = await signJwt(
              { success: !!decision.allowed, nonce: claims.nonce, email: principal?.email || null },
              { privateJwk, kid, now: now() },
            );
            return { token: answer };
          },
        },
        {
          method: 'GET',
          path: '/api/access/keys',
          deps: [],
          // Public by design: it is a public key, and Cloudflare fetches it unauthenticated.
          handler() {
            return { keys: [publicJwkOf(privateJwk, { kid })] };
          },
        },
      ];
    },
  };
}
