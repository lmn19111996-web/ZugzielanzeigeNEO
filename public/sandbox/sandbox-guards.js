// === SANDBOX GUARDS ===
// Injected right before js/init.js (see sandbox-server.js), i.e. after every
// script that defines these functions and before startup can call them. The
// sandbox is only the train list, the Belegungsplan and the editor; every
// other area is disabled here — not just hidden — so keyboard shortcuts, a
// saved default workspace or a stray button can't reach it either. The
// matching nav items are hidden in sandbox.css.

(function () {
  'use strict';

  const BLOCKED_MODES = new Set([
    'db-api', 'announcements', 'notes', 'projects', 'vorlagen',
    'log-viewer', 'reviews', 'recycle-bin',
  ]);
  const noop = function () {};

  if (typeof window.setWorkspaceMode === 'function') {
    const realSetWorkspaceMode = window.setWorkspaceMode;
    // Function declarations are writable global properties, so reassigning
    // also redirects the bare setWorkspaceMode(...) calls inside the app.
    window.setWorkspaceMode = function sandboxSetWorkspaceMode(mode) {
      if (!BLOCKED_MODES.has(mode)) return realSetWorkspaceMode(mode);
      console.info(`[sandbox] "${mode}" is disabled in the sandbox`);
      // Blocked drawers/overlays simply don't open.
      if (mode === 'announcements' || mode === 'notes' || mode === 'db-api') return;
      // A blocked workspace (e.g. the saved default at startup) shows the
      // list instead — or stays on the Belegungsplan if that's active.
      const current = typeof currentWorkspaceMode !== 'undefined' ? currentWorkspaceMode : 'list';
      return realSetWorkspaceMode(current === 'occupancy' ? 'occupancy' : 'list');
    };
  }

  // Drawers / overlays opened directly (nav buttons, editor, station button).
  ['openAnnouncementsDrawer', 'openNoteDrawer', 'showStationOverlay'].forEach(name => {
    if (typeof window[name] === 'function') window[name] = noop;
  });
})();
