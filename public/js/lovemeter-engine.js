// === LOVEMETER ENGINE ===
// Pure computation module — Moodmeter/Lovemeter subsystem.
// Implements centripetal Catmull–Rom spline interpolation for historical data
// and ODE-based prediction for future emotional trajectory.
// No DOM access, no side effects outside the in-memory cache.
// All tunable parameters live in LOVEMETER_CONFIG below.

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — every adjustable coefficient in one place.
// ─────────────────────────────────────────────────────────────────────────────
const LOVEMETER_CONFIG = {

  // ── Emotional point baseline & limits ─────────────────────────────────────
  M_BASE:    1000,   // Mbase: psychologically neutral but emotionally healthy state
  M_MIN:     0,      // Hard floor for emotional point
  M_MAX:     1e7,    // Hard ceiling (display clips at Y_DISPLAY_MAX)

  // ── Zone thresholds (from spec table 1) ───────────────────────────────────
  M_COLORLESS: 150,    // M < 150: colorless / emotionally depleted
  M_MOODY:     700,    // 150 ≤ M < 700: moody / emotionally suppressed
  M_NORMAL:    1500,   // 700 ≤ M < 1500: normal emotionally active
  M_CRUSH:     10000,  // 1500 ≤ M < 10000: elevated / crush state
  M_SEVERE:    1e6,    // 10000 ≤ M < 1e6: severe amplification
                       // M ≥ 1e6: emotionally supercritical

  // ── Prediction ODE parameters ─────────────────────────────────────────────
  // System: dx/dt = m,  dm/dt = p(x)·(m_target − m)
  //         m_target = −k_eff·(x − B),  k_eff = K_BASE / P(x)
  //         P(x) = 1 + (|x| / PERSIST_NORM)^PERSIST_EXP,  p(x) = P0 / P(x)
  BASELINE:     1000,   // B: emotional equilibrium target
  K_BASE:       0.10,   // base return-toward-baseline strength (per minute)
  P0:           0.04,   // base slope-adaptation coefficient (per minute)
  PERSIST_EXP:  1.2,    // exponent in persistence factor
  PERSIST_NORM: 1000,   // normalization constant in persistence factor

  // ── Temporal axis distortion (spec §2.8) ──────────────────────────────────
  // x = sign(t) · ((|t| + ε) / α)^(1/5)   where t is minutes from now
  ALPHA:       0.0003, // α: distortion scaling parameter
  EPSILON_MIN: 1,      // ε: numerical stability clamp near t=0 (in minutes)

  // ── Time window ───────────────────────────────────────────────────────────
  PAST_DAYS:   5,    // history shown to the left of "now"
  FUTURE_DAYS: 21,   // prediction shown to the right of "now"

  // ── Eye-contact interaction model (spec §2.5) ─────────────────────────────
  // ΔM_eye = r_eye · t_eye,  r_eye = λ·(M − M0)
  LAMBDA:  1e-4,   // λ: eye-contact reactivity scaling
  EYE_M0:  700,    // M0: threshold below which eye-contact has no effect

  // ── Preset single events (spec §2.4) ─────────────────────────────────────
  // Each event applies ΔM to the current M retrieved from the helper array.
  PRESET_EVENTS: [],   // user-defined presets — managed via localStorage, see lmPresets*

  // ── Rendering ─────────────────────────────────────────────────────────────
  Y_DISPLAY_MAX: 10000,  // chart clips M values above this for display
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORAL DISTORTION (spec §2.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert real elapsed time (minutes from now, negative = past) to
 * the distorted graph coordinate x.
 *   x = sign(t) · ((|t| + ε) / α)^(1/5)
 */
function lmTimeToX(t_min, alpha, epsilon) {
  return Math.sign(t_min) * Math.pow((Math.abs(t_min) + epsilon) / alpha, 0.2);
}

/**
 * Convert distorted graph coordinate x back to minutes from now.
 *   t = sign(x) · (α · |x|^5 − ε)
 */
function lmXToTime(x, alpha, epsilon) {
  if (x === 0) return 0;
  const raw = alpha * Math.pow(Math.abs(x), 5) - epsilon;
  return Math.sign(x) * Math.max(0, raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// CATMULL–ROM SPLINE — non-uniform parameterization (spec §2.10)
// Interpolates M as a function of timestamp t.
// Tangents are computed using the Catmull–Rom finite difference rule, adjusted
// for non-uniform time spacing. Ghost points extend the spline at both ends.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hermite basis functions for u ∈ [0,1]:
 *   P(u) = h00·P0 + h10·dt·T0 + h01·P1 + h11·dt·T1
 */
function _hermiteEval(u, M0, M1, T0, T1, dt) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 =  2*u3 - 3*u2 + 1;
  const h10 =    u3 - 2*u2 + u;
  const h01 = -2*u3 + 3*u2;
  const h11 =    u3 -   u2;
  return h00*M0 + h10*dt*T0 + h01*M1 + h11*dt*T1;
}

/**
 * Compute Catmull–Rom tangents for a sorted array of {ts, M} data points.
 * Returns an array of tangent values (dM/dt, units: M per ms).
 */
function _computeCRTangents(pts) {
  const n = pts.length;
  const T = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      // Forward difference at left endpoint
      const dt = pts[1].ts - pts[0].ts;
      T[i] = dt > 0 ? (pts[1].M - pts[0].M) / dt : 0;
    } else if (i === n - 1) {
      // Backward difference at right endpoint
      const dt = pts[n-1].ts - pts[n-2].ts;
      T[i] = dt > 0 ? (pts[n-1].M - pts[n-2].M) / dt : 0;
    } else {
      // Central difference (non-uniform spacing)
      const dt_total = pts[i+1].ts - pts[i-1].ts;
      T[i] = dt_total > 0 ? (pts[i+1].M - pts[i-1].M) / dt_total : 0;
    }
  }
  return T;
}

/**
 * Build a spline evaluator function from sorted data points.
 * Returns a function (ts_ms) => M, valid for ts_ms within the data range.
 * Returns null for queries outside the range (caller handles extrapolation).
 */
function buildMoodSpline(dataPoints) {
  const pts = dataPoints.slice().sort((a, b) => a.ts - b.ts);
  if (pts.length === 0) return () => LOVEMETER_CONFIG.M_BASE;
  if (pts.length === 1) return (ts) => (ts === pts[0].ts ? pts[0].M : null);

  const tangents = _computeCRTangents(pts);

  return function getMoodAt(ts) {
    if (ts < pts[0].ts || ts > pts[pts.length-1].ts) return null;
    if (ts === pts[0].ts) return pts[0].M;
    if (ts === pts[pts.length-1].ts) return pts[pts.length-1].M;

    // Binary search for the segment containing ts
    let lo = 0, hi = pts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid+1].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const dt = pts[i+1].ts - pts[i].ts;
    if (dt <= 0) return pts[i].M;
    const u = (ts - pts[i].ts) / dt;
    const M = _hermiteEval(u, pts[i].M, pts[i+1].M, tangents[i], tangents[i+1], dt);
    return Math.max(LOVEMETER_CONFIG.M_MIN, M);
  };
}

