// === Smart advisory: auto-suggested delay/cancel reasons ===
// A train IS the "task" the Stressmeter already simulates (see stressmeter-engine.js
// getTaskAtMinute/simulateMultiDay). Rule 3b reuses the per-train tier the Stressmeter
// already computed and stored on t._alertLvl (stressmeter-ui.js renderGraph), rather
// than re-simulating independently here.

const DelayReasons = Object.freeze([
  'Fahrzeugmangel',
  'Verspätete Bereitstellung des Zuges',
  'Kurzfristiger Personalausfall',
  'Vorfahrt eines anderen Zuges',
  'Technische Defekt am Zug',
  'Streckensperrung',
  'Feiertag',
  'Ereignis'
]);

function wasPreviousTrainDelayed(train, allActiveTrains, now) {
  const myStart = parseTime(train.actual || train.plan, now, train.date);
  if (!myStart) return false;

  const sameDay = allActiveTrains
    .filter(t => t && t.date === train.date && t._uniqueId !== train._uniqueId)
    .map(t => ({ t, start: parseTime(t.actual || t.plan, now, t.date) }))
    .filter(x => x.start)
    .sort((a, b) => a.start - b.start);

  let prev = null;
  for (const x of sameDay) {
    if (x.start < myStart) prev = x.t;
    else break;
  }
  return !!(prev && prev.actual && prev.actual !== prev.plan);
}

function isLaterOfOverlappingPair(train, allActiveTrains, now) {
  const start1 = parseTime(train.actual || train.plan, now, train.date);
  const end1 = getOccupancyEnd(train, now);
  if (!start1 || !end1) return false;

  return allActiveTrains.some(other => {
    if (!other || other._uniqueId === train._uniqueId) return false;
    const start2 = parseTime(other.actual || other.plan, now, other.date);
    const end2 = getOccupancyEnd(other, now);
    if (!start2 || !end2) return false;
    const overlap = start1 < end2 && end1 > start2;
    return overlap && start1 > start2; // train is the later one
  });
}

// Rule: the gap between this train's start and the immediately preceding
// same-day train's end (occupancy end) is short (0-15 min) — a tight turnaround.
// Negative gaps (actual overlap) are excluded here since that's covered by
// isLaterOfOverlappingPair instead.
function hasShortTurnaround(train, allActiveTrains, now) {
  const myStart = parseTime(train.actual || train.plan, now, train.date);
  if (!myStart) return false;

  const sameDay = allActiveTrains
    .filter(t => t && t.date === train.date && t._uniqueId !== train._uniqueId)
    .map(t => ({ start: parseTime(t.actual || t.plan, now, t.date), end: getOccupancyEnd(t, now) }))
    .filter(x => x.start)
    .sort((a, b) => a.start - b.start);

  let prev = null;
  for (const x of sameDay) {
    if (x.start < myStart) prev = x;
    else break;
  }
  if (!prev || !prev.end) return false;

  const gapMinutes = (myStart - prev.end) / 60000;
  return gapMinutes >= 0 && gapMinutes < 15;
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
function computeSuggestedDelayReasons(train, allActiveTrains, now) {
  const reasons = [];

  if (train._hasDelay && wasPreviousTrainDelayed(train, allActiveTrains, now)) {
    reasons.push('Verspätung aus vorheriger Fahrt');
  }

  if (isLaterOfOverlappingPair(train, allActiveTrains, now)) {
    reasons.push('Vorfahrt eines anderen Zuges');
  }

  if (hasShortTurnaround(train, allActiveTrains, now)) {
    reasons.push('Kurze Wendezeit');
  }

  const tier = getAuslastungTier(train);
  if (tier === 'extreme') reasons.push('Außergewöhnlich hohe Auslastung erwartet');
  else if (tier === 'high') reasons.push('Hohe Auslastung erwartet');

  const nextDayReason = getNextDayArrivalReason(train, now);
  if (nextDayReason) reasons.push(nextDayReason);

  return reasons;
}

window.DelayReasons = DelayReasons;
window.computeSuggestedDelayReasons = computeSuggestedDelayReasons;
