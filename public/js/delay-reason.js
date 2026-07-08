// === Smart advisory: auto-suggested delay/cancel reasons ===
// A train IS the "task" the Stressmeter already simulates (see stressmeter-engine.js
// getTaskAtMinute/simulateMultiDay). Rule 3b reuses the per-train tier the Stressmeter
// already computed and stored on t._alertLvl (stressmeter-ui.js renderGraph), rather
// than re-simulating independently here.

function getDelayReasons() {
  if (window.AppSettings) return window.AppSettings.get('delayReasons');
  return [
    'Fahrzeugmangel',
    'Verspätete Bereitstellung des Zuges',
    'Kurzfristiger Personalausfall',
    'Vorfahrt eines anderen Zuges',
    'Technische Defekt am Zug',
    'Streckensperrung',
    'Feiertag',
    'Ereignis'
  ];
}

// Precomputes, once per render cycle, the per-train "previous same-day train"
// and "is this the later half of an overlapping pair" facts that
// wasPreviousTrainDelayed/hasShortTurnaround/isLaterOfOverlappingPair need.
// Previously each of those three rules independently filtered + sorted the
// *entire* active-train list for *every* train (O(n) work × n trains, done
// three times over) — this does one O(n log n) pass instead.
function buildAdvisoryContext(allActiveTrains, now) {
  const byDate = new Map();
  (allActiveTrains || []).forEach(t => {
    if (!t) return;
    const start = parseTime(t.actual || t.plan, now, t.date);
    if (!start) return;
    const end = getOccupancyEnd(t, now);
    const key = t.date || '';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push({ t, start, end });
  });

  const info = new Map(); // _uniqueId -> { prev, prevEnd, isLaterOfOverlap }

  byDate.forEach(list => {
    list.sort((a, b) => a.start - b.start);

    // Sliding window of trains that could still overlap the current one
    // (occupancy end still ahead of the current train's start).
    const active = [];
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];

      for (let j = active.length - 1; j >= 0; j--) {
        if (active[j].end && active[j].end <= cur.start) active.splice(j, 1);
      }

      let isLaterOfOverlap = false;
      if (cur.end) {
        for (const other of active) {
          if (other.end && cur.start < other.end && cur.end > other.start) {
            isLaterOfOverlap = true;
            break;
          }
        }
      }

      const prev = i > 0 ? list[i - 1] : null;
      info.set(cur.t._uniqueId, {
        prev: prev ? prev.t : null,
        prevEnd: prev ? prev.end : null,
        isLaterOfOverlap
      });

      active.push(cur);
    }
  });

  return info;
}

function wasPreviousTrainDelayed(train, context) {
  const entry = context.get(train._uniqueId);
  const prev = entry && entry.prev;
  return !!(prev && prev.actual && prev.actual !== prev.plan);
}

function isLaterOfOverlappingPair(train, context) {
  const entry = context.get(train._uniqueId);
  return !!(entry && entry.isLaterOfOverlap);
}

// Rule: the gap between this train's start and the immediately preceding
// same-day train's end (occupancy end) is short (0-15 min) — a tight turnaround.
// Negative gaps (actual overlap) are excluded here since that's covered by
// isLaterOfOverlappingPair instead.
function hasShortTurnaround(train, context, now) {
  const myStart = parseTime(train.actual || train.plan, now, train.date);
  if (!myStart) return false;

  const entry = context.get(train._uniqueId);
  const prevEnd = entry && entry.prevEnd;
  if (!prevEnd) return false;

  const gapMinutes = (myStart - prevEnd) / 60000;
  const threshold = window.AppSettings ? window.AppSettings.get('turnaroundThresholdMin') : 15;
  return gapMinutes >= 0 && gapMinutes < threshold;
}

// Rule: the train's arrival (occupancy end) falls on a later calendar day than
// its scheduled date — e.g. a night service departing just before midnight.
// Returns "Ankunft am DD.MM" using the arrival's own date, or null if it doesn't
// cross midnight (or times are missing).
function getNextDayArrivalReason(train, now) {
  if (!train.date) return null;
  const occEnd = getOccupancyEnd(train, now);
  if (!occEnd) return null;

  const startDay = new Date(train.date + 'T00:00:00');
  const endDay = new Date(occEnd.getFullYear(), occEnd.getMonth(), occEnd.getDate());
  if (endDay.getTime() === startDay.getTime()) return null;

  const dd = String(occEnd.getDate()).padStart(2, '0');
  const mm = String(occEnd.getMonth() + 1).padStart(2, '0');
  return `Ankunft am ${dd}.${mm}`;
}

