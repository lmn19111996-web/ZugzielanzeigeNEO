(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SbxCandidates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// Candidate timetables for a sandbox level — the choice set of the learned
// cost model (see "From Delay Regression to a Learned Cost Model").
//
// Decision trains: every train from the first disruption on, in planned order.
// Each one is kept or cancelled (2^n combinations, n ≤ 10). On top of that a
// candidate may carry ONE special action:
//   hold(i)         train i stays at its plan; overlap is recorded
//   shrink(i)       train i is shortened so it ends before the next kept train
//                   (leaving the full learned break — or, as "trim", only a
//                   5-min transition — even where you planned no gap), at
//                   most down to its minimum duration;
//                   also a train disrupted by a late start (not by an overrun)
//   relocate(i, k)  train i (disrupted or not) jumps behind the k-th kept train
//                   planned after it (k = 1..3); that train shrinks if needed
//                   so i still fits before the planned end of the day. The
//                   slot i leaves stays empty — later trains are never pulled
//                   forward. A relocated disrupted train runs at its planned
//                   duration (the overrun belonged to the slot it left).
// and the whole day is built either with planned gaps (a gap never longer
// than you planned) or, with `rest`, with full breaks after every task that
// ran late.
//
// Walking the day in (possibly re-ordered) planned order, a kept train starts
//   max(plan, end of each blocking predecessor + gap)
// — a blocking predecessor is a kept train planned to finish before it starts
// (planned-parallel trains don't block), or anything before a relocated train.
//   gap = planned gap                    if the pair is linked and the first ran late
//       = break(duration of the first)  if rest and the first ran late, or the
//                                        order was changed by a relocation
//       = min(break, planned gap)        otherwise
// A candidate where a recurring train moves further than its slack allows is
// dropped. Identical timetables are merged.
//
// Options (all optional; without them: push / hold / cancel with gap 0):
//   breakFn(durMin) → minutes · linked(uidA, uidB) → bool · maxShift(uid) → min
//   minDur(uid, plannedMin) → shortest allowed duration · rest · shrink · relocate
//   minGap() → one fixed gap for every pair (legacy reference)
// patterns.candidateOptions() builds them from patterns fitted on earlier levels.

const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
const delayOf = (plan, actual) => { const a = toMin(actual); if (a == null || plan == null) return 0; let d = a - plan; if (d < -720) d += 1440; if (d > 720) d -= 1440; return d; };

// The day as decision problem: ordered trains, their plan, planned duration,
// given start/duration for disrupted trains.
//
// Day-start trains (the only explicit rule; marked per recurring template in
// Einstellungen → Prognosemodell, stored on the level as baseDay[].dayStart):
// the train that marks when you are up. It is never cancelled or relocated,
// and its actual start is a floor for every train planned after it — skipping
// the ritual doesn't make you get up earlier. It can still be shortened.
//
// Fixed appointments (second explicit rule, marked per task family in
// Einstellungen → Prognosemodell → Feste Termine; baseDay[].appointment):
// classes, Tennis … Its end is fixed: it never ends late and never pushes the
// trains after it. Attending late means attending less (start = when you are
// free, end = planned end); if you are free only after it ended, it can only
// be skipped. It is never moved behind other trains, held or shortened by
// choice. No limit on how late you may join — the costs learn that.
function framing(level) {
  const disrupted = new Set((level.scenario.disruptions || []).map(d => d.uid));
  const disruptionType = new Map((level.scenario.disruptions || []).map(d => [d.uid, d.type || 'delay']));
  const dayStart = new Set(((level.ep && level.ep.baseDay) || []).filter(b => b && b.dayStart).map(b => b.uid));
  const appointment = new Set(((level.ep && level.ep.baseDay) || []).filter(b => b && b.appointment).map(b => b.uid));
  const pdOf = (uid, fallback) => {
    const v = level.scenario.basePlannedDauer && level.scenario.basePlannedDauer[uid];
    return v != null ? Number(v) || 0 : fallback;
  };
  const day = level.start.map(t => {
    const plan = toMin(level.scenario.basePlan[t._uniqueId] || t.plan);
    return {
      uid: t._uniqueId, linie: t.linie, ziel: t.ziel, plan,
      plannedDauer: pdOf(t._uniqueId, Number(t.dauer) || 0),
      givenStart: plan + delayOf(plan, t.actual), givenDauer: Number(t.dauer) || 0,
      disrupted: disrupted.has(t._uniqueId),
      disruptionType: disruptionType.get(t._uniqueId) || null,
      dayStart: dayStart.has(t._uniqueId),
      appointment: appointment.has(t._uniqueId),
    };
  }).filter(x => x.plan != null).sort((a, b) => a.plan - b.plan || (a.uid < b.uid ? -1 : 1));
  const firstIdx = day.findIndex(x => x.disrupted);
  const gates = day.filter(x => x.dayStart).map(x => ({ uid: x.uid, plan: x.plan, start: x.givenStart }));
  return { day, firstIdx, decision: firstIdx === -1 ? [] : day.slice(firstIdx), gates };
}

// Earliest start allowed by the day-start trains planned before x.
function gateFloor(fr, x) {
  let f = -Infinity;
  (fr.gates || []).forEach(g => { if (g.uid !== x.uid && g.plan <= x.plan) f = Math.max(f, g.start); });
  return f;
}

// Shortest transition between two trains when a train is trimmed to fit.
const MIN_TRANSITION = 5;

function normOptions(o = {}) {
  if (o.__norm) return o;
  const fixed = o.minGap ? o.minGap() : 0;
  return {
    __norm: true,
    breakFn: o.breakFn || (() => fixed),
    linked: o.linked || null,
    maxShift: o.maxShift || (() => Infinity),
    minDur: o.minDur || ((uid, planned) => Math.round(planned * 0.5)),
    rest: !!o.rest, shrink: !!o.shrink, relocate: !!o.relocate,
  };
}

// Build one timetable. cfg = { actions: uid → 'cancel' | 'push' | 'keep', special, rest }.
// Returns null if the candidate is impossible or breaks a slack limit.
function build(fr, cfg, opts) {
  const o = normOptions(opts);
  const pre = new Set(fr.day.slice(0, Math.max(0, fr.firstIdx)).map(x => x.uid));
  const cancelled = (x) => !pre.has(x.uid) && cfg.actions[x.uid] === 'cancel';
  const sp = cfg.special || null;
  if (fr.day.some(x => x.dayStart && !pre.has(x.uid) && cfg.actions[x.uid] === 'cancel')) return null;
  const order = fr.day.slice();
  let relocUid = null, behindUid = null;
  if (sp && sp.type === 'relocate') {
    const xi = order.findIndex(t => t.uid === sp.uid);
    if (xi === -1 || order[xi].dayStart || order[xi].appointment) return null;
    const later = order.slice(xi + 1).filter(t => !cancelled(t) && t.plannedDauer > 0);
    const j = later[sp.k - 1];
    if (!j) return null;
    const x = order[xi];
    order.splice(xi, 1);
    order.splice(order.indexOf(j) + 1, 0, x);
    relocUid = x.uid; behindUid = j.uid;
  }
  const dayEnd = Math.max(...fr.day.map(x => x.plan + x.plannedDauer));
  // A relocated disrupted train runs at its planned duration: its overrun
  // belonged to the slot it left.
  const durOf = (x) => (x.disrupted && x.uid !== relocUid ? x.givenDauer : x.plannedDauer);

  const gapAfter = (p, x) => {
    const plannedGap = x.plan - p.plannedEnd;
    const late = p.end > p.plannedEnd + 0.5;
    const reordered = p.reloc || x.uid === relocUid;
    if (late && o.linked && plannedGap >= 0 && !reordered && o.linked(p.uid, x.uid)) return plannedGap;
    const br = o.breakFn(p.dur);
    if (plannedGap < 0 || reordered) return br;
    if (cfg.rest && late) return br;
    return Math.min(br, plannedGap);
  };
  // Duration for a train shortened to fit (at position i, starting at s).
  // gap: 'break' = leave the learned break, 'min' = only a short transition.
  const fitDuration = (i, x, s, gap = 'break') => {
    const y = order.slice(i + 1).find(t => !cancelled(t) && !pre.has(t.uid));
    let d = durOf(x);
    for (let it = 0; it < 3; it++) {
      const br = gap === 'min' ? MIN_TRANSITION : o.breakFn(d);
      let limit;
      if (!y) limit = dayEnd;
      else if (y.uid === relocUid) limit = dayEnd - durOf(y) - br;
      // Shortening is how you make room for the break, so the full break counts
      // (not capped at the gap you planned — a block planned back to back
      // before an appointment is shortened to get there in time).
      else limit = (y.disrupted ? y.givenStart : y.plan) - br;
      d = Math.min(durOf(x), limit - s);
    }
    return d;
  };

  const settled = [];
  const starts = {}, durs = {}, delays = {}, shrinkMin = {};
  let overlapMin = 0, end = -Infinity;
  for (let i = 0; i < order.length; i++) {
    const x = order[i];
    let s, d;
    if (pre.has(x.uid)) { s = x.givenStart; d = x.givenDauer; }
    else {
      if (cancelled(x)) continue;
      const isReloc = x.uid === relocUid;
      if (x.disrupted && !isReloc) {
        s = x.givenStart; d = x.givenDauer;
        // A train that starts late may be shortened to fit (an overrun may not:
        // that would undo the disruption).
        if (sp && sp.type === 'shrink' && sp.uid === x.uid && x.disruptionType === 'delay') {
          const minD = o.minDur(x.uid, x.plannedDauer);
          d = Math.max(minD, Math.min(d, Math.round(fitDuration(i, x, s, sp && sp.type === 'shrink' && sp.uid === x.uid ? sp.gap : 'break'))));
          if (d < x.givenDauer) shrinkMin[x.uid] = x.givenDauer - d;
        }
      }
      else {
        d = durOf(x);
        let blockEnd = -Infinity, rawEnd = -Infinity;
        settled.forEach(p => {
          if (!isReloc && !p.reloc && p.plannedEnd > x.plan) return; // planned in parallel
          blockEnd = Math.max(blockEnd, p.end + gapAfter(p, x));
          rawEnd = Math.max(rawEnd, p.end);
        });
        const floor = gateFloor(fr, x);
        const earliest = Math.max(x.disrupted ? x.givenStart : x.plan, floor);
        if (sp && sp.type === 'hold' && sp.uid === x.uid) {
          if (x.plan < floor) return null; // can't hold a train before you're up
          s = x.plan; overlapMin += Math.max(0, rawEnd - x.plan);
        } else s = Math.max(earliest, blockEnd);
        if (x.appointment) {
          // Fixed appointment: the end stays; arriving late = attending less.
          // Free only after it ended → it can only be skipped.
          if (sp && sp.uid === x.uid) return null;
          d = x.plan + x.plannedDauer - s;
          if (d <= 0) return null;
        } else if (!x.disrupted && ((sp && sp.type === 'shrink' && sp.uid === x.uid) || x.uid === behindUid)) {
          const minD = o.minDur(x.uid, x.plannedDauer);
          d = Math.max(minD, Math.min(d, Math.round(fitDuration(i, x, s, sp && sp.type === 'shrink' && sp.uid === x.uid ? sp.gap : 'break'))));
          if (d < x.plannedDauer) shrinkMin[x.uid] = x.plannedDauer - d;
        }
        if (!x.disrupted && !x.appointment && s - x.plan > o.maxShift(x.uid) + 0.5) return null;
      }
      starts[x.uid] = s; durs[x.uid] = d;
      if (!x.disrupted) delays[x.uid] = s - x.plan;
    }
    settled.push({ uid: x.uid, plan: x.plan, plannedEnd: x.plan + x.plannedDauer, start: s, end: s + d, dur: d, reloc: x.uid === relocUid, pre: pre.has(x.uid) });
    end = Math.max(end, s + d);
  }
  // Break deficit: minutes of break missing between consecutive tasks.
  let deficitMin = 0;
  const seq = settled.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < seq.length; i++) {
    const A = seq[i - 1], B = seq[i];
    if (A.pre && B.pre) continue;
    if (A.plannedEnd > B.plan && !A.reloc && !B.reloc) continue; // planned in parallel
    deficitMin += Math.max(0, o.breakFn(A.dur) - Math.max(0, B.start - A.end));
  }
  return { starts, durs, delays, shrinkMin, overlapMin, deficitMin, relocated: relocUid, behind: behindUid, end: Number.isFinite(end) ? end : null };
}

