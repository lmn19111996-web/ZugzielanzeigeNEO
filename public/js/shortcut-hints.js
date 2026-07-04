// Shortcut-hints overlay — shows on Ctrl hold, hidden in dashboard mode.
(function () {
  'use strict';

  const SHORTCUTS = [
    { keys: 'Ctrl + A', label: 'Lovemeter' },
    { keys: 'Ctrl + S', label: 'Speichern' },
    { keys: 'Ctrl + D', label: 'Station auswählen' },
    { keys: 'Ctrl + F', label: 'Suche' },
    { keys: 'Ctrl + G', label: 'Neuer Eintrag' },
    { keys: 'Ctrl + H', label: 'Neuer Dauereintrag' },
    { keys: 'Ctrl + L', label: 'Dashboard' },
  ];

  let overlay = null;
  let showTimer = null;
  let visible = false;

  function isDashboardOpen() {
    const el = document.getElementById('dashboard-overlay');
    return el && el.style.display !== 'none' && el.style.display !== '';
  }

  function isInTextField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'shortcut-hints-overlay';
    el.setAttribute('aria-hidden', 'true');

    const title = document.createElement('div');
    title.className = 'shortcut-hints-title';
    title.textContent = 'Shortcuts';
    el.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'shortcut-hints-grid';

    SHORTCUTS.forEach(({ keys, label }) => {
      const tile = document.createElement('div');
      tile.className = 'shortcut-hint-tile';

      const kbd = document.createElement('span');
      kbd.className = 'shortcut-hint-keys';
      kbd.textContent = keys;

      const desc = document.createElement('span');
      desc.className = 'shortcut-hint-label';
      desc.textContent = label;

      tile.appendChild(kbd);
      tile.appendChild(desc);
      grid.appendChild(tile);
    });

    el.appendChild(grid);
    document.body.appendChild(el);
    return el;
  }

  function showOverlay() {
    if (isDashboardOpen()) return;
    if (isInTextField()) return;
    if (!overlay) overlay = buildOverlay();
    overlay.classList.add('is-visible');
    visible = true;
  }

  function hideOverlay() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (!overlay) return;
    overlay.classList.remove('is-visible');
    visible = false;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Control') return;
    if (visible || showTimer) return;
    showTimer = setTimeout(function () {
      showTimer = null;
      showOverlay();
    }, 400);
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === 'Control') hideOverlay();
  });

  // Also hide when a Ctrl+key combo is actually triggered
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key !== 'Control') hideOverlay();
  }, true);

  // Hide if window loses focus
  window.addEventListener('blur', hideOverlay);
})();
