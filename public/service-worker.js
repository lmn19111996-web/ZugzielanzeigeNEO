const ICON_CACHE = 'push-icons-v1';
const ICON_URLS = [
  '/res/png/square/s1.png', '/res/png/square/s2.png', '/res/png/square/s3.png',
  '/res/png/square/s4.png', '/res/png/square/s5.png', '/res/png/square/s6.png',
  '/res/png/square/s7.png', '/res/png/square/s8.png', '/res/png/square/s9.png',
  '/res/png/square/s11.png', '/res/png/square/s25.png', '/res/png/square/s26.png',
  '/res/png/square/s41.png', '/res/png/square/s42.png', '/res/png/square/s45.png',
  '/res/png/square/s46.png', '/res/png/square/s47.png', '/res/png/square/s51.png',
  '/res/png/square/s60.png', '/res/png/square/s62.png', '/res/png/square/s75.png',
  '/res/png/square/s85.png', '/res/png/square/s95.png',
  '/res/announcement.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(ICON_CACHE).then(cache => cache.addAll(ICON_URLS))
  );
});

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  // Serve push notification icons from cache when network is unavailable
  if (ICON_URLS.includes(new URL(e.request.url).pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
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