/**
 * Resolve relative (delta) data points against the evolving spline.
 * Points are processed left-to-right in chronological order.
 *   - Absolute points (no delta field): M used as stored.
 *   - Relative points (delta field present): M = spline_baseline_at_ts + delta,
 *     where the baseline spline is built from all previously resolved points.
 * This ensures that editing a past point cascades correctly to all
 * downstream relative points.
 */
function resolveDataPoints(rawPoints) {
  const cfg    = LOVEMETER_CONFIG;
  const sorted = rawPoints.slice().sort((a, b) => a.ts - b.ts);
  const resolved = [];

  for (var i = 0; i < sorted.length; i++) {
    var pt = sorted[i];
    if (pt.delta === undefined || pt.delta === null) {
      // Absolute / override point — M is canonical, use as-is
      resolved.push(Object.assign({}, pt));
    } else {
      // Relative point — baseline = spline of resolved so far at pt.ts
      var baselineM;
      if (resolved.length === 0) {
        baselineM = cfg.M_BASE;
      } else if (resolved.length === 1) {
        baselineM = resolved[0].M;
      } else {
        var spline = buildMoodSpline(resolved);
        var val    = spline(pt.ts);
        if (val !== null) {
          baselineM = val;
        } else if (pt.ts < resolved[0].ts) {
          baselineM = resolved[0].M;
        } else {
          baselineM = resolved[resolved.length - 1].M;
        }
      }
      resolved.push(Object.assign({}, pt, { M: Math.max(cfg.M_MIN, baselineM + pt.delta) }));
    }
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// ODE PREDICTION ENGINE (spec §2.12)
// Euler integration of the two-state ODE:
//   dx/dt = m
//   dm/dt = p(x)·(m_target − m)
//   m_target = −k_eff·(x − B)
//   P(x) = 1 + (|x| / P_norm)^P_exp
//   k_eff = K_BASE / P(x),   p(x) = P0 / P(x)
// ─────────────────────────────────────────────────────────────────────────────

function _lmPersistence(x, cfg) {
  return 1 + Math.pow(Math.abs(x) / cfg.PERSIST_NORM, cfg.PERSIST_EXP);
}

/**
 * Simulate the future emotional trajectory using Euler integration.
 * @param {number} x0       Initial emotional state (M at prediction start).
 * @param {number} m0       Initial emotional slope (M/minute at prediction start).
 * @param {number} numSteps Number of 1-minute steps to simulate.
 * @param {object} cfg      LOVEMETER_CONFIG.
 * @returns {Float64Array}  Predicted M value at each minute offset.
 */
function simulateLovemeterFuture(x0, m0, numSteps, cfg) {
  const B   = cfg.BASELINE;
  const out = new Float64Array(numSteps);
  let x = x0;
  let m = m0;

  for (let i = 0; i < numSteps; i++) {
    const P      = _lmPersistence(x, cfg);
    const kEff   = cfg.K_BASE / P;
    const mTarget = -kEff * (x - B);
    const pAdj   = cfg.P0 / P;
    // Euler step (dt = 1 minute)
    m += pAdj * (mTarget - m);
    x += m;
    x  = Math.max(cfg.M_MIN, x);
    out[i] = x;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER ARRAY (spec §2.2)
// 1-minute resolution array spanning PAST_DAYS before now to FUTURE_DAYS after.
// Combines spline interpolation (past) with ODE prediction (future).
// Cached in memory; invalidated on data change or after 60 minutes.
// ─────────────────────────────────────────────────────────────────────────────

let _lmHelperCache = null;
let _lmHelperCacheKey = '';

/**
 * Build (or return cached) helper array.
 * @param {Array} dataPoints  Array of {ts: ms, M: number} sorted or unsorted.
 * @returns {{ computedAt, startMs, points: Float64Array, lastDataTs }}
 */
function getLovemeterHelperArray(dataPoints) {
  const cfg    = LOVEMETER_CONFIG;
  const nowMs  = Date.now();
  const dpKey  = dataPoints.map(p => p.ts + ':' + p.M + ':' + (p.delta !== undefined ? p.delta : '')).join('|');

  // Reuse cache if data unchanged and computed within the last 60 minutes
  if (_lmHelperCache && _lmHelperCacheKey === dpKey) {
    if ((nowMs - _lmHelperCache.computedAt) < 60 * 60000) return _lmHelperCache;
  }

  const TOTAL_MINS = (cfg.PAST_DAYS + cfg.FUTURE_DAYS) * 1440;
  const startMs    = nowMs - cfg.PAST_DAYS * 24 * 60 * 60 * 1000;

  // Resolve relative (delta) points against the evolving baseline
  const resolved    = resolveDataPoints(dataPoints);
  const sorted      = resolved.slice().sort((a, b) => a.ts - b.ts);
  const lastPt      = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const lastDataMs  = lastPt ? lastPt.ts : null;

  // Build spline evaluator for the historical region
  const getMood = buildMoodSpline(sorted);

  // Determine prediction start: the last recorded data point (or now if none)
  const predStartMs = lastDataMs !== null ? lastDataMs : nowMs;

  // Initial conditions for ODE at predStartMs
  let x0 = lastPt ? lastPt.M : cfg.M_BASE;
  let m0 = 0;
  if (sorted.length >= 2) {
    const prev = sorted[sorted.length - 2];
    const dtMs = lastPt.ts - prev.ts;
    if (dtMs > 0) m0 = (lastPt.M - prev.M) / (dtMs / 60000); // M per minute
  }

  // Run ODE from predStartMs to end of window
  const predSteps = Math.ceil((startMs + TOTAL_MINS * 60000 - predStartMs) / 60000) + 2;
  const future    = predSteps > 0 ? simulateLovemeterFuture(x0, m0, predSteps, cfg) : new Float64Array(0);

  // Fill the helper array
  const points = new Float64Array(TOTAL_MINS);
  for (let i = 0; i < TOTAL_MINS; i++) {
    const ts = startMs + i * 60000;
    let M;
    if (ts <= predStartMs) {
      // Historical region: use spline (fall back to M_BASE if no data)
      const splineM = getMood(ts);
      if (splineM !== null) {
        M = splineM;
      } else if (sorted.length === 0) {
        M = cfg.M_BASE;
      } else if (ts < sorted[0].ts) {
        // Before first data point: extrapolate backward (flat from first point)
        M = sorted[0].M;
      } else {
        // After last data point but ts <= predStartMs — use last known M
        M = x0;
      }
    } else {
      // Future prediction region
      const futureIdx = Math.round((ts - predStartMs) / 60000);
      M = futureIdx < future.length ? future[futureIdx] : cfg.BASELINE;
    }
    points[i] = Math.max(cfg.M_MIN, M);
  }

  _lmHelperCache = { computedAt: nowMs, startMs, points, lastDataTs: lastDataMs };
  _lmHelperCacheKey = dpKey;
  return _lmHelperCache;
}

/**
 * Look up M at a specific absolute timestamp (ms) from the helper array.
 */
function getLovemeterMoodAt(ts_ms, dataPoints) {
  const h   = getLovemeterHelperArray(dataPoints);
  const idx = Math.round((ts_ms - h.startMs) / 60000);
  if (idx < 0)              return dataPoints.length > 0
    ? dataPoints.slice().sort((a,b)=>a.ts-b.ts)[0].M
    : LOVEMETER_CONFIG.M_BASE;
  if (idx >= h.points.length) return LOVEMETER_CONFIG.BASELINE;
  return h.points[idx];
}

/**
 * Get the current emotional state: { M, slope (M/min), zone, zone_label }.
 */
function getCurrentMoodState(dataPoints) {
  const nowMs = Date.now();
  const M     = getLovemeterMoodAt(nowMs, dataPoints);
  const M_1   = getLovemeterMoodAt(nowMs - 60000, dataPoints);
  const slope = M - M_1; // M per minute
  const cfg   = LOVEMETER_CONFIG;

  let zone, zone_label;
  if      (M < cfg.M_COLORLESS) { zone = 'colorless';     zone_label = 'Farblos'; }
  else if (M < cfg.M_MOODY)     { zone = 'moody';         zone_label = 'Launisch'; }
  else if (M < cfg.M_NORMAL)    { zone = 'normal';        zone_label = 'Normal aktiv'; }
  else if (M < cfg.M_CRUSH)     { zone = 'crush';         zone_label = 'Elevated · Crush'; }
  else if (M < cfg.M_SEVERE)    { zone = 'severe';        zone_label = 'Severe Amplification'; }
  else                           { zone = 'supercritical'; zone_label = 'Supercritical'; }

  return { M, slope, zone, zone_label };
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute ΔM for an eye-contact interaction (spec §2.5).
 *   ΔM_eye = r_eye · t_eye,   r_eye = λ · (M − M0)
 * @param {number} durationSeconds  Duration of eye contact in seconds.
 * @param {number} currentM         Current emotional state M at time of event.
 * @returns {number} ΔM (may be negative if M < M0).
 */
function computeEyeContactDeltaM(durationSeconds, currentM) {
  const cfg  = LOVEMETER_CONFIG;
  const rEye = cfg.LAMBDA * (currentM - cfg.EYE_M0);
  return rEye * durationSeconds;
}

/**
 * Apply a ΔM event at the given timestamp.
 * Reads the current M from the helper array, adds ΔM, and returns the new data point.
 * @param {number} ts_ms     Timestamp for the new data point (ms).
 * @param {number} deltaM    Change in emotional points.
 * @param {Array}  dataPoints  Existing data point array (read-only).
 * @returns {{ ts: number, M: number }} New data point to be pushed to the array.
 */
function applyLovemeterDelta(ts_ms, deltaM, dataPoints) {
  const cfg      = LOVEMETER_CONFIG;
  const currentM = getLovemeterMoodAt(ts_ms, dataPoints);
  const newM     = Math.max(cfg.M_MIN, currentM + deltaM);
  return { ts: ts_ms, M: newM };
}

/**
 * Apply an absolute M override at the given timestamp (spec §2.6).
 * @param {number} ts_ms    Timestamp for the new data point (ms).
 * @param {number} Mvalue   Absolute emotional point value to set.
 * @returns {{ ts: number, M: number }} New data point.
 */
function applyLovemeterOverride(ts_ms, Mvalue) {
  const cfg = LOVEMETER_CONFIG;
  return { ts: ts_ms, M: Math.max(cfg.M_MIN, Number(Mvalue)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED BEHAVIORAL ATTRIBUTES (spec §2.13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute representative derived behavioral attributes from M.
 * Returns named attribute values (all dimensionless unless noted).
 */
function computeDerivedAttributes(M) {
  // ── Tunable coefficients ─────────────────────────────────────────────────
  var ALPHA      = 0.001;    // motivation amplification coefficient
  var BETA       = 0.001;    // social confidence coefficient
  var DELTA      = 0.0008;   // outfit optimization coefficient
  var LAMBDA     = 0.0012;   // eye-contact reactivity coefficient (ΔM per ms)
  var ETA        = 0.0010;   // notification sensitivity coefficient
  var GAMMA      = 0.0005;   // train-window cinematic coefficient
  var FOCUS_BASE = 1500;     // M above which focus begins degrading
  var FOCUS_K    = 8500;     // focus degradation scale
  var FOCUS_EXP  = 0.7;      // focus degradation exponent
  var SLEEP_DENOM= 10000;    // sleep probability half-point

  // Music damage: perceived loudness damage in dB; baseline 70 dB at M=700
  // Formula: 70 × (1 + (M−700)/700)  →  scales linearly above 700, floors at 0
  var MUSIC_DAMAGE_BASE  = 70;   // dB at M=700
  var MUSIC_DAMAGE_SCALE = 700;  // M-range per +70 dB step

  // Thought recurrence — thoughts per hour; baseline 2 t/h at M=700
  var THOUGHT_BASE  = 2;     // t/h at M=700
  var THOUGHT_SCALE = 500;
  var THOUGHT_EXP   = 1.3;

  // Crush-related threshold (attributes zero below this)
  var CRUSH_THRESHOLD = 1500;

  // Coincidence bias
  var COINC_SCALE = 600;
  var COINC_EXP   = 1.35;

  // Delusion persistence
  var DELUSION_SCALE = 900;
  var DELUSION_EXP   = 1.4;

  // Emotional inertia
  var INERTIA_SCALE = 1000;
  var INERTIA_EXP   = 1.2;

  // Lyric sensitivity
  var LYRIC_SCALE = 700;
  var LYRIC_EXP   = 1.15;

  // Sunlight amplification
  var SUN_SCALE = 1000;
  var SUN_EXP   = 1.2;
  // ── Derived values ───────────────────────────────────────────────────────
  var delta  = M - 700;
  var dPos   = Math.max(0, delta);                    // zero below 700
  var dCrush = Math.max(0, M - CRUSH_THRESHOLD);      // zero below 1500

  return {
    // General attributes (active from M=700)
    motivation:        ALPHA * delta,
    social:            BETA  * delta,
    outfit:            DELTA * dPos,
    music_damage:      Math.max(0, MUSIC_DAMAGE_BASE * (1 + delta / MUSIC_DAMAGE_SCALE)),  // dB
    // Eye-contact reactivity: ΔM gained per ms of eye contact
    eye_reactivity:    LAMBDA * dPos,
    // Thought recurrence: thoughts per hour
    thought:           THOUGHT_BASE * (1 + Math.pow(dPos / THOUGHT_SCALE, THOUGHT_EXP)),
    // Crush-related attributes (zero below M=1500)
    replay:            dCrush > 0 ? Math.pow(Math.log(dCrush + 1), 3) : 0,
    notification:      ETA   * dCrush,
    train_window:      GAMMA * dCrush,
    coincidence:       Math.pow(dCrush / COINC_SCALE,    COINC_EXP),
    sunlight:          1 + Math.pow(dCrush / SUN_SCALE,  SUN_EXP),
    lyric:             Math.pow(dCrush / LYRIC_SCALE,    LYRIC_EXP),
    delusion:          Math.pow(dCrush / DELUSION_SCALE, DELUSION_EXP),
    // Universal attributes
    inertia:           1 + Math.pow(Math.max(0, M) / INERTIA_SCALE, INERTIA_EXP),
    focus:             Math.max(0, 1 - Math.pow(Math.max(0, M - FOCUS_BASE) / FOCUS_K, FOCUS_EXP)),
    sleep:             1 / (1 + M / SLEEP_DENOM),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE INVALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/** Call after any mutation to the data points array. */
function invalidateLovemeterCache() {
  _lmHelperCache    = null;
  _lmHelperCacheKey = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESET EVENTS — stored in localStorage, user-managed
// Each preset: { id: string, name: string, delta: number }
// ─────────────────────────────────────────────────────────────────────────────

var LM_PRESETS_KEY = 'lovemeter_presets';

function lmPresetsLoad() {
  try {
    var raw = localStorage.getItem(LM_PRESETS_KEY);
    if (raw) { var p = JSON.parse(raw); if (Array.isArray(p)) return p; }
  } catch(_) {}
  return [];
}

function lmPresetsSave(presets) {
  try { localStorage.setItem(LM_PRESETS_KEY, JSON.stringify(presets)); } catch(_) {}
  // Sync to server (fire-and-forget)
  try {
    fetch('/api/lovemeter-presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(presets)
    }).catch(function(){});
  } catch(_) {}
}

// Load presets from server on startup, falling back to localStorage
function lmPresetsInit(callback) {
  fetch('/api/lovemeter-presets')
    .then(function(r) { return r.json(); })
    .then(function(presets) {
      if (Array.isArray(presets) && presets.length > 0) {
        try { localStorage.setItem(LM_PRESETS_KEY, JSON.stringify(presets)); } catch(_) {}
      }
      if (callback) callback();
    })
    .catch(function() { if (callback) callback(); });
}

function lmPresetsAdd(name, delta) {
  var presets = lmPresetsLoad();
  var preset  = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name, delta: delta };
  presets.push(preset);
  lmPresetsSave(presets);
  return presets;
}

function lmPresetsDelete(id) {
  var presets = lmPresetsLoad().filter(function(p) { return p.id !== id; });
  lmPresetsSave(presets);
  return presets;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA PERSISTENCE (server-side JSON file via REST API)
// Falls back to localStorage as offline cache.
// ─────────────────────────────────────────────────────────────────────────────

const LM_STORAGE_KEY = 'lovemeter_data_points';

/** Load data points from the server; fall back to localStorage if offline.
 *  Also syncs presets from server on first load. */
async function loadLovemeterDataPoints() {
  // Sync presets from server (non-blocking)
  lmPresetsInit(null);
  try {
    const res = await fetch('/api/lovemeter');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const points = await res.json();
    // Mirror to localStorage so offline reads still work
    try { localStorage.setItem(LM_STORAGE_KEY, JSON.stringify(points)); } catch(_) {}
    return Array.isArray(points) ? points : [];
  } catch (_) {
    try {
      const raw = localStorage.getItem(LM_STORAGE_KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p; }
    } catch(_) {}
    return [];
  }
}

/** Persist a single new/updated data point to the server. Returns updated full array. */
async function saveLovemeterPoint(point) {
  try {
    const res = await fetch('/api/lovemeter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(point),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { points } = await res.json();
    try { localStorage.setItem(LM_STORAGE_KEY, JSON.stringify(points)); } catch(_) {}
    return points;
  } catch (_) {
    // Offline: persist locally only
    try {
      const raw = localStorage.getItem(LM_STORAGE_KEY);
      const existing = raw ? JSON.parse(raw) : [];
      const idx = existing.findIndex(p => p.ts === point.ts);
      if (idx !== -1) existing[idx] = point; else existing.push(point);
      existing.sort((a, b) => a.ts - b.ts);
      localStorage.setItem(LM_STORAGE_KEY, JSON.stringify(existing));
      return existing;
    } catch(_) { return [point]; }
  }
}

/** Delete a data point by timestamp. Returns updated full array. */
async function deleteLovemeterPoint(ts) {
  try {
    const res = await fetch('/api/lovemeter/' + ts, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { points } = await res.json();
    try { localStorage.setItem(LM_STORAGE_KEY, JSON.stringify(points)); } catch(_) {}
    return points;
  } catch (_) {
    try {
      const raw = localStorage.getItem(LM_STORAGE_KEY);
      const existing = raw ? JSON.parse(raw) : [];
      const next = existing.filter(p => p.ts !== ts);
      localStorage.setItem(LM_STORAGE_KEY, JSON.stringify(next));
      return next;
    } catch(_) { return []; }
  }
}

/** Legacy sync shim used by inline code — replaces old saveLovemeterDataPoints. */
function saveLovemeterDataPoints(dataPoints) {
  // Fire-and-forget bulk save; updates localStorage immediately.
  try { localStorage.setItem(LM_STORAGE_KEY, JSON.stringify(dataPoints)); } catch(_) {}
  fetch('/api/lovemeter', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dataPoints),
  }).catch(function() {});
  return dataPoints;
}
