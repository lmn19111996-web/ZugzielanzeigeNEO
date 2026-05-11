---
description: "Implement the Stressmeter / Energy system for ZugzielanzeigeNEO as specified in the Task Categorization and Stressmeter Concept document"
name: "Implement Stressmeter"
agent: "agent"
---

# Stressmeter Implementation Plan

## Overview

This prompt guides the full implementation of the Energy / Stressmeter system as defined in the design document. The feature consists of three independent layers that must be built in order:

1. **Engine** — pure JS simulation of `E(t)` across 1440 minutes
2. **Badge** — live colour-coded indicator in the top bar
3. **Dashboard** — slide-down panel with the interactive energy graph

---

## Step 1 — Create `public/js/stressmeter-engine.js`

This is a pure-function module with zero DOM dependency. All adjustable coefficients are declared at the top in a single `STRESSMETER_CONFIG` object.

### 1.1 Config block (all tuneable constants in one place)

```js
const STRESSMETER_CONFIG = {
  // ── Energy bookkeeping ───────────────────────────────────────
  E_MAX:     1500, // absolute ceiling; energy is clamped to this
  E_DEFAULT: 1000, // starting energy when no carry-over is available
  E_BASE:    1000, // Ebase used in overload cap formula

  // ── Fatigue multiplier  M_fatigue = 1 + alpha*(Emax/(E-offset))^gamma
  // Higher alpha → fatigue hits harder at low energy
  // Higher gamma → fatigue curve is steeper (more sudden)
  // offset shifts the denominator; default -970 keeps M near 1 at E=1000
  FATIGUE_ALPHA:  0.1,
  FATIGUE_GAMMA:  10,
  FATIGUE_OFFSET: -970,

  // ── Circadian multiplier  M_circadian = 1 - beta * sin(4π(t-phase)/24)
  // beta = 0 disables circadian effect; 0.2 gives ±20% swing
  // phaseShift (hours) slides the two daily peaks left/right
  CIRCADIAN_BETA:       0.2,
  CIRCADIAN_PHASE_SHIFT: 1.5, // shift peaks to ~10:00 and ~22:00

  // ── Passive recovery  ΔE_passive = ε * dt  (per minute)
  // epsilon is per-hour; divide by 60 internally
  PASSIVE_RECOVERY_RATE: 35, // energy/hour

  // ── Idle / sleep recovery  dE_fast/dt = k*(EmaxWithCap - E)
  // k = 0 disables fast recovery; higher k = faster approach to cap
  IDLE_RECOVERY_K:     0.3,    // per hour (converted to per minute internally)
  IDLE_THRESHOLD_MIN:  60,     // gap must exceed this many minutes to trigger fast recovery

  // ── Overload effect on sleep cap
  // omega = 0 disables penalty; 0.3 means severe overload → 30% cap reduction
  OVERLOAD_OMEGA:     0.3,
  OVERLOAD_E_THRESHOLD: 150,   // below this end-of-day energy, penalty starts

  // ── Stress display thresholds (for badge colour)
  STRESS_GREEN:  700, // E ≥ this → green
  STRESS_YELLOW: 400, // E ≥ this → yellow; below → red
};
```

### 1.2 Category load table

Map every subcategory to `{ basePoint, loadFactor }` exactly as per the spec table. Key is lowercase line name (e.g. `'s1'`, `'s75'`, `'fex'`).

```js
const TASK_LOAD = {
  s1:  { basePoint:    0, loadFactor: -100 },
  s11: { basePoint:    0, loadFactor:  -40 },
  s2:  { basePoint:   10, loadFactor:   60 },
  s3:  { basePoint: -100, loadFactor:  110 },
  s4:  { basePoint: -100, loadFactor:  -75 },
  s41: { basePoint:    0, loadFactor:  120 },
  s42: { basePoint:    0, loadFactor:  120 },
  s5:  { basePoint: -145, loadFactor:   90 },
  s51: { basePoint: -200, loadFactor:   90 },
  s6:  { basePoint:    0, loadFactor:  100 },
  s60: { basePoint:    0, loadFactor:  100 },
  s62: { basePoint:    0, loadFactor:  100 },
  s7:  { basePoint:    0, loadFactor:  130 },
  s75: { basePoint:   20, loadFactor:  160 },
  s8:  { basePoint: -100, loadFactor:  -50 },
  s85: { basePoint: -150, loadFactor: -100 },
  s9:  { basePoint:   30, loadFactor:  100 },
  s95: { basePoint:   60, loadFactor:   70 },
};
```

