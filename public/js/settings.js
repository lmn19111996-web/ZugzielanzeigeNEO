// === APP SETTINGS ===
// Global settings shared by every device (not per-browser), persisted server-side
// via /api/settings (backed by app_settings.json, gitignored). An in-memory cache
// keeps window.AppSettings.get() synchronous for existing call sites in
// delay-reason.js, notifications.js, init.js, journal.js and schedule.js; the
// cache is populated from the server on load (window.AppSettings.ready resolves
// once that fetch completes) and updated immediately whenever set() is called,
// with the full object PUT to the server in the background.

const SETTINGS_DEFAULTS = {
  turnaroundThresholdMin: 15,
  delayReasons: [
    'Fahrzeugmangel',
    'Verspätete Bereitstellung des Zuges',
    'Kurzfristiger Personalausfall',
    'Vorfahrt eines anderen Zuges',
    'Technische Defekt am Zug',
    'Streckensperrung',
    'Feiertag',
    'Ereignis'
  ],
  notificationLeadMin: 20,
  lookaheadWindowDays: 14,
  journalDayStartHour: 6,
  defaultWorkspace: 'auto'
};

let _settingsCache = Object.assign({}, SETTINGS_DEFAULTS);

// Recurring trains are materialized into real schedule entries up front for
// every day in this window, so an unbounded value silently balloons data.json
// (e.g. 999 days x several daily entries). Clamp on both read and write so a
// bad stored value self-heals the next time it's read.
const LOOKAHEAD_WINDOW_MAX_DAYS = 30;

function _clampSetting(key, value) {
  if (key === 'lookaheadWindowDays') {
    const num = Number(value);
    // Anything outside the sane range (including a leftover bad value like 999)
    // resets to the default rather than merely capping, so a corrupted stored
    // value doesn't linger just under the ceiling.
    if (!num || num < 1 || num > LOOKAHEAD_WINDOW_MAX_DAYS) return SETTINGS_DEFAULTS.lookaheadWindowDays;
    return num;
  }
  return value;
}

function getAppSettings() {
  return Object.assign({}, SETTINGS_DEFAULTS, _settingsCache);
}

function getAppSetting(key) {
  const value = Object.prototype.hasOwnProperty.call(_settingsCache, key) ? _settingsCache[key] : SETTINGS_DEFAULTS[key];
  return _clampSetting(key, value);
}

function setAppSetting(key, value) {
  _settingsCache[key] = _clampSetting(key, value);
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_settingsCache)
  }).catch(function (e) { console.warn('Failed to save settings:', e); });
  return _settingsCache;
}

const _settingsReady = fetch('/api/settings')
  .then(function (r) { return r.json(); })
  .then(function (stored) {
    if (stored && typeof stored === 'object') {
      _settingsCache = Object.assign({}, SETTINGS_DEFAULTS, stored);
    }
  })
  .catch(function (e) { console.warn('Failed to load settings from server:', e); });

window.AppSettings = {
  get: getAppSetting,
  set: setAppSetting,
  getAll: getAppSettings,
  ready: _settingsReady,
  DEFAULTS: SETTINGS_DEFAULTS
};

// === SETTINGS PAGE ===
// Changes are held in a local draft and only written to AppSettings (and
// applied to the app) when the user presses "Anwenden". "Verwerfen" discards
// the draft and returns to whichever workspace was active before.

const WORKSPACE_OPTIONS = [
  { value: 'auto', label: 'Automatisch (zuletzt verwendete Ansicht)' },
  { value: 'list', label: 'Abfahrtstafel (Liste)' },
  { value: 'occupancy', label: 'Belegungsplan' },
  { value: 'projects', label: 'Projekte' },
  { value: 'reviews', label: 'Rezensionen' },
  { value: 'log-viewer', label: 'Log' },
  { value: 'vorlagen', label: 'Vorlagen' }
];

let _settingsDraft = null;

function _buildSettingsSection(titleText, descText) {
  const section = document.createElement('div');
  section.className = 'settings-section';
  const title = document.createElement('h3');
  title.className = 'settings-section-title';
  title.textContent = titleText;
  section.appendChild(title);
  if (descText) {
    const desc = document.createElement('p');
    desc.className = 'settings-section-desc';
    desc.textContent = descText;
    section.appendChild(desc);
  }
  return section;
}

// Number input backed by _settingsDraft[key]. If the user leaves an
// out-of-range value in the field, it's silently reset back to the last
// valid value on blur/change rather than being accepted.
function _buildNumberRow(section, labelText, key, opts) {
  opts = opts || {};
  const row = document.createElement('div');
  row.className = 'settings-row';
  const label = document.createElement('label');
  label.className = 'settings-label';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-input';
  input.value = _settingsDraft[key];
  if (opts.min != null) input.min = opts.min;
  if (opts.max != null) input.max = opts.max;
  input.addEventListener('change', function () {
    const num = Number(input.value);
    const outOfRange = isNaN(num)
      || (opts.min != null && num < opts.min)
      || (opts.max != null && num > opts.max);
    if (outOfRange) {
      input.value = _settingsDraft[key];
      return;
    }
    _settingsDraft[key] = num;
  });
  row.append(label, input);
  section.appendChild(row);
}

function _buildSelectRow(section, labelText, key, options) {
  const row = document.createElement('div');
  row.className = 'settings-row';
  const label = document.createElement('label');
  label.className = 'settings-label';
  label.textContent = labelText;
  const select = document.createElement('select');
  select.className = 'settings-input';
  options.forEach(function (opt) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === _settingsDraft[key]) o.selected = true;
    select.appendChild(o);
  });
  select.addEventListener('change', function () {
    _settingsDraft[key] = select.value;
  });
  row.append(label, select);
  section.appendChild(row);
}

