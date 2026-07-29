// A way a notification reaches a person.
//
// The inbox is not one of these. NotificationCenter batches mentions, collapses each
// batch into one notification, and writes it to the user's inbox — that is the durable
// record, it works with no channel configured at all, and /api/notifications serves it.
// A channel is the part that goes and TELLS someone: a web push, an email, a message
// into a chat workspace. Nothing here is allowed to be the only copy of anything.
//
// Two constraints worth knowing before writing one:
//
//   It must be fetch-based. On Workers the drain runs inside a cron slice, where there
//   are no sockets — an email channel has to be an HTTP API (Resend, SES, Postmark),
//   not SMTP. A channel that opens a socket works on a self-hosted drive and fails on
//   the runtime the drive most often ships to.
//
//   Delivery is best-effort and isolated. A channel that throws is logged and the rest
//   still run; the notification is already in the inbox by then, so a failed send loses
//   the ping and not the notification.
//
// Channels may also own routes — the endpoints a client needs to REGISTER with them, of
// which a VAPID key and a push subscription are the obvious example. Those endpoints
// live with the channel rather than in the core route table, so the drive's API does
// not grow a permanent `/api/push/*` whether or not push exists.

import { TroveError } from '../errors.js';

export class NotificationChannel {
  /**
   * Stable identifier, used in logs and to find a channel among its peers.
   * @returns {string}
   */
  get id() {
    throw TroveError.unsupported('A NotificationChannel must have an id');
  }

  /**
   * Deliver one notification to one user. Called once per user per drain, after the
   * notification is already in their inbox.
   *
   * @param {string} userId the principal id
   * @param {object} note the collapsed notification — id, kind, count, items, title
   * @returns {Promise<void>}
   */
  async deliver(userId, note) { // eslint-disable-line no-unused-vars
    throw TroveError.unsupported(`Channel "${this.id}" cannot deliver`);
  }

  /**
   * Endpoints this channel needs, mounted under the drive's router.
   *
   * Each is `{ method, path, deps, handler }` with the same meaning the router gives
   * them — `deps` names the resources the handler is leased, and the handler receives
   * them alongside `principal`, `req`, `params` and `query`. Returning nothing is the
   * common case: a channel that reads an address off the identity has nothing to
   * register.
   *
   * `helpers` is the request plumbing the router owns and a channel should not
   * reimplement: `body(req)` parses JSON under the server's size cap — the cap is the
   * point, a channel parsing the body itself is an unbounded read — and
   * `requirePrincipal(principal)` throws the same 401 every other route throws.
   *
   * @param {{body: Function, requirePrincipal: Function}} helpers
   * @returns {Array<{method: string, path: string, deps?: string[], handler: Function}>}
   */
  routes(helpers) { // eslint-disable-line no-unused-vars
    return [];
  }
}
