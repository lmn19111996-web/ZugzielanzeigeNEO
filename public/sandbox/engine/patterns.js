(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SbxPatterns = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// Rescheduling patterns inferred from earlier levels — the rules the candidate
// timetables (candidates.js) are built with. Replaces min-gap.js.
//
//   breaks      after a task you take a break that grows with how long it ran:
//                 break(A) = b · duration(A)            clamped to [0, 90] min
//               (intensity is assumed proportional to duration for now, so one
//               b for all tasks). Fitted robustly (least absolute deviation) on
//               the gaps you left after a late task when the next task had to
//               move.
//
//   links       two consecutive tasks that move as one block: when the first
//               runs late, the second keeps its planned gap (Circe → Journaling).
//               A pair is linked when it kept its planned gap in at least 2 of
//               the levels where the first task ran late, and in ≥ 2/3 of them.
//
//   slack       how far a recurring task may move later before you would rather
//               cancel it, relocate something else or shorten — the "reserved
//               region" of an anchor like Abend. Inferred per template as the
//               largest shift seen so far + 15 min, never below the floor, and
//               only once the template has been seen kept in ≥ 3 decisions
//               (before that: unlimited). Shortening: never below the
//               shortest duration you have given the family (seen >= 3
//               times, incl. trains that started late as the disruption);
//               before that, 50 % of the planned duration.
//
// Tasks are task families of recurring templates ("F:<family>"); one-off
// trains fall back to their line ("L:<line>") for links and get no slack limit.

const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
const delayOf = (plan, actual) => { const a = toMin(actual); if (a == null || plan == null) return 0; let d = a - plan; if (d < -720) d += 1440; if (d > 720) d -= 1440; return d; };
// Task families: recurring templates with the same role (e.g. the 7 weekday
// templates of Morning Ritual). Automatic family = line + name, ignoring case,
// punctuation and [..] prefixes; the settings can merge families or split a
// template off (predictionModel.familyOverrides, applied when a level is made
// and stored as baseDay[].family). Patterns and costs are learned per family,
// so what one weekday teaches applies to all of them. Keep familyName() in
// sync with public/js/prediction-settings.js.
const familyName = (ziel) => String(ziel || '').replace(/\[[^\]]*\]/g, '').toLowerCase().replace(/[!?.,:;]/g, '').replace(/\s+/g, ' ').trim();
const autoFamily = (b) => `${String((b && b.linie) || '').toUpperCase()}|${familyName(b && b.ziel)}`;
const familyKey = (b) => (b && b.templateId ? (b.family || autoFamily(b)) : null);
const taskKey = (b) => (b && b.templateId ? `F:${familyKey(b)}` : `L:${(b && b.linie) || '?'}`);
const pairKey = (a, b) => `${a}>${b}`;

const BREAK_MAX = 90;
const SLACK_FLOOR = 60;
const SLACK_MIN_SEEN = 3;
const SHRINK_MIN_RATIO = 0.5;

// Kept trains of a recorded level as you left them, in planned order.
function keptTrains(level) {
  const base = new Map((level.ep.baseDay || []).map(b => [b.uid, b]));
  const disrupted = new Set((level.scenario.disruptions || []).map(d => d.uid));
  const pd = (uid) => Number(level.scenario.basePlannedDauer[uid]) || 0;
  return level.final
    .filter(t => !t.canceled && level.scenario.basePlan[t._uniqueId] != null)
    .map(t => {
      const plan = toMin(level.scenario.basePlan[t._uniqueId]);
      const start = plan + delayOf(plan, t.actual);
      const dur = Number(t.dauer) || 0;
      const b = base.get(t._uniqueId);
      return { uid: t._uniqueId, plan, start, dur, end: start + dur, plannedDur: pd(t._uniqueId), plannedEnd: plan + pd(t._uniqueId), key: taskKey(b), templated: !!(b && b.templateId), disrupted: disrupted.has(t._uniqueId) };
    })
    .sort((a, b) => a.plan - b.plan || (a.uid < b.uid ? -1 : 1));
}

