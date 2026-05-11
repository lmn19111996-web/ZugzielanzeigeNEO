// === JOURNAL ISLAND & REVIEW WRITE DRAWER ===
//  Journal Island Widget
// ══════════════════════════════════════════════════════════════
(function initJournalIsland() {
  const island   = document.getElementById('journal-island');
  const card     = document.getElementById('journal-card');
  const closeBtn = document.getElementById('journal-card-close');
  const starRow  = document.getElementById('journal-star-row');
  const textarea = document.getElementById('journal-text');
  const submitBtn = document.getElementById('journal-submit');
  const toast    = document.getElementById('journal-card-toast');
  const dateEl   = document.getElementById('journal-card-date');

  if (!island || !card) return;

  // Hidden by default; updateJournalIslandVisibility() reveals it once the
  // correct workspace mode is active and no entry exists for today.
  island.style.display = 'none';

  let selectedRating = 0;
  let islandDone = false; // permanently hidden after today's submit

  // ── Logical day: 06:00 – 05:59 next day ─────────────────────
  function getLogicalDate() {
    const d = new Date();
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }

  // ── Accent color applied when card opens ─────────────────────
  function applyAccentToCard() {
    const ac = (typeof currentAccentColor !== 'undefined' && currentAccentColor)
      ? currentAccentColor : '#ffcc00';
    const hdr = card.querySelector('.journal-card-header');
    if (hdr) hdr.style.borderBottomColor = ac;
    if (textarea) textarea.style.borderColor = ac;
    if (submitBtn) submitBtn.style.background = ac;
  }

  // ── Reminder mode: 21:00–05:59 always expands label ─────────
  function updateReminderMode() {
    const h = new Date().getHours();
    island.classList.toggle('is-reminder', h >= 21 || h < 6);
  }
  updateReminderMode();
  setInterval(updateReminderMode, 60000);

  // ── Workspace visibility ─────────────────────────────────────
  window.updateJournalIslandVisibility = function(wsMode) {
    if (islandDone) return;
    island.style.display = (wsMode === 'list' || wsMode === 'occupancy') ? '' : 'none';
  };

  // ── Check if entry already exists for today ──────────────────
  (async function initIslandState() {
    try {
      const res  = await fetch('/api/journal');
      const data = await res.json();
      const today = getLogicalDate();
      const exists = (data.reviews || []).some(function(rv) { return rv.date === today; });
      if (exists) {
        islandDone = true;
        island.style.display = 'none';
      }
    } catch (e) { /* silent */ }
  })();

  // ── Open / close card ────────────────────────────────────────
  function openCard() {
    island.classList.add('island-hidden');
    card.classList.add('is-open');
    card.setAttribute('aria-hidden', 'false');
    if (dateEl) {
      const d = new Date();
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      dateEl.textContent = d.toLocaleDateString('de-DE', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
    }
    applyAccentToCard();
    textarea.focus();
  }

  function closeCard() {
    card.classList.remove('is-open');
    card.setAttribute('aria-hidden', 'true');
    if (!islandDone) {
      setTimeout(function() { island.classList.remove('island-hidden'); }, 180);
    }
  }

  island.addEventListener('click', openCard);
  closeBtn.addEventListener('click', closeCard);

  document.addEventListener('click', function(e) {
    if (card.classList.contains('is-open') && !card.contains(e.target)
        && e.target !== island && !island.contains(e.target)) {
      closeCard();
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && card.classList.contains('is-open')) closeCard();
  });

  // ── Star interaction ─────────────────────────────────────────
  const stars = Array.from(starRow.querySelectorAll('.journal-star'));

  function paintStars(upTo) {
    stars.forEach(function(s, i) {
      s.classList.toggle('hovered', i < upTo);
      s.classList.toggle('selected', i < upTo);
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

  // ── Submit ───────────────────────────────────────────────────
  submitBtn.addEventListener('click', async function() {
    if (!selectedRating) return;
    submitBtn.disabled = true;
    submitBtn.textContent = '…';

    const today = getLogicalDate();

    try {
      const res = await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: selectedRating, text: textarea.value.trim(), date: today })
      });

      if (!res.ok) {
        const err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'Fehler beim Speichern');
      }

      // Transition button to success state (same accent color as card)
      const successColor = (typeof currentAccentColor !== 'undefined' && currentAccentColor)
        ? currentAccentColor : '#ffcc00';
      submitBtn.textContent = '✓ Gespeichert';
      submitBtn.style.background = successColor;
      submitBtn.style.color = '#111';
      islandDone = true;

      setTimeout(function() {
        closeCard();
        island.style.display = 'none';
      }, 1200);

    } catch (e) {
      // Show error briefly in button, then reset
      submitBtn.textContent = e.message;
      submitBtn.style.background = '#c0392b';
      submitBtn.style.color = '#fff';
      submitBtn.disabled = false;
      setTimeout(function() {
        submitBtn.textContent = 'Speichern';
        submitBtn.style.background = '';
        submitBtn.style.color = '';
        submitBtn.disabled = false;
      }, 2500);
    }
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

  function getLogicalDate() {
    const d = new Date();
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }

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
        const d = new Date();
        if (d.getHours() < 6) d.setDate(d.getDate() - 1);
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
        e.stopPropagation();
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

  function closeDrawer() {
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

  // ── Submit ───────────────────────────────────────────────────
  submitBtn.addEventListener('click', async function() {
    if (!selectedRating) return;
    submitBtn.disabled = true;
    submitBtn.textContent = '…';

    try {
      let res;
      if (_editEntry) {
        // Update existing review
        res = await fetch('/api/journal/' + _editEntry.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: selectedRating, text: textarea.value.trim() })
        });
      } else {
        // Create new review
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

      const ac = (typeof currentAccentColor !== 'undefined' && currentAccentColor)
        ? currentAccentColor : '#ffcc00';
      submitBtn.textContent = '✓ Gespeichert';
      submitBtn.style.background = ac;
      submitBtn.style.color = '#111';

      const savedCallback = _onSaved;
      setTimeout(function() {
        closeDrawer();
        if (typeof savedCallback === 'function') {
          savedCallback();
        } else if (typeof renderReviewsPage === 'function' &&
            typeof currentWorkspaceMode !== 'undefined' &&
            currentWorkspaceMode === 'reviews') {
          renderReviewsPage();
        }
      }, 1000);

    } catch (e) {
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
    }
  });

})();