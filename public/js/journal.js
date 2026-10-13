// === JOURNAL: LOGICAL DAY, REMINDER DOT & REVIEW WRITE DRAWER ===

// ── Logical day: journalDayStartHour – (journalDayStartHour - 1) next day ──
// Shared by the reminder dot and the review-write drawer below.
window.getLogicalDate = function() {
  const startHour = window.AppSettings ? window.AppSettings.get('journalDayStartHour') : 6;
  const d = new Date();
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
};

// ══════════════════════════════════════════════════════════════
//  Journal Reminder Dot  (nav rail → "Rezensionen")
// ══════════════════════════════════════════════════════════════
// Lit once the evening is late enough that the day should have been
// journalled but hasn't been. The window runs from 21:00 until the logical
// day rolls over (journalDayStartHour), so the nudge lasts exactly as long as
// the day it refers to.
(function initJournalReminderDot() {
  const REMINDER_HOUR = 21;
  const RECHECK_MS    = 10 * 60 * 1000;  // re-poll while the dot is lit

  let knownDate = null;   // logical date the cached answer applies to
  let hasEntry  = false;
  let lastCheck = 0;
  let inFlight  = null;

  function dayStartHour() {
    const h = window.AppSettings ? window.AppSettings.get('journalDayStartHour') : 6;
    return Math.min(Number(h) || 6, REMINDER_HOUR);
  }

  function inReminderWindow() {
    const h = new Date().getHours();
    return h >= REMINDER_HOUR || h < dayStartHour();
  }

  function paint() {
    const dot = document.getElementById('journal-dot');
    if (dot) dot.hidden = !(inReminderWindow() && !hasEntry);
  }

  /**
   * @param {boolean} force  Skip the cache (use after a save).
   */
  async function refresh(force) {
    const today = window.getLogicalDate();

    if (today !== knownDate) {      // new logical day — previous answer is stale
      knownDate = today;
      hasEntry  = false;
      lastCheck = 0;
    }

    paint();  // reflect the window/cache immediately

    // Nothing to ask about outside the window, and no need to re-ask once an
    // entry is known to exist for this logical day.
    if (!force && (!inReminderWindow() || hasEntry)) return;
    if (!force && Date.now() - lastCheck < RECHECK_MS) return;
    if (inFlight) return inFlight;

    inFlight = (async function () {
      try {
        const res  = await fetch('/api/journal');
        const data = await res.json();
        hasEntry = (data.reviews || []).some(function (rv) { return rv.date === today; });
        lastCheck = Date.now();
      } catch (e) {
        // Offline or server down — leave the last known answer in place.
      } finally {
        inFlight = null;
        paint();
      }
    })();

    return inFlight;
  }

  // Called by the save paths so the dot clears without waiting for a re-poll.
  window.markJournalEntrySaved = function () {
    knownDate = window.getLogicalDate();
    hasEntry  = true;
    lastCheck = Date.now();
    paint();
  };

  window.refreshJournalDot = refresh;

  refresh();
  setInterval(function () { refresh(); }, 60000);
})();

// ══════════════════════════════════════════════════════════════
//  "Rezension" entry in the DB button's flyout menu
// ══════════════════════════════════════════════════════════════
// Opens the review-write drawer directly — never the Rezensionen workspace.
// If today's logical day already has an entry, that entry is opened for
// editing so the day can't end up with two reviews.
(function initJournalMenuEntry() {
  const item = document.getElementById('badge-menu-journal');
  if (!item) return;

  let opening = false;

  item.addEventListener('click', async function (e) {
    e.stopPropagation();
    if (opening) return;            // double-click while the fetch is in flight
    if (typeof window.openReviewWriteDrawer !== 'function') return;

    opening = true;
    const today = window.getLogicalDate();
    let existing = null;

    try {
      const res  = await fetch('/api/journal');
      const data = await res.json();
      existing = (data.reviews || []).find(function (rv) { return rv.date === today; }) || null;
    } catch (err) {
      // Offline or server down: fall through and open a blank entry. Saving
      // it goes through the offline outbox like any other journal write.
      console.warn('Rezension lookup failed, opening a new entry:', err);
    } finally {
      opening = false;
    }

    // No onSaved callback needed: doSave() already clears the reminder dot for
    // new entries and re-renders the Rezensionen page when it is the open
    // workspace (that gate is also why an onSaved passed from here would not
    // fire in the normal case, where the drawer is opened over the train list).
    window.openReviewWriteDrawer(existing, null);
  });
})();