// Consecutive pairs (planned order, first planned to finish before the second
// starts) where the first ran late.
function latePairs(level) {
  const kept = keptTrains(level), out = [];
  for (let i = 1; i < kept.length; i++) {
    const A = kept[i - 1], B = kept[i];
    if (A.plannedEnd > B.plan) continue;
    if (!(A.end > A.plannedEnd + 0.5)) continue;
    out.push({ A, B, plannedGap: B.plan - A.plannedEnd, gap: B.start - A.end, moved: B.start > B.plan + 0.5 });
  }
  return out;
}

// ---------------------------------------------------------------- links
function linkObservations(level) {
  return latePairs(level)
    .filter(p => p.plannedGap >= 15 && p.gap >= 0)
    .map(p => ({ pair: pairKey(p.A.key, p.B.key), kept: Math.abs(p.gap - p.plannedGap) <= 5 }));
}

function fitLinks(obs) {
  const tally = new Map();
  obs.forEach(o => { const t = tally.get(o.pair) || { n: 0, kept: 0 }; t.n++; if (o.kept) t.kept++; tally.set(o.pair, t); });
  const links = new Set();
  tally.forEach((t, k) => { if (t.kept >= 2 && t.kept / t.n >= 2 / 3) links.add(k); });
  return { links, tally };
}

// ---------------------------------------------------------------- breaks
function breakObservations(level, links = new Set()) {
  return latePairs(level)
    .filter(p => p.moved && p.gap >= 0 && p.gap <= BREAK_MAX && !links.has(pairKey(p.A.key, p.B.key)))
    .map(p => ({ dur: p.A.dur, gap: p.gap, level: level.ep.level }));
}

// gap ≈ b·dur (dur in hours): least absolute deviation = the median of
// gap/dur weighted by dur. (A flat break, the median gap, fits the recorded
// levels about as well — 12 vs 13 min median error — but the assumption is
// that longer = more intense = longer break.)
function fitBreaks(obs) {
  const ok = obs.filter(o => o.dur > 0);
  if (ok.length < 3) return { a: 0, b: 0, n: ok.length, mad: null };
  const r = ok.map(o => ({ ratio: o.gap / (o.dur / 60), w: o.dur })).sort((x, y) => x.ratio - y.ratio);
  const half = r.reduce((s, x) => s + x.w, 0) / 2;
  let acc = 0, b = r[r.length - 1].ratio;
  for (const x of r) { acc += x.w; if (acc >= half) { b = x.ratio; break; } }
  const res = ok.map(o => Math.abs(o.gap - b * o.dur / 60)).sort((x, y) => x - y);
  return { a: 0, b, n: ok.length, mad: res[Math.floor(res.length / 2)] };
}

const breakMinutes = (breaks, durMin) => Math.max(0, Math.min(BREAK_MAX, breaks.a + breaks.b * durMin / 60));

// ---------------------------------------------------------------- slack
// Shift: only trains that were not disrupted (a disruption's delay is given).
// Duration: also trains disrupted by a late start (how long you then made
// them is your choice), not by an overrun (that duration is given).
function slackObservations(level) {
  const ds = level.scenario.disruptions || [];
  const firstPlan = Math.min(...ds.map(d => toMin(level.scenario.basePlan[d.uid])).filter(v => v != null));
  const overrun = new Set(ds.filter(d => d.type === 'overrun').map(d => d.uid));
  return keptTrains(level)
    .filter(k => k.templated && k.plan >= firstPlan && !overrun.has(k.uid))
    .map(k => ({ key: k.key, shift: k.disrupted ? null : Math.max(0, k.start - k.plan), dur: k.plannedDur > 0 ? k.dur : null }));
}

