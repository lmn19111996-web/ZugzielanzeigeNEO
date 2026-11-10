// === WELCOME RIBBON ===
// Greeting shown (a) the first time the startup Abfahrtstafel is closed and
// (b) when the user returns to the app after being away for AWAY_MS (window
// unfocused/hidden). dashboard.js reports every close via window.welcomeRibbonDashboardClosed.
//
// Sequence: full-width ribbon slides down from the top edge with a
// time-of-day greeting (see GREETINGS), its accent bar sweeps in underneath, then the text
// rolls up and the current headline train (a live clone of the top ribbon's
// .train-entry) rolls in. After a few seconds the ribbon slides back out.
// Purely decorative: pointer-events are off, so it never blocks the UI below.

(function () {
  const T_ENTER = 450;      // slide-in duration (keep in sync with CSS)
  const T_GREETING = 1800;  // how long the greeting holds before the train rolls in
  const T_TRAIN = 4000;     // how long the train holds before sliding out
  const T_EXIT = 450;       // slide-out duration (keep in sync with CSS)

  // Returning after being away (other window / hidden) at least this long
  // greets automatically the moment the app is focused again.
  const AWAY_MS = 120 * 60 * 1000;

  let active = false;         // a ribbon is currently on screen
  let pendingReturn = false;  // returned while the Abfahrtstafel was open
  let awaySince = document.hidden || !document.hasFocus() ? Date.now() : null;

  // Greeting pools by time of day; one is picked at random each time.
  // [fromHour, toHour) — the night slot wraps past midnight.
  const GREETINGS = [
    { from: 5,  to: 11, lines: ['Guten Morgen!', 'Willkommen zurück!', 'Frisch in den Tag!', 'SERVUSSS!', 'Breakfast cookie?', 'Today\'s mission: Flirt with strangers'] },
    { from: 11, to: 14, lines: ['Guten Tag!', 'Mahlzeit!', 'Willkommen zurück!', 'Halbzeit - weiter geht\'s!','Geh essen, falls noch nicht passiert!'] },
    { from: 14, to: 18, lines: ['Guten Tag!', 'Willkommen zurück!', 'Weiter geht\'s!', 'Auf in den Nachmittag!'] },
    { from: 18, to: 22, lines: ['Guten Abend!', 'Willkommen zurück!', 'Schönen Feierabend!', 'Noch eine Runde?'] },
    { from: 22, to: 5,  lines: ['Gute Nacht… oder doch nicht?', 'Noch wach?', 'Nachtschicht!', 'Willkommen zurück, Nachteule!'] }
  ];

  function pickGreeting(now = new Date()) {
    const h = now.getHours();
    const slot = GREETINGS.find(s => s.from < s.to ? (h >= s.from && h < s.to) : (h >= s.from || h < s.to));
    const lines = slot ? slot.lines : ['Willkommen zurück!'];
    return lines[Math.floor(Math.random() * lines.length)];
  }

  function cloneHeadlineEntry() {
    const src = document.querySelector('#first-train-container .train-entry');
    if (!src) return null;
    const clone = src.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    return { src, clone };
  }

  function accentBackground(entry) {
    const linie = entry && entry.dataset ? entry.dataset.linie : '';
    if (!linie) return 'var(--color-nav-accent, var(--color-accent-primary))';
    if (typeof hasSpecialLineGradient === 'function' && hasSpecialLineGradient(linie)) {
      return getLineGradient(linie, 'to right');
    }
    return typeof getLineColor === 'function' ? getLineColor(linie) : 'var(--color-accent-primary)';
  }

  // Mirror the headline countdown into the clone (clock.js only updates the
  // original inside #first-train-container).
  function syncCountdown(src, clone) {
    const a = src.querySelector('[data-departure]');
    const b = clone.querySelector('[data-departure]');
    if (!a || !b) return;
    const aElapsed = a.querySelector('.countdown-elapsed-time');
    const bElapsed = b.querySelector('.countdown-elapsed-time');
    if (aElapsed && bElapsed) {
      // Only touch the digits so the laufend/elapsed cross-fade keeps running.
      if (bElapsed.textContent !== aElapsed.textContent) bElapsed.textContent = aElapsed.textContent;
    } else if (b.innerHTML !== a.innerHTML) {
      b.innerHTML = a.innerHTML;
    }
  }

  function showWelcomeRibbon() {
    if (active) return;
    active = true;
    pendingReturn = false;

    const headline = cloneHeadlineEntry();
    const ribbon = document.createElement('div');
    ribbon.className = 'welcome-ribbon';
    ribbon.setAttribute('role', 'status');
    ribbon.setAttribute('aria-live', 'polite');
    ribbon.innerHTML = `
      <div class="welcome-ribbon-stage">
        <div class="welcome-ribbon-slide welcome-ribbon-greeting"></div>
        <div class="welcome-ribbon-slide welcome-ribbon-train"></div>
      </div>
      <div class="welcome-ribbon-bar"></div>`;
    ribbon.querySelector('.welcome-ribbon-greeting').textContent = pickGreeting();
    ribbon.querySelector('.welcome-ribbon-bar').style.background = accentBackground(headline && headline.src);
    if (headline) ribbon.querySelector('.welcome-ribbon-train').appendChild(headline.clone);
    document.body.appendChild(ribbon);

    const timers = [];
    let syncInterval = null;
    let leaving = false;

    function leave() {
      if (leaving) return;
      leaving = true;
      timers.forEach(clearTimeout);
      if (syncInterval) clearInterval(syncInterval);
      ribbon.classList.remove('is-in');
      ribbon.classList.add('is-out');
      setTimeout(() => { ribbon.remove(); active = false; }, T_EXIT + 50);
    }

    // Force a layout so the initial off-screen transform is committed before
    // the transition class lands.
    void ribbon.offsetHeight;
    requestAnimationFrame(() => ribbon.classList.add('is-in'));

    if (!headline) {
      timers.push(setTimeout(leave, T_ENTER + T_GREETING + 1200));
      return;
    }

    timers.push(setTimeout(() => {
      ribbon.classList.add('show-train');
      syncCountdown(headline.src, headline.clone);
      syncInterval = setInterval(() => {
        if (!headline.src.isConnected) return; // headline re-rendered; keep last state
        syncCountdown(headline.src, headline.clone);
      }, 1000);
      // Restart tickers on the clone (marquee state lives on the original spans).
      requestAnimationFrame(() => {
        const slide = ribbon.querySelector('.welcome-ribbon-train');
        if (typeof applyZugzielScrolling === 'function') applyZugzielScrolling(slide);
        if (typeof applyCancelNoticeScrolling === 'function') applyCancelNoticeScrolling(slide);
      });
      timers.push(setTimeout(leave, T_TRAIN));
    }, T_ENTER + T_GREETING));
  }

  function isDashboardOpen() {
    const overlay = document.getElementById('dashboard-overlay');
    return !!overlay && overlay.style.display !== 'none' && overlay.style.display !== '';
  }

  function onReturn() {
    if (isDashboardOpen()) { pendingReturn = true; return; } // greet once the board closes
    showWelcomeRibbon();
  }

  // ── Away/back detection ───────────────────────────────────────────────────
  // "Away" starts when the window loses focus or the page is hidden (other
  // window, minimised, fully covered, screen locked). "Back" is when it is
  // visible AND focused again — the greeting plays right then, no input needed.
  // Date.now() keeps counting through system sleep, so standby is covered.
  function isPresent() {
    return !document.hidden && document.hasFocus();
  }

  function markAway() {
    if (awaySince === null) awaySince = Date.now();
  }

  function checkBack() {
    if (!isPresent() || awaySince === null) return;
    const now = Date.now();
    const awayFor = now - awaySince;
    awaySince = null;
    if (awayFor >= AWAY_MS) onReturn();
  }

  window.addEventListener('blur', markAway);
  window.addEventListener('focus', checkBack);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markAway(); else checkBack();
  });

  // Called by dashboard.js whenever the Abfahrtstafel closes.
  window.welcomeRibbonDashboardClosed = function (openedAtStartup) {
    if (openedAtStartup || pendingReturn) showWelcomeRibbon();
  };

  window.showWelcomeRibbon = showWelcomeRibbon;
}());
