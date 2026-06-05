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

// ── App Shell Cache ───────────────────────────────────────────────────────────
const SHELL_CACHE = 'app-shell-v1';
const SHELL_URLS = [
  '/mobile.html',
  '/style.css',
  '/design-tokens.css',
  '/manifest.json',
  '/stations.json',
  '/templates.js',
  '/app.js',
  '/js/globals.js',
  '/js/utils.js',
  '/js/notifications.js',
  '/js/schedule.js',
  '/js/announcements.js',
  '/js/drawers.js',
  '/js/workspace.js',
  '/js/render-trains.js',
  '/js/editor.js',
  '/js/projects.js',
  '/js/reviews.js',
  '/js/swipe.js',
  '/js/time-suggestion.js',
  '/js/station.js',
  '/js/clock.js',
  '/js/journal.js',
  '/js/stressmeter-engine.js',
  '/js/stressmeter-ui.js',
  '/js/lovemeter-engine.js',
  '/js/lovemeter-ui.js',
  '/js/checkin.js',
  '/js/init.js',
  '/js/dashboard.js',
  '/js/shortcut-hints.js',
  '/js/offline.js',
  // Icons and UI assets
  '/res/1.svg', '/res/2.svg', '/res/3.svg', '/res/4.svg', '/res/5.svg',
  '/res/6.svg', '/res/6.png', '/res/7.svg', '/res/8.svg', '/res/9.svg',
  '/res/10.svg', '/res/11.svg', '/res/12.svg', '/res/13.svg', '/res/17.svg',
  '/res/s1.svg', '/res/s2.svg', '/res/s3.svg', '/res/s4.svg', '/res/s5.svg',
  '/res/s6.svg', '/res/s7.svg', '/res/s8.svg', '/res/s9.svg', '/res/s11.svg',
  '/res/s17.svg', '/res/s21.svg', '/res/s25.svg', '/res/s26.svg',
  '/res/s41.svg', '/res/s42.svg', '/res/s45.svg', '/res/s46.svg', '/res/s47.svg',
  '/res/s51.svg', '/res/s60.svg', '/res/s62.svg', '/res/s74.svg', '/res/s75.svg',
  '/res/s85.svg', '/res/s95.svg',
  '/res/fex.svg', '/res/c0.svg', '/res/c1.svg', '/res/c2.svg', '/res/c3.svg', '/res/c4.svg',
  '/res/cb0.svg', '/res/cb1.svg', '/res/cb2.svg', '/res/cb3.svg', '/res/cb4.svg',
  '/res/auslastung1.svg', '/res/auslastung2.svg', '/res/auslastung3.svg', '/res/auslastung4.svg',
  '/res/energy.svg', '/res/announcement.png', '/res/icon.svg',
  '/res/pin.svg', '/res/unpin.svg', '/res/delete.svg', '/res/edit.png',
  '/res/plus.svg', '/res/menu.svg', '/res/list.png', '/res/notes.png',
  '/res/occupancy.svg', '/res/project.svg', '/res/inventory.svg',
  '/res/arrowup.svg', '/res/arrowdown.svg', '/res/doubleup.svg', '/res/doubledown.svg',
  '/res/checkin.svg', '/res/checkout.svg', '/res/eingecheckt.svg',
  '/res/3dotsvertical.svg', '/res/todo.png',
  '/res/sun.svg', '/res/moon.svg', '/res/grocery.svg', '/res/meal.svg',
  '/res/countdown.png',
  '/res/DB_logo_white_rgb_100px.svg',
  '/res/S-Bahn-Berlin/logo.svg',
];

// GET API endpoints that get network-first + stale fallback
const STALE_API_PREFIXES = [
  '/api/schedule',
  '/api/journal',
  '/api/lovemeter',
];
const API_CACHE = 'api-cache-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    Promise.all([
      caches.open(ICON_CACHE).then(cache => cache.addAll(ICON_URLS)),
      caches.open(SHELL_CACHE).then(cache =>
        Promise.all(SHELL_URLS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache', url, err))
        ))
      ),
    ])
  );
});

self.addEventListener('activate', e => e.waitUntil(
  Promise.all([
    self.clients.claim(),
    // Remove outdated caches
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== ICON_CACHE && k !== SHELL_CACHE && k !== API_CACHE).map(k => caches.delete(k)))
    ),
  ])
));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const { pathname } = url;

  // 1. Push notification icons — cache-first
  if (ICON_URLS.includes(pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // 2. App shell static assets (including /res/ icons) — network-first, cache fallback
  // (During development this ensures you always get fresh code when online)
  if (SHELL_URLS.includes(pathname) || pathname === '/' || pathname.startsWith('/res/')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(cached => cached || Response.error())
        )
    );
    return;
  }

  // 3. GET API calls (schedule, journal, lovemeter) — network-first, stale fallback
  if (e.request.method === 'GET' && STALE_API_PREFIXES.some(p => pathname.startsWith(p))) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(API_CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          // Return stale cache if available; otherwise let the browser handle the failure naturally
          caches.match(e.request).then(cached => cached || Response.error())
        )
    );
    return;
  }

  // 4. Everything else (including POST/PUT mutations) — pass through
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
