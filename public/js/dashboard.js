// === STATIC DASHBOARD MODE (Abfahrtstafel) ===
// Open: Ctrl+L or badge-menu button. Auto-opens on startup.
// Exit: hold Ctrl, press L twice within 500 ms.

(function () {
  let dashboardOpen = false;
  let dashboardClockInterval = null;
  let lastCtrlLTime = 0;

  // Use the shared selectedEva/selectedStationName localStorage keys as the single source of truth.
  // These are never removed when switching to personal mode — only stationMode changes.
  function getDisplayStation() {
    return localStorage.getItem('selectedStationName') || 'Abfahrt';
  }
  function getDisplayEva() {
    return localStorage.getItem('selectedEva') || null;
  }

  function isSBahnLike(linie) {
    if (typeof linie !== 'string') return false;
    return /^S\d+/i.test(linie) || linie.toUpperCase() === 'FEX' || linie.toUpperCase() === 'SEV' || /^\d+$/.test(linie);
  }

  function getViaText(train) {
    const zh = train.zwischenhalte;
    if (!zh) return '';
    if (Array.isArray(zh)) return zh.filter(s => s && s.trim()).join(' – ');
    return String(zh).replace(/\n/g, ' – ');
  }

  function buildRow(train, now) {
    const isCancelled = !!train.canceled;
    const delay = isCancelled ? 0 : getDelay(train.plan, train.actual, now, train.date);
    const isDelayed = !isCancelled && !!train.actual && train.actual !== train.plan && delay > 0;
    const tTime = parseTime(train.actual || train.plan, now, train.date);
    const occEnd = getOccupancyEnd(train, now);
    const isOccupying = !isCancelled && tTime && occEnd && tTime <= now && occEnd > now;

    const rowClass = 'departure-row' + (isCancelled ? ' cancelled' : '');
    const dotClass = 'indicator-dot' + (isCancelled ? ' cancelled' : (isOccupying ? ' current' : ''));

    const linie = train.linie || '—';
    let badgeHTML;
    if (isSBahnLike(train.linie)) {
      badgeHTML = `<img class="train-symbol" src="res/${linie.toLowerCase()}.svg" alt="${linie}" onerror="this.outerHTML='<div class=\\'line-badge line-badge--pill\\'>${linie}</div>'">`;
    } else {
      badgeHTML = `<div class="line-badge">${linie}</div>`;
    }

    const viaText = getViaText(train);
    const dest = (train.ziel || '').replace(/^\[ZF\]\s*/, '');

    return `<div class="${rowClass}">
      <div class="col-dot dep-dot"><div class="${dotClass}"></div></div>
      <div class="col-time dep-time">
        ${badgeHTML}
        <div class="time-row">
          <span class="dep-sched">${train.plan || '—'}</span>
          ${isDelayed ? `<span class="dep-delayed">${train.actual}</span>` : ''}
        </div>
      </div>
      <div class="col-destination dep-destination">
        <div class="via-stops"><span class="via-scroll-text" data-via="${viaText.replace(/"/g, '&quot;')}">${viaText}</span></div>
        <div class="dest-name">${dest || '—'}</div>
      </div>
      <div class="col-platform dep-platform${train.platformChanged ? ' platform-changed' : ''}">${train.platform || '—'}</div>
    </div>`;
  }

  function buildEmptyRow() {
    return `<div class="departure-row">
      <div class="col-dot dep-dot"></div>
      <div class="col-time dep-time dep-empty"></div>
      <div class="col-destination dep-destination dep-empty"></div>
      <div class="col-platform dep-platform dep-empty"></div>
    </div>`;
  }

  function updateDashboardClock() {
    const clockEl = document.getElementById('dashboard-clock');
    const hourEl = document.getElementById('dashboard-hour');
    const minuteEl = document.getElementById('dashboard-minute');
    if (!clockEl) return;
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    clockEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    const hourDeg = (h % 12) * 30 + m * 0.5;
    const minuteDeg = m * 6 + s * 0.1;
    if (hourEl) hourEl.style.transform = `translateX(-50%) rotate(${hourDeg}deg)`;
    if (minuteEl) minuteEl.style.transform = `translateX(-50%) rotate(${minuteDeg}deg)`;
  }

  // trains must always be an explicit array; never reads processedTrainData directly here
  function renderDashboard(trains) {
    const grid = document.getElementById('dashboard-rows-grid');
    if (!grid) return;
    const now = new Date();

    // Station name
    const stationEl = document.getElementById('dashboard-station-name');
    if (stationEl) stationEl.textContent = getDisplayStation();

    // Clock
    updateDashboardClock();

    const trainList = (trains || []);
    const trains_ = trainList;
    const rowsHTML = trains_.map(t => buildRow(t, now)).join('');

    // Replace existing departure rows
    grid.querySelectorAll('.departure-row').forEach(r => r.remove());
    grid.insertAdjacentHTML('beforeend', rowsHTML);

    // Apply scrolling to via-stops that overflow their container
    requestAnimationFrame(() => applyViaScrolling(grid));
  }

  function applyViaScrolling(grid) {
    grid.querySelectorAll('.via-scroll-text').forEach(span => {
      // Cancel any running marquee cycle on this span
      if (typeof span._marqueeCancel === 'function') span._marqueeCancel();

      const container = span.parentElement;
      if (!container) return;
      const originalText = span.dataset.via || '';
      if (!originalText) return;

      // Reset to plain text and measure overflow
      span.style.transition = 'none';
      span.style.transform = '';
      span.textContent = originalText;

      const scrollDist = span.scrollWidth - container.clientWidth;
      if (scrollDist <= 0) return;

      // Mark with +++ at start and end
      span.textContent = `+++ ${originalText} +++`;
      const markedScrollDist = span.scrollWidth - container.clientWidth;

      startMarquee(span, markedScrollDist);
    });
  }

  // startMarquee extracted to utils.js (window.startMarquee) so other tickers
  // (e.g. the cancel-notice-tag in render-trains.js) can reuse it.

  function fetchAndRender(eva) {
    renderDashboard([]);
    fetch(`/api/db-departures?eva=${encodeURIComponent(eva)}`)
      .then(r => r.ok ? r.json() : Promise.reject('not ok'))
      .then(data => {
        if (!dashboardOpen) return;
        const trains = (data.trains || [])
          .filter(t => t.ziel !== 'Ankunft')
          .map(t => {
            const n = { ...t, source: 'db-api' };
            if (t.stops && !t.zwischenhalte) { n.zwischenhalte = t.stops; delete n.stops; }
            return n;
          });
        renderDashboard(trains);
      })
      .catch(() => { if (dashboardOpen) renderDashboard([]); });
  }

  function openDashboard() {
    if (dashboardOpen) return;
    dashboardOpen = true;
    history.pushState({ dashboardOpen: true }, '');
    const overlay = document.getElementById('dashboard-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    dashboardClockInterval = setInterval(updateDashboardClock, 1000);

    // Persist current real station (if any) so subsequent opens remember it — handled by station.js/chooseLive now
    if (isRealStation()) {
      renderDashboard(processedTrainData.futureTrains || []);
      return;
    }

    if (currentStationName) {
      // Station selected but no usable EVA — show empty
      renderDashboard([]);
      return;
    }

    // Pure personal-timetable mode (no station selected): fetch for last real station, or show empty
    const lastEva = getDisplayEva();
    if (lastEva) {
      fetchAndRender(lastEva);
    } else {
      renderDashboard([]);
    }
  }

  // Expose so renderCurrentWorkspaceView can trigger a dashboard refresh
  window.renderDashboardIfOpen = function () {
    if (!dashboardOpen) return;
    if (isRealStation()) {
      renderDashboard(processedTrainData.futureTrains || []);
    } else if (currentStationName) {
      // Station selected but no usable EVA — clear the board immediately
      renderDashboard([]);
    }
    // Pure personal-timetable mode: do not refresh (last fetch result stays until next open)
  };

  function closeDashboard() {
    if (!dashboardOpen) return;
    dashboardOpen = false;
    const overlay = document.getElementById('dashboard-overlay');
    if (overlay) overlay.style.display = 'none';
    if (dashboardClockInterval) {
      clearInterval(dashboardClockInterval);
      dashboardClockInterval = null;
    }
  }

  // Ctrl+L → open. While open: first Ctrl+L arms exit, second Ctrl+L within 500 ms closes.
  // Ctrl+F while open → open station selection overlay.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F') && dashboardOpen) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof showStationOverlay === 'function') showStationOverlay();
      return;
    }
    if (!e.ctrlKey || (e.key !== 'l' && e.key !== 'L')) return;
    e.preventDefault();
    if (!dashboardOpen) {
      openDashboard();
    } else {
      const now = Date.now();
      if (now - lastCtrlLTime <= 500) {
        closeDashboard();
        lastCtrlLTime = 0;
      } else {
        lastCtrlLTime = now;
      }
    }
  });

  // Expose for startup call and badge dropdown button
  window.openDashboardMode  = openDashboard;
  window.closeDashboardMode = closeDashboard;

  // Browser back button exits dashboard mode
  window.addEventListener('popstate', function (e) {
    if (dashboardOpen) {
      closeDashboard();
    }
  });
}());
