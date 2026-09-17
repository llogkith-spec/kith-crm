// KITH phone alerts — service worker. Shows pings on the lock screen and
// opens the right job when tapped. Deliberately caches nothing, so an
// upload to GitHub is never hidden behind an old copy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'KITH', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'KITH Cars', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.split('?')[0] === url.split('?')[0] && 'focus' in c) {
        c.postMessage({ type: 'kith-open', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
