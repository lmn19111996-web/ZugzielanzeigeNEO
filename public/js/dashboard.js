// === STATIC DASHBOARD MODE (Abfahrtstafel) ===
// Triggered with Ctrl+L. Exit by pressing Ctrl+L twice (hold Ctrl, press L twice within 500ms).

(function () {
  let dashboardOpen = false;
  let dashboardClockInterval = null;
  let lastCtrlLTime = 0;

  function isSBahnLike(linie) {
    if (typeof linie !== 'string') return false;
    return /^S\d+/i.test(linie) || linie.toUpperCase() === 'FEX' || /^\d+$/.test(linie);
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

  function renderDashboard() {
    const grid = document.getElementById('dashboard-rows-grid');
    if (!grid) return;
    const now = new Date();

    // Station name
    const stationEl = document.getElementById('dashboard-station-name');
    if (stationEl) stationEl.textContent = currentStationName || 'Meine Fahrten';

    // Clock
    updateDashboardClock();

    // Build departure rows
    const trains = (processedTrainData.futureTrains || []).slice(0, 10);
    const rowsHTML = trains.map(t => buildRow(t, now)).join('');
    const emptyCount = Math.max(0, 10 - trains.length);
    const emptyHTML = Array.from({ length: emptyCount }, buildEmptyRow).join('');

    // Replace existing departure rows
    grid.querySelectorAll('.departure-row').forEach(r => r.remove());
    grid.insertAdjacentHTML('beforeend', rowsHTML + emptyHTML);

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

  function startMarquee(span, scrollDist) {
    const SPEED = 40; // px per second (slow scroll)
    const PAUSE = 3000; // ms pause at start and end
    const scrollDuration = Math.round((scrollDist / SPEED) * 1000);
    let cancelled = false;
    let timers = [];

    span._marqueeCancel = function() {
      cancelled = true;
      timers.forEach(clearTimeout);
      span.style.transition = 'none';
      span.style.transform = '';
    };

    function cycle() {
      if (cancelled || !span.isConnected) return;
      // Step 1: jump to start (no transition), pause 1s
      span.style.transition = 'none';
      span.style.transform = 'translateX(0)';
      timers.push(setTimeout(() => {
        if (cancelled || !span.isConnected) return;
        // Step 2: scroll to end
        span.style.transition = `transform ${scrollDuration}ms linear`;
        span.style.transform = `translateX(-${scrollDist}px)`;
        timers.push(setTimeout(() => {
          if (cancelled || !span.isConnected) return;
          // Step 3: pause at end 1s, then restart
          timers.push(setTimeout(cycle, PAUSE));
        }, scrollDuration));
      }, PAUSE));
    }

    cycle();
  }

  function openDashboard() {
    if (dashboardOpen) return;
    dashboardOpen = true;
    const overlay = document.getElementById('dashboard-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    renderDashboard();
    dashboardClockInterval = setInterval(updateDashboardClock, 1000);
  }

  // Expose so renderCurrentWorkspaceView can trigger a dashboard refresh
  window.renderDashboardIfOpen = function () {
    if (dashboardOpen) renderDashboard();
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
}());