function _buildDelayReasonsSection() {
  const section = _buildSettingsSection(
    'Verspätungsgründe',
    'Schwelle für die automatische "Kurze Wendezeit"-Erkennung und die Liste der wählbaren Verspätungsgründe.'
  );

  _buildNumberRow(section, 'Kurze-Wendezeit-Schwelle (Minuten)', 'turnaroundThresholdMin', { min: 0 });

  const listWrap = document.createElement('div');
  listWrap.className = 'settings-reasons-list';
  section.appendChild(listWrap);

  function renderReasonRows() {
    listWrap.innerHTML = '';
    _settingsDraft.delayReasons.forEach(function (reason, idx) {
      const row = document.createElement('div');
      row.className = 'settings-reason-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-input';
      input.value = reason;
      input.addEventListener('change', function () {
        _settingsDraft.delayReasons[idx] = input.value.trim() || reason;
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'settings-reason-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', function () {
        _settingsDraft.delayReasons.splice(idx, 1);
        renderReasonRows();
      });
      row.append(input, removeBtn);
      listWrap.appendChild(row);
    });
  }
  renderReasonRows();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'settings-add-reason';
  addBtn.textContent = '+ Grund hinzufügen';
  addBtn.addEventListener('click', function () {
    _settingsDraft.delayReasons.push('Neuer Grund');
    renderReasonRows();
  });
  section.appendChild(addBtn);

  return section;
}

function _buildNotificationsSection() {
  const section = _buildSettingsSection(
    'Benachrichtigungen',
    'Vorlaufzeit für Abfahrts-Erinnerungen sowie Verwaltung der Push-Benachrichtigungen auf diesem Gerät.'
  );

  _buildNumberRow(section, 'Vorlaufzeit (Minuten vor Abfahrt)', 'notificationLeadMin', { min: 1 });

  // ── Push subscription management (migrated from push-settings.html) ──
  const permRow = document.createElement('div');
  permRow.className = 'settings-push-status';
  const permDot = document.createElement('span');
  permDot.className = 'settings-push-dot';
  const permLabel = document.createElement('span');
  permLabel.textContent = 'Browser-Berechtigung: …';
  permRow.append(permDot, permLabel);

  const subRow = document.createElement('div');
  subRow.className = 'settings-push-status';
  const subDot = document.createElement('span');
  subDot.className = 'settings-push-dot';
  const subLabel = document.createElement('span');
  subLabel.textContent = 'Dieses Gerät: …';
  subRow.append(subDot, subLabel);

  const serverRow = document.createElement('div');
  serverRow.className = 'settings-push-status';
  const serverDot = document.createElement('span');
  serverDot.className = 'settings-push-dot';
  const serverLabel = document.createElement('span');
  serverLabel.textContent = 'Server: …';
  serverRow.append(serverDot, serverLabel);

  const btnRow = document.createElement('div');
  btnRow.className = 'settings-push-buttons';
  const btnSubscribe = document.createElement('button');
  btnSubscribe.className = 'settings-btn-subscribe';
  btnSubscribe.textContent = 'Auf diesem Gerät anmelden';
  btnSubscribe.disabled = true;
  const btnUnsubscribe = document.createElement('button');
  btnUnsubscribe.className = 'settings-btn-unsubscribe';
  btnUnsubscribe.textContent = 'Von diesem Gerät abmelden';
  btnUnsubscribe.disabled = true;
  const btnTest = document.createElement('button');
  btnTest.className = 'settings-btn-test';
  btnTest.textContent = 'Test-Benachrichtigung senden';
  btnTest.disabled = true;
  btnRow.append(btnSubscribe, btnUnsubscribe, btnTest);

  section.append(permRow, subRow, serverRow, btnRow);

  function setDot(el, state) {
    el.className = 'settings-push-dot' + (state ? ' ' + state : '');
  }

  function _urlBase64ToUint8Array(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(function (c) { return c.charCodeAt(0); }));
  }

  async function refreshPushStatus() {
    const perm = Notification.permission;
    permLabel.textContent = 'Browser-Berechtigung: ' + (perm === 'granted' ? 'Erlaubt' : perm === 'denied' ? 'Verweigert' : 'Nicht gesetzt');
    setDot(permDot, perm === 'granted' ? 'ok' : perm === 'denied' ? 'err' : 'warn');

    const hasSW = 'serviceWorker' in navigator && 'PushManager' in window;
    if (!hasSW) {
      subLabel.textContent = 'Dieses Gerät: Nicht unterstützt';
      setDot(subDot, 'err');
      serverLabel.textContent = 'Server: –';
      setDot(serverDot, '');
      return;
    }

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      subLabel.textContent = 'Dieses Gerät: ' + (sub ? 'Angemeldet' : 'Nicht angemeldet');
      setDot(subDot, sub ? 'ok' : '');
      btnSubscribe.disabled = !!sub || perm === 'denied';
      btnUnsubscribe.disabled = !sub;
      btnTest.disabled = !sub;
    } catch (e) {
      subLabel.textContent = 'Dieses Gerät: Fehler';
      setDot(subDot, 'err');
    }

    try {
      const r = await fetch('/api/push/debug');
      if (r.ok) {
        const d = await r.json();
        serverLabel.textContent = 'Server: ' + (d.vapidConfigured
          ? `Aktiv · ${d.subscriptionCount} Gerät(e) · ${d.pendingEventCount} geplante Benachrichtigung(en)`
          : 'VAPID nicht konfiguriert');
        setDot(serverDot, d.vapidConfigured ? 'ok' : 'err');
      } else {
        serverLabel.textContent = 'Server: Nicht erreichbar';
        setDot(serverDot, 'warn');
      }
    } catch (e) {
      serverLabel.textContent = 'Server: Nicht erreichbar';
      setDot(serverDot, 'warn');
    }
  }

  btnSubscribe.addEventListener('click', async function () {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await refreshPushStatus(); return; }
    try {
      const kr = await fetch('/api/push/vapid-public-key');
      if (!kr.ok) { await refreshPushStatus(); return; }
      const { publicKey } = await kr.json();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlBase64ToUint8Array(publicKey) });
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    } catch (e) {
      console.error('Push subscribe failed:', e);
    }
    await refreshPushStatus();
  });

  btnUnsubscribe.addEventListener('click', async function () {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) { await refreshPushStatus(); return; }
      await sub.unsubscribe();
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    } catch (e) {
      console.error('Push unsubscribe failed:', e);
    }
    await refreshPushStatus();
  });

  btnTest.addEventListener('click', async function () {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('Test – Zugzielanzeige', {
        body: 'Push-Benachrichtigungen funktionieren auf diesem Gerät.',
        icon: '/res/6.png',
        vibrate: [200, 100, 200],
        tag: 'settings-push-test-' + Date.now()
      });
    } catch (e) {
      console.error('Test notification failed:', e);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').then(refreshPushStatus).catch(refreshPushStatus);
  } else {
    refreshPushStatus();
  }

  return section;
}

