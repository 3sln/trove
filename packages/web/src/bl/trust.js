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