// All distinct candidate timetables for a level.
function enumerate(level, opts = {}) {
  const fr = framing(level);
  const o = normOptions(opts);
  const dec = fr.decision;
  const specials = [null];
  dec.forEach(x => {
    if (x.appointment) return; // attend (end fixed) or skip — nothing else
    if (!x.disrupted) specials.push({ type: 'hold', uid: x.uid });
    if (o.shrink && (!x.disrupted || x.disruptionType === 'delay') && x.plannedDauer >= 30) {
      specials.push({ type: 'shrink', uid: x.uid, gap: 'break' });
      specials.push({ type: 'shrink', uid: x.uid, gap: 'min' }); // trim: just a short transition
    }
    if (o.relocate && !x.dayStart) for (let k = 1; k <= 3; k++) specials.push({ type: 'relocate', uid: x.uid, k });
  });
  const seen = new Map();
  const n = dec.length;
  const keepMask = dec.reduce((m, x, i) => (x.dayStart ? m | (1 << i) : m), 0); // never cancelled
  for (const rest of (o.rest ? [false, true] : [false])) {
    for (const special of specials) {
      for (let mask = 0; mask < (1 << n); mask++) {
        if (mask & keepMask) continue;
        const actions = {};
        dec.forEach((x, i) => { actions[x.uid] = (mask >> i) & 1 ? 'cancel' : (x.disrupted ? 'keep' : 'push'); });
        if (special && actions[special.uid] === 'cancel') continue;
        const t = build(fr, { actions, special, rest }, o);
        if (!t) continue;
        const cancels = dec.filter(x => actions[x.uid] === 'cancel').map(x => x.uid);
        const keptDec = dec.filter(x => actions[x.uid] !== 'cancel');
        const key = cancels.join(',') + '|' + keptDec.map(x => `${t.starts[x.uid]}/${t.durs[x.uid]}`).join(',') + '|' + t.overlapMin + '|' + (t.relocated || '');
        if (!seen.has(key)) seen.set(key, Object.assign({ actions, special, rest, cancels: new Set(cancels), key }, t));
      }
    }
  }
  return { framing: fr, candidates: [...seen.values()] };
}

