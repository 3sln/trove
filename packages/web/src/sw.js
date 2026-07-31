// Trove service worker — offline support + web-push. Three caches:
//   trove-shell : the app shell (HTML/JS/CSS/icons) — so the whole workbench,
//                 including every BUILT-IN media player & previewer (they're in
//                 the bundle), works offline. Stale-while-revalidate.
//   trove-files : bytes of files the user "made available offline" (pinned).
//                 Cache-first, so openers read them with no network.
//   trove-api   : GET /api responses (listings, sidecars…) seen while online,
//                 network-first with a cache fallback for read-only offline use.
// Writes offline aren't proxied here — the client queues sidecar changes itself
// and replays them (CRDT-merge) on reconnect. On push (bodyless) we pull the
// inbox and notify.

import { directRead } from './platform/directRead.js';

// The build stamps SHELL with a hash of the emitted assets (see build.mjs), so a deploy
// gives the new worker a new shell cache and `activate` below retires the old one. It
// was `trove-shell-v1` and never changed, which made that sweep a no-op — two builds
// shared one cache and whichever entry landed first won.
//
// API and FILES deliberately do NOT rotate. API is data, not code, and FILES holds the
// bytes of files the user pinned for offline use — naming it per build would throw away
// someone's offline library every time the app was redeployed.
const SHELL = __TROVE_SHELL__;
const API = 'trove-api-v1';
const FILES = 'trove-files-v1';
const KEEP = new Set([SHELL, API, FILES]);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/index.html', '/icon.svg']).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') return; // only same-origin GETs

  if (url.pathname === '/api/items/download') {
    event.respondWith(pinnedFirst(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

/**
 * What a failed fetch actually means — which is not "offline" unless the browser says so.
 *
 * Every arm of this worker used to answer a rejected fetch with a synthesised 504 whose
 * body said "Offline". Both halves of that were wrong, and together they cost a day of
 * debugging: a bucket with no CORS policy rejects the fetch, so an online drive with a
 * misconfigured store reported itself as a gateway timeout while offline, and the tab was
 * neither. A worker cannot diagnose why a fetch failed, so it must not claim to.
 *
 *   503, not 504 — a made-up 504 is indistinguishable from a real proxy timeout, and
 *   that is exactly the wrong tree to send someone up.
 *   `x-trove-sw` — so a client (and a person reading the network panel) can tell this
 *   response was invented here and never reached a server.
 *   The real error, and `navigator.onLine`, because those are the two facts available.
 *
 * `kind` is how far the guess is allowed to go. A file request is the one that leaves this
 * origin — the server answers it with a redirect to the store — so a store that refuses
 * the browser is the likely cause there and nowhere else. For everything else the honest
 * statement is that the server did not answer; naming CORS would send someone to check a
 * bucket policy when their drive is simply down.
 */
function failed(err, kind) {
  const offline = self.navigator.onLine === false;
  const detail = err?.message || String(err || 'the request failed');
  const cause = kind === 'file'
    ? 'The browser reports it is online, so this is usually the backing store refusing it — '
      + 'check Activity → Needs attention for the store’s CORS policy.'
    : 'The browser reports it is online, so the server did not answer.';
  const message = offline
    ? 'You are offline, and this is not available offline.'
    : `This request could not be completed (${detail}). ${cause}`;
  const json = kind === 'api';
  return new Response(
    json ? JSON.stringify({ error: { code: offline ? 'offline' : 'unavailable', message } }) : message,
    {
      status: 503,
      statusText: offline ? 'Offline' : 'Request Failed',
      headers: {
        'content-type': json ? 'application/json' : 'text/plain; charset=utf-8',
        'x-trove-sw': offline ? 'offline' : 'fetch-failed',
      },
    },
  );
}

// Pinned files live in trove-files (keyed by the full download URL). If present,
// serve from cache (works offline and avoids re-downloading); else go to network.
async function pinnedFirst(req) {
  const cache = await caches.open(FILES);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return sliceForRange(hit, req.headers.get('range'));
  // Straight from the store, decrypted here, when the deployment can presign and this
  // worker can get a plan. Encryption defends the storage host, so the bytes are allowed
  // to reach us — what must not reach the bucket is plaintext. Returns null for every
  // reason it might not apply, and then this is the proxy path it always was.
  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    try {
      const direct = await directRead(id, req.headers.get('range'), (path) => fetch(path, { credentials: 'same-origin' }));
      if (direct) return direct;
    } catch { /* fall through to the proxy */ }
  }
  try {
    return await fetch(req);
  } catch (err) {
    return failed(err, 'file');
  }
}

/**
 * Serve the range the caller actually asked for.
 *
 * The cache is keyed by URL alone, so a ranged request matched the full 200 response and
 * got the WHOLE file back. The MP4 parser walks a container with 16-byte range reads and
 * re-read offset 0 every time — 64 fetches, no chapters, no cover — and each of those
 * materialised the entire body, so a pinned 600 MB audiobook read tens of gigabytes out
 * of CacheStorage behind a spinner. `readTextCapped` lost its 512 KB cap the same way.
 */
async function sliceForRange(res, header) {
  if (!header) return res;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return res;
  const buf = new Uint8Array(await res.clone().arrayBuffer());
  const total = buf.byteLength;
  let start;
  let end;
  if (m[1] === '') {
    const n = Math.min(Number(m[2] || 0), total);
    if (!(n > 0)) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    start = total - n;
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (!(start >= 0) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
  }
  const headers = new Headers(res.headers);
  headers.set('content-range', `bytes ${start}-${end}/${total}`);
  headers.set('content-length', String(end - start + 1));
  headers.set('accept-ranges', 'bytes');
  return new Response(buf.subarray(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

async function networkFirst(req) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return failed(err, 'api');
  }
}

// What a request asked to BE, against what came back. The server no longer answers a
// miss under /assets/ with index.html, which is what used to produce this — but the
// consequence was bad enough to be worth refusing here as well. A 200 whose body is
// HTML, stored under a .js URL, is a module that fails to link on every load from then
// on; and because a cache hit is served without ever asking the network again, it does
// not heal. Nothing else in this worker is load-bearing enough to leave that to one
// check in another process.
const EXPECTED_TYPE = {
  script: /javascript|ecmascript/i,
  style: /text\/css/i,
  font: /font/i,
  image: /^image\//i,
};

function typeMatches(req, res) {
  const want = EXPECTED_TYPE[req.destination];
  if (!want) return true; // documents, and anything the browser has no opinion about
  return want.test(res.headers.get('content-type') || '');
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  // The error is kept rather than discarded: it is the only description of what went
  // wrong that anyone will ever see, and `failed` needs it to avoid inventing a reason.
  let reason = null;
  const network = fetch(req).then((res) => {
    // Let a mismatch through — the browser's own error is clearer than anything we
    // could synthesise — but never keep it.
    if (res.ok && typeMatches(req, res)) cache.put(req, res.clone());
    return res;
  }).catch((err) => {
    reason = err;
    return null;
  });
  return cached || (await network) || failed(reason, 'asset');
}

// --- web push (bodyless → pull inbox) --------------------------------------
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let title = 'New activity in Trove';
      let body = '';
      try {
        const res = await fetch('/api/notifications', { credentials: 'include' });
        if (res.ok) {
          const inbox = await res.json();
          const latest = inbox.items?.find((n) => !n.read) || inbox.items?.[0];
          if (latest) {
            title = latest.title || title;
            body = latest.items?.[0]?.excerpt ? `“${latest.items[0].excerpt}”` : '';
          }
        }
      } catch { /* offline */ }
      await self.registration.showNotification(title, { body, icon: '/icon.svg', badge: '/icon.svg', tag: 'trove-mentions', renotify: true });
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.postMessage({ type: 'trove-push' });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })(),
  );
});