function fitSlack(obs, { floor = SLACK_FLOOR } = {}) {
  const by = new Map();
  obs.forEach(o => {
    const s = by.get(o.key) || { n: 0, maxShift: 0, nDur: 0, minDur: Infinity };
    if (o.shift != null) { s.n++; s.maxShift = Math.max(s.maxShift, o.shift); }
    if (o.dur != null) { s.nDur++; s.minDur = Math.min(s.minDur, o.dur); }
    by.set(o.key, s);
  });
  const maxShift = new Map(), minDur = new Map();
  by.forEach((s, k) => {
    if (s.n >= SLACK_MIN_SEEN) maxShift.set(k, Math.max(floor, s.maxShift + 15));
    if (s.nDur >= SLACK_MIN_SEEN && Number.isFinite(s.minDur)) minDur.set(k, s.minDur);
  });
  return { maxShift, minDur, floor, seen: by };
}

// ---------------------------------------------------------------- all together
function fitPatterns(levels, { slackFloor = SLACK_FLOOR } = {}) {
  const { links, tally } = fitLinks(levels.flatMap(linkObservations));
  const breaks = fitBreaks(levels.flatMap(l => breakObservations(l, links)));
  const slack = fitSlack(levels.flatMap(slackObservations), { floor: slackFloor });
  return { breaks, links, linkTally: tally, slack, levels: levels.length };
}

// Options for candidates.enumerate() from fitted patterns, for one level.
// `use` picks the pieces: { breaks, links, slack, rest, shrink, relocate }.
function candidateOptions(patterns, level, use = {}) {
  const base = new Map((level.ep.baseDay || []).map(b => [b.uid, b]));
  const keyOf = (uid) => taskKey(base.get(uid));
  const o = { keyOf };
  if (patterns && use.breaks) o.breakFn = (durMin) => breakMinutes(patterns.breaks, durMin);
  if (patterns && use.links) o.linked = (a, b) => patterns.links.has(pairKey(keyOf(a), keyOf(b)));
  if (patterns && use.slack) {
    o.maxShift = (uid) => { const v = patterns.slack.maxShift.get(keyOf(uid)); return v == null ? Infinity : v; };
    // shortest allowed duration: the shortest you have given the family
    o.minDur = (uid, planned) => { const v = patterns.slack.minDur && patterns.slack.minDur.get(keyOf(uid)); return v == null ? Math.round(planned * SHRINK_MIN_RATIO) : Math.min(planned, v); };
  }
  o.rest = !!use.rest; o.shrink = !!use.shrink; o.relocate = !!use.relocate;
  return o;
}

// Fitted patterns as plain JSON (Sets / Maps → arrays) and back.
function patternsToJSON(p) {
  return {
    breaks: p.breaks, links: [...p.links], linkTally: [...p.linkTally.entries()], levels: p.levels,
    slack: { floor: p.slack.floor, maxShift: [...p.slack.maxShift.entries()], minDur: [...(p.slack.minDur || new Map()).entries()], seen: [...p.slack.seen.entries()] },
  };
}
function patternsFromJSON(j) {
  if (!j) return fitPatterns([]);
  const s = j.slack || {};
  return {
    breaks: j.breaks || { a: 0, b: 0, n: 0, mad: null }, links: new Set(j.links || []), linkTally: new Map(j.linkTally || []), levels: j.levels || 0,
    slack: { floor: s.floor != null ? s.floor : SLACK_FLOOR, maxShift: new Map(s.maxShift || []), minDur: new Map(s.minDur || []), seen: new Map(s.seen || []) },
  };
}

return {
  keptTrains, latePairs, linkObservations, fitLinks, breakObservations, fitBreaks, breakMinutes,
  slackObservations, fitSlack, fitPatterns, candidateOptions, taskKey, pairKey, patternsToJSON, patternsFromJSON,
  familyName, autoFamily, familyKey,
  SLACK_FLOOR, BREAK_MAX, SHRINK_MIN_RATIO,
};
});
