// === STRESSMETER UI ===
// Today + 13 days forward (14 days total). Fixed Y-axis; chart scrolls.
// Depends on: stressmeter-engine.js, utils.js (getLineColor), globals.js

(function initStressmeter () {
  'use strict';

  // ── Chart constants ───────────────────────────────────────────────────────
  var DAYS      = 14;    // today + 13 future
  var TODAY_IDX = 0;     // today is column 0
  var L_YAXIS   = 52;    // width of fixed Y-axis SVG (must match CSS margin-left)
  var R         = 16;    // right pad in scrollable SVG
  var T         = 30;    // top pad (date labels + day/night header)
  var B         = 34;    // bottom pad (x-axis labels)
  var Y_MAX     = 1500;
  var Y_MIN     = 0;
  var Y_RANGE   = Y_MAX - Y_MIN;
  var IDLE_C    = 'rgba(156,163,175,1.0)';
  // Snap-to-boundary tolerance: within this many px of a task boundary the cursor snaps to it
  var SNAP_PX   = 12;
  // Override-point hit tolerance in px (radial distance from marker center)
  var OVERRIDE_HIT_PX = 14;
  // Font for all SVG text
  var SVG_FONT  = "'Bahnschrift', 'Bahnschrift Condensed', 'Arial Narrow', sans-serif";

  // ── State ─────────────────────────────────────────────────────────────────
  var dashboardOpen    = false;
  var lastBadgeMinute  = -1;
  var _hoverRaf        = null;   // rAF handle for tooltip throttle
  var _lastHoverE      = null;   // cached mousemove event for rAF
  var _lastHoverPoint  = null;   // { dateStr, minute, E }
  var manualEOverrides = {};     // { 'YYYY-MM-DD': { minute: E, ... }, ... }
  var _pinnedOverridePoint = null; // { dateStr, minute }
  var _skipAutoTooltip  = false;   // flag to suppress auto-pinned tooltip after setting override
  var _graphRenderCache = { key: '', svgMarkup: '' };
  var _nowLineEl = null;

  // Load overrides from localStorage
  function loadOverridesFromStorage() {
    try {
      var stored = localStorage.getItem('stressmeter_manual_overrides');
      if (stored) manualEOverrides = JSON.parse(stored);
    } catch (e) { /* ignore storage errors */ }
  }

  // Save overrides to localStorage
  function saveOverridesToStorage() {
    try {
      localStorage.setItem('stressmeter_manual_overrides', JSON.stringify(manualEOverrides));
    } catch (e) { /* ignore storage errors */ }
  }

  loadOverridesFromStorage();

  // ── DOM ───────────────────────────────────────────────────────────────────
  var badge        = document.getElementById('stressmeter-badge');
  var dashboard    = document.getElementById('stress-dashboard');
  var scrollWrap   = document.getElementById('sg-scroll-wrap');
  var svg          = document.getElementById('stress-svg');
  var yAxisSvg     = document.getElementById('sg-yaxis');
  var tooltipEl    = document.getElementById('sg-tooltip');
  var tipDate      = document.getElementById('sg-tip-date');
  var tipTime      = document.getElementById('sg-tip-time');
  var tipEnergy    = document.getElementById('sg-tip-energy');
  var tipOverrideActions = document.getElementById('sg-tip-override-actions');
  var tipOverrideEdit = document.getElementById('sg-tip-override-edit');
  var tipOverrideRemove = document.getElementById('sg-tip-override-remove');
  var tipDelta     = document.getElementById('sg-tip-delta');
  var tipTask      = document.getElementById('sg-tip-task');
  var tipWindow    = document.getElementById('sg-tip-window');
  var tipRate      = document.getElementById('sg-tip-rate');
  var tipFatigue   = document.getElementById('sg-tip-fatigue');
  var tipCircadian = document.getElementById('sg-tip-circadian');
  var tipContext   = document.getElementById('sg-tip-context');
  var tipAlert     = document.getElementById('sg-tip-alert');
  var badgeEdit    = document.getElementById('sg-badge-edit');
  if (!badge || !dashboard || !scrollWrap || !svg || !tooltipEl) return;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

  function offsetDate(base, days) {
    var d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function f(n) { return (+n).toFixed(1); }

  function esc(v) {
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getTrainsForDate(d) {
    return (processedTrainData.allTrains || []).filter(function (t) { return t.date === d; });
  }

  function isOverridePoint(dateStr, minute) {
    return !!(manualEOverrides[dateStr] && manualEOverrides[dateStr][minute] != null);
  }

  function setOverride(dateStr, minute, value) {
    if (!manualEOverrides[dateStr]) manualEOverrides[dateStr] = {};
    manualEOverrides[dateStr][minute] = Math.max(Y_MIN, Math.min(Y_MAX, Number(value)));
    saveOverridesToStorage();
    _pinnedOverridePoint = { dateStr: dateStr, minute: minute };
    _skipAutoTooltip = true;
    lastBadgeMinute = -1;
    updateStressBadge();
    if (dashboardOpen) {
      renderGraph();
      setTimeout(function () { _skipAutoTooltip = false; }, 100);
    }
  }

  function clearOverride(dateStr, minute) {
    if (!manualEOverrides[dateStr]) return;
    delete manualEOverrides[dateStr][minute];
    if (!Object.keys(manualEOverrides[dateStr]).length) delete manualEOverrides[dateStr];
    saveOverridesToStorage();
    if (_pinnedOverridePoint && _pinnedOverridePoint.dateStr === dateStr && _pinnedOverridePoint.minute === minute) {
      _pinnedOverridePoint = null;
    }
    lastBadgeMinute = -1;
    updateStressBadge();
    if (dashboardOpen) renderGraph();
  }

  function openOverridePopup(anchorEl, dateStr, minute, initialE) {
    var existing = document.getElementById('sg-energy-popup');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.id = 'sg-energy-popup';
    popup.className = 'date-jump-popup sg-energy-popup';
    popup.innerHTML =
      '<div class="date-jump-popup-label">Energiepunkt bearbeiten</div>' +
      '<input type="number" class="sg-energy-input" id="sg-energy-input" min="' + Y_MIN + '" max="' + Y_MAX + '" step="1" value="' + Math.round(initialE) + '">' +
      '<div class="date-jump-popup-hint">Enter = speichern, Esc = abbrechen</div>';

    var a = anchorEl.getBoundingClientRect();
    popup.style.top = (a.bottom + 6) + 'px';
    popup.style.left = (a.left - 120) + 'px';
    document.body.appendChild(popup);

    var input = popup.querySelector('#sg-energy-input');
    input.focus();
    input.select();

    function applyAndClose(save) {
      if (save) {
        var v = Number(input.value);
        if (!isNaN(v)) setOverride(dateStr, minute, v);
      }
      popup.remove();
      removeOutsideListener();
    }

    input.addEventListener('keydown', function (e2) {
      if (e2.key === 'Enter') { e2.preventDefault(); applyAndClose(true); }
      if (e2.key === 'Escape') { e2.preventDefault(); applyAndClose(false); }
    });

    function outsideClick(e2) {
      if (!popup.contains(e2.target) && e2.target !== anchorEl) applyAndClose(true);
    }
    function removeOutsideListener() {
      document.removeEventListener('pointerdown', outsideClick, true);
    }
    setTimeout(function () { document.addEventListener('pointerdown', outsideClick, true); }, 0);
  }

  function showPinnedTooltip() {
    if (!_pinnedOverridePoint || !svg._dates || !svg._DAY_W || !dashboardOpen || _skipAutoTooltip) return;
    var wRect = scrollWrap.getBoundingClientRect();
    var colIdx = svg._dates.indexOf(_pinnedOverridePoint.dateStr);
    if (colIdx < 0) return;
    var px = colIdx * svg._DAY_W + (_pinnedOverridePoint.minute / 1440) * svg._DAY_W;
    processHover({
      _forcePoint: { dateStr: _pinnedOverridePoint.dateStr, minute: _pinnedOverridePoint.minute },
      clientX: wRect.left + px - scrollWrap.scrollLeft,
      clientY: wRect.top + T + 18
    });
  }

  function cloneStepsMap(src, dates) {
    var out = {};
    dates.forEach(function (d) {
      var arr = src[d] || [];
      out[d] = arr.map(function (s) { return s ? { ...s } : s; });
    });
    return out;
  }

  function applyManualOverrides(baseMap, dates) {
    var out = cloneStepsMap(baseMap, dates);
   
    dates.forEach(function (d) {
      var steps = out[d];
      if (!steps || !steps.length) return;
     
      // Apply overrides only to the specific minute, no propagation forward
      // Recovery will continue naturally from the next minute
      var dayOverrides = manualEOverrides[d];
      if (dayOverrides) {
        var mins = Object.keys(dayOverrides).map(function (k) { return Number(k); }).filter(function (m) { return !isNaN(m); });
        mins.forEach(function (m) {
          if (m < 0 || m > 1439 || !steps[m]) return;
          var target = Math.max(Y_MIN, Math.min(Y_MAX, Number(dayOverrides[m])));
          if (isNaN(target)) return;
          // Only set this specific minute; don't propagate delta to future minutes
          steps[m].E = target;
        });
      }
    });
   
    return out;
  }

  // Clamps E to [Y_MIN, Y_MAX] then maps to SVG y coordinate
  function yPx(E, H) {
    var e = Math.max(Y_MIN, Math.min(Y_MAX, E));
    return T + (1 - (e - Y_MIN) / Y_RANGE) * (H - T - B);
  }

  function trainSignature(t) {
    if (!t) return '';
    return [
      t._uniqueId || '',
      t.date || '',
      t.plan || '',
      t.actual || '',
      Number(t.dauer) || 0,
      t.linie || '',
      t.canceled ? 1 : 0
    ].join('|');
  }

  function buildGraphRenderKey(today, dayW, height) {
    var version = (typeof schedule !== 'undefined' && schedule && schedule._meta) ? (schedule._meta.version || 0) : 0;
    var trainsSig = (processedTrainData.allTrains || []).map(trainSignature).join('~');
    var overridesSig = JSON.stringify(manualEOverrides || {});
    return [today, dayW, height, version, trainsSig, overridesSig].join('::');
  }

  function ensureNowLine() {
    if (_nowLineEl && _nowLineEl.parentElement) return _nowLineEl;
    var shellEl = scrollWrap.parentElement;
    if (!shellEl) return null;
    _nowLineEl = shellEl.querySelector('.sg-now-line');
    if (!_nowLineEl) {
      _nowLineEl = document.createElement('div');
      _nowLineEl.className = 'sg-now-line';
      shellEl.appendChild(_nowLineEl);
    }
    return _nowLineEl;
  }

  function updateNowLineOverlay(dayW, height) {
    var lineEl = ensureNowLine();
    if (!lineEl) return;
    if (!dashboardOpen) {
      lineEl.style.opacity = '0';
      return;
    }
    var nowD = new Date();
    var nMin = nowD.getHours() * 60 + nowD.getMinutes();
    var x = L_YAXIS + (TODAY_IDX * dayW + (nMin / 1440) * dayW) - scrollWrap.scrollLeft;
    lineEl.style.left = x + 'px';
    lineEl.style.top = (T - 4) + 'px';
    lineEl.style.height = (height - B - T + 8) + 'px';
    lineEl.style.opacity = '0.85';
  }

  function bindSvgInteractionHandlers() {
    svg.removeEventListener('mousemove', onHoverThrottled);
    svg.removeEventListener('mouseleave', onLeave);
    svg.removeEventListener('touchmove', onHoverThrottled);
    svg.removeEventListener('touchend', onLeave);

    svg.addEventListener('mousemove', onHoverThrottled);
    svg.addEventListener('mouseleave', onLeave);
    svg.addEventListener('touchmove', onHoverThrottled, { passive: true });
    svg.addEventListener('touchend', onLeave);
  }

  // ── Badge ─────────────────────────────────────────────────────────────────
  badge.addEventListener('click', toggleDashboard);
  svg.addEventListener('click', onSvgClick);

  if (badgeEdit) {
    badgeEdit.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var now = new Date();
      var dateStr = todayStr();
      var minute = now.getHours() * 60 + now.getMinutes();
      var dates = [dateStr];
      var sMap = getOrComputeAllDaySteps(processedTrainData.allTrains || [], dates, manualEOverrides);
      var step = (sMap[dateStr] || [])[Math.min(1439, minute)];
      var currentE = step ? Math.round(step.E) : Y_MAX;
      openOverridePopup(badgeEdit, dateStr, minute, currentE);
    });
  }

  if (tipOverrideEdit) {
    tipOverrideEdit.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!_lastHoverPoint || !isOverridePoint(_lastHoverPoint.dateStr, _lastHoverPoint.minute)) return;
      openOverridePopup(tipOverrideEdit, _lastHoverPoint.dateStr, _lastHoverPoint.minute, _lastHoverPoint.E);
    });
  }
  if (tipOverrideRemove) {
    tipOverrideRemove.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!_lastHoverPoint) return;
      clearOverride(_lastHoverPoint.dateStr, _lastHoverPoint.minute);
      tooltipEl.classList.remove('show');
    });
  }

  function updateStressBadge() {
    var now    = new Date();
    var minute = now.getHours() * 60 + now.getMinutes();
    if (minute === lastBadgeMinute) return;
    lastBadgeMinute = minute;
    var sMap;
    try {
      var date  = todayStr();
      var datesList = [];
      for (var j = 0; j < DAYS; j++) { datesList.push(offsetDate(date, j)); }
      sMap = getOrComputeAllDaySteps(processedTrainData.allTrains || [], datesList, manualEOverrides);
    } catch (e) { return; }
    var daySteps = sMap[todayStr()] || [];
    var cfg = STRESSMETER_CONFIG;

    // Scan full day to find daily minimum (forecast)
    var minDayE = Infinity;
    for (var m = 0; m < 1440; m++) {
      if (daySteps[m] && daySteps[m].E < minDayE) minDayE = daySteps[m].E;
    }
    if (!isFinite(minDayE)) return;

    var tier, label;
    if      (minDayE >= cfg.STRESS_GREEN)         { tier = 1; label = 'Geringe Auslastung erwartet'; }
    else if (minDayE >= cfg.STRESS_YELLOW)         { tier = 2; label = 'Mittlere Auslastung erwartet'; }
    else if (minDayE >= cfg.OVERLOAD_E_THRESHOLD)  { tier = 3; label = 'Hohe Auslastung erwartet'; }
    else                                           { tier = 4; label = 'Au\u00dfergew\u00f6hnlich hohe Auslastung erwartet'; }

    var iconEl  = document.getElementById('sg-badge-icon');
    var labelEl = document.getElementById('sg-badge-label');
    var numEl   = document.getElementById('sg-badge-num');
    if (iconEl)  iconEl.src         = 'res/auslastung' + tier + '.svg';
    if (labelEl) labelEl.textContent = label;

    var curStep = daySteps[Math.min(minute, 1439)];
    var curE    = curStep ? Math.round(curStep.E) : null;
    if (numEl && curE !== null) {
      numEl.textContent = String(curE);
      // Smooth gradient matching CSS tokens: green(≥700) → yellow(400) → orange(150) → dark-red(0)
      var t1; var r, g, b;
      if (curE >= cfg.STRESS_GREEN) {
        r = 34;  g = 197; b = 94;   // var(--energy-green)  #22c55e
      } else if (curE >= cfg.STRESS_YELLOW) {
        t1 = (curE - cfg.STRESS_YELLOW) / (cfg.STRESS_GREEN - cfg.STRESS_YELLOW);
        r = Math.round(234 + t1 * (34  - 234)); // #eab308 → #22c55e
        g = Math.round(179 + t1 * (197 - 179));
        b = Math.round(8   + t1 * (94  -   8));
      } else if (curE >= cfg.OVERLOAD_E_THRESHOLD) {
        t1 = (curE - cfg.OVERLOAD_E_THRESHOLD) / (cfg.STRESS_YELLOW - cfg.OVERLOAD_E_THRESHOLD);
        r = Math.round(249 + t1 * (234 - 249)); // #f97316 → #eab308
        g = Math.round(115 + t1 * (179 - 115));
        b = Math.round(22  + t1 * (8   -  22));
      } else {
        t1 = curE / cfg.OVERLOAD_E_THRESHOLD;
        r = Math.round(185 + t1 * (249 - 185)); // #b91c1c → #f97316
        g = Math.round(28  + t1 * (115 -  28));
        b = Math.round(28  + t1 * (22  -  28));
      }
      numEl.style.color = 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    var trendEl = document.getElementById('sg-badge-trend');
    if (trendEl && curStep) {
      var recovering = curStep.dE_per_min > 0;
      trendEl.src = recovering ? 'res/doubleup.svg' : 'res/doubledown.svg';
      trendEl.classList.toggle('trend-up',   recovering);
      trendEl.classList.toggle('trend-down', !recovering);
    }

    badge.classList.remove('badge-green', 'badge-yellow', 'badge-orange', 'badge-red');
    badge.classList.add(tier === 1 ? 'badge-green' : tier === 2 ? 'badge-yellow' : tier === 3 ? 'badge-orange' : 'badge-red');
    document.body.classList.toggle('stress-alert', tier === 4);

    if (dashboardOpen && svg._DAY_W && svg._H) {
      updateNowLineOverlay(svg._DAY_W, svg._H);
    }
  }

  // ── Dashboard toggle ──────────────────────────────────────────────────────
  function toggleDashboard() {
    dashboardOpen = !dashboardOpen;
    dashboard.classList.toggle('open', dashboardOpen);
    dashboard.setAttribute('aria-hidden', String(!dashboardOpen));
    badge.setAttribute('aria-expanded', String(dashboardOpen));
    if (dashboardOpen) {
      requestAnimationFrame(function () {
        requestAnimationFrame(renderGraph);
      });
    } else {
      updateNowLineOverlay(svg._DAY_W || Math.max(120, scrollWrap.clientWidth), svg._H || (scrollWrap.clientHeight || 280));
    }
  }

  // ── Fixed Y-axis SVG ──────────────────────────────────────────────────────
  function renderYAxis(H, cfg) {
    if (!yAxisSvg) return;
    var W = L_YAXIS;
    yAxisSvg.setAttribute('width',   W);
    yAxisSvg.setAttribute('height',  H);
    yAxisSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    yAxisSvg.style.width  = W + 'px';
    yAxisSvg.style.height = H + 'px';

    var s = '';
    // no background fill — transparent, blends with chart background

    for (var gv = Y_MIN; gv <= Y_MAX; gv += 150) {
      var gy = f(yPx(gv, H));
      s += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="' +
           (gv % 300 === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)') + '" stroke-width="1"/>';
    }

    var YG = [
      { E: cfg.E_MAX,                lbl: String(cfg.E_MAX),                fill: 'rgba(255,255,255,0.65)' },
      { E: 1250,                     lbl: '1250',                           fill: 'rgba(255,255,255,0.45)' },
      { E: 1000,                     lbl: '1000',                           fill: 'rgba(255,255,255,0.45)' },
      { E: cfg.STRESS_GREEN,         lbl: String(cfg.STRESS_GREEN),         fill: 'rgba(255,255,255,0.65)' },
      { E: cfg.STRESS_YELLOW,        lbl: String(cfg.STRESS_YELLOW),        fill: 'rgba(255,255,255,0.65)' },
      { E: cfg.OVERLOAD_E_THRESHOLD, lbl: String(cfg.OVERLOAD_E_THRESHOLD), fill: 'rgba(255,255,255,0.65)' },
      { E: 0,                        lbl: '0',                              fill: 'rgba(255,255,255,0.45)' },
    ];
    YG.forEach(function (g) {
      if (g.E < Y_MIN || g.E > Y_MAX) return;
      var gy = f(yPx(g.E, H));
      s += '<text x="' + (W - 5) + '" y="' + f(+gy + 5) + '" text-anchor="end" font-size="13" fill="' + g.fill + '" font-family=' + SVG_FONT + '>' + esc(g.lbl) + '</text>';
    });

    s += '<line x1="' + (W - 1) + '" y1="' + T + '" x2="' + (W - 1) + '" y2="' + (H - B) + '" stroke="rgba(255,255,255,0.45)" stroke-width="1.5"/>';

    yAxisSvg.innerHTML = s;
  }

  // ── Build snap-point index for a day ─────────────────────────────────────
  // Returns array of {minute, E, color} for task start/end boundaries.
  function buildSnapPoints(trains, steps) {
    var pts = [];
    var seen = {};
    trains.forEach(function (t) {
      if (t.canceled) return;
      var start = smParseTimeToMinutes(t.actual || t.plan);
      var dur   = Math.max(0, Number(t.dauer) || 0);
      if (start === null || !dur) return;
      var color = (typeof getLineColor === 'function') ? getLineColor(t.linie) : '#888';
      [Math.round(start), Math.round(start + dur)].forEach(function (mn) {
        mn = Math.max(0, Math.min(1439, mn));
        if (seen[mn]) return;
        seen[mn] = true;
        var sv = steps[mn];
        if (!sv) return;
        pts.push({ minute: mn, E: sv.E, color: color });
      });
    });
    return pts;
  }

  // ── Main chart render ─────────────────────────────────────────────────────
  function renderGraph() {
    var savedScroll = scrollWrap.scrollLeft;
    var DAY_W  = Math.max(120, scrollWrap.clientWidth);
    var H      = scrollWrap.clientHeight || 280;
    var DH     = H - T - B;
    var SVG_W  = DAYS * DAY_W + R;
    var today  = todayStr();
    var cfg    = STRESSMETER_CONFIG;

    var dates = [];
    for (var i = 0; i < DAYS; i++) dates.push(offsetDate(today, i));

    var renderKey = buildGraphRenderKey(today, DAY_W, H);

    renderYAxis(H, cfg);

    if (_graphRenderCache.key === renderKey && _graphRenderCache.svgMarkup) {
      svg.setAttribute('width', _graphRenderCache.SVG_W);
      svg.setAttribute('height', H);
      svg.setAttribute('viewBox', '0 0 ' + _graphRenderCache.SVG_W + ' ' + H);
      svg.style.width = _graphRenderCache.SVG_W + 'px';
      svg.style.height = H + 'px';
      svg.style.cursor = 'crosshair';
      if (svg.innerHTML !== _graphRenderCache.svgMarkup) svg.innerHTML = _graphRenderCache.svgMarkup;

      svg._stepsMap = _graphRenderCache.stepsMap;
      svg._snapMap = _graphRenderCache.snapMap;
      svg._overridePoints = _graphRenderCache.overridePoints;
      svg._dates = _graphRenderCache.dates;
      svg._H = H;
      svg._DAY_W = DAY_W;

      scrollWrap.scrollLeft = savedScroll;
      bindSvgInteractionHandlers();
      updateNowLineOverlay(DAY_W, H);
      return;
    }

    var s        = '';
    var fullW    = DAYS * DAY_W;
    var stepsMap = getOrComputeAllDaySteps(processedTrainData.allTrains || [], dates, manualEOverrides);
    var snapMap  = {};   // dateStr -> [{minute, E, color}]
    var overridePoints = []; // [{dateStr, minute, x, y}]

    // Brightness + invert filters for chart images
    s += '<defs>' +
         '<filter id="sg-bf" color-interpolation-filters="sRGB">' +
         '<feComponentTransfer>' +
         '<feFuncR type="linear" slope="1.18" intercept="0.02"/>' +
         '<feFuncG type="linear" slope="1.18" intercept="0.02"/>' +
         '<feFuncB type="linear" slope="1.18" intercept="0.02"/>' +
         '</feComponentTransfer></filter>' +
         '<filter id="sg-invert" color-interpolation-filters="sRGB">' +
         '<feComponentTransfer>' +
         '<feFuncR type="linear" slope="-1" intercept="1"/>' +
         '<feFuncG type="linear" slope="-1" intercept="1"/>' +
         '<feFuncB type="linear" slope="-1" intercept="1"/>' +
         '</feComponentTransfer></filter>' +
         '<linearGradient id="sg-hdr-dawn" x1="0" y1="0" x2="1" y2="0">' +
         '<stop offset="0" style="stop-color: var(--hdr-night); stop-opacity: 1"/>' +
         '<stop offset="1" style="stop-color: var(--hdr-day);   stop-opacity: 1"/>' +
         '</linearGradient>' +
         '<linearGradient id="sg-hdr-dusk" x1="0" y1="0" x2="1" y2="0">' +
         '<stop offset="0" style="stop-color: var(--hdr-day);   stop-opacity: 1"/>' +
         '<stop offset="1" style="stop-color: var(--hdr-night); stop-opacity: 1"/>' +
         '</linearGradient>' +
         '</defs>';

    // Alternating day backgrounds
    for (var i = 0; i < DAYS; i++) {
      s += '<rect x="' + (i * DAY_W) + '" y="' + T + '" width="' + DAY_W + '" height="' + DH + '" fill="' +
           (i === 0 ? 'rgba(255,255,200,0.05)' : i % 2 === 0 ? 'rgba(255,255,255,0.014)' : 'rgba(255,255,255,0.026)') + '"/>';
    }

    // Zone bands: green(700-1500) / yellow(400-700) / dark-orange(150-400) / dark-red(0-150)
    s += '<rect x="0" y="' + f(yPx(cfg.E_MAX, H)) + '" width="' + fullW + '" height="' + f(yPx(cfg.STRESS_GREEN, H) - yPx(cfg.E_MAX, H)) + '" fill="rgba(42,163,98,0.10)"/>';
    s += '<rect x="0" y="' + f(yPx(cfg.STRESS_GREEN, H)) + '" width="' + fullW + '" height="' + f(yPx(cfg.STRESS_YELLOW, H) - yPx(cfg.STRESS_GREEN, H)) + '" fill="rgba(250,183,0,0.09)"/>';
    s += '<rect x="0" y="' + f(yPx(cfg.STRESS_YELLOW, H)) + '" width="' + fullW + '" height="' + f(yPx(cfg.OVERLOAD_E_THRESHOLD, H) - yPx(cfg.STRESS_YELLOW, H)) + '" fill="rgba(210,90,0,0.13)"/>';
    s += '<rect x="0" y="' + f(yPx(cfg.OVERLOAD_E_THRESHOLD, H)) + '" width="' + fullW + '" height="' + f(yPx(Y_MIN, H) - yPx(cfg.OVERLOAD_E_THRESHOLD, H)) + '" fill="rgba(180,0,0,0.16)"/>';

    // Y gridlines
    for (var gv = Y_MIN; gv <= Y_MAX; gv += 150) {
      var gy = f(yPx(gv, H));
      s += '<line x1="0" y1="' + gy + '" x2="' + fullW + '" y2="' + gy + '" stroke="' +
           (gv % 300 === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)') + '" stroke-width="1"/>';
    }

    // Named threshold lines
    var TH_LINES = [
      { E: cfg.E_MAX,                stroke: 'rgba(255,255,255,0.18)' },
      { E: cfg.STRESS_GREEN,         stroke: 'rgba(42,163,98,0.55)'   },
      { E: cfg.STRESS_YELLOW,        stroke: 'rgba(250,183,0,0.55)'   },
      { E: cfg.OVERLOAD_E_THRESHOLD, stroke: 'rgba(239,80,80,0.55)'   },
      { E: 0,                        stroke: 'rgba(255,255,255,0.22)' },
    ];
    TH_LINES.forEach(function (g) {
      if (g.E < Y_MIN || g.E > Y_MAX) return;
      var gy = f(yPx(g.E, H));
      s += '<line x1="0" y1="' + gy + '" x2="' + fullW + '" y2="' + gy + '" stroke="' + g.stroke + '" stroke-width="1.4"/>';
    });

    // Per-day columns
    for (var i = 0; i < DAYS; i++) {
      var dateStr = dates[i];
      var colX    = i * DAY_W;
      var isToday = (i === TODAY_IDX);

      // Day/night header band (y=0..T only): night | dawn-grad | day | dusk-grad | night
      // 5.5h night | 1h gradient | 11h day | 1h gradient | 5.5h night = 24h
      s += '<rect x="' + colX                              + '" y="0" width="' + f((5.5/24)*DAY_W) + '" height="' + T + '" style="fill: var(--hdr-night)"/>';
      s += '<rect x="' + f(colX + (5.5/24)*DAY_W)         + '" y="0" width="' + f((1/24)*DAY_W)   + '" height="' + T + '" fill="url(#sg-hdr-dawn)"/>';
      s += '<rect x="' + f(colX + (6.5/24)*DAY_W)         + '" y="0" width="' + f((11/24)*DAY_W)  + '" height="' + T + '" style="fill: var(--hdr-day)"/>';
      s += '<rect x="' + f(colX + (17.5/24)*DAY_W)        + '" y="0" width="' + f((1/24)*DAY_W)   + '" height="' + T + '" fill="url(#sg-hdr-dusk)"/>';
      s += '<rect x="' + f(colX + (18.5/24)*DAY_W)        + '" y="0" width="' + f((5.5/24)*DAY_W) + '" height="' + T + '" style="fill: var(--hdr-night)"/>';
      if (DAY_W > 72) {
        var iconSz = 14, iconY = f((T - iconSz) / 2);
        s += '<image href="res/moon.svg" x="' + f(colX + (3/24)*DAY_W  - iconSz/2) + '" y="' + iconY + '" width="' + iconSz + '" height="' + iconSz + '" opacity="0.80"/>';
        s += '<image href="res/sun.svg"  x="' + f(colX + (12/24)*DAY_W - iconSz/2) + '" y="' + iconY + '" width="' + iconSz + '" height="' + iconSz + '" opacity="0.80" filter="url(#sg-invert)"/>';
        s += '<image href="res/moon.svg" x="' + f(colX + (21/24)*DAY_W - iconSz/2) + '" y="' + iconY + '" width="' + iconSz + '" height="' + iconSz + '" opacity="0.80"/>';
      }

      s += '<line x1="' + colX + '" y1="' + T + '" x2="' + colX + '" y2="' + (H - B) +
           '" stroke="rgba(255,255,255,' + (isToday ? '0.40' : '0.15') + ')" stroke-width="' + (isToday ? '1.6' : '1') + '"/>';

      var d    = new Date(dateStr + 'T12:00:00');
      var dlbl = (isToday ? 'Heute \u00b7 ' : '') +
                 d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
      s += '<text x="' + (colX + 7) + '" y="' + (T - 9) +
         '" font-size="15" font-weight="' + (isToday ? '700' : '500') +
         '" fill="' + (isToday ? 'rgba(255,255,230,0.95)' : 'rgba(255,255,255,0.78)') +
           '" font-family=' + SVG_FONT + '>' + esc(dlbl) + '</text>';

      for (var hr = 0; hr <= 24; hr += 3) {
        var hx  = colX + (hr / 24) * DAY_W;
        var hst = hr % 6 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
        s += '<line x1="' + f(hx) + '" y1="' + T + '" x2="' + f(hx) + '" y2="' + (H - B) +
             '" stroke="' + hst + '" stroke-width="1"/>';
        if (hr < 24) {
          s += '<text x="' + f(hx) + '" y="' + (H - B + 15) +
               '" text-anchor="middle" font-size="13" fill="rgba(255,255,255,0.55)" font-family=' + SVG_FONT + '>' +
               (hr < 10 ? '0' : '') + hr + ':00</text>';
        }
      }

      var trains = getTrainsForDate(dateStr);
      var steps  = stepsMap[dateStr] || [];

      var snaps = buildSnapPoints(trains, steps);
      snapMap[dateStr] = snaps;

      // Task bands — with alert detection
      trains.forEach(function (t) {
        if (t.canceled) return;
        var start = smParseTimeToMinutes(t.actual || t.plan);
        var dur   = Math.max(0, Number(t.dauer) || 0);
        if (start === null || !dur) return;
        var baseColor = (typeof getLineColor === 'function') ? getLineColor(t.linie) : '#888';
        var bx        = colX + (start / 1440) * DAY_W;
        var bw        = (dur  / 1440) * DAY_W;
        // Scan steps for minimum E during this task to detect alert state
        var startM = Math.round(start);
        var endM   = Math.min(1439, Math.round(start + dur));
        var minE   = Infinity;
        for (var sm = startM; sm <= endM; sm++) {
          var sv = steps[sm];
          if (sv && sv.E < minE) minE = sv.E;
        }
        var alertLvl = minE < cfg.OVERLOAD_E_THRESHOLD ? 3   // <150: dark red zone
                     : minE < cfg.STRESS_YELLOW        ? 2   // 150-400: orange zone
                     : minE < cfg.STRESS_GREEN         ? 1   // 400-700: yellow zone
                     : 0;
        var fillColor = alertLvl === 3 ? '#ef4444' : baseColor;
        var fillOpacity = alertLvl === 3 ? '0.30' : '0.14';
        s += '<rect x="' + f(bx) + '" y="' + T + '" width="' + f(Math.max(2, bw)) + '" height="' + DH +
             '" fill="' + fillColor + '" opacity="' + fillOpacity + '"/>';
        if (bw > 24) {
          var lineLower = (t.linie || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          var iw = 32, ih = 16;
          s += '<image href="res/' + lineLower + '.svg" x="' + f(bx + bw / 2 - iw / 2) + '" y="' + (T + 6) +
               '" width="' + iw + '" height="' + ih + '"/>';
          if (alertLvl > 0) {
            var aIcon = alertLvl === 3 ? 'auslastung4' : alertLvl === 2 ? 'auslastung3' : 'auslastung2';
            var ai = 20;
            s += '<image href="res/' + aIcon + '.svg" x="' + f(bx + bw / 2 - ai / 2) + '" y="' + (T + 26) +
                 '" width="' + ai + '" height="' + ai + '"/>';
          }
        }
        // Store alert level on train object for badge use
        t._alertLvl = alertLvl;
      });

      // Energy curve
      s += '<g filter="url(#sg-bf)">';
      for (var m = 0; m < 1437; m += 3) {
        var s1 = steps[m], s2 = steps[m + 3];
        if (!s1 || !s2) continue;
        var taskId = s1.task ? s1.task.linie : null;
        var col    = (taskId && typeof getLineColor === 'function') ? getLineColor(taskId) : IDLE_C;
        if ((s1.task && s1.task._alertLvl === 3) || s1.E < cfg.OVERLOAD_E_THRESHOLD || s2.E < cfg.OVERLOAD_E_THRESHOLD) col = '#FF0000';
        s += '<line x1="' + f(colX + (m       / 1440) * DAY_W) + '" y1="' + f(yPx(s1.E, H)) +
             '" x2="' + f(colX + ((m + 3) / 1440) * DAY_W) + '" y2="' + f(yPx(s2.E, H)) +
             '" stroke="' + col + '" stroke-width="2.0" stroke-linecap="round"/>';
      }
      s += '</g>';

      // Snap-point diamonds on task boundaries
      snaps.forEach(function (sp) {
        var sx = f(colX + (sp.minute / 1440) * DAY_W);
        var sy = f(yPx(sp.E, H));
        s += '<circle cx="' + sx + '" cy="' + sy + '" r="3" fill="' + sp.color + '" filter="url(#sg-bf)"/>';
      });

      // Manual override points - styled like snap points but with distinct coloring
      var dayOverrides = manualEOverrides[dateStr] || {};
      Object.keys(dayOverrides).forEach(function (mk) {
        var om = Number(mk);
        if (isNaN(om) || om < 0 || om > 1439 || !steps[om]) return;
        var ox = colX + (om / 1440) * DAY_W;
        var oy = yPx(steps[om].E, H);
        overridePoints.push({ dateStr: dateStr, minute: om, x: ox, y: oy });
        // Render as a larger point with colored ring and white core (matching snap-point style but distinctive)
        s += '<circle cx="' + f(ox) + '" cy="' + f(oy) + '" r="5" fill="rgba(99,197,34,0.3)" stroke="rgba(99,197,34,0.85)" stroke-width="2.2" filter="url(#sg-bf)"/>';
        s += '<circle cx="' + f(ox) + '" cy="' + f(oy) + '" r="2.8" fill="#ffffff"/>';
      });

    }

    s += '<line x1="' + fullW + '" y1="' + T + '" x2="' + fullW + '" y2="' + (H - B) +
         '" stroke="rgba(255,255,255,0.15)" stroke-width="1.2"/>';

    // IMPORTANT: hit overlay and hover overlays must be last (on top)
    // The hit overlay uses pointer-events:all; actual cursor is set to none on svg
    // so only the overlay decides the cursor.
    s += '<rect id="sg-hit" x="0" y="0" width="' + SVG_W + '" height="' + H +
         '" fill="rgba(0,0,0,0)" style="cursor:crosshair"/>';

    s += '<line id="sg-hl" x1="0" y1="' + T + '" x2="0" y2="' + (H - B) +
         '" stroke="rgba(255,255,255,0.30)" stroke-width="1.4" stroke-dasharray="5 5" visibility="hidden"/>';
    s += '<circle id="sg-hd" cx="0" cy="0" r="5" fill="#ffffff" stroke="#0b1420" stroke-width="2" visibility="hidden"/>';

    svg.setAttribute('width',   SVG_W);
    svg.setAttribute('height',  H);
    svg.setAttribute('viewBox', '0 0 ' + SVG_W + ' ' + H);
    svg.style.width  = SVG_W + 'px';
    svg.style.height = H + 'px';
    svg.style.cursor = 'crosshair';   // always crosshair — no child can override
    svg.innerHTML = s;

    svg._stepsMap = stepsMap;
    svg._snapMap  = snapMap;
    svg._overridePoints = overridePoints;
    svg._dates    = dates;
    svg._H        = H;
    svg._DAY_W    = DAY_W;

    _graphRenderCache = {
      key: renderKey,
      svgMarkup: s,
      stepsMap: stepsMap,
      snapMap: snapMap,
      overridePoints: overridePoints,
      dates: dates,
      SVG_W: SVG_W
    };

    scrollWrap.scrollLeft = savedScroll;

    // Events on the entire SVG element (not just hit rect) so cursor never flickers
    bindSvgInteractionHandlers();
    updateNowLineOverlay(DAY_W, H);
  }

  // ── Tooltip (throttled via rAF) ───────────────────────────────────────────
  function onHoverThrottled(e) {
    _lastHoverE = e;
    if (_hoverRaf) return;
    _hoverRaf = requestAnimationFrame(function () {
      _hoverRaf = null;
      if (_lastHoverE) processHover(_lastHoverE);
    });
  }

  function processHover(e) {
    if (!svg._stepsMap || !svg._dates) return;
    
    // If we have a pinned override point, check if cursor moved far enough to unpin
    if (_pinnedOverridePoint && !e._forcePoint) {
      var wRect   = scrollWrap.getBoundingClientRect();
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      var DAY_W   = svg._DAY_W || 300;
      var svgX    = clientX - wRect.left + scrollWrap.scrollLeft;
      var colIdx  = svg._dates.indexOf(_pinnedOverridePoint.dateStr);
      if (colIdx >= 0) {
        var pinnedX = colIdx * DAY_W + (_pinnedOverridePoint.minute / 1440) * DAY_W;
        var distFromPinned = Math.abs(svgX - pinnedX);
        // Unpin if cursor moves more than 50px away
        if (distFromPinned > 50) {
          _pinnedOverridePoint = null;
          tooltipEl.classList.remove('show');
          return;
        }
      }
      showPinnedTooltip();
      return;
    }
    var wRect   = scrollWrap.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    var DAY_W   = svg._DAY_W || 300;
    var H       = svg._H;
    var svgX;
    var colIdx;
    var minute;
    var dateStr;
    if (e._forcePoint) {
      dateStr = e._forcePoint.dateStr;
      minute = e._forcePoint.minute;
      colIdx = svg._dates.indexOf(dateStr);
      if (colIdx < 0) { onLeave(); return; }
      svgX = colIdx * DAY_W + (minute / 1440) * DAY_W;
      clientX = wRect.left + svgX - scrollWrap.scrollLeft;
      clientY = wRect.top + T + 18;
    } else {
      svgX    = clientX - wRect.left + scrollWrap.scrollLeft;
      colIdx  = Math.floor(svgX / DAY_W);
      if (colIdx < 0 || colIdx >= DAYS || clientY < wRect.top || clientY > wRect.bottom) {
        onLeave();
        return;
      }
      var frac = (svgX - colIdx * DAY_W) / DAY_W;
      minute  = Math.round(Math.max(0, Math.min(1439, frac * 1440)));
      dateStr = svg._dates[colIdx];
    }
    var steps   = svg._stepsMap[dateStr];
    if (!steps) { onLeave(); return; }

    // Snap: find nearest task boundary within SNAP_PX
    var snaps   = (svg._snapMap && svg._snapMap[dateStr]) || [];
    var snapped = null;
    var minDist = Infinity;
    snaps.forEach(function (sp) {
      var spX  = colIdx * DAY_W + (sp.minute / 1440) * DAY_W;
      var dist = Math.abs(svgX - spX);
      if (dist < SNAP_PX && dist < minDist) { minDist = dist; snapped = sp; }
    });

    // Check for nearby override markers and auto-pin tooltip (2D hit test)
    var nearbyOverride = null;
    var overrideDist = Infinity;
    (svg._overridePoints || []).forEach(function (p) {
      if (p.dateStr !== dateStr || e._forcePoint) return;
      var dx = svgX - p.x;
      var dy = (clientY - wRect.top) - p.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < OVERRIDE_HIT_PX && dist < overrideDist) {
        overrideDist = dist;
        nearbyOverride = p;
      }
    });
    if (nearbyOverride && !_pinnedOverridePoint) {
      _pinnedOverridePoint = { dateStr: nearbyOverride.dateStr, minute: nearbyOverride.minute };
    }

    var minute2  = e._forcePoint
      ? minute
      : (nearbyOverride ? nearbyOverride.minute : (snapped ? snapped.minute : minute));
    var step     = steps[minute2];
    if (!step) { onLeave(); return; }

    var E   = Math.round(step.E);
    var cx  = f(colIdx * DAY_W + (minute2 / 1440) * DAY_W);
    var cy  = f(yPx(step.E, H));
    var col = (step.task && typeof getLineColor === 'function') ? getLineColor(step.task.linie) : IDLE_C;

    var hl = svg.querySelector('#sg-hl');
    var hd = svg.querySelector('#sg-hd');
    if (hl) { hl.setAttribute('x1', cx); hl.setAttribute('x2', cx); hl.setAttribute('visibility', 'visible'); }
    if (hd) { hd.setAttribute('cx', cx); hd.setAttribute('cy', cy); hd.setAttribute('fill', col); hd.setAttribute('visibility', 'visible'); }
    svg.style.cursor = step.task ? 'pointer' : 'crosshair';

    var hh   = String(Math.floor(minute2 / 60)).padStart(2, '0');
    var mm   = String(minute2 % 60).padStart(2, '0');
    var taskName = step.task ? (step.task.ziel || '\u2014') : 'Leerlauf / Schlaf';
    var rateNum  = step.dE_per_min;
    var rateStr  = (rateNum >= 0 ? '+' : '') + rateNum.toFixed(2);
    var rateCol  = rateNum >= 0 ? getComputedStyle(document.documentElement).getPropertyValue('--energy-green').trim() : getComputedStyle(document.documentElement).getPropertyValue('--energy-red').trim();

    // Compute total delta for the whole task
    var totalDelta = null;
    var taskStart  = null;
    var taskEnd    = null;
    if (step.task) {
      var tStart = smParseTimeToMinutes(step.task.actual || step.task.plan);
      var tDur   = Number(step.task.dauer) || 0;
      if (tStart !== null && tDur > 0) {
        taskStart = tStart;
        taskEnd   = tStart + tDur;
        var s0  = steps[Math.round(tStart)];
        var sEnd = steps[Math.min(1439, Math.round(tStart + tDur))];
        if (s0 && sEnd) totalDelta = Math.round(sEnd.E - s0.E);
      }
    }
    var deltaStr = totalDelta !== null ? ((totalDelta >= 0 ? '+' : '') + totalDelta) : '';
    var deltaCol = totalDelta !== null ? (totalDelta >= 0 ? getComputedStyle(document.documentElement).getPropertyValue('--energy-green').trim() : getComputedStyle(document.documentElement).getPropertyValue('--energy-red').trim()) : '#9db1c9';

    // Alert level for current point
    var cfg2 = STRESSMETER_CONFIG;
    var alertLvl = E < cfg2.OVERLOAD_E_THRESHOLD ? 2 : E < cfg2.STRESS_YELLOW ? 1 : 0;
    var alertTxt = alertLvl === 2 ? '\u26a0 Kritisch — Schwarze Zone!' : alertLvl === 1 ? '\u26a0 Warnung — Orange Zone' : '';
    var alertCol = alertLvl === 2 ? '#ef4444' : '#facc15';

    _lastHoverPoint = { dateStr: dateStr, minute: minute2, E: E };
    var overrideFocused = isOverridePoint(dateStr, minute2);

    // Time window string
    var windowStr = '';
    if (taskStart !== null) {
      var wh1 = String(Math.floor(taskStart / 60)).padStart(2, '0');
      var wm1 = String(Math.round(taskStart) % 60).padStart(2, '0');
      var wh2 = String(Math.floor(taskEnd   / 60)).padStart(2, '0');
      var wm2 = String(Math.round(taskEnd)   % 60).padStart(2, '0');
      windowStr = wh1 + ':' + wm1 + ' \u2013 ' + wh2 + ':' + wm2;
    } else {
      var idleStart = minute2;
      var idleEnd = minute2;
      while (idleStart > 0 && steps[idleStart - 1] && !steps[idleStart - 1].task) idleStart--;
      while (idleEnd < 1439 && steps[idleEnd + 1] && !steps[idleEnd + 1].task) idleEnd++;
      var ih1 = String(Math.floor(idleStart / 60)).padStart(2, '0');
      var im1 = String(idleStart % 60).padStart(2, '0');
      var ih2 = String(Math.floor(idleEnd / 60)).padStart(2, '0');
      var im2 = String(idleEnd % 60).padStart(2, '0');
      windowStr = ih1 + ':' + im1 + ' \u2013 ' + ih2 + ':' + im2;
    }

    tooltipEl.style.setProperty('--tip-color', col);
    if (tipDate)      tipDate.textContent      = dateStr;
    if (tipTime)      tipTime.textContent      = hh + ':' + mm + (snapped ? ' \u2022' : '');
    if (tipEnergy)  { tipEnergy.innerHTML = '<img src="res/energy.svg" class="sg-tip-energy-icon" alt=""> ' + E; tipEnergy.style.color = col; }
    if (tipDelta)   { tipDelta.textContent     = deltaStr ? deltaStr + ' \u26a1' : ''; tipDelta.style.color = deltaCol; }
    if (tipTask) {
      if (step.task) {
        var tipLine = (step.task.linie || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        tipTask.innerHTML = '<img src="res/' + tipLine + '.svg" class="sg-tip-linie-badge" alt="' + esc(step.task.linie || '') + '"> ' + esc(taskName);
      } else {
        tipTask.textContent = taskName;
      }
    }
    if (tipWindow)    tipWindow.textContent    = windowStr;
    if (tipOverrideActions) tipOverrideActions.style.display = overrideFocused ? 'flex' : 'none';
    if (tipRate)    { tipRate.textContent      = rateStr; tipRate.style.color = rateCol; }
    if (tipFatigue)   tipFatigue.textContent   = 'Erschöpf.\u00d7: ' + step.M_fatigue.toFixed(3);
    if (tipCircadian) tipCircadian.textContent = 'Zirkadian\u00d7: ' + step.M_circadian.toFixed(3);
    if (tipContext)   tipContext.textContent   = 'Kontext\u00d7: ' + step.M_context.toFixed(3);
    if (tipAlert)   { tipAlert.textContent     = alertTxt; tipAlert.style.color = alertCol; }

    // Position tooltip: directly below cursor; flip above if clipping
    var TTIP_W    = 248;
    var TTIP_H    = 140;
    var shellEl   = scrollWrap.parentElement;          // .sg-chart-shell (position:relative)
    var shellRect = shellEl.getBoundingClientRect();
    var leftInShell = L_YAXIS + parseFloat(cx) - scrollWrap.scrollLeft;
    var topInShell  = clientY - shellRect.top;

    var tipLeft = leftInShell + 16;
    if (tipLeft + TTIP_W > shellRect.width) tipLeft = leftInShell - TTIP_W - 8;
    tipLeft = Math.max(L_YAXIS + 2, tipLeft);

    var tipTop = Math.max(4, topInShell + 14);

    tooltipEl.style.left = tipLeft + 'px';
    tooltipEl.style.top  = tipTop + 'px';
    tooltipEl.classList.add('show');
  }

  function onLeave() {
    if (_pinnedOverridePoint) {
      showPinnedTooltip();
      return;
    }
    _lastHoverE = null;
    _lastHoverPoint = null;
    svg.style.cursor = 'crosshair';
    var hl = svg.querySelector('#sg-hl');
    var hd = svg.querySelector('#sg-hd');
    if (hl) hl.setAttribute('visibility', 'hidden');
    if (hd) hd.setAttribute('visibility', 'hidden');
    tooltipEl.classList.remove('show');
  }

  // ── Task band click: open editor drawer ───────────────────────────────────
  function onSvgClick(e) {
    if (!svg._stepsMap || !svg._dates) return;
    var wRect   = scrollWrap.getBoundingClientRect();
    var clientX = e.clientX, clientY = e.clientY;
    if (clientY < wRect.top || clientY > wRect.bottom) return;
    var DAY_W   = svg._DAY_W || 300;
    var svgX    = clientX - wRect.left + scrollWrap.scrollLeft;
    var colIdx  = Math.floor(svgX / DAY_W);
    if (colIdx < 0 || colIdx >= DAYS) return;
    var frac    = (svgX - colIdx * DAY_W) / DAY_W;
    var minute  = Math.round(Math.max(0, Math.min(1439, frac * 1440)));
    var dateStr = svg._dates[colIdx];

    // Clicking near an override marker pins tooltip on that marker
    var nearestOverride = null;
    var nearestDist = OVERRIDE_HIT_PX;
    var localY = clientY - wRect.top;
    (svg._overridePoints || []).forEach(function (p) {
      if (p.dateStr !== dateStr) return;
      var dx = svgX - p.x;
      var dy = localY - p.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestOverride = p;
      }
    });
    if (nearestOverride) {
      _pinnedOverridePoint = { dateStr: nearestOverride.dateStr, minute: nearestOverride.minute };
      showPinnedTooltip();
      return;
    }
    _pinnedOverridePoint = null;

    var steps   = svg._stepsMap[dateStr];
    if (!steps) return;
    var step = steps[minute];
    if (!step || !step.task) return;
    tooltipEl.classList.remove('show');
    if (typeof renderFocusMode === 'function') { renderFocusMode(step.task); }
  }

  // ── Smooth wheel scroll with velocity inertia ─────────────────────────────
  // Each scroll event adds to velocity; velocity decays each frame for smooth inertia.
  var _wheelVel = 0;
  var _wheelRaf = null;
  function _wheelStep() {
    if (Math.abs(_wheelVel) < 0.5) { _wheelRaf = null; _wheelVel = 0; return; }
    scrollWrap.scrollLeft += _wheelVel;
    _wheelVel *= 0.88;
    _wheelRaf = requestAnimationFrame(_wheelStep);
  }
  scrollWrap.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      _wheelVel += e.deltaY * 0.4;
      if (!_wheelRaf) _wheelRaf = requestAnimationFrame(_wheelStep);
    }
  }, { passive: false });

  scrollWrap.addEventListener('keydown', function (e) {
    if      (e.key === 'ArrowRight') { e.preventDefault(); scrollWrap.scrollLeft += 180; }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); scrollWrap.scrollLeft -= 180; }
  });

  scrollWrap.addEventListener('scroll', function () {
    if (!dashboardOpen) return;
    updateNowLineOverlay(svg._DAY_W || Math.max(120, scrollWrap.clientWidth), svg._H || (scrollWrap.clientHeight || 280));
  }, { passive: true });

  // Debounced resize re-render
  var _resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!dashboardOpen) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(renderGraph, 250);
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.updateStressBadge = updateStressBadge;

  window.stressmeterOnDataChanged = function () {
    invalidateStressmeterCache();
    _graphRenderCache.key = '';
    _graphRenderCache.svgMarkup = '';
    lastBadgeMinute = -1;
    updateStressBadge();
    if (dashboardOpen) renderGraph();
  };

})();
