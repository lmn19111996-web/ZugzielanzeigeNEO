// === SANDBOX SHIM ===
// Loaded as the very first script of /sandbox.html (injected by
// sandbox-server.js), before any app code. It makes the unmodified app run
// against sandbox data and nothing else:
//
//  - Clock:    new Date() / Date.now() are frozen at 00:00 of the scenario
//              day, so every train of that day is "upcoming" and nothing
//              departs while you work. Explicit dates (new Date(y, m, d),
//              new Date(str)) behave normally.
//  - Network:  /api/schedule → /api/sandbox/*. Every other non-GET /api/ call
//              (settings, push, journal, bins, logs …) is swallowed with a
//              fake success. Live departures (db-departures) are blocked.
//  - Storage:  localStorage keys are prefixed "sbx:" and IndexedDB names
//              "sbx-", so view prefs and — critically — the offline outbox
//              (which the live app replays to /api/schedule) never mix.
//  - Push/SSE: EventSource, Notification, service-worker registration and
//              showNotification are stubbed out.
//
// The real implementations stay reachable for sandbox code via window.__sbx.

(function () {
  'use strict';

  const RealDate = window.Date;
  const realFetch = window.fetch.bind(window);

  // ---- boot state (synchronous: the clock must be set before app code runs) ----
  let bootState = null;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/sandbox/state', false);
    xhr.send(null);
    if (xhr.status === 200) bootState = JSON.parse(xhr.responseText);
  } catch (e) {
    console.error('[sandbox] could not load state', e);
  }
  if (!bootState) bootState = { schedule: { fixedSchedule: [], spontaneousEntries: [], projects: [] }, scenario: null };

  const realToday = new RealDate();
  const simDay = (bootState.scenario && bootState.scenario.date)
    || `${realToday.getFullYear()}-${String(realToday.getMonth() + 1).padStart(2, '0')}-${String(realToday.getDate()).padStart(2, '0')}`;
  const [sy, sm, sd] = simDay.split('-').map(Number);
  const SIM_NOW = new RealDate(sy, sm - 1, sd, 0, 0, 0, 0).getTime();

  // ---- frozen clock ----
  class SimDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(SIM_NOW);
      else super(...args);
    }
    static now() { return SIM_NOW; }
  }
  SimDate.parse = RealDate.parse;
  SimDate.UTC = RealDate.UTC;
  window.Date = SimDate;

  // ---- namespaced localStorage ----
  try {
    const real = window.localStorage;
    const P = 'sbx:';
    const ownKeys = () => {
      const keys = [];
      for (let i = 0; i < real.length; i++) {
        const k = real.key(i);
        if (k && k.startsWith(P)) keys.push(k.slice(P.length));
      }
      return keys;
    };
    const sandboxStorage = {
      getItem: (k) => real.getItem(P + k),
      setItem: (k, v) => real.setItem(P + k, String(v)),
      removeItem: (k) => real.removeItem(P + k),
      key: (i) => ownKeys()[i] ?? null,
      clear: () => ownKeys().forEach(k => real.removeItem(P + k)),
      get length() { return ownKeys().length; },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => sandboxStorage });
  } catch (e) {
    console.warn('[sandbox] localStorage namespacing failed', e);
  }

  // ---- namespaced IndexedDB (offline outbox!) ----
  try {
    const idb = window.indexedDB;
    const realOpen = idb.open.bind(idb);
    const realDelete = idb.deleteDatabase.bind(idb);
    idb.open = (name, version) => realOpen('sbx-' + name, version);
    idb.deleteDatabase = (name) => realDelete('sbx-' + name);
  } catch (e) {
    console.warn('[sandbox] IndexedDB namespacing failed', e);
  }

  // ---- push / notifications / SSE ----
  window.EventSource = class SandboxEventSource {
    constructor(url) { this.url = url; this.readyState = 2; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
  window.Notification = class SandboxNotification {
    constructor() {}
    static get permission() { return 'denied'; }
    static requestPermission() { return Promise.resolve('denied'); }
    close() {}
  };
  try {
    if (window.ServiceWorkerRegistration) {
      window.ServiceWorkerRegistration.prototype.showNotification = () => Promise.resolve();
    }
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new Error('Service worker disabled in sandbox'));
    }
  } catch (e) { /* not available */ }

  // ---- keyboard: no app Ctrl shortcuts, Ctrl+S = "Fertig" ----
  // Registered on window in the capture phase before any app script, so it
  // sees every key first. Any Ctrl/Cmd key stops here: none of the app's own
  // shortcuts (Ctrl+D/G/H/I/S, dashboard, lovemeter) and no Ctrl hint
  // overlay. Browser defaults (copy, paste, select all in a text field,
  // reload) still work — only Ctrl+S is prevented, and handed to the
  // sandbox app as "Fertig" (sandbox-app.js sets window.__sbx.onSave).
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) && e.key !== 'Control' && e.key !== 'Meta') return;
    e.stopImmediatePropagation();
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); // no browser "save page" dialog
      if (!e.repeat && window.__sbx && typeof window.__sbx.onSave === 'function') window.__sbx.onSave();
    }
  }, true);

  // ---- no Abfahrtstafel (dashboard) ----
  // dashboard.js assigns window.openDashboardMode after init.js has already
  // queued its startup call, so trap the property: the setter swallows the
  // assignment and every caller (startup, DB menu, mobile menu) gets a no-op.
  Object.defineProperty(window, 'openDashboardMode', {
    configurable: true,
    get: () => function sandboxNoDashboard() {},
    set: () => {},
  });

  // ---- network router ----
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  let lastSavedEntries = new Map(
    (bootState.schedule.spontaneousEntries || []).map(t => [t._uniqueId, t])
  );

  const TRACKED_FIELDS = ['plan', 'actual', 'dauer', 'canceled', 'date'];

  // Per-train field changes between two saves; feeds the decision log.
  function diffEntries(prevMap, nextList) {
    const changes = [];
    const seen = new Set();
    for (const t of nextList) {
      if (!t || !t._uniqueId) continue;
      seen.add(t._uniqueId);
      const before = prevMap.get(t._uniqueId);
      if (!before) { changes.push({ uid: t._uniqueId, kind: 'created', after: pick(t) }); continue; }
      const changed = TRACKED_FIELDS.filter(f => String(before[f] ?? '') !== String(t[f] ?? ''));
      if (changed.length) changes.push({ uid: t._uniqueId, kind: 'changed', fields: changed, before: pick(before), after: pick(t) });
    }
    for (const [uid, before] of prevMap) {
      if (!seen.has(uid)) changes.push({ uid, kind: 'deleted', before: pick(before) });
    }
    return changes;
  }

  function pick(t) {
    const o = {};
    TRACKED_FIELDS.forEach(f => { if (t[f] !== undefined) o[f] = t[f]; });
    return o;
  }

  async function handleScheduleGet() {
    const res = await realFetch('/api/sandbox/state', { cache: 'no-store' });
    const state = res.ok ? await res.json() : bootState;
    lastSavedEntries = new Map((state.schedule.spontaneousEntries || []).map(t => [t._uniqueId, t]));
    return json(state.schedule);
  }

  async function handleSchedulePost(bodyText) {
    let body;
    try { body = JSON.parse(bodyText || '{}'); } catch (e) { return json({ error: 'bad json' }, 400); }
    delete body.pushEvents; // never schedule pushes for sandbox trains
    const entries = Array.isArray(body.spontaneousEntries) ? body.spontaneousEntries : [];
    const changes = diffEntries(lastSavedEntries, entries);
    lastSavedEntries = new Map(entries.map(t => [t._uniqueId, t]));
    const res = await realFetch('/api/sandbox/schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (changes.length) {
      window.dispatchEvent(new CustomEvent('sbx:saved', { detail: { changes } }));
    }
    return res.ok ? json(await res.json()) : json({ error: 'sandbox save failed' }, 500);
  }

  window.fetch = async function sandboxFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    let u;
    try { u = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
    if (u.origin !== location.origin) return realFetch(input, init);
    const p = u.pathname;

    if (p.startsWith('/api/sandbox/')) return realFetch(input, init);
    if (p === '/api/schedule') {
      if (method === 'GET') return handleScheduleGet();
      if (method === 'POST') return handleSchedulePost(init && init.body);
    }
    if (p.startsWith('/api/db-departures')) return json({ error: 'Live departures are disabled in the sandbox' }, 503);
    // Settings are read live (line importance ranking), but the Nachtsperre
    // (curfew) does not apply in the sandbox: it would silently force-cancel
    // sandbox trains in its window (globals.js applyCurfewRule).
    if (p === '/api/settings' && method === 'GET') {
      const res = await realFetch(input, init);
      if (!res.ok) return res;
      const settings = await res.json().catch(() => ({}));
      return json(Object.assign({}, settings, { curfewEnabled: false }));
    }
    if (method !== 'GET' && p.startsWith('/api/')) {
      console.info(`[sandbox] blocked ${method} ${p} (no writes to live data)`);
      return json({ success: true, sandbox: true });
    }
    return realFetch(input, init);
  };

  window.__sbx = {
    RealDate,
    realFetch,
    simDay,
    SIM_NOW,
    bootState,
    realNowIso: () => new RealDate().toISOString(),
  };

  console.info(`[sandbox] active — frozen clock ${simDay} 00:00, live data isolated`);
})();
