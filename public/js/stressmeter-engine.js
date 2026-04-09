// === STRESSMETER ENGINE ===
// Pure simulation module — no DOM access, no side effects outside the cache.
// All tunable parameters live in STRESSMETER_CONFIG below.

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — every adjustable coefficient in one place.
// Edit values here; the formulas and engine will pick them up automatically.
// ─────────────────────────────────────────────────────────────────────────────
const STRESSMETER_CONFIG = {

  // ── Energy limits ──────────────────────────────────────────────────────────
  E_MAX:     1500,  // Hard ceiling; E is clamped to this after every step.
  E_MIN:     0,     // Hard floor; energy cannot go below zero.
  E_DEFAULT: 1000,  // Starting value when no carry-over data is available.
  E_BASE:    1000,  // Reference value used in the overload recovery-cap formula.

  // ── Fatigue multiplier: M_fatigue = 1 + alpha * (Emax / (E − offset))^gamma
  // Effect: as E falls, the denominator shrinks and M grows → tasks cost more.
  // alpha  — overall strength of the fatigue effect (0 = disabled).
  // gamma  — exponent controlling curve steepness; higher = more sudden onset.
  // offset — shifts the denominator so that M ≈ 1.0 at E = E_DEFAULT.
  //           Default −970: at E=1000 → denom=1970 → (1500/1970)^10 ≈ 0.07 → M≈1.007 ✓
  FATIGUE_ALPHA:  0.1,
  FATIGUE_GAMMA:  10,
  FATIGUE_OFFSET: -970,

  // ── Circadian multiplier: M_circadian = 1 − beta · sin(4π(t − phase) / 24)
  // Effect: tasks cheaper near circadian peaks, more expensive near troughs.
  //   C(t) ∈ [−1, +1]: +1 = peak performance, −1 = worst performance.
  //   M = 1 − beta·C: peak → M = 1−beta < 1 (easier); trough → M = 1+beta > 1 (harder).
  // beta       — swing amplitude (0.2 gives ±20% cost range).
  // phaseShift — hours to slide the two daily peaks; default 1.5 h → peaks ~10:00 & 22:00.
  CIRCADIAN_BETA:        0.2,
  CIRCADIAN_PHASE_SHIFT: 1.5,  // hours

  // ── Passive recovery: ΔE_passive = ε · dt
  // Effect: constant background energy trickle regardless of activity.
  // epsilon — recovery rate in energy per hour (≈ 0.58 E/min at 35 E/h).
  PASSIVE_RECOVERY_RATE: 35,   // energy / hour

  // ── Idle / sleep fast recovery: dE_fast/dt = k · (cap − E)
  // Effect: exponential approach to the recovery cap during long idle gaps.
  // k                  — rate constant (per hour); higher → faster approach to cap.
  // IDLE_THRESHOLD_MIN — a gap must be at least this long to trigger fast recovery.
  IDLE_RECOVERY_K:      0.3,   // per hour
  IDLE_THRESHOLD_MIN:   60,    // minutes

  // ── Overload penalty on overnight recovery cap
  // Effect: very bad days reduce the maximum energy recoverable overnight.
  //   O = max(0, (Eoverload − Eend) / Eoverload)     (normalised overwork amount)
  //   EmaxWithCap = Ebase · (1 − omega · O)
  // omega              — penalty strength (0.3 → up to 30% cap reduction).
  // OVERLOAD_E_THRESHOLD — Eend must be below this for the penalty to engage.
  OVERLOAD_OMEGA:          0.3,
  OVERLOAD_E_THRESHOLD:    150,

  // ── Badge colour thresholds (used by the UI module)
  STRESS_GREEN:  700,   // E ≥ this → green badge
  STRESS_YELLOW: 400,   // E ≥ this → yellow badge; below → red + alert border
};

