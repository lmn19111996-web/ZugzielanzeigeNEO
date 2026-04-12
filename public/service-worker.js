self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', () => {
  // Minimal fetch listener required for PWA installability
});

// Web Push: server sends { title, options } as JSON payload
self.addEventListener('push', e => {
  let title = 'Zugzielanzeige';
  let options = { icon: '/res/6.png', badge: '/res/6.png', vibrate: [200, 100, 200] };
  try {
    const data = e.data.json();
    title = data.title || title;
    options = Object.assign(options, data.options || {});
  } catch {}
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url === targetUrl && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('notificationclose', () => {
  // Closed by user — no action needed
});
