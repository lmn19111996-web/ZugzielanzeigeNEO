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

// Reads the tier the Stressmeter already computed for this train-as-task.
// t._alertLvl is set by stressmeter-ui.js's renderGraph() when the Stressmeter
// overlay has been opened for that date; until then it's undefined, which simply
// yields no Auslastung suggestion here.
function getAuslastungTier(train) {
  if (train._alertLvl === 3) return 'extreme';
  if (train._alertLvl === 2) return 'high';
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

  const tier = getAuslastungTier(train);
  if (tier === 'extreme') reasons.push('Außergewöhnlich hohe Auslastung erwartet');
  else if (tier === 'high') reasons.push('Hohe Auslastung erwartet');

  return reasons;
}

window.DelayReasons = DelayReasons;
window.computeSuggestedDelayReasons = computeSuggestedDelayReasons;