// ─────────────────────────────────────────────────────────────────────────────
// TASK LOAD TABLE
// Each subcategory maps to { basePoint, loadFactor }.
//   Load = basePoint + durationHours · loadFactor
//   Load is *subtracted* from E → positive values drain energy, negative restore it.
//   basePoint: flat per-occurrence cost; spread across dauer minutes in the engine.
//   loadFactor: energy cost rate per hour.
// ─────────────────────────────────────────────────────────────────────────────
const TASK_LOAD = {
  s1:  { basePoint:    0, loadFactor: -100 },  // Break (general, lunch/dinner)
  s11: { basePoint:    0, loadFactor:  -40 },  // Combined break (cooking + break)
  s2:  { basePoint:   10, loadFactor:   60 },  // Chores (laundry etc.)
  s3:  { basePoint: -100, loadFactor:  110 },  // Creative work
  s4:  { basePoint: -100, loadFactor:  -75 },  // Girls' Night Out / recovery
  s41: { basePoint:    0, loadFactor:  120 },  // Paid student job
  s42: { basePoint:    0, loadFactor:  120 },  // Volunteer job
  s5:  { basePoint: -60, loadFactor:   90 },  // Self-care
  s51: { basePoint: -100, loadFactor:   90 },  // Extensive self-care session
  s6:  { basePoint:    0, loadFactor:  100 },  // University lecture / exam
  s60: { basePoint:    0, loadFactor:  100 },  // Group work in uni
  s62: { basePoint:    0, loadFactor:  100 },  // Seminar in uni
  s7:  { basePoint:    0, loadFactor:  130 },  // Self-study session
  s75: { basePoint:   20, loadFactor:  160 },  // Intensive study (exam prep)
  s8:  { basePoint: -100, loadFactor:  -50 },  // Leisure travel
  s85: { basePoint: -150, loadFactor: -100 },  // Long trip (>1000 km)
  s9:  { basePoint:   30, loadFactor:  100 },  // Group work (unreviewed)
  s95: { basePoint:   60, loadFactor:   70 },  // Student organisation / club work
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPER FUNCTIONS — all arguments are primitives; no globals read inside.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a "HH:MM" time-string to minutes since midnight.
 * Returns null if the input is missing or unparseable.
 */
function smParseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Circadian rhythm multiplier.
 *   C(t) = sin( 4π(t − phaseShift) / 24 )     — ranges [−1, +1]
 *   M_circadian = 1 − beta · C(t)
 * Peak (C = +1): M < 1 → tasks cost less.
 * Trough (C = −1): M > 1 → tasks cost more.
 */
function circadianMultiplier(tHours, phaseShift, beta) {
  const C = Math.sin((4 * Math.PI * (tHours - phaseShift)) / 24);
  return 1 - beta * C;
}

/**
 * Fatigue multiplier.
 *   M_fatigue = 1 + alpha · (Emax / (E − offset))^gamma
 * As E decreases the denominator shrinks → M grows → tasks drain more energy.
 * Clamped to [0.5, 5] to prevent numerical runaway.
 */
function fatigueMultiplier(E, Emax, alpha, gamma, offset) {
  const denom = E - offset;
  if (denom <= 0) return 5;                         // guard against zero / negative
  const M = 1 + alpha * Math.pow(Emax / denom, gamma);
  return Math.min(5, Math.max(0.5, M));
}

/**
 * Context multiplier — always 1.0 at this development stage.
 * Reserved for future context-aware load modifiers.
 */
function contextMultiplier() {
  return 1;
}

/**
 * Find the task (train object) active at a specific minute of the day.
 * Returns null if no task is running.
 * Prefers `actual` start time over `plan`; skips canceled tasks.
 */
function getTaskAtMinute(trainsForDay, minuteOfDay) {
  for (const train of trainsForDay) {
    if (train.canceled) continue;
    const startMin = smParseTimeToMinutes(train.actual || train.plan);
    if (startMin === null) continue;
    const dur = Math.max(0, Number(train.dauer) || 0);
    if (dur === 0) continue;
    if (minuteOfDay >= startMin && minuteOfDay < startMin + dur) return train;
  }
  return null;
}

/**
 * Look up { basePoint, loadFactor } for a task's line category.
 * Returns zero-load defaults for unknown categories.
 */
function computeBaseLoad(train) {
  const key = (train.linie || '').toLowerCase().trim();
  return TASK_LOAD[key] || { basePoint: 0, loadFactor: 0 };
}

/**
 * Passive recovery delta for one dt.
 *   ΔE_passive = ε · dt_hours   (always positive — background trickle)
 */
function passiveRecoveryDelta(dt_hours, epsilon) {
  return epsilon * dt_hours;
}

/**
 * Fast idle / sleep recovery delta for one dt.
 *   dE_fast/dt = k · (cap − E)   →   ΔE = k · (cap − E) · dt_hours
 * Exponential approach to cap; naturally decelerates as E nears the ceiling.
 */
function fastRecoveryDelta(E, cap, k, dt_hours) {
  return k * (cap - E) * dt_hours;
}

/**
 * Compute the maximum energy recoverable in the gap (with overload penalty).
 * Base cap is E_BASE in normal situations. Heavy overwork lowers it.
 *   O = max(0, (Eoverload − E) / Eoverload)     — how far below threshold currently
 *   EmaxWithCap = E_BASE · (1 − omega · O)
 * When E is above threshold (normal), O=0 → cap=E_BASE=1000
 * When E is below threshold (overworked), cap reduces toward E_BASE*(1-omega)
 */
function computeEmaxWithCap(Ebase, E_current, omega, Eoverload) {
  const O = Math.max(0, (Eoverload - E_current) / Eoverload);
  return Ebase * (1 - omega * O);
}


// ─────────────────────────────────────────────────────────────────────────────
// CONTINUOUS MULTI-DAY SIMULATION
// Single unbroken pass over numDays×1440 minutes. No carry-over bookkeeping —
// E flows naturally step-to-step. Recovery cap is evaluated locally at each
// gap entry based on E at that exact moment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate all dates in one continuous pass.
 * @param {Array}  allTrains        All train/task objects (any date — filtered internally).
 * @param {Array}  dates            Ordered date strings for the simulation window.
 * @param {object} cfg              STRESSMETER_CONFIG.
 * @param {object} manualOverrides  Manual energy overrides: { dateStr: { minute: E, ... }, ... }
 * @returns {Object} { [dateStr]: Array(1440) } of step objects per local minute.
 */
function simulateMultiDay(allTrains, dates, cfg, manualOverrides, dayStartSeeds) {
  const numDays  = dates.length;
  const TOTAL    = numDays * 1440;
  const DT_HOURS = 1 / 60;

  // Sparse absolute-minute task index over all days.
  const taskAtMin = new Array(TOTAL);
  allTrains.forEach(t => {
    if (t.canceled) return;
    const dayIdx = dates.indexOf(t.date);
    if (dayIdx < 0) return;
    const start = smParseTimeToMinutes(t.actual || t.plan);
    const dur   = Math.max(0, Number(t.dauer) || 0);
    if (start === null || dur === 0) return;
    const absStart = Math.max(0, dayIdx * 1440 + Math.round(start));
    const absEnd   = Math.min(absStart + Math.round(dur), TOTAL);
    for (let m = absStart; m < absEnd; m++) {
      if (!taskAtMin[m]) taskAtMin[m] = t;
    }
  });

  const stepsMap = {};
  dates.forEach(d => { stepsMap[d] = new Array(1440); });

  const seededStart = dayStartSeeds && dayStartSeeds[dates[0]] != null
    ? Number(dayStartSeeds[dates[0]])
    : cfg.E_DEFAULT;
  let E = Math.min(cfg.E_MAX, Math.max(cfg.E_MIN, isNaN(seededStart) ? cfg.E_DEFAULT : seededStart));

  // Inline gap tracking — cap is fixed at gap entry from E at that moment.
  let gapStart  = -1;   // absolute minute the current gap began (-1 = not in gap)
  let gapCap    = cfg.E_BASE;
  let inLongGap = false;

  for (let m = 0; m < TOTAL; m++) {
    const task    = taskAtMin[m] || null;
    const localM  = m % 1440;
    const dateStr = dates[Math.floor(m / 1440)];
    const tHours  = localM / 60;

    const M_c   = circadianMultiplier(tHours, cfg.CIRCADIAN_PHASE_SHIFT, cfg.CIRCADIAN_BETA);
    const M_f   = fatigueMultiplier(E, cfg.E_MAX, cfg.FATIGUE_ALPHA, cfg.FATIGUE_GAMMA, cfg.FATIGUE_OFFSET);
    const M_ctx = contextMultiplier();

    let dE  = 0;
    let alf = 0;

    if (task) {
      gapStart  = -1;
      inLongGap = false;
      const { basePoint, loadFactor } = computeBaseLoad(task);
      const dur_min = Math.max(1, Number(task.dauer) || 1);
      dE = -(loadFactor * M_c * M_f * M_ctx) * DT_HOURS
           - (basePoint / dur_min)
           + passiveRecoveryDelta(DT_HOURS, cfg.PASSIVE_RECOVERY_RATE);
      alf = loadFactor;

    } else {
      if (gapStart < 0) {
        // Entering a new idle gap — fix recovery cap from current E.
        gapStart  = m;
        gapCap    = computeEmaxWithCap(cfg.E_BASE, E, cfg.OVERLOAD_OMEGA, cfg.OVERLOAD_E_THRESHOLD);
        inLongGap = false;
      }
      if (!inLongGap && (m - gapStart) >= cfg.IDLE_THRESHOLD_MIN) {
        inLongGap = true;
      }
      if (inLongGap) {
        // During fast recovery, passive recovery is suspended
        // Fast recovery pulls energy toward the recovery cap (typically ~1000, lower after overwork)
        dE = fastRecoveryDelta(E, gapCap, cfg.IDLE_RECOVERY_K, DT_HOURS);
      } else {
        dE = passiveRecoveryDelta(DT_HOURS, cfg.PASSIVE_RECOVERY_RATE);
      }
    }

    // Update E and always clamp to [0, 1500] bounds
    // This ensures recovery never exceeds max and depletion never goes below zero
    E = Math.min(cfg.E_MAX, Math.max(cfg.E_MIN, E + dE));
    
    // Check for manual override for this specific minute
    // If override exists, apply it and use it as the energy value for next minute's calculation
    if (manualOverrides && manualOverrides[dateStr] && manualOverrides[dateStr][localM] != null) {
      E = Math.max(cfg.E_MIN, Math.min(cfg.E_MAX, Number(manualOverrides[dateStr][localM])));
    }
    
    stepsMap[dateStr][localM] = {
      minute:      localM,
      E:           E,           // Clamped value (0-1500), or overridden value
      dE_per_min:  dE,
      task,
      loadFactor:  alf,
      M_circadian: M_c,
      M_fatigue:   M_f,
      M_context:   M_ctx,
    };
  }

  return stepsMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────
let _smCache    = null;
let _smCacheKey = '';

/**
 * Return cached stepsMap if inputs are unchanged, otherwise re-simulate.
 * @param {Array} allTrains  All train objects (any date).
 * @param {Array} dates      Ordered date strings for the simulation window.
 * @param {object} manualOverrides  Manual energy overrides: { dateStr: { minute: E, ... }, ... }
 * @returns {Object} { [dateStr]: Array(1440) }
 */
function getOrComputeAllDaySteps(allTrains, dates, manualOverrides, dayStartSeeds) {
  manualOverrides = manualOverrides || {};
  dayStartSeeds = dayStartSeeds || {};
  const overrideKey = JSON.stringify(manualOverrides);
  const seedKey = JSON.stringify(
    dates.reduce((acc, d) => {
      if (dayStartSeeds[d] != null) acc[d] = dayStartSeeds[d];
      return acc;
    }, {})
  );
  const key = dates.join(',') + '|' + JSON.stringify(
    allTrains.map(t => `${t._uniqueId}:${t.date}:${t.actual || ''}:${t.dauer}:${!!t.canceled}`)
  ) + '|' + overrideKey + '|' + seedKey;
  if (key === _smCacheKey && _smCache !== null) return _smCache;
  _smCache    = simulateMultiDay(allTrains, dates, STRESSMETER_CONFIG, manualOverrides, dayStartSeeds);
  _smCacheKey = key;
  return _smCache;
}

/** Bust the cache — call after any schedule mutation (save, edit). */
function invalidateStressmeterCache() {
  _smCache    = null;
  _smCacheKey = '';
}