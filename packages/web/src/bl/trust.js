// What a plugin package's signature actually means.
//
// This is a security classification, not a label. It decided the same four states in two
// different components — the installed-plugin list and the install-review dialog — with two
// different sets of words, and the distinction that matters most was the one that drifted:
//
//   `invalid` is NOT `unverified`. Unverified means nobody signed it, which is the ordinary
//   case for a plugin you got from a friend. Invalid means it WAS signed and the signature
//   does not verify — the bytes are not the bytes that were signed. That is the one state
//   implying someone altered the package, and the list once rendered it in the same amber as
//   the benign case, because the two `if` ladders were maintained separately and one of them
//   was missing a branch.
//
// So the classification lives here, once, and the components choose their own wording from
// `status`. What is a security judgement is in the business layer; how many characters fit
// in a badge is not.

/**
 * Whether a package may be installed at all, and on what terms.
 *
 * Three answers, because the states differ in kind rather than in degree:
 *
 *   - `invalid` is REFUSED. It means the package was signed and the signature does not
 *     verify — the bytes are not the bytes that were signed. No development workflow
 *     produces that; it means the package was altered in transit or at rest. There is
 *     nothing for a user to weigh, so they are not asked.
 *
 *   - `unverified` is installable but only DELIBERATELY. Nobody signed it, which is the
 *     ordinary state of a plugin you are writing: you cannot sign a package you are still
 *     changing. So it stays possible, behind an acknowledgement that says what is being
 *     given up — no publisher, no proof the code is what its author shipped.
 *
 *   - `signed` carries a real signature whose domain does not vouch for the key. That is a
 *     claim to a namespace rather than a proof of one, so it is said prominently and left
 *     to the user; refusing it would block a valid publisher whose assetlinks are merely
 *     misconfigured.
 *
 * This is also what closes namespace squatting. A package claiming another publisher's
 * domain is unverified by construction — the real domain does not publish its key — so it
 * cannot be installed without the user being told exactly that.
 */
export function installPolicyFor(trust) {
  const t = describeTrust(trust);
  if (t.status === 'invalid') {
    return {
      status: t.status,
      allowed: false,
      requiresAcknowledgement: false,
      headline: 'This package has been altered',
      detail: `${t.explanation}. It was signed, and the signature does not match its contents — so it is not what its author published. Trove will not install it.`,
    };
  }
  if (t.status === 'unverified') {
    return {
      status: t.status,
      allowed: true,
      requiresAcknowledgement: true,
      headline: 'Unsigned — for development only',
      detail: 'Nobody has signed this package, so there is no way to tell who wrote it or whether it has been altered since. Install it only if you built it yourself or you trust wherever you got it from.',
    };
  }
  if (t.status === 'signed') {
    return {
      status: t.status,
      allowed: true,
      requiresAcknowledgement: false,
      headline: 'Signed, but the domain does not vouch for the key',
      detail: `${t.explanation}. The signature is real; what is unproven is that ${t.domain || 'the publisher'} authorised it.`,
    };
  }
  return { status: t.status, allowed: true, requiresAcknowledgement: false, headline: null, detail: null };
}

/**
 * @param {{status?: string, domain?: string, reason?: string}|null} trust
 * @returns {{status: string, tone: string, icon: string, domain: string|null, explanation: string, severity: number}}
 */
export function describeTrust(trust) {
  const t = trust || {};
  switch (t.status) {
    case 'verified':
      return {
        status: 'verified', tone: 'verified', icon: 'check', domain: t.domain || null,
        explanation: t.domain
          ? `Signed by a key published at ${t.domain}`
          : 'Signed by a key the publishing domain vouches for',
        severity: 0,
      };
    case 'signed':
      return {
        status: 'signed', tone: 'signed', icon: 'info', domain: t.domain || null,
        explanation: t.reason || 'Signed, but the domain does not vouch for the key',
        severity: 1,
      };
    case 'invalid':
      return {
        status: 'invalid', tone: 'invalid', icon: 'warn', domain: t.domain || null,
        // Said plainly. This is the only state that means tampering rather than absence.
        explanation: t.reason || 'The signature did not verify — this package may have been altered',
        severity: 3,
      };
    default:
      return {
        status: 'unverified', tone: 'unverified', icon: 'warn', domain: t.domain || null,
        explanation: t.reason || 'This plugin is not signed',
        severity: 2,
      };
  }
}