// Your actual timetable in the same terms.
function userChoice(level, fr) {
  const fin = new Map(level.final.map(t => [t._uniqueId, t]));
  const cancels = new Set(), delays = {}, starts = {}, durs = {};
  fr.decision.forEach(x => {
    const t = fin.get(x.uid);
    if (!t) return;
    if (t.canceled) { cancels.add(x.uid); return; }
    const d = delayOf(x.plan, t.actual);
    starts[x.uid] = x.plan + d; durs[x.uid] = Number(t.dauer) || 0;
    if (!x.disrupted) delays[x.uid] = d;
  });
  return { cancels, delays, starts, durs };
}

// Nearest candidate to your timetable: a different cancel decision costs 1000,
// otherwise the summed minute difference (start and duration) on trains kept
// in both.
function nearest(enumd, user) {
  let best = null;
  for (const c of enumd.candidates) {
    let dist = 0;
    enumd.framing.decision.forEach(x => {
      const uc = user.cancels.has(x.uid), cc = c.cancels.has(x.uid);
      if (uc !== cc) { dist += 1000; return; }
      if (uc) return;
      if (user.starts[x.uid] != null && c.starts[x.uid] != null) dist += Math.abs(c.starts[x.uid] - user.starts[x.uid]);
      if (user.durs[x.uid] != null && c.durs[x.uid] != null) dist += Math.abs(c.durs[x.uid] - user.durs[x.uid]);
    });
    if (!best || dist < best.dist) best = { cand: c, dist };
  }
  return best;
}

// Reference for the replay: the candidate closest to your actual timetable —
// the best any model choosing among these candidates could do. Uses your
// answer; it is a ceiling, not a model. `options` = enumerate options, or a
// function level → options.
function bestCandidateModel({ label, options } = {}) {
  return {
    name: label || 'reference: best candidate',
    predict: (level) => {
      const e = enumerate(level, typeof options === 'function' ? options(level) : (options || {}));
      const user = userChoice(level, e.framing);
      const n = nearest(e, user);
      const delays = {}, cancels = {};
      e.framing.decision.forEach(x => {
        if (n.cand.cancels.has(x.uid)) { cancels[x.uid] = true; return; }
        if (!x.disrupted) delays[x.uid] = n.cand.delays[x.uid] || 0;
      });
      return { delays, cancels, endOfDay: n.cand.end, nearestDist: n.dist, candidateCount: e.candidates.length };
    },
  };
}

return { framing, build, enumerate, userChoice, nearest, bestCandidateModel, normOptions, toMin, delayOf };

});
