// === LOVEMETER UI ===
// M(t)-Diagram with nonlinear temporal axis distortion.
// -5 days history (spline) + "now" + +21 days prediction (ODE).
// Depends on: lovemeter-engine.js

(function initLovemeter() {
  'use strict';

  // ── Chart layout constants ─────────────────────────────────────────────────
  var L_YAXIS   = 52;    // fixed Y-axis SVG width (must match CSS margin-left)
  var R         = 16;    // right padding inside scrollable SVG
  var T         = 22;    // top padding (tick labels)
  var B         = 28;    // bottom padding (x-axis time labels)
  var Y_MAX     = LOVEMETER_CONFIG.M_NORMAL;  // updated dynamically before each render
  var _yMaxTarget = LOVEMETER_CONFIG.M_NORMAL; // the snapped target ceiling
  var _yAnimRaf   = null;                       // RAF handle for Y_MAX animation
  var _yAnimFrame = 0;                          // frame counter for throttling
  var _focusMode  = false;                      // when true: Y_MAX based on ±6h window only
  var Y_MIN     = LOVEMETER_CONFIG.M_MIN;     // 0
  var Y_RANGE   = Y_MAX - Y_MIN;
  var SVG_FONT  = "'Bahnschrift', 'Bahnschrift Condensed', 'Arial Narrow', sans-serif";
  // ── Design-token colours — read from CSS custom properties at runtime ────
  // This lets design-tokens.css be the single source of truth for all graph colours.
  function _cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function _C() {
    return {
      curveHistory:    _cssVar('--lm-curve-history',          '#d97706'),
      curvePredict:    _cssVar('--lm-curve-predict',          'rgba(217,119,6,0.45)'),
      curveOverride:   _cssVar('--lm-curve-override',         'rgba(200,100,220,0.85)'),
      grid:            _cssVar('--lm-graph-grid',             'rgba(0,0,0,0.14)'),
      yaxisGrid:       _cssVar('--lm-graph-yaxis-grid',       'rgba(0,0,0,0.18)'),
      yaxisBorder:     _cssVar('--lm-graph-yaxis-border',     'rgba(0,0,0,0.35)'),
      yaxisLabel:      _cssVar('--lm-graph-yaxis-label',      'rgba(0,0,0,0.65)'),
      yaxisLabelTop:   _cssVar('--lm-graph-yaxis-label-top',  'rgba(0,0,0,0.75)'),
      tickMajor:       _cssVar('--lm-graph-tick-major',       'rgba(0,0,0,0.35)'),
      tickMinor:       _cssVar('--lm-graph-tick-minor',       'rgba(0,0,0,0.16)'),
      tickLabel:       _cssVar('--lm-graph-tick-label',       'rgba(0,0,0,0.70)'),
      tickLabelSm:     _cssVar('--lm-graph-tick-label-sm',    'rgba(0,0,0,0.45)'),
      dateLabel:       _cssVar('--lm-graph-date-label',       'rgba(0,0,0,0.65)'),
      separator:       _cssVar('--lm-graph-separator',        'rgba(0,0,0,0.22)'),
      nowLine:         _cssVar('--lm-graph-now-line',         'rgba(0,0,0,0.35)'),
      nowLabel:        _cssVar('--lm-graph-now-label',        'rgba(0,0,0,0.65)'),
      crosshair:       _cssVar('--lm-graph-crosshair',        'rgba(200,60,140,0.55)'),
      dotStroke:       _cssVar('--lm-graph-dot-stroke',       'rgba(0,0,0,0.35)'),
      lineMoodyLow:    _cssVar('--lm-line-moody-low',         'rgba(140,80,30,0.80)'),
      lineMoodyHigh:   _cssVar('--lm-line-moody-high',        'rgba(160,95,20,0.85)'),
      lineBaseline:    _cssVar('--lm-line-baseline',          'rgba(0,0,0,0.55)'),
      lineCrush:       _cssVar('--lm-line-crush',             'rgba(109,40,217,0.90)'),
    };
  }
  // Cached colour palette — refreshed each render so live token edits apply immediately.
  var C = _C();

  var CURVE_COLOR    = C.curveHistory;  // kept for badge/tooltip back-compat
  var PREDICT_COLOR  = C.curvePredict;
  var OVERRIDE_COLOR = C.curveOverride;

  // ── State ─────────────────────────────────────────────────────────────────
  var dashboardOpen    = false;
  var _drawerOpen      = false;
  var _drawerPoint     = null;   // existing data point being edited, or null
  var _drawerTs        = null;   // timestamp for the drawer
  var _drawerM         = null;   // current M at drawerTs
  var _eyeActive       = false;  // eye contact toggle state
  var _lastBadgeM      = -1;
  var _hoverRaf        = null;
  var _lastHoverE      = null;
  var _lastHoverPoint  = null;   // { tMin, M, ts }
  var _snapPoint       = null;   // nearest logged data point when within snap radius
  var _graphCache      = { key: '', markup: '' };
  var _nowLineEl       = null;
  var _dataPoints      = [];     // live array of {ts, M}
  var SNAP_PX          = 20;     // pixels within which cursor snaps to a data point

  // ── Pan / swipe state ─────────────────────────────────────────────────────
  var viewOffset   = 0;     // viewport center in minutes-from-now (0 = current time)
  var _panStartX   = null;  // clientX where pan began
  var _panStartOfs = 0;     // viewOffset at pan start
  var _isPanning   = false; // true once drag > 5 px threshold
  var _panMoved    = false; // latched; cleared on next click
  var _panRaf      = null;

  // ── Load data from server (async) ─────────────────────────────────────────
  loadLovemeterDataPoints().then(function(pts) {
    _dataPoints = pts;
    invalidateLovemeterCache();
    _lastBadgeM = -1;
    updateLovemeterBadge();
    if (dashboardOpen) { _graphCache.key = ''; renderGraph(); }
  });

  // ── DOM refs ──────────────────────────────────────────────────────────────
  var badge       = document.getElementById('lovemeter-badge');
  var dashboard   = document.getElementById('lm-overlay');
  var scrollWrap  = document.getElementById('lm-scroll-wrap');
  var svg         = document.getElementById('lovemeter-svg');
  var yAxisSvg    = document.getElementById('lm-yaxis');
  var pointBubble = document.getElementById('lm-point-bubble');
  var bubbleEvent = document.getElementById('lm-bubble-event');
  var badgeEdit   = document.getElementById('lm-badge-edit');
  var badgeNum    = document.getElementById('lm-badge-num');
  var badgeTrend  = document.getElementById('lm-badge-trend');
  var badgeLabel  = document.getElementById('lm-badge-label');
  var focusBtn    = document.getElementById('lm-focus-btn');
  var bubblesBtn  = document.getElementById('lm-bubbles-btn');
  var centerNowBtn = document.getElementById('lm-center-now-btn');
  var statsZone   = document.getElementById('lm-stats-zone');

  // Event drawer DOM refs
  var eventDrawer    = document.getElementById('lm-event-drawer');
  var drawerClose    = document.getElementById('lm-drawer-close');
  var drawerTitle    = document.getElementById('lm-drawer-title');
  var drawerWhen         = document.getElementById('lm-drawer-when');
  var drawerPresetList   = document.getElementById('lm-drawer-preset-list');
  var newPresetName      = document.getElementById('lm-new-preset-name');
  var newPresetDelta     = document.getElementById('lm-new-preset-delta');
  var drawerEyeBtn       = document.getElementById('lm-drawer-eye-btn');
  var drawerEyeDur       = document.getElementById('lm-eye-duration');
  var drawerEyeInput     = document.getElementById('lm-drawer-eye-dur');
  var drawerAbs          = document.getElementById('lm-drawer-abs');
  var drawerLog          = document.getElementById('lm-drawer-log');
  var drawerSave         = document.getElementById('lm-drawer-save');
  var drawerDelete       = document.getElementById('lm-drawer-delete');

  if (focusBtn) {
    focusBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _focusMode = !_focusMode;
      focusBtn.classList.toggle('lm-focus-active', _focusMode);
      _graphCache.key = '';
      lovemeterOnDataChanged();
    });
  }

  var _showAllBubbles = false;
  if (bubblesBtn) {
    bubblesBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _showAllBubbles = !_showAllBubbles;
      bubblesBtn.classList.toggle('lm-active', _showAllBubbles);
      _graphCache.key = '';
      lovemeterOnDataChanged();
    });
  }

  if (centerNowBtn) {
    centerNowBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      viewOffset = 0;
      _graphCache.key = '';
      lovemeterOnDataChanged();
    });
  }

  if (!badge || !dashboard || !scrollWrap || !svg) return;

  // ── Pure helpers ──────────────────────────────────────────────────────────
  function f(n) { return (+n).toFixed(1); }

  function esc(v) {
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtMs(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  }

  function fmtMsTime(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  // Map M value to SVG y coordinate (no clamp — clipPath / range guards handle out-of-range)
  function yPx(M, H) {
    return T + (1 - (M - Y_MIN) / Y_RANGE) * (H - T - B);
  }

  // ── Temporal axis mapping ─────────────────────────────────────────────────
  var CFG   = LOVEMETER_CONFIG;
  var ALPHA = CFG.ALPHA;
  var EPS   = CFG.EPSILON_MIN;

  // Full calculated helper-array bounds (minutes from now)
  var T_PAST_MIN   = -CFG.PAST_DAYS   * 1440;   // -7200
  var T_FUTURE_MIN = +CFG.FUTURE_DAYS * 1440;   // +30240

  // ── Viewport geometry ─────────────────────────────────────────────────
  // Visible window: [viewOffset − VIEW_HALF_MIN, viewOffset + VIEW_HALF_MIN]
  //   Left NL block:  −2 days to −6 hours relative to viewport center
  //   Linear block:   −6 hours to +6 hours relative to viewport center  (50%)
  //   Right NL block: +6 hours to +2 days relative to viewport center
  // Outer blocks are symmetric → 25% each. The nonlinear distortion is applied
  // relative to the viewport center (t_rel = t_min − viewOffset).
  var VIEW_HALF_DAYS = 2;
  var VIEW_HALF_MIN  = VIEW_HALF_DAYS * 1440;   // 2880 minutes = 2 days
  var LINEAR_CLAMP_MIN = 360;                    // 6 hours in minutes

  // Viewport center constraints (so the 4-day window never leaves the helper array)
  var MIN_VIEW_OFFSET = T_PAST_MIN   + VIEW_HALF_MIN;  // −5d+2d = −3d
  var MAX_VIEW_OFFSET = T_FUTURE_MIN - VIEW_HALF_MIN;  // +21d−2d = +19d

  // Precompute abstract-x boundaries for the NL zones (relative to viewport center,
  // evaluated at the two boundary magnitudes: 6 h and 2 days). Both outer zones are
  // symmetric so we only need two values.
  var _X_CLAMP   = lmTimeToX(LINEAR_CLAMP_MIN, ALPHA, EPS);  // abstract x at +6h
  var _X_BOUND   = lmTimeToX(VIEW_HALF_MIN,    ALPHA, EPS);  // abstract x at +2d
  var _X_NL_SPAN = _X_BOUND - _X_CLAMP;                      // span of each NL zone

  // Pixel-fraction allocations (symmetric)
  var LIN_FRAC       = 0.50;
  var PAST_NL_FRAC   = 0.25;
  var FUTURE_NL_FRAC = 0.25;

  /**
   * Map minutes-from-now (t_min) to SVG pixel column.
   * Uses viewOffset as the viewport center; t_rel = t_min − viewOffset.
   */
  function tMinToPx(t_min, W_chart) {
    var t_rel = t_min - viewOffset;
    if (t_rel <= -LINEAR_CLAMP_MIN) {
      // Left NL zone: |t_rel| in [LINEAR_CLAMP_MIN, VIEW_HALF_MIN]
      var mag   = Math.min(Math.abs(t_rel), VIEW_HALF_MIN);
      var x_abs = lmTimeToX(mag, ALPHA, EPS);   // positive abstract x
      var fr    = _X_NL_SPAN > 0 ? (x_abs - _X_CLAMP) / _X_NL_SPAN : 0;  // 0 at −6h, 1 at −2d
      return L_YAXIS + (1 - fr) * PAST_NL_FRAC * W_chart;                 // left at −2d, right at −6h
    } else if (t_rel >= LINEAR_CLAMP_MIN) {
      // Right NL zone
      var mag2  = Math.min(t_rel, VIEW_HALF_MIN);
      var x_abs2 = lmTimeToX(mag2, ALPHA, EPS);
      var fr2   = _X_NL_SPAN > 0 ? (x_abs2 - _X_CLAMP) / _X_NL_SPAN : 0; // 0 at +6h, 1 at +2d
      return L_YAXIS + (PAST_NL_FRAC + LIN_FRAC) * W_chart + fr2 * FUTURE_NL_FRAC * W_chart;
    } else {
      // Linear zone: t_rel in [−LINEAR_CLAMP_MIN, +LINEAR_CLAMP_MIN]
      return L_YAXIS + PAST_NL_FRAC * W_chart
           + (t_rel + LINEAR_CLAMP_MIN) / (2 * LINEAR_CLAMP_MIN) * LIN_FRAC * W_chart;
    }
  }

  /** Inverse: SVG pixel column → minutes-from-now. */
  function pxToTMin(px, W_chart) {
    var pxLinStart = L_YAXIS + PAST_NL_FRAC * W_chart;
    var pxLinEnd   = pxLinStart + LIN_FRAC * W_chart;
    if (px <= pxLinStart) {
      // Left NL zone: fr=0 at pxLinStart (t_rel=−6h), fr=1 at L_YAXIS (t_rel=−2d)
      var fr   = PAST_NL_FRAC > 0 ? 1 - (px - L_YAXIS) / (PAST_NL_FRAC * W_chart) : 0;
      fr = Math.max(0, Math.min(1, fr));
      var x_abs = _X_CLAMP + fr * _X_NL_SPAN;
      return viewOffset - lmXToTime(x_abs, ALPHA, EPS);
    } else if (px >= pxLinEnd) {
      // Right NL zone: fr=0 at pxLinEnd (t_rel=+6h), fr=1 at right edge (t_rel=+2d)
      var fr2  = FUTURE_NL_FRAC > 0 ? (px - pxLinEnd) / (FUTURE_NL_FRAC * W_chart) : 0;
      fr2 = Math.max(0, Math.min(1, fr2));
      var x_abs2 = _X_CLAMP + fr2 * _X_NL_SPAN;
      return viewOffset + lmXToTime(x_abs2, ALPHA, EPS);
    } else {
      // Linear zone
      var t_rel = -LINEAR_CLAMP_MIN + (px - pxLinStart) / (LIN_FRAC * W_chart) * 2 * LINEAR_CLAMP_MIN;
      return viewOffset + t_rel;
    }
  }

  /** Pixel position of t=0 ("now"), accounting for current viewport offset. */
  function nowPx(W_chart) {
    return tMinToPx(0, W_chart);
  }

  /** Clamp viewOffset so the 4-day window stays inside the helper-array bounds. */
  function _clampViewOffset(vo) {
    return Math.max(MIN_VIEW_OFFSET, Math.min(MAX_VIEW_OFFSET, vo));
  }

  // ── X-axis tick generator (dynamic, based on viewOffset) ──────────────────
  // Generates 6-hourly ticks within the visible window.
  function buildTicks() {
    var nowMs          = Date.now();
    var mSinceMidnight = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes();
    var vMin = viewOffset - VIEW_HALF_MIN;
    var vMax = viewOffset + VIEW_HALF_MIN;
    var ticks = [];
    // First 6-hour boundary at or after vMin (anchored to today's midnight)
    var firstT = Math.ceil((vMin - (-mSinceMidnight)) / 360) * 360 + (-mSinceMidnight);
    for (var t = firstT; t <= vMax + 1; t += 360) {
      if (t < vMin) continue;
      var absTs = nowMs + t * 60000;
      var d     = new Date(absTs);
      var hh    = d.getHours();
      var mm    = d.getMinutes();
      var label = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
      ticks.push({ t: t, label: label, major: (hh === 0 && mm === 0) });
    }
    return ticks;
  }

  // ── Zone and Y-label builders (dynamic, depend on current Y_MAX) ──────────
  // Background is now a vertical SVG gradient (gray→brown→pink→purple→black)
  // from 0 to 3000; above 3000 is pure black.
  function buildZones() { return []; }  // zone bands replaced by gradient

  function _gradientId() { return 'lm-bg-grad'; }

  function _buildGradientDef() {
    // Stops mapped to Y fractions (0=bottom=0M, 1=top=Y_MAX)
    // Gradient direction: y1=1 (M=0) → y2=0 (M=Y_MAX)
    // gray → brown → pink → purple → black at 150 / 700 / 1500 / 3000
    var stops = [
      { m: 0,    color: '110,110,120', a: 0.55 },  // gray baseline
      { m: 150,  color: '110,110,120', a: 0.50 },  // gray still
      { m: 700,  color: '120,55,15',   a: 0.60 },  // brown
      { m: 1500, color: '210,60,130',  a: 0.55 },  // pink
      { m: 3000, color: '90,30,180',   a: 0.50 },  // purple
      { m: 4500, color: '8,4,12',      a: 0.75 },  // near-black
    ];
    var s = '<defs><linearGradient id="' + _gradientId() + '" x1="0" y1="1" x2="0" y2="0" gradientUnits="objectBoundingBox">';
    stops.forEach(function (st) {
      if (st.m > Y_MAX) return;
      var pct = Math.round(st.m / Math.max(Y_MAX, 1) * 100);
      s += '<stop offset="' + pct + '%" stop-color="rgb(' + st.color + ')" stop-opacity="' + st.a + '"/>';
    });
    var last = stops.filter(function(st){ return st.m <= Y_MAX; }).pop();
    if (last) s += '<stop offset="100%" stop-color="rgb(' + last.color + ')" stop-opacity="' + last.a + '"/>';
    s += '</linearGradient></defs>';
    return s;
  }

  function buildYLabels() {
    var labs = [];
    // Step size: Y_MAX / 7.5 rounded to a clean multiple
    var rawStep = Y_MAX / 7.5;
    var mag     = Math.pow(10, Math.floor(Math.log10(rawStep)));
    var step    = Math.ceil(rawStep / mag) * mag;
    if (step < 1) step = 1;
    for (var m = 0; m <= Y_MAX; m += step) {
      labs.push({ M: Math.round(m), fill: C.yaxisLabel });
    }
    // Always include the exact Y_MAX label
    if (labs.length === 0 || labs[labs.length-1].M < Y_MAX) {
      labs.push({ M: Y_MAX, fill: C.yaxisLabelTop });
    }
    return labs.filter(function(l) { return l.M <= Y_MAX; });
  }

  // ── Badge update ──────────────────────────────────────────────────────────
  function updateLovemeterBadge() {
    var state = getCurrentMoodState(_dataPoints);
    var M     = Math.round(state.M);
    if (M === _lastBadgeM) return;
    _lastBadgeM = M;

    if (badgeNum)   badgeNum.textContent = M >= 10000 ? (M/1000).toFixed(0)+'k' : String(M);
    if (badgeLabel) badgeLabel.textContent = state.zone_label;

    // Zone-based badge color
    var color;
    if      (state.zone === 'colorless')     color = '#b91c1c';
    else if (state.zone === 'moody')         color = '#c2410c';
    else if (state.zone === 'normal')        color = '#22c55e';
    else if (state.zone === 'crush')         color = '#ff69b4';
    else if (state.zone === 'severe')        color = '#c026d3';
    else                                     color = '#7c3aed';

    if (badgeNum) badgeNum.style.color = color;

    var heartEl = badge.querySelector('.lm-badge-heart');
    if (heartEl) heartEl.style.color = color;

    if (badgeTrend) {
      var rising = state.slope > 0;
      badgeTrend.textContent = rising ? '↑' : state.slope < 0 ? '↓' : '→';
      badgeTrend.style.color = rising ? '#ff69b4' : '#9ca3af';
    }

    badge.className = badge.className
      .replace(/\blm-zone-\S+/g, '').trim();
    badge.classList.add('lm-zone-' + state.zone);

    if (dashboardOpen && svg._W_chart) updateNowLine(svg._W_chart);
  }

  // ── Now-line overlay ──────────────────────────────────────────────────────
  function ensureNowLine() {
    if (_nowLineEl && _nowLineEl.parentElement) return _nowLineEl;
    var shell = scrollWrap.parentElement;
    if (!shell) return null;
    _nowLineEl = shell.querySelector('.lm-now-line');
    if (!_nowLineEl) {
      _nowLineEl = document.createElement('div');
      _nowLineEl.className = 'sg-now-line lm-now-line';
      shell.appendChild(_nowLineEl);
    }
    return _nowLineEl;
  }

  function updateNowLine(W_chart, H) {
    var el = ensureNowLine();
    if (!el) return;
    if (!dashboardOpen) { el.style.opacity = '0'; return; }
    var H2 = H || (scrollWrap.clientHeight || 280);
    var px = nowPx(W_chart);
    el.style.left   = px + 'px';
    el.style.top    = T + 'px';
    el.style.height = (H2 - T - B) + 'px';
    el.style.opacity = '0.85';
  }

  // ── Y-axis SVG ────────────────────────────────────────────────────────────
  function renderYAxis(H) {
    if (!yAxisSvg) return;
    C = _C();
    var W = L_YAXIS;
    yAxisSvg.setAttribute('width',   W);
    yAxisSvg.setAttribute('height',  H);
    yAxisSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    yAxisSvg.style.width  = W + 'px';
    yAxisSvg.style.height = H + 'px';

    var s = '';

    // Horizontal gridlines and Y-axis labels (built dynamically for current Y_MAX)
    var yLabels = buildYLabels();
    yLabels.forEach(function (g) {
      var gy = f(yPx(g.M, H));
      s += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy +
           '" stroke="' + C.yaxisGrid + '" stroke-width="1"/>';
    });

    yLabels.forEach(function (g) {
      var gy = f(yPx(g.M, H));
      var lbl = g.M >= 10000 ? (g.M/1000).toFixed(0)+'k' : g.M >= 1000 ? (g.M/1000).toFixed(g.M % 1000 === 0 ? 0 : 1)+'k' : String(g.M);
      s += '<text x="' + (W - 5) + '" y="' + f(+gy + 4) + '" text-anchor="end" font-size="14" fill="' +
           g.fill + '" font-family=' + SVG_FONT + '>' + esc(lbl) + '</text>';
    });

    s += '<line x1="' + (W-1) + '" y1="' + T + '" x2="' + (W-1) + '" y2="' + (H-B) +
         '" stroke="' + C.yaxisBorder + '" stroke-width="1.5"/>';

    yAxisSvg.innerHTML = s;
  }

  // ── Main chart render ─────────────────────────────────────────────────────
  function renderGraph() {
    var H       = scrollWrap.clientHeight || 260;
    var SVG_W   = scrollWrap.clientWidth  || 640;
    var W_chart = SVG_W - L_YAXIS - R;
    var nowMs   = Date.now();

    // Fetch helper array (cached) and compute dynamic Y-axis ceiling
    // Only scan the visible viewport window [viewOffset±2d] so the Y-axis
    // scales to what the user can actually see, not the entire dataset.
    var helper   = getLovemeterHelperArray(_dataPoints);
    var _resolvedPoints = resolveDataPoints(_dataPoints);
    var _yFocusHalf = _focusMode ? LINEAR_CLAMP_MIN : VIEW_HALF_MIN;
    var _vMin    = viewOffset - _yFocusHalf;   // minutes-from-now, viewport left edge
    var _vMax    = viewOffset + _yFocusHalf;   // minutes-from-now, viewport right edge
    var _yMaxNew = CFG.M_NORMAL;
    for (var _vi = 0; _vi < helper.points.length; _vi++) {
      var _viTMin = (helper.startMs + _vi * 60000 - nowMs) / 60000;
      if (_viTMin < _vMin || _viTMin > _vMax) continue;
      if (helper.points[_vi] > _yMaxNew) _yMaxNew = helper.points[_vi];
    }
    if      (_yMaxNew > CFG.M_CRUSH)  _yMaxNew = Math.ceil(_yMaxNew / 10000) * 10000;
    else if (_yMaxNew > CFG.M_NORMAL) _yMaxNew = Math.ceil(_yMaxNew /  1000) * 1000;
    else                              _yMaxNew  = CFG.M_NORMAL;

    // Smooth Y_MAX transitions: lerp toward target, re-render until settled
    if (_yMaxNew !== _yMaxTarget) {
      _yMaxTarget = _yMaxNew;
      if (!_yAnimRaf) {
        (function _yAnimStep() {
          _yAnimFrame++;
          var diff = _yMaxTarget - Y_MAX;
          if (Math.abs(diff) < 1) {
            Y_MAX = _yMaxTarget;
            Y_RANGE = Y_MAX - Y_MIN;
            _yAnimRaf = null;
            _graphCache.key = '';
            renderGraph();
            return;
          }
          Y_MAX += diff * 0.25;  // lerp speed
          Y_RANGE = Y_MAX - Y_MIN;
          // Only rebuild SVG every 2nd frame — halves innerHTML cost during animation
          if (_yAnimFrame % 2 === 0) {
            _graphCache.key = '';
            renderGraph();
          }
          _yAnimRaf = requestAnimationFrame(_yAnimStep);
        })();
      }
    }
    Y_MAX   = Math.abs(_yMaxTarget - Y_MAX) < 1 ? _yMaxTarget : Y_MAX;
    Y_RANGE = Y_MAX - Y_MIN;

    renderYAxis(H);

    // Build cache key: data signature + size + now-minute + dynamic Y_MAX
    var nowMin = Math.floor(nowMs / 60000);
    var dpSig  = _dataPoints.map(function(p){ return p.ts + ':' + p.M + ':' + (p.delta !== undefined ? p.delta : ''); }).join('|');
    var cacheKey = [dpSig, SVG_W, H, nowMin, Y_MAX, Math.round(viewOffset)].join('::');

    if (_graphCache.key === cacheKey && _graphCache.markup) {
      svg.setAttribute('width',   SVG_W);
      svg.setAttribute('height',  H);
      svg.setAttribute('viewBox', '0 0 ' + SVG_W + ' ' + H);
      svg.style.width  = SVG_W + 'px';
      svg.style.height = H + 'px';
      if (svg.innerHTML !== _graphCache.markup) svg.innerHTML = _graphCache.markup;
      svg._W_chart = W_chart;
      svg._H = H;
      _bindSvgHandlers();
      updateNowLine(W_chart, H);
      return;
    }

    var s  = '';
    var DH = H - T - B;

    // ── Clip path for chart area (hides anything above top or below bottom) ─
    // Expanded by 8px on all sides so point markers at the edges aren't cropped.
    var _clipId = 'lm-chart-clip-' + W_chart;
    var _clipPad = 20;
    s += '<defs><clipPath id="' + _clipId + '"><rect x="' + (L_YAXIS - _clipPad) + '" y="' + (T - _clipPad) +
         '" width="' + (W_chart + _clipPad * 2) + '" height="' + (DH + _clipPad * 2) + '"/></clipPath></defs>';

    // ── Gradient background (gray→brown→pink→purple→black, 0..3000) ─────────
    s += _buildGradientDef();
    s += '<rect x="' + L_YAXIS + '" y="' + T + '" width="' + W_chart + '" height="' + DH +
         '" fill="url(#' + _gradientId() + ')"/>';
    // ── Evenly-spaced horizontal grid (subtle backdrop) ───────────────────────
    buildYLabels().forEach(function (g) {
      if (g.M === 0) return;
      var gy = f(yPx(g.M, H));
      s += '<line x1="' + L_YAXIS + '" y1="' + gy + '" x2="' + (SVG_W - R) + '" y2="' + gy +
           '" stroke="' + C.grid + '" stroke-width="0.8"/>';
    });
    // ── Fixed horizontal helper lines at key M thresholds ──────────────────
    var _hLines = [
      { M: 400,  stroke: C.lineMoodyLow,  w: '2.0' },
      { M: 700,  stroke: C.lineMoodyHigh, w: '2.2' },
      { M: 1000, stroke: C.lineBaseline,  w: '2.2' },
      { M: 1500, stroke: C.lineCrush,     w: '2.2' },
    ];
    _hLines.forEach(function (hl) {
      if (hl.M > Y_MAX) return;
      var gy = f(yPx(hl.M, H));
      s += '<line x1="' + L_YAXIS + '" y1="' + gy + '" x2="' + (SVG_W - R) + '" y2="' + gy +
           '" stroke="' + hl.stroke + '" stroke-width="' + hl.w + '"/>';
    });

    // ── X-axis ticks + per-day verticals ─────────────────────────────────────
    var vMin  = viewOffset - VIEW_HALF_MIN;
    var vMax  = viewOffset + VIEW_HALF_MIN;
    var ticks = buildTicks();
    ticks.forEach(function (tick) {
      if (tick.t < vMin || tick.t > vMax) return;
      var tx = f(tMinToPx(tick.t, W_chart));
      // Midnight (major) → brighter day-separator; 6-hourly → subtle
      var strokeCol = tick.major ? C.tickMajor : C.tickMinor;
      var sw        = tick.major ? '1.5' : '0.8';
      s += '<line x1="' + tx + '" y1="' + T + '" x2="' + tx + '" y2="' + (H - B) +
           '" stroke="' + strokeCol + '" stroke-width="' + sw + '"/>';
      s += '<text x="' + tx + '" y="' + (H - B + 20) + '" text-anchor="middle" font-size="15" fill="' +
           (tick.major ? C.tickLabel : C.tickLabelSm) + '" font-family=' + SVG_FONT + '>' + esc(tick.label) + '</text>';
      // Date header at midnight transitions
      if (tick.major) {
        var absTs  = nowMs + tick.t * 60000;
        var dLabel = new Date(absTs).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
        s += '<text x="' + f(+tx + 5) + '" y="' + (T - 5) + '" text-anchor="start" font-size="17" font-weight="700"' +
             ' fill="' + C.dateLabel + '" font-family=' + SVG_FONT + '>' + esc(dLabel) + '</text>';
      }
    });

    // ── Zone separator verticals (NL|linear boundaries) ──────────────────────
    var _sepL = f(L_YAXIS + PAST_NL_FRAC * W_chart);
    var _sepR = f(L_YAXIS + (PAST_NL_FRAC + LIN_FRAC) * W_chart);
    s += '<line x1="' + _sepL + '" y1="' + T + '" x2="' + _sepL + '" y2="' + (H - B) +
         '" stroke="' + C.separator + '" stroke-width="2"/>';
    s += '<line x1="' + _sepR + '" y1="' + T + '" x2="' + _sepR + '" y2="' + (H - B) +
         '" stroke="' + C.separator + '" stroke-width="2"/>';

    // ── "Now" marker (only when t=0 is within the visible window) ───────────
    if (vMin <= 0 && 0 <= vMax) {
      var nx = f(nowPx(W_chart));
      s += '<line x1="' + nx + '" y1="' + T + '" x2="' + nx + '" y2="' + (H - B) +
           '" stroke="' + C.nowLine + '" stroke-width="1.8" stroke-dasharray="6 3"/>';
      s += '<text x="' + nx + '" y="' + (T - 6) + '" text-anchor="middle" font-size="15" font-weight="bold" fill="' + C.nowLabel + '" font-family=' +
           SVG_FONT + '>NOW</text>';
    }

    // ── M(t) curve — forward-mapped time samples ─────────────────────────
    // Use forward mapping (time → x_abstract → pixel) to correctly handle the
    // nonlinear distortion including the discontinuity at t=0.
    // Split at lastDataTs: history (solid) vs prediction (dashed).
    var lastDataTs  = helper.lastDataTs;
    var predStartTs = lastDataTs !== null ? lastDataTs : nowMs;

    var histPoints = [];
    var predPoints = [];

    var TOTAL_HELPER = helper.points.length;
    // Sample every minute; clipped to the 4-day viewport window
    var renderFrom = Math.max(T_PAST_MIN,   vMin);
    var renderTo   = Math.min(T_FUTURE_MIN, vMax);
    var lastHistPx = -999, lastPredPx = -999;
    for (var hi = 0; hi < TOTAL_HELPER; hi++) {
      var ts_i   = helper.startMs + hi * 60000;
      var tMin_i = (ts_i - nowMs) / 60000;
      if (tMin_i < renderFrom || tMin_i > renderTo) continue;
      var xPx_i = tMinToPx(tMin_i, W_chart);
      if (xPx_i < L_YAXIS - 1 || xPx_i > SVG_W - R + 1) continue;
      var M_i = helper.points[hi];
      var yPx_i = yPx(M_i, H);
      // Skip samples whose M value is outside the current Y display range.
      // The clip-path handles boundary clipping; clamping instead causes the line
      // to visually stick to the ceiling/floor in focus mode.
      if (M_i < Y_MIN || M_i > Y_MAX) continue;

      if (ts_i <= predStartTs) {
        // Historical region
        if (Math.abs(xPx_i - lastHistPx) >= 0.5) {
          histPoints.push({ x: xPx_i, y: yPx_i });
          lastHistPx = xPx_i;
        }
      } else {
        // Prediction region
        if (Math.abs(xPx_i - lastPredPx) >= 0.5) {
          predPoints.push({ x: xPx_i, y: yPx_i });
          lastPredPx = xPx_i;
        }
      }
    }

    if (histPoints.length > 1) {
      var path = 'M' + f(histPoints[0].x) + ',' + f(histPoints[0].y);
      for (var i = 1; i < histPoints.length; i++) {
        path += ' L' + f(histPoints[i].x) + ',' + f(histPoints[i].y);
      }
      s += '<path d="' + path + '" stroke="' + C.curveHistory + '" stroke-width="3.5" fill="none" stroke-linecap="round" clip-path="url(#' + _clipId + ')"/>';
    }

    if (predPoints.length > 1) {
      var path2 = 'M' + f(predPoints[0].x) + ',' + f(predPoints[0].y);
      for (var j = 1; j < predPoints.length; j++) {
        path2 += ' L' + f(predPoints[j].x) + ',' + f(predPoints[j].y);
      }
      s += '<path d="' + path2 + '" stroke="' + C.curvePredict + '" stroke-width="2.0" fill="none"' +
           ' stroke-dasharray="7 4" stroke-linecap="round" stroke-width="3.0" clip-path="url(#' + _clipId + ')\"/>';
    }

    // ── Data point markers ────────────────────────────────────────────────
    _resolvedPoints.forEach(function (dp) {
      var t_min = (dp.ts - nowMs) / 60000;
      if (t_min < vMin || t_min > vMax) return;
      if (dp.M > Y_MAX || dp.M < Y_MIN) return;  // hide markers outside display range
      var dpX = f(tMinToPx(t_min, W_chart));
      var dpY = f(yPx(dp.M, H));
      s += '<circle cx="' + dpX + '" cy="' + dpY + '" r="4" fill="rgba(0,0,0,0.25)"' +
           ' stroke="' + C.curveHistory + '" stroke-width="1.5"/>';
      s += '<circle cx="' + dpX + '" cy="' + dpY + '" r="1.8" fill="#ffffff"/>';

      // All-bubbles mode: foreignObject bubble with full CSS word-wrap
      if (_showAllBubbles && dp.event) {
        var dSign = (dp.delta !== undefined && dp.delta !== null) ? ((dp.delta >= 0 ? '+' : '') + dp.delta + '  ') : '';
        var label = dSign + dp.event;
        var foW = 200;
        var cx2 = parseFloat(dpX);
        var cy2 = parseFloat(dpY);
        var foX = cx2 - foW / 2;
        var bubbleH = 40; // approx; foreignObject content flows beyond if multi-line
        var nearTop = cy2 - T < 60;
        var foY = nearTop ? cy2 + 10 : cy2 - 10 - bubbleH;
        s += '<foreignObject x="' + f(foX) + '" y="' + f(foY) + '" width="' + foW + '" height="200" overflow="visible">' +
             '<div xmlns="http://www.w3.org/1999/xhtml" style="' +
               'display:inline-block;max-width:' + foW + 'px;padding:5px 8px;' +
               'background:rgba(15,17,23,0.93);border:1px solid rgba(255,105,180,0.35);' +
               'border-radius:5px;font-size:16px;font-weight:600;color:rgba(255,255,255,0.92);' +
               'word-break:break-word;line-height:1.35;font-family:sans-serif;' +
             '">' + esc(label) + '</div>' +
             '</foreignObject>';
      }
    });

    // ── Hover crosshair elements (hidden initially) ───────────────────────
    s += '<rect id="lm-hit" x="' + L_YAXIS + '" y="0" width="' + W_chart + '" height="' + H +
         '" fill="rgba(0,0,0,0)" style="cursor:crosshair"/>';
    s += '<line id="lm-hl" x1="0" y1="' + T + '" x2="0" y2="' + (H - B) +
         '" stroke="' + C.crosshair + '" stroke-width="1.4" stroke-dasharray="5 5" visibility="hidden"/>';
    s += '<circle id="lm-hd" cx="0" cy="0" r="4" fill="' + C.curveHistory + '" stroke="' + C.dotStroke + '" stroke-width="1.5" visibility="hidden"/>';

    svg.setAttribute('width',   SVG_W);
    svg.setAttribute('height',  H);
    svg.setAttribute('viewBox', '0 0 ' + SVG_W + ' ' + H);
    svg.style.width  = SVG_W + 'px';
    svg.style.height = H + 'px';
    svg.style.cursor = 'crosshair';
    svg.innerHTML    = s;

    svg._W_chart = W_chart;
    svg._H       = H;
    svg._helper  = helper;
    svg._nowMs   = nowMs;

    _graphCache = { key: cacheKey, markup: s };

    _bindSvgHandlers();
    updateNowLine(W_chart, H);
  }

  // ── Hover / tooltip ───────────────────────────────────────────────────────
  function _bindSvgHandlers() {
    svg.removeEventListener('mousemove', _onHoverThrottled);
    svg.removeEventListener('mouseleave', _onLeave);
    svg.removeEventListener('touchmove', _onHoverThrottled);
    svg.removeEventListener('touchend', _onLeave);
    svg.addEventListener('mousemove',  _onHoverThrottled);
    svg.addEventListener('mouseleave', _onLeave);
    svg.addEventListener('touchmove',  _onHoverThrottled, { passive: true });
    svg.addEventListener('touchend',   _onLeave);
  }

  function _onHoverThrottled(e) {
    _lastHoverE = e;
    if (_hoverRaf) return;
    _hoverRaf = requestAnimationFrame(function () {
      _hoverRaf = null;
      if (_lastHoverE) _processHover(_lastHoverE);
    });
  }

  function _onLeave() {
    if (pointBubble) pointBubble.classList.remove('show');
    var hl = svg.querySelector('#lm-hl');
    var hd = svg.querySelector('#lm-hd');
    if (hl) hl.setAttribute('visibility', 'hidden');
    if (hd) hd.setAttribute('visibility', 'hidden');
    _lastHoverPoint = null;
  }

  function _processHover(e) {
    if (_isPanning) return;   // suppress tooltip while panning
    if (!svg._helper || !svg._W_chart) return;
    var wRect  = scrollWrap.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var W_chart = svg._W_chart;
    var H       = svg._H;

    var svgX = clientX - wRect.left;
    if (svgX < L_YAXIS || svgX > wRect.width - R) { _onLeave(); return; }

    var t_min  = pxToTMin(svgX, W_chart);
    var ts     = svg._nowMs + t_min * 60000;
    var helper = svg._helper;
    var idx    = Math.round((ts - helper.startMs) / 60000);
    if (idx < 0 || idx >= helper.points.length) { _onLeave(); return; }

    var M  = helper.points[idx];
    var cx = f(svgX);
    var cy = f(yPx(Math.min(M, Y_MAX), H));

    // ── Snap detection ────────────────────────────────────────────────────
    var _vpMin = viewOffset - VIEW_HALF_MIN;
    var _vpMax = viewOffset + VIEW_HALF_MIN;
    _snapPoint = null;
    var bestDist = SNAP_PX;
    for (var si = 0; si < _dataPoints.length; si++) {
      var dp = _dataPoints[si];
      var dpTMin = (dp.ts - svg._nowMs) / 60000;
      if (dpTMin < _vpMin || dpTMin > _vpMax) continue;
      if (dp.M > Y_MAX || dp.M < Y_MIN) continue;  // skip out-of-range markers
      var dpXPx = tMinToPx(dpTMin, W_chart);
      var dist  = Math.abs(svgX - dpXPx);
      if (dist < bestDist) { bestDist = dist; _snapPoint = dp; }
    }
    // If snapped, override all display values with the logged point
    if (_snapPoint) {
      ts    = _snapPoint.ts;
      M     = _snapPoint.M;
      t_min = (ts - svg._nowMs) / 60000;
      idx   = Math.round((ts - helper.startMs) / 60000);
      cx    = f(tMinToPx(t_min, W_chart));
      cy    = f(yPx(M, H));
    }

    var hl = svg.querySelector('#lm-hl');
    var hd = svg.querySelector('#lm-hd');
    var inRange = (M >= Y_MIN && M <= Y_MAX);
    if (hl) { hl.setAttribute('x1', cx); hl.setAttribute('x2', cx); hl.setAttribute('visibility', 'visible'); }
    if (hd) { hd.setAttribute('cx', cx); hd.setAttribute('cy', cy); hd.setAttribute('visibility', inRange ? 'visible' : 'hidden'); }

    _lastHoverPoint = { tMin: t_min, M: M, ts: ts };

    // ── Speech bubble: show whenever snapped to a logged data point ──────
    if (_snapPoint && pointBubble) {
      var evtName  = _snapPoint.event || '';
      var evtDelta = (_snapPoint.delta !== undefined && _snapPoint.delta !== null)
                       ? _snapPoint.delta : null;

      // Always show something — fallback to M value + date/time
      var date  = new Date(_snapPoint.ts);
      var tStr  = String(date.getHours()).padStart(2,'0') + ':' + String(date.getMinutes()).padStart(2,'0');
      var dStr  = date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
      var Mdisp = _snapPoint.M >= 10000 ? (_snapPoint.M/1000).toFixed(1)+'k' : Math.round(_snapPoint.M).toString();

      if (bubbleEvent) {
        var labelText = evtName || (dStr + ' ' + tStr + '  ♥ ' + Mdisp);
        if (evtDelta !== null) {
          var dSign = evtDelta >= 0 ? '+' : '';
          labelText += '  (' + dSign + evtDelta + ')';
        }
        bubbleEvent.textContent = labelText;
        bubbleEvent.style.display = '';
      }
      // Position bubble at the data point (fixed coords)
      var ptX = wRect.left + parseFloat(cx);
      var ptY = wRect.top  + parseFloat(cy);
      pointBubble.style.left = ptX + 'px';
      pointBubble.style.top  = ptY + 'px';
      pointBubble.classList.add('show');
    } else if (pointBubble) {
      pointBubble.classList.remove('show');
    }
  }

  // ── Chart click: open event drawer at hovered / snapped point ───────────
  svg.addEventListener('click', function (e) {
    if (_panMoved) { _panMoved = false; return; }
    if (!_lastHoverPoint) return;
    var ts = _snapPoint ? _snapPoint.ts : _lastHoverPoint.ts;
    var M  = _snapPoint ? _snapPoint.M  : _lastHoverPoint.M;
    _openEventDrawer(ts, M, _snapPoint || null);
  });

  // ── Event drawer ─────────────────────────────────────────────────────────
  function _tsToDatetimeLocal(ts) {
    var d = new Date(ts);
    var pad = function(n){ return String(n).padStart(2,'0'); };
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function _renderDrawerPresets() {
    if (!drawerPresetList) return;
    var presets = lmPresetsLoad();
    if (presets.length === 0) {
      drawerPresetList.innerHTML = '<span class="lm-preset-empty">No presets yet</span>';
      return;
    }
    drawerPresetList.innerHTML = presets.map(function (p) {
      var label = esc(p.name) + ' <span class="lm-preset-delta">' + (p.delta > 0 ? '+' : '') + p.delta + '</span>';
      return '<span class="lm-preset-chip" data-id="' + esc(p.id) + '" data-delta="' + p.delta + '" data-name="' + esc(p.name) + '">' +
               label +
               '<button class="lm-preset-chip-del" data-id="' + esc(p.id) + '" aria-label="Delete preset">×</button>' +
             '</span>';
    }).join('');
    // Apply button — auto-register immediately
    drawerPresetList.querySelectorAll('.lm-preset-chip').forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        if (e.target.classList.contains('lm-preset-chip-del')) return;
        var name  = chip.getAttribute('data-name') || '';
        var delta = parseInt(chip.getAttribute('data-delta'), 10);
        _drawerApplyDelta(name, delta);
      });
    });
    // Delete button
    drawerPresetList.querySelectorAll('.lm-preset-chip-del').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        lmPresetsDelete(btn.getAttribute('data-id'));
        _renderDrawerPresets();
      });
    });
  }

  function _openEventDrawer(ts, currentM, existingPoint) {
    _drawerTs    = ts;
    _drawerM     = currentM;
    _drawerPoint = existingPoint || null;
    _eyeActive   = false;

    // Apply current train line colour as drawer accent
    var accent = (typeof currentAccentColor !== 'undefined' && currentAccentColor)
      ? currentAccentColor : 'var(--color-accent-primary)';
    eventDrawer.style.setProperty('--lm-drawer-accent', accent);
    eventDrawer.style.setProperty('--lm-drawer-accent-hover', accent);
    eventDrawer.style.setProperty('--lm-drawer-accent-bg', 'rgba(0,0,0,0.08)');
    eventDrawer.style.setProperty('--lm-drawer-accent-focus', 'rgba(0,0,0,0.10)');
    eventDrawer.style.setProperty('--lm-drawer-border-bottom', accent);

    // Title
    if (drawerTitle) drawerTitle.textContent = 'WHAT HAPPENED???';

    // When
    if (drawerWhen) drawerWhen.value = _tsToDatetimeLocal(ts);

    // Presets (localStorage)
    _renderDrawerPresets();

    // Wire new-preset inputs: Enter on either field → add preset + apply
    function _wireNewPresetEnter(el) {
      if (!el) return;
      el.onkeydown = function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var name  = newPresetName  ? newPresetName.value.trim()       : '';
        var delta = newPresetDelta ? parseInt(newPresetDelta.value, 10) : NaN;
        if (!name || isNaN(delta)) return;
        lmPresetsAdd(name, delta);
        if (newPresetName)  newPresetName.value  = '';
        if (newPresetDelta) newPresetDelta.value = '';
        _renderDrawerPresets();
        _drawerApplyDelta(name, delta);
      };
    }
    _wireNewPresetEnter(newPresetName);
    _wireNewPresetEnter(newPresetDelta);

    // Reset eye toggle
    if (drawerEyeBtn)  drawerEyeBtn.classList.remove('active');
    if (drawerEyeDur)  drawerEyeDur.style.display = 'none';
    if (drawerEyeInput) {
      drawerEyeInput.value = '';
      drawerEyeInput.onkeydown = function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var ms = Number(drawerEyeInput.value);
        if (isNaN(ms) || ms <= 0) return;
        var sec = (ms / 1000).toFixed(3).replace('.', ',');
        var eventLabel = 'Made eye-contact for ' + sec + ' seconds';
        var delta = computeEyeContactDeltaM(ms, _drawerM);
        _drawerApplyDelta(eventLabel, delta);
      };
    }

    // Reset override field
    if (drawerAbs) {
      drawerAbs.value = existingPoint ? String(existingPoint.M) : '';
      drawerAbs.onkeydown = function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var val = Number(drawerAbs.value);
        if (isNaN(val)) return;
        _drawerApplyOverride('Manual override!', val);
      };
    }

    // Footer: show Save+Delete only when editing existing
    if (drawerLog)    drawerLog.style.display    = existingPoint ? 'none' : '';
    if (drawerSave)   drawerSave.style.display   = existingPoint ? '' : 'none';
    if (drawerDelete) drawerDelete.style.display = existingPoint ? '' : 'none';

    // Open
    if (eventDrawer) {
      eventDrawer.classList.add('is-open');
      eventDrawer.setAttribute('aria-hidden', 'false');
    }
    document.body.classList.add('lm-drawer-open');
    _drawerOpen = true;
  }

  function _closeEventDrawer() {
    if (eventDrawer) {
      eventDrawer.classList.remove('is-open');
      eventDrawer.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('lm-drawer-open');
    _drawerOpen  = false;
    _drawerPoint = null;
  }

  // ── Save helpers ─────────────────────────────────────────────────────────
  function _currentTs() {
    var whenVal = drawerWhen ? new Date(drawerWhen.value).getTime() : _drawerTs;
    return isNaN(whenVal) ? _drawerTs : whenVal;
  }

  function _commitPoint(newPoint) {
    saveLovemeterPoint(newPoint).then(function(pts) {
      _dataPoints = pts;
      invalidateLovemeterCache();
      _graphCache.key = '';
      _lastBadgeM = -1;
      updateLovemeterBadge();
      _renderStats();
      if (dashboardOpen) renderGraph();
    });
    _closeEventDrawer();
  }

  function _drawerApplyDelta(eventName, deltaM) {
    var ts = _currentTs();
    var newPoint = applyLovemeterDelta(ts, deltaM, _dataPoints);
    if (eventName) newPoint.event = eventName;
    newPoint.delta = deltaM;
    _commitPoint(newPoint);
  }

  function _drawerApplyOverride(eventName, Mvalue) {
    var ts = _currentTs();
    var newPoint = applyLovemeterOverride(ts, Mvalue);
    if (eventName) newPoint.event = eventName;
    _commitPoint(newPoint);
  }

  // Save button — only shown when editing an existing point (e.g. change the When field)
  function _drawerSaveAndClose() {
    if (!_drawerPoint) return;
    var ts = _currentTs();
    var absVal = (drawerAbs && drawerAbs.value !== '') ? Number(drawerAbs.value) : null;
    var newPoint;
    if (absVal !== null && !isNaN(absVal)) {
      newPoint = applyLovemeterOverride(ts, absVal);
      newPoint.event = _drawerPoint.event || 'Manual override!';
    } else {
      newPoint = { ts: ts, M: _drawerPoint.M };
      if (_drawerPoint.event) newPoint.event = _drawerPoint.event;
      if (_drawerPoint.delta !== undefined) newPoint.delta = _drawerPoint.delta;
    }
    _commitPoint(newPoint);
  }

  if (drawerClose)  drawerClose.addEventListener('click', _closeEventDrawer);
  if (drawerLog)    drawerLog.addEventListener('click', function () {
    var ts = _currentTs();
    var absVal = (drawerAbs && drawerAbs.value !== '') ? Number(drawerAbs.value) : null;
    var newPoint;
    if (absVal !== null && !isNaN(absVal)) {
      newPoint = applyLovemeterOverride(ts, absVal);
      newPoint.event = 'Manual override!';
    } else {
      newPoint = { ts: ts, M: getLovemeterMoodAt(ts, _dataPoints) };
    }
    _commitPoint(newPoint);
  });
  if (drawerSave)   drawerSave.addEventListener('click', _drawerSaveAndClose);

  if (drawerDelete) {
    drawerDelete.addEventListener('click', function () {
      if (!_drawerPoint) return;
      var pt = _drawerPoint;
      _closeEventDrawer();
      deleteLovemeterPoint(pt.ts).then(function(pts) {
        _dataPoints = pts;
        _snapPoint  = null;
        invalidateLovemeterCache();
        _graphCache.key = '';
        _lastBadgeM = -1;
        updateLovemeterBadge();
        _renderStats();
        if (dashboardOpen) renderGraph();
      });
    });
  }

  if (drawerEyeBtn) {
    drawerEyeBtn.addEventListener('click', function () {
      _eyeActive = !_eyeActive;
      drawerEyeBtn.classList.toggle('active', _eyeActive);
      if (drawerEyeDur) {
        drawerEyeDur.style.display = _eyeActive ? 'inline-flex' : 'none';
        if (_eyeActive && drawerEyeInput) setTimeout(function () { drawerEyeInput.focus(); }, 50);
      }
    });
  }

  // Keyboard shortcuts handled globally below

  // ── Stats rendering ───────────────────────────────────────────────────────
  function _renderStats() {
    if (!statsZone) return;
    var nowMs  = Date.now();
    var cfg    = LOVEMETER_CONFIG;
    var state  = getCurrentMoodState(_dataPoints);
    var M      = state.M;
    var slope  = state.slope;
    var attr   = computeDerivedAttributes(M);

    var zoneClass;
    if      (M < cfg.M_COLORLESS) zoneClass = 'lm-stat-red';
    else if (M < cfg.M_MOODY)     zoneClass = 'lm-stat-red';
    else if (M < cfg.M_NORMAL)    zoneClass = 'lm-stat-green';
    else if (M < cfg.M_CRUSH)     zoneClass = 'lm-stat-pink';
    else                           zoneClass = 'lm-stat-purple';

    var Mdisp     = M >= 10000 ? (M/1000).toFixed(1)+'k' : Math.round(M).toString();
    var slopeStr  = (slope >= 0 ? '+' : '') + slope.toFixed(2) + ' M/min';
    var slopeCls  = slope >= 0 ? 'lm-stat-green' : 'lm-stat-red';

    var helper   = getLovemeterHelperArray(_dataPoints);
    var idx6h    = Math.round((nowMs + 6*60*60000  - helper.startMs) / 60000);
    var idx24h   = Math.round((nowMs + 24*60*60000 - helper.startMs) / 60000);
    var M6h      = (idx6h  >= 0 && idx6h  < helper.points.length) ? helper.points[idx6h]  : cfg.BASELINE;
    var M24h     = (idx24h >= 0 && idx24h < helper.points.length) ? helper.points[idx24h] : cfg.BASELINE;
    var M6hDisp  = M6h  >= 10000 ? (M6h /1000).toFixed(1)+'k' : Math.round(M6h).toString();
    var M24hDisp = M24h >= 10000 ? (M24h/1000).toFixed(1)+'k' : Math.round(M24h).toString();

    var sortedPts = _dataPoints.slice().sort(function(a,b){ return a.ts - b.ts; });
    var lastPt    = sortedPts.length ? sortedPts[sortedPts.length-1] : null;
    var maxPt     = sortedPts.reduce(function(best, p){ return p.M > (best ? best.M : -Infinity) ? p : best; }, null);
    var minPt     = sortedPts.reduce(function(best, p){ return p.M < (best ? best.M : Infinity)  ? p : best; }, null);

    var lastStr       = lastPt ? new Date(lastPt.ts).toLocaleString('en-GB', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
    var timeSinceLast = lastPt ? (function(){ var ms = nowMs - lastPt.ts; var h = Math.floor(ms/3600000); var m = Math.floor((ms%3600000)/60000); return h > 0 ? h+'h '+m+'m ago' : m+'m ago'; })() : '—';
    var pct = function(v) { return (v * 100).toFixed(0) + '%'; };

    var overviewRows = [
      { label: 'Current mood',       value: Mdisp,                  cls: zoneClass },
      { label: 'Slope',              value: slopeStr,                cls: slopeCls  },
      { label: 'Forecast +6 h',      value: M6hDisp,                 cls: '' },
      { label: 'Forecast +24 h',     value: M24hDisp,                cls: '' },
      { label: 'All-time high',      value: maxPt ? String(Math.round(maxPt.M)) : '—', cls: 'lm-stat-pink' },
      { label: 'All-time low',       value: minPt ? String(Math.round(minPt.M)) : '—', cls: 'lm-stat-red'  },
      { label: 'Logged events',      value: String(_dataPoints.length),               cls: '' },
      { label: 'Time since last',    value: timeSinceLast,           cls: '' },
    ];

    var attrRows = [
      { label: 'Motivation',                  value: pct(attr.motivation),                    cls: '' },
      { label: 'Social confidence',           value: pct(attr.social),                        cls: '' },
      { label: 'Outfit drive',                value: pct(attr.outfit),                        cls: '' },
      { label: 'Music damage',                value: attr.music_damage.toFixed(1) + ' dB',    cls: '' },
      { label: 'Eye-contact reactivity',      value: attr.eye_reactivity.toFixed(4) + ' /ms', cls: '' },
      { label: 'Thought recurrence rate',     value: attr.thought.toFixed(1) + ' t/h',        cls: '' },
      { label: 'Replay-loop frequency',       value: attr.replay.toFixed(1),                  cls: '' },
      { label: 'Notification sensitivity',    value: pct(attr.notification),                  cls: '' },
      { label: 'Train-window delusion',       value: pct(attr.train_window),                  cls: '' },
      { label: 'Coincidence significance',    value: attr.coincidence.toFixed(2) + '×',       cls: '' },
      { label: 'Sunlight amplification',      value: attr.sunlight.toFixed(2) + '×',          cls: '' },
      { label: 'Lyric interpretation',        value: attr.lyric.toFixed(2) + '×',             cls: '' },
      { label: 'Delusion persistence',        value: attr.delusion.toFixed(2) + '×',          cls: '' },
      { label: 'Emotional inertia',           value: attr.inertia.toFixed(2) + '×',           cls: '' },
      { label: 'Cognitive focus stability',   value: pct(attr.focus),                         cls: '' },
      { label: 'Sleep probability',           value: pct(attr.sleep),                         cls: '' },
    ];

    function _renderGrid(rows) {
      var s = '<div class="lm-stats-grid">';
      rows.forEach(function(row) {
        s += '<div class="project-info-section lm-stat-row">' +
          '<div class="project-field-label">' + esc(row.label) + '</div>' +
          '<div class="project-field-value ' + row.cls + '">' + esc(row.value) + '</div>' +
          '<div class="lm-stat-spacer"></div>' +
          '</div>';
      });
      s += '</div>';
      return s;
    }

    var html = '<div class="lm-stats-groups">' +
      _renderGrid(overviewRows) +
      _renderGrid(attrRows) +
      '</div>';
    statsZone.innerHTML = html;
  }

  // ── Badge interactions ────────────────────────────────────────────────────
  badge.addEventListener('click', _toggleDashboard);

  var backBtn = document.getElementById('lm-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', function () {
      if (dashboardOpen) _toggleDashboard();
    });
  }

  var quickLogBtn = document.getElementById('lm-quick-log-btn');
  if (quickLogBtn) {
    quickLogBtn.addEventListener('click', function () {
      var nowMs2 = Date.now();
      var M2 = getLovemeterMoodAt(nowMs2, _dataPoints);
      _openEventDrawer(nowMs2, M2, null);
    });
  }

  if (badgeEdit) {
    badgeEdit.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var nowMs2 = Date.now();
      var M      = getLovemeterMoodAt(nowMs2, _dataPoints);
      if (!dashboardOpen) _toggleDashboard();
      _openEventDrawer(nowMs2, M, null);
    });
  }

  function _toggleDashboard() {
    dashboardOpen = !dashboardOpen;
    dashboard.classList.toggle('is-open', dashboardOpen);
    document.body.classList.toggle('lm-open', dashboardOpen);
    dashboard.setAttribute('aria-hidden', String(!dashboardOpen));
    badge.setAttribute('aria-expanded', String(dashboardOpen));
    if (dashboardOpen) {
      _renderStats();
      requestAnimationFrame(function () { requestAnimationFrame(renderGraph); });
    } else {
      if (_drawerOpen) _closeEventDrawer();
      updateNowLine(svg._W_chart || 400, svg._H || 260);
    }
  }

  // Global keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    var active = document.activeElement;
    var tag = active ? active.tagName : '';
    var inInput = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

    // Escape: close drawer if open, otherwise close lovemeter
    if (e.key === 'Escape') {
      if (_drawerOpen) {
        e.preventDefault();
        _closeEventDrawer();
      } else if (dashboardOpen) {
        e.preventDefault();
        _toggleDashboard();
      }
      return;
    }

    // Ctrl+A: open event drawer for the current moment (independent of lovemeter overlay)
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !e.shiftKey) {
      if (inInput) return;
      e.preventDefault();
      var nowMs2 = Date.now();
      var M2 = getLovemeterMoodAt(nowMs2, _dataPoints);
      _openEventDrawer(nowMs2, M2, null);
    }
  });

  // ── Pan / swipe on the chart ─────────────────────────────────────────────────
  // Minutes per pixel — defined by the linear zone's rate so dragging feels
  // consistent regardless of where in the chart the user grabs.
  function _panDeltaMin(dPx, W_chart) {
    return -dPx * (2 * LINEAR_CLAMP_MIN) / (LIN_FRAC * W_chart);
  }

  function _panStart(clientX) {
    _panStartX   = clientX;
    _panStartOfs = viewOffset;
    _isPanning   = false;
    _panMoved    = false;
  }

  function _panMove(clientX) {
    if (_panStartX === null) return;
    var W_chart = svg._W_chart || (scrollWrap.clientWidth - L_YAXIS - R);
    var dx = clientX - _panStartX;
    if (!_isPanning && Math.abs(dx) > 5) {
      _isPanning = true;
      _panMoved  = true;
      _onLeave();  // hide tooltip immediately
    }
    if (!_isPanning) return;
    viewOffset = _clampViewOffset(_panStartOfs + _panDeltaMin(dx, W_chart));
    if (_panRaf) return;
    _panRaf = requestAnimationFrame(function () {
      _panRaf = null;
      _graphCache.key = '';
      renderGraph();
    });
  }

  function _panEnd() {
    _isPanning = false;
    _panStartX = null;
  }

  // Mouse (desktop)
  scrollWrap.addEventListener('mousedown', function (e) { _panStart(e.clientX); });
  document.addEventListener('mousemove', function (e) {
    if (_panStartX !== null) _panMove(e.clientX);
  });
  document.addEventListener('mouseup', _panEnd);

  // Touch (mobile / trackpad)
  scrollWrap.addEventListener('touchstart', function (e) {
    _panStart(e.touches[0].clientX);
  }, { passive: true });
  scrollWrap.addEventListener('touchmove', function (e) {
    _panMove(e.touches[0].clientX);
  }, { passive: true });
  scrollWrap.addEventListener('touchend', _panEnd, { passive: true });
  scrollWrap.addEventListener('touchcancel', _panEnd, { passive: true });

  // ── Wheel scroll (treated as horizontal drag with inertia) ────────────────
  var _wVel = 0;
  var _wRaf = null;
  function _wStep() {
    if (Math.abs(_wVel) < 0.01) { _wRaf = null; _wVel = 0; return; }
    var W_chart = svg._W_chart || (scrollWrap.clientWidth - L_YAXIS - R);
    viewOffset = _clampViewOffset(viewOffset + _panDeltaMin(_wVel, W_chart));
    _wVel *= 0.88;
    _graphCache.key = '';
    renderGraph();
    _wRaf = requestAnimationFrame(_wStep);
  }
  scrollWrap.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      // deltaY > 0 = scroll down = scroll forward in time (rightward)
      _wVel += e.deltaY * 0.4;
      if (!_wRaf) _wRaf = requestAnimationFrame(_wStep);
    }
  }, { passive: false });

  // ── Resize / scroll ───────────────────────────────────────────────────────
  var _resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!dashboardOpen) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function () {
      _graphCache.key = '';
      renderGraph();
    }, 250);
  });

  // ── Periodic badge refresh (every minute) ─────────────────────────────────
  setInterval(updateLovemeterBadge, 60000);
  updateLovemeterBadge();

  // ── Public API ────────────────────────────────────────────────────────────
  window.updateLovemeterBadge = updateLovemeterBadge;

  window.lovemeterOnDataChanged = function () {
    loadLovemeterDataPoints().then(function(pts) {
      _dataPoints = pts;
      invalidateLovemeterCache();
      _graphCache.key = '';
      _lastBadgeM = -1;
      updateLovemeterBadge();
      _renderStats();
      if (dashboardOpen) renderGraph();
    });
  };

})();