### 1.3 Pure helper functions

Each multiplier is its own pure function. Arguments are primitives; no globals read.

```
circadianMultiplier(tHours, phaseShift, beta)
  → M = 1 - beta * sin(4π(t - phaseShift) / 24)

fatigueMultiplier(E, Emax, alpha, gamma, offset)
  → M = 1 + alpha * (Emax / (E - offset))^gamma
  → clamp result to [0.5, 5] to prevent runaway

contextMultiplier()
  → always 1 (placeholder for future use)

getTaskAtMinute(trainsForDay, minuteOfDay)
  → returns the train object active at that minute, or null
  → a task is active if: startMinute <= minuteOfDay < startMinute + dauer
  → use actual time if set, else plan time; skip canceled tasks

computeBaseLoad(train)
  → looks up TASK_LOAD by train.linie.toLowerCase()
  → returns { basePoint, loadFactor } or { basePoint: 0, loadFactor: 0 } for unknown

passiveRecoveryDelta(dt_hours, epsilon)
  → ΔE = epsilon * dt_hours   (always positive; energy is slowly replenished)

fastRecoveryDelta(E, EmaxWithCap, k, dt_hours)
  → ΔE = k * (EmaxWithCap - E) * dt_hours   (approaches cap asymptotically)

computeEmaxWithCap(Ebase, Eend, omega, Eoverload)
  → O = max(0, (Eoverload - Eend) / Eoverload)
  → EmaxWithCap = Ebase * (1 - omega * O)
```

### 1.4 Main simulation function

```
simulateDay(trainsForDay, E_initial, config)
  → returns Array[1440] of step objects:
     { minute, E, dE_dt, task, loadFactor, M_circadian, M_fatigue, M_context }
```