function _buildDefaultWorkspaceSection() {
  const section = _buildSettingsSection(
    'Standard-Arbeitsbereich',
    'Welche Ansicht beim Start der App geöffnet werden soll.'
  );
  _buildSelectRow(section, 'Startansicht', 'defaultWorkspace', WORKSPACE_OPTIONS);
  return section;
}

function _buildJournalSection() {
  const section = _buildSettingsSection(
    'Journal-Tagesgrenze',
    'Ab welcher Uhrzeit ein neuer Tag für das Journal beginnt (z. B. für Nachtschichten).'
  );
  _buildNumberRow(section, 'Tagesgrenze (Stunde, 0–23)', 'journalDayStartHour', { min: 0, max: 23 });
  return section;
}

function _buildLookaheadSection() {
  const section = _buildSettingsSection(
    'Vorschau-Fenster',
    `Wie viele Tage im Voraus wiederkehrende Fahrten und geplante Benachrichtigungen erzeugt werden (maximal ${LOOKAHEAD_WINDOW_MAX_DAYS} Tage). Täglich/wöchentlich/werktags nutzen dieses Fenster; monatliche und jährliche Muster verwenden weiterhin ihr eigenes volles Zeitfenster.`
  );
  _buildNumberRow(section, `Vorschau-Fenster (Tage, max. ${LOOKAHEAD_WINDOW_MAX_DAYS})`, 'lookaheadWindowDays', { min: 1, max: LOOKAHEAD_WINDOW_MAX_DAYS });
  return section;
}

function _returnToPreviousWorkspace() {
  const target = window._preSettingsWorkspaceMode || 'list';
  if (typeof window.setWorkspaceMode === 'function') window.setWorkspaceMode(target);
}

function _buildFooter() {
  const footer = document.createElement('div');
  footer.className = 'settings-footer';

  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'settings-footer-btn settings-footer-btn--discard';
  discardBtn.textContent = 'Verwerfen';
  discardBtn.addEventListener('click', function () {
    _settingsDraft = null;
    _returnToPreviousWorkspace();
  });

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'settings-footer-btn settings-footer-btn--apply';
  applyBtn.textContent = 'Anwenden';
  applyBtn.addEventListener('click', function () {
    const draft = _settingsDraft;
    _settingsDraft = null;
    Object.keys(draft).forEach(function (key) {
      window.AppSettings.set(key, draft[key]);
    });

    // Brief success indication, same pattern as the journal drawer's save button
    applyBtn.disabled = true;
    discardBtn.disabled = true;
    applyBtn.textContent = '✓ Gespeichert';
    setTimeout(_returnToPreviousWorkspace, 500);
  });

  footer.append(discardBtn, applyBtn);
  return footer;
}

async function renderSettingsPage() {
  const trainListEl = document.getElementById('train-list');
  if (!trainListEl) return;

  if (window.AppSettings.ready) await window.AppSettings.ready;

  trainListEl.innerHTML = '';
  _settingsDraft = window.AppSettings.getAll();

  const page = document.createElement('div');
  page.className = 'settings-page';

  const scroll = document.createElement('div');
  scroll.className = 'settings-scroll';

  const header = document.createElement('div');
  header.className = 'settings-page-header';
  const titleEl = document.createElement('h2');
  titleEl.className = 'settings-page-title';
  titleEl.textContent = 'Einstellungen';
  header.appendChild(titleEl);
  scroll.appendChild(header);

  scroll.appendChild(_buildDelayReasonsSection());
  scroll.appendChild(_buildNotificationsSection());
  scroll.appendChild(_buildDefaultWorkspaceSection());
  scroll.appendChild(_buildJournalSection());
  scroll.appendChild(_buildLookaheadSection());

  page.appendChild(scroll);
  page.appendChild(_buildFooter());

  trainListEl.appendChild(page);
}

window.renderSettingsPage = renderSettingsPage;
