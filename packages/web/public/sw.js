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

const SHELL = 'trove-shell-v1';
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

  if (url.pathname === '/api/fs/download') {
    event.respondWith(pinnedFirst(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

// Pinned files live in trove-files (keyed by the full download URL). If present,
// serve from cache (works offline and avoids re-downloading); else go to network.
async function pinnedFirst(req) {
  const cache = await caches.open(FILES);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return new Response('Offline and not available offline', { status: 504 });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: { code: 'offline', message: 'Offline — this data isn’t cached.' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('Offline', { status: 504 });
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