// Rule: the train's line is under a curfew (Nachtsperre) and it departs
// before the curfew window starts, but its occupancy runs long enough to
// bleed into the window. Trains that depart INSIDE the window are handled
// separately (force-cancelled in globals.js's applyCurfewRule), so this only
// ever fires for trains that are still allowed to run.
function crossesCurfewBoundary(train, now) {
  if (train.canceled) return false;
  if (!window.AppSettings || !window.AppSettings.get('curfewEnabled')) return false;
  if (typeof window.isTimeInCurfewWindow !== 'function') return false;

  const lines = (window.AppSettings.get('curfewLines') || []).map(l => String(l).toUpperCase());
  if (!train.linie || !lines.includes(String(train.linie).toUpperCase())) return false;

  const startHour = window.AppSettings.get('curfewStartHour');
  const endHour = window.AppSettings.get('curfewEndHour');
  const depTime = parseTime(train.actual || train.plan, now, train.date);
  const occEnd = getOccupancyEnd(train, now);
  if (!depTime || !occEnd) return false;

  return !window.isTimeInCurfewWindow(depTime, startHour, endHour)
    && window.isTimeInCurfewWindow(occEnd, startHour, endHour);
}

// Reads the tier the Stressmeter already computed for this train-as-task.
// stressmeter-ui.js's renderGraph() sets this when the Stressmeter overlay has
// been opened for that date; until then there's simply no Auslastung suggestion.
// Read from window._auslastungTierCache (keyed by the stable _uniqueId) rather
// than train._alertLvl directly — schedule.trains gets replaced with freshly
// parsed objects on nearly every reload/SSE update, which would otherwise wipe
// the mutated property moments after it's set.
function getAuslastungTier(train) {
  const cache = window._auslastungTierCache || {};
  const lvl = train._uniqueId != null && cache[train._uniqueId] !== undefined
    ? cache[train._uniqueId]
    : train._alertLvl;
  if (lvl === 3) return 'extreme';
  if (lvl === 2) return 'high';
  return null;
}

// Returns an array of every auto-reason currently applicable to this train (0-3
// entries). All matching rules are surfaced together — none suppresses another.
// `allActiveTrainsOrContext` may be either the raw train array (a fresh
// buildAdvisoryContext() is built internally — convenient for one-off calls)
// or an already-built context from buildAdvisoryContext (preferred when
// calling this for every train in a list — see globals.js).
function computeSuggestedDelayReasons(train, allActiveTrainsOrContext, now) {
  const context = allActiveTrainsOrContext instanceof Map
    ? allActiveTrainsOrContext
    : buildAdvisoryContext(allActiveTrainsOrContext, now);

  const reasons = [];

  if (train._hasDelay && wasPreviousTrainDelayed(train, context)) {
    reasons.push('Verspätung aus vorheriger Fahrt');
  }

  if (isLaterOfOverlappingPair(train, context)) {
    reasons.push('Vorfahrt eines anderen Zuges');
  }

  if (hasShortTurnaround(train, context, now)) {
    reasons.push('Kurze Wendezeit');
  }

  const tier = getAuslastungTier(train);
  if (tier === 'extreme') reasons.push('Außergewöhnlich hohe Auslastung erwartet');
  else if (tier === 'high') reasons.push('Hohe Auslastung erwartet');

  const nextDayReason = getNextDayArrivalReason(train, now);
  if (nextDayReason) reasons.push(nextDayReason);

  if (crossesCurfewBoundary(train, now)) reasons.push('Grenzüberstreitend');

  return reasons;
}

Object.defineProperty(window, 'DelayReasons', { get: getDelayReasons, configurable: true });
window.computeSuggestedDelayReasons = computeSuggestedDelayReasons;
window.buildAdvisoryContext = buildAdvisoryContext;