// ══════════════════════════════════════════════════════════════
//  Review Write Drawer
// ══════════════════════════════════════════════════════════════
(function initReviewWriteDrawer() {
  const drawer    = document.getElementById('review-write-drawer');
  const closeBtn  = document.getElementById('review-write-drawer-close');
  const titleEl   = document.getElementById('review-write-drawer-title') ||
                    drawer && drawer.querySelector('.review-write-drawer-title');
  const dateEl    = document.getElementById('review-write-date');
  const starRow   = document.getElementById('review-write-stars');
  const textarea  = document.getElementById('review-write-text');
  const submitBtn = document.getElementById('review-write-submit');

  if (!drawer) return;

  let selectedRating = 0;
  let _editEntry = null;   // non-null when editing an existing review
  let _onSaved   = null;   // callback when save completes

  // ── Esc / click-outside handlers (registered on open, removed on close) ──
  let _escHandler = null;
  let _clickOutHandler = null;

  const getLogicalDate = window.getLogicalDate;

  function applyAccent() {
    const ac = (typeof currentAccentColor !== 'undefined' && currentAccentColor)
      ? currentAccentColor : '#ffcc00';
    submitBtn.style.background = ac;
    submitBtn.style.color = '#111';
    const hdr = document.getElementById('review-write-drawer-header');
    if (hdr) hdr.style.borderBottomColor = ac;
  }

  // ── Open (new or edit) ────────────────────────────────────────
  function openDrawer(reviewEntry, onSaved) {
    _editEntry = reviewEntry || null;
    _onSaved   = onSaved || null;

    // Title
    if (titleEl) titleEl.textContent = _editEntry ? 'Rezension bearbeiten' : 'Wie war dein Tag?';

    // Date
    if (dateEl) {
      if (_editEntry && _editEntry.date) {
        const d = new Date(_editEntry.date + 'T00:00:00');
        dateEl.textContent = d.toLocaleDateString('de-DE', {
          weekday: 'long', day: 'numeric', month: 'long'
        });
      } else {
        const d = new Date(getLogicalDate() + 'T00:00:00');
        dateEl.textContent = d.toLocaleDateString('de-DE', {
          weekday: 'long', day: 'numeric', month: 'long'
        });
      }
    }

    // Pre-fill stars + textarea when editing
    selectedRating = _editEntry ? _editEntry.rating : 0;
    paintStars(selectedRating);
    textarea.value = _editEntry ? (_editEntry.text || '') : '';
    submitBtn.disabled = _editEntry ? false : true;
    submitBtn.textContent = 'Speichern';
    submitBtn.style.background = '';
    submitBtn.style.color = '';

    applyAccent();

    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('review-write-drawer-open');

    // Register close handlers
    _escHandler = function(e) {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
        e.preventDefault();
        e.stopPropagation();
        closeDrawer();
      }
    };
    _clickOutHandler = function(e) {
      if (!drawer.contains(e.target) && !e.target.closest('.reviews-new-btn')) {
        closeDrawer();
      }
    };
    document.addEventListener('keydown', _escHandler, true);
    // Use a tiny timeout so the opening click doesn't immediately trigger close
    setTimeout(function() {
      document.addEventListener('click', _clickOutHandler, true);
    }, 50);

    if (textarea) setTimeout(function() { textarea.focus(); }, 100);
  }

  // Raw DOM close — does NOT save. Called internally after save completes.
  function closeDrawerNow() {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('review-write-drawer-open');

    if (_escHandler) {
      document.removeEventListener('keydown', _escHandler, true);
      _escHandler = null;
    }
    if (_clickOutHandler) {
      document.removeEventListener('click', _clickOutHandler, true);
      _clickOutHandler = null;
    }
  }

  // Public close — auto-saves pending changes first.
  function closeDrawer() {
    if (selectedRating > 0 &&
        !(submitBtn.disabled && submitBtn.textContent === '…') &&
        submitBtn.textContent !== '✓ Gespeichert') {
      doSave({ silent: true });
    } else {
      closeDrawerNow();
    }
  }

  window.openReviewWriteDrawer  = openDrawer;
  window.closeReviewWriteDrawer = closeDrawer;

  closeBtn.addEventListener('click', closeDrawer);

  // ── Star interaction ─────────────────────────────────────────
  const stars = Array.from(starRow.querySelectorAll('.journal-star'));

  function paintStars(upTo) {
    stars.forEach(function(s, i) {
      s.classList.toggle('selected', i < upTo);
      s.classList.toggle('hovered', i < upTo);
    });
  }

  starRow.addEventListener('mousemove', function(e) {
    const s = e.target.closest('.journal-star');
    if (!s) return;
    const val = Number(s.dataset.val);
    stars.forEach(function(st, i) {
      st.classList.toggle('hovered', i < val);
      st.classList.remove('selected');
    });
  });

  starRow.addEventListener('mouseleave', function() {
    stars.forEach(function(s, i) {
      s.classList.remove('hovered');
      s.classList.toggle('selected', i < selectedRating);
    });
  });

  starRow.addEventListener('click', function(e) {
    const s = e.target.closest('.journal-star');
    if (!s) return;
    selectedRating = Number(s.dataset.val);
    paintStars(selectedRating);
    submitBtn.disabled = false;
  });

  // ── Save logic (shared by submit button and auto-save on close) ─
  async function doSave(opts) {
    // opts.silent = true → save quietly (no UI feedback, close immediately after)
    const silent = opts && opts.silent;
    if (!selectedRating) return;
    if (submitBtn.disabled && submitBtn.textContent === '…') return; // already saving

    submitBtn.disabled = true;
    if (!silent) submitBtn.textContent = '…';

    try {
      let res;
      if (_editEntry) {
        res = await fetch('/api/journal/' + _editEntry.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: selectedRating, text: textarea.value.trim() })
        });
      } else {
        res = await fetch('/api/journal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: selectedRating, text: textarea.value.trim(), date: getLogicalDate() })
        });
      }

      if (!res.ok) {
        const err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'Fehler beim Speichern');
      }

      const savedCallback = _onSaved;

      // A brand-new review is dated today, so today's reminder is satisfied.
      // Editing an existing one says nothing about today.
      if (!_editEntry && typeof window.markJournalEntrySaved === 'function') {
        window.markJournalEntrySaved();
      }

      if (silent) {
        closeDrawerNow();
        if (typeof savedCallback === 'function' &&
            typeof currentWorkspaceMode !== 'undefined' &&
            currentWorkspaceMode === 'reviews') {
          savedCallback();
        } else if (typeof renderReviewsPage === 'function' &&
            typeof currentWorkspaceMode !== 'undefined' &&
            currentWorkspaceMode === 'reviews') {
          renderReviewsPage();
        }
      } else {
        const ac = (typeof currentAccentColor !== 'undefined' && currentAccentColor)
          ? currentAccentColor : '#ffcc00';
        submitBtn.textContent = '✓ Gespeichert';
        submitBtn.style.background = ac;
        submitBtn.style.color = '#111';

        setTimeout(function() {
          closeDrawerNow();
          if (typeof savedCallback === 'function' &&
              typeof currentWorkspaceMode !== 'undefined' &&
              currentWorkspaceMode === 'reviews') {
            savedCallback();
          } else if (typeof renderReviewsPage === 'function' &&
              typeof currentWorkspaceMode !== 'undefined' &&
              currentWorkspaceMode === 'reviews') {
            renderReviewsPage();
          }
        }, 1000);
      }

    } catch (e) {
      // Queue offline if network is unavailable
      if (window.offlineOutbox && typeof window.isAppOnline === 'function' && !window.isAppOnline()) {
        const offlineUrl = _editEntry ? '/api/journal/' + _editEntry.id : '/api/journal';
        const offlineMethod = _editEntry ? 'PUT' : 'POST';
        const offlineBody = _editEntry
          ? JSON.stringify({ rating: selectedRating, text: textarea.value.trim() })
          : JSON.stringify({ rating: selectedRating, text: textarea.value.trim(), date: getLogicalDate() });
        window.offlineOutbox.queue({ url: offlineUrl, method: offlineMethod, headers: { 'Content-Type': 'application/json' }, body: offlineBody });
        console.log('📥 Journal save queued offline');
        if (!silent) { submitBtn.textContent = '⏳ Offline gespeichert'; setTimeout(function() { closeDrawerNow(); }, 1200); }
        else { closeDrawerNow(); }
        return;
      }
      if (!silent) {
        submitBtn.textContent = e.message;
        submitBtn.style.background = '#c0392b';
        submitBtn.style.color = '#fff';
        submitBtn.disabled = false;
        setTimeout(function() {
          submitBtn.textContent = 'Speichern';
          submitBtn.style.background = '';
          submitBtn.style.color = '';
          applyAccent();
        }, 2500);
      } else {
        // silent save failed — still close, don't leave drawer stuck open
        closeDrawerNow();
      }
    }
  }

  // ── Submit ───────────────────────────────────────────────────
  submitBtn.addEventListener('click', function() {
    doSave({ silent: false });
  });

})();