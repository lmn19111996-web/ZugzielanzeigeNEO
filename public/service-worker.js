const ICON_CACHE = 'push-icons-v3';
const ICON_URLS = [
  '/res/png/s1.png', '/res/png/s2.png', '/res/png/s3.png',
  '/res/png/s4.png', '/res/png/s5.png', '/res/png/s6.png',
  '/res/png/s7.png', '/res/png/s8.png', '/res/png/s9.png',
  '/res/png/s11.png', '/res/png/s17.png', '/res/png/s21.png',
  '/res/png/s25.png', '/res/png/s26.png', '/res/png/s28.png',
  '/res/png/s41.png', '/res/png/s42.png', '/res/png/s45.png',
  '/res/png/s46.png', '/res/png/s47.png', '/res/png/s49.png',
  '/res/png/s51.png', '/res/png/s57.png', '/res/png/s60.png',
  '/res/png/s62.png', '/res/png/s74.png', '/res/png/s75.png',
  '/res/png/s85.png', '/res/png/s91.png', '/res/png/s92.png',
  '/res/png/s93.png', '/res/png/s94.png', '/res/png/s95.png',
  '/res/png/s96.png', '/res/png/s97.png', '/res/png/s98.png',
  '/res/png/s99.png', '/res/png/sev.png', '/res/png/1.png',
  '/res/png/2.png', '/res/png/3.png', '/res/png/4.png',
  '/res/png/5.png', '/res/png/6.png', '/res/png/7.png',
  '/res/png/8.png', '/res/png/9.png', '/res/png/10.png',
  '/res/png/11.png', '/res/png/12.png', '/res/png/13.png',
  '/res/png/17.png', '/res/png/fex.png', '/res/announcement.png'
];

// ── App Shell Cache ───────────────────────────────────────────────────────────
const SHELL_CACHE = 'app-shell-v1';
const SHELL_URLS = [
  '/mobile.html',
  '/style.css',
  '/design-tokens.css',
  '/manifest.json',
  '/stations.json',
  '/vvs-stations.json',
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
  '/res/u.svg', '/res/u1.svg', '/res/u2.svg', '/res/u3.svg', '/res/u4.svg', '/res/u5.svg',
  '/res/u6.svg', '/res/u7.svg', '/res/u8.svg', '/res/u9.svg', '/res/u12.svg',
  '/res/u13.svg', '/res/u14.svg', '/res/u15.svg', '/res/u16.svg', '/res/u19.svg',
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
      // Per-URL, like SHELL_URLS below: addAll() rejects atomically, so a
      // single missing icon used to fail install outright - the worker never
      // activated, serviceWorker.ready never resolved, and push died with it.
      caches.open(ICON_CACHE).then(cache =>
        Promise.all(ICON_URLS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache icon', url, err))
        ))
      ),
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

// Fetch with a timeout — falls back to cache if the network hangs (e.g. Tailscale up, server down)
function _fetchWithTimeout(request, timeoutMs) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(request, { signal: ctrl.signal })
    .then(res  => { clearTimeout(tid); return res; })
    .catch(err => { clearTimeout(tid); throw err; });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const { pathname } = url;

  // 1a. index.html is a static redirect shell — always serve from cache instantly
  if (pathname === '/' || pathname === '/index.html') {
    e.respondWith(
      caches.match(e.request).then(cached => cached || _fetchWithTimeout(e.request, 5000))
    );
    return;
  }

  // 1b. Push notification icons — cache-first
  if (ICON_URLS.includes(pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // 2. App shell static assets (including /res/ icons) — network-first with 5s timeout, cache fallback
  // (During development this ensures you always get fresh code when online)
  if (SHELL_URLS.includes(pathname) || pathname.startsWith('/res/')) {
    e.respondWith(
      _fetchWithTimeout(e.request, 5000)
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
      _fetchWithTimeout(e.request, 5000)
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

  // 4. POST/PUT/DELETE to /api/ — add timeout so mutations don't hang;
  //    return 503 on network failure so JS catch blocks get a clean HTTP error
  //    instead of an unhandled 'Failed to fetch' rejection.
  if ((e.request.method === 'POST' || e.request.method === 'PUT' || e.request.method === 'DELETE')
      && pathname.startsWith('/api/')) {
    e.respondWith(
      _fetchWithTimeout(e.request, 8000)
        .catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }))
    );
    return;
  }

  // 5. Everything else — pass through
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
