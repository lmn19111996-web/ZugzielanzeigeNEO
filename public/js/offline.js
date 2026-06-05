// === OFFLINE MANAGER ===
// Tracks real server reachability (not just navigator.onLine).
// Polls /api/health every POLL_INTERVAL_MS. On transition:
//   online  → offline : show banner, stop non-essential fetches
//   offline → online  : hide banner, flush outbox, re-fetch schedule
//
// Other modules use isAppOnline() to gate server calls.

(function () {
  const POLL_INTERVAL_MS  = 10000; // check every 10 s while online
  const RETRY_INTERVAL_MS = 5000;  // check every 5 s while offline
  const HEALTH_URL        = '/api/health';
  const PROBE_TIMEOUT_MS  = 4000;

  let _serverOnline   = true;  // optimistic initial state
  let _pollTimer      = null;

  // ── IndexedDB outbox ────────────────────────────────────────────────────────

  const _offlineDB = (() => {
    let _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('offline-outbox', 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('outbox')) {
            const store = db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
            store.createIndex('by_queued', 'queuedAt');
          }
        };
        req.onsuccess = e => { _db = e.target.result; resolve(_db); };
        req.onerror   = () => reject(req.error);
      });
    }
    return { open };
  })();

  async function _deleteOutboxItem(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').delete(id);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function offlineOutboxQueue(payload) {
    try {
      const db = await _offlineDB.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').add({ ...payload, queuedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      });
    } catch (e) {
      console.error('[offline] Failed to queue request:', e);
    }
  }

  async function offlineOutboxFlush() {
    let db;
    try { db = await _offlineDB.open(); } catch { return; }

    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const req = tx.objectStore('outbox').index('by_queued').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });

    if (!items.length) return;
    console.log(`[offline] Flushing ${items.length} queued request(s)…`);

    for (const item of items) {
      try {
        const res = await fetch(item.url, {
          method:  item.method,
          headers: item.headers || { 'Content-Type': 'application/json' },
          body:    item.body,
        });
        if (res.ok || res.status === 409) {
          await _deleteOutboxItem(db, item.id);
          console.log(`[offline] ✅ Replayed ${item.method} ${item.url}`);
        } else {
          console.warn(`[offline] ⚠️ Replay failed (${res.status}) — keeping in outbox`);
        }
      } catch (e) {
        console.warn('[offline] Still offline during flush, stopping:', e.message);
        break;
      }
    }
  }

  // ── Banner ──────────────────────────────────────────────────────────────────

  function _showBanner() {
    const el = document.getElementById('offline-banner');
    if (el) el.classList.add('visible');
  }

  function _hideBanner() {
    const el = document.getElementById('offline-banner');
    if (el) el.classList.remove('visible');
  }

  // ── Server probe ────────────────────────────────────────────────────────────

  async function _probeServer() {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res  = await fetch(HEALTH_URL, { method: 'GET', cache: 'no-store', signal: ctrl.signal });
      clearTimeout(tid);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function _onBecameOnline() {
    console.log('[offline] ✅ Server reachable — switching to online mode');
    _serverOnline = true;
    _hideBanner();
    await offlineOutboxFlush();
    // Re-fetch schedule so the UI reflects any queued saves that just landed
    if (typeof fetchSchedule === 'function' && typeof processTrainData === 'function') {
      try {
        const data = await fetchSchedule(true);
        processTrainData(data);
        if (typeof renderTrains === 'function') renderTrains();
      } catch (e) {
        console.warn('[offline] Re-fetch after reconnect failed:', e.message);
      }
    }
  }

  function _onBecameOffline() {
    console.log('[offline] ❌ Server unreachable — switching to offline mode');
    _serverOnline = false;
    _showBanner();
  }

  async function _poll() {
    const reachable = await _probeServer();

    if (reachable && !_serverOnline) {
      await _onBecameOnline();
    } else if (!reachable && _serverOnline) {
      _onBecameOffline();
    }

    // Schedule next poll — shorter interval while offline so we reconnect quickly
    _pollTimer = setTimeout(_poll, _serverOnline ? POLL_INTERVAL_MS : RETRY_INTERVAL_MS);
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  // Do an immediate probe on load so we know the real state before any fetches
  _probeServer().then(reachable => {
    if (!reachable) _onBecameOffline();
    // Start polling loop
    _pollTimer = setTimeout(_poll, reachable ? POLL_INTERVAL_MS : RETRY_INTERVAL_MS);
  });

  // Also react to browser network events for instant response
  window.addEventListener('online',  () => { clearTimeout(_pollTimer); _poll(); });
  window.addEventListener('offline', () => { clearTimeout(_pollTimer); _onBecameOffline(); _pollTimer = setTimeout(_poll, RETRY_INTERVAL_MS); });

  // ── Public API ──────────────────────────────────────────────────────────────

  // Use this everywhere instead of navigator.onLine
  window.isAppOnline = () => _serverOnline;

  window.offlineOutbox = {
    queue: offlineOutboxQueue,
    flush: offlineOutboxFlush,
  };

})();