Algorithm for each of the 1440 minute steps:
1. `tHours = minute / 60`
2. Find active task via `getTaskAtMinute`
3. Look up `{ basePoint, loadFactor }` from `TASK_LOAD`
4. If no active task → check idle gap; if gap ≥ `IDLE_THRESHOLD_MIN` → use fast recovery, else passive only
5. `M_c = circadianMultiplier(tHours, ...)`
6. `M_f = fatigueMultiplier(E, ...)`
7. `M_ctx = contextMultiplier()`
8. If task active:
   - `dE_dt = -(loadFactor * M_c * M_f * M_ctx) / 60`  (loadFactor is per-hour, dt = 1 min)
   - `baseContribution = -basePoint / 60`  (spread base point over the task's duration)
   - `ΔE = dE_dt + baseContribution + passiveRecoveryDelta(1/60, ε)`
9. If idle gap active: `ΔE = fastRecoveryDelta(...) + passiveRecoveryDelta(...)`
10. If no task, gap < threshold: `ΔE = passiveRecoveryDelta(...)`
11. `E_next = clamp(E + ΔE, -500, E_MAX)`
12. Store step and advance

**Important — base point handling:** The spec defines `basePoint` as a fixed cost per task occurrence, not per minute. Divide `basePoint` by the task's `dauer` (in minutes) to distribute it evenly across the task's duration so it works through the derivative.

### 1.5 Cache and invalidation

```
let _cachedSteps = null;
let _cacheKey = '';

function getOrComputeSteps(trainsForDay, dateStr, E_initial)
  → cacheKey = dateStr + JSON.stringify(trainsForDay.map(t => t._uniqueId + t.actual + t.dauer))
  → if key unchanged, return _cachedSteps
  → else recompute, store, return

function invalidateStressmeterCache()  // called after any schedule save
```

Export from module: `{ simulateDay, getOrComputeSteps, invalidateStressmeterCache, STRESSMETER_CONFIG, TASK_LOAD }`

---

## Step 2 — Create `public/js/stressmeter-ui.js`

Handles the badge, the dashboard panel DOM, the canvas graph, and hover tooltip. Depends on `stressmeter-engine.js` being loaded first.

### 2.1 Badge

- Target element: the top bar. Add `<button id="stressmeter-badge">` next to the journal island button.
- Badge shows integer energy value, e.g. `"847 ⚡"`.
- CSS class determines colour: `.badge-green` / `.badge-yellow` / `.badge-red` driven by `STRESSMETER_CONFIG.STRESS_GREEN/YELLOW`.
- At red level: add class `stress-alert` to `document.body`, which activates a glowing red top border (`box-shadow: inset 0 4px 12px rgba(255,0,0,0.5)` on `body::before`).
- Clicking badge calls `toggleStressDashboard()`.
- Update every minute by hooking into the existing `updateClock()` call cycle.

### 2.2 Dashboard panel

```html
<div id="stress-dashboard" class="stress-dashboard hidden">
  <div class="stress-graph-container">
    <canvas id="stress-canvas"></canvas>
    <div id="stress-tooltip" class="stress-tooltip hidden"></div>
  </div>
  <div class="stress-axis-labels"><!-- JS-generated hour labels --></div>
</div>
```

- Insert between `#top-bar` and `#main-content` in `mobile.html`.
- `toggleStressDashboard()`: toggle `.hidden`; when revealing, call `renderStressGraph(today)`.
- The `#main-content` element gets `margin-top` transition so it slides down smoothly.

### 2.3 Canvas graph rendering — `renderStressGraph(dateStr)`

```
function renderStressGraph(dateStr)
```

1. Get today's trains from `processedTrainData.allTrains` filtered by `dateStr`.
2. Call `getOrComputeSteps(trains, dateStr, E_initial)` to get 1440 steps.
3. Determine `E_initial`: read from `localStorage('stressmeter_carry_' + previousDateStr)` or use `E_DEFAULT`.
4. Canvas pixel mapping:
   - x: `minute / 1440 * canvasWidth`
   - y: `(E_MAX - E) / (E_MAX - (-500)) * canvasHeight`  (inverted, higher E = higher on canvas)
5. **Task background bands** (drawn first, muted):
   - For each train: fill a rect from `startMinute/1440*W` to `endMinute/1440*W`, full height.
   - Fill colour: `getLineColor(train.linie)` at `opacity 0.15`.
6. **Overload threshold line**: horizontal dashed line at y for `E = STRESSMETER_CONFIG.OVERLOAD_E_THRESHOLD`, colour `rgba(255,80,80,0.6)`.
7. **Energy curve**: stroke a `Path2D` through all 1440 `(x, y)` points.
   - Colour the stroke as a gradient: green → yellow → red matching the thresholds.
8. **Current time needle**: vertical line at `(nowMinute / 1440 * W)`, white, `opacity 0.8`.
9. Store the computed steps array on the canvas element as `canvas._steps` for the hover handler.

### 2.4 Hover tooltip

- `mousemove` / `touchmove` listener on canvas.
- From pointer x, compute `minute = Math.round(x / W * 1440)`.
- Read `canvas._steps[minute]`.
- Populate `#stress-tooltip`:
  ```
  14:32
  ⚡ 612  (−1.8 E/min)
  Task: S6 · Vorlesung
  ─────────────────────
  Base load:        100/h
  Fatigue ×:       1.04
  Circadian ×:     0.92
  Net slope:      −1.8 E/min
  ```
- Position tooltip to follow cursor, clamped to canvas bounds.
- Hide on `mouseleave`.

### 2.5 Live update hooks

- After `saveSchedule()` resolves → call `invalidateStressmeterCache()` then re-render if dashboard is open.
- Every minute tick (inside `updateClock()`) → update badge value from pre-computed steps, no re-simulation.

---

## Step 3 — CSS additions in `public/style.css`

Add at the end of the mobile `@media` block:

```css
/* ── Stressmeter badge ── */
#stressmeter-badge {
  font-size: 1.8vh;
  font-weight: 600;
  padding: 0.3vh 1.2vw;
  border-radius: 2vh;
  border: none;
  cursor: pointer;
  transition: background 0.4s, color 0.4s;
}
.badge-green  { background: #1e6b3a; color: #7fff9a; }
.badge-yellow { background: #6b5b00; color: #ffe066; }
.badge-red    { background: #6b0000; color: #ff6666; }

/* Glowing alert border at top of screen */
.stress-alert::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 6px 18px rgba(255, 0, 0, 0.55);
  z-index: 9999;
  animation: stress-pulse 2s ease-in-out infinite;
}
@keyframes stress-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}

/* ── Dashboard panel ── */
.stress-dashboard {
  overflow: hidden;
  max-height: 0;
  transition: max-height 0.35s ease;
  background: var(--color-bg-panel);
}
.stress-dashboard.open {
  max-height: 42vh;
}
.stress-graph-container {
  position: relative;
  width: 100%;
  height: 38vh;
}
#stress-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.stress-tooltip {
  position: absolute;
  background: rgba(10, 14, 60, 0.92);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 1vh;
  padding: 1vh 1.5vw;
  font-size: 1.5vh;
  pointer-events: none;
  white-space: pre;
  color: #fff;
  z-index: 10;
}
.stress-tooltip.hidden { display: none; }
```

---

## Step 4 — Wire into `mobile.html` and `init.js`

### `mobile.html`

1. Add badge button inside `#top-bar`, after the journal island toggle:
   ```html
   <button id="stressmeter-badge" class="badge-green" aria-label="Stressmeter">— ⚡</button>
   ```
2. Add dashboard panel immediately after `#top-bar`:
   ```html
   <div id="stress-dashboard" class="stress-dashboard">
     <div class="stress-graph-container">
       <canvas id="stress-canvas"></canvas>
       <div id="stress-tooltip" class="stress-tooltip hidden"></div>
     </div>
   </div>
   ```
3. Add script tags in load order (before `js/init.js`):
   ```html
   <script src="js/stressmeter-engine.js"></script>
   <script src="js/stressmeter-ui.js"></script>
   ```

### `init.js`

In the per-minute tick that calls `updateClock()`, also call:
```js
updateStressBadge();   // exported from stressmeter-ui.js
```

In the post-`saveSchedule()` continuation (inside `schedule.js`):
```js
invalidateStressmeterCache();
```

---

## Step 5 — Energy carry-over between days

At end of simulation (minute 1439), store result in localStorage:
```js
localStorage.setItem('stressmeter_carry_' + dateStr, JSON.stringify({ E: steps[1439].E }));
```

When starting simulation for `dateStr`, load carry-over from the previous calendar day:
```js
const prev = getPreviousDateStr(dateStr);
const stored = localStorage.getItem('stressmeter_carry_' + prev);
const E_initial = stored ? JSON.parse(stored).E : STRESSMETER_CONFIG.E_DEFAULT;
```

---

## File summary

| File | Action |
|------|--------|
| `public/js/stressmeter-engine.js` | **Create** — pure simulation, no DOM |
| `public/js/stressmeter-ui.js` | **Create** — badge, dashboard, canvas, tooltip |
| `public/style.css` | **Edit** — badge + dashboard CSS |
| `public/mobile.html` | **Edit** — badge button, dashboard div, two script tags |
| `public/js/init.js` | **Edit** — hook `updateStressBadge()` into minute tick |
| `public/js/schedule.js` | **Edit** — call `invalidateStressmeterCache()` after save |

---

## Implementation constraints (from spec §9–§11)

- All effects work through dE/dt only — no instant jumps
- `STRESSMETER_CONFIG` is the single location for all tunable numbers
- Engine functions are pure (no global reads inside function bodies)
- `M_context` is always 1; leave the hook in place for future use
- No external libraries or frameworks
- Canvas drawn with native 2D context API only
- Simulation result cached by content hash; invalidated on any schedule mutation
