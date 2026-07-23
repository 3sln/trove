// Trove service worker — handles web-push for @mention notifications. We send
// *bodyless* pushes (no payload, see server webpush.js), so on 'push' the worker
// fetches the freshest inbox itself and shows the top notification, then tells
// any open tab to refresh its bell. Clicking a notification focuses/opens Trove.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
      } catch {
        /* offline — still show a generic nudge */
      }
      await self.registration.showNotification(title, {
        body,
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: 'trove-mentions',
        renotify: true,
      });
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
