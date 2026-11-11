// Real days → training "levels" for the sandbox delay model.
//
// Needs the day recorder's data (day_logs/, see day-recorder.js):
//   snapshots/YYYY-MM-DD.json  the day's plan at day start = base plan
//   events/YYYY-MM.jsonl       every change, with the time it was made
//
// Pass 1 replays all of the day's changes to get the final state and the
// primary disruptions (a late start that earlier trains don't explain, or a
// run over the planned duration). The time a disruption was first recorded
// gives T0, the moment the day started going wrong.
//
// Pass 2 replays again and classifies every cancellation / deletion at the
// moment it was made:
//   intentional  — before T0, or while the train had no extra overlap
//                  pressing on it: the train is removed from the day, as if
//                  it had never been planned (it is not a reaction).
//   compensating — at or after T0, on a train under pressure (or on the
//                  disrupted train itself): a "canceled" training example.
// Trains added after T0 are reactions too and are left out; trains added
// before T0 count as planned. A train counts as decided if anything about it
// changed at or after T0 (or it was checked in); untouched trains follow the
// sandbox label rule.
//
// Known limit: a delay entered only after the fact makes T0 late, so a
// compensating cancellation made before that entry reads as intentional.

const fs = require('fs');
const path = require('path');

const PRIMARY_MIN = 5;
const OVERRUN_MIN = 10;

const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
const toHHMM = (min) => { const v = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; };
const delayOf = (plan, actual) => { const a = toMin(actual); if (a == null || plan == null) return 0; let d = a - plan; if (d < -720) d += 1440; if (d > 720) d -= 1440; return d; };

function listRecordedDays(dir) {
  const snapDir = path.join(dir, 'snapshots');
  if (!fs.existsSync(snapDir)) return [];
  return fs.readdirSync(snapDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
}

function loadEventsFor(dir, date) {
  const evDir = path.join(dir, 'events');
  if (!fs.existsSync(evDir)) return [];
  const [y, m] = date.split('-').map(Number);
  const months = [date.slice(0, 7), `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`];
  const out = [];
  months.forEach(mo => {
    const f = path.join(evDir, `${mo}.jsonl`);
    if (!fs.existsSync(f)) return;
    fs.readFileSync(f, 'utf8').split('\n').forEach(line => {
      if (!line.trim()) return;
      try { const e = JSON.parse(line); if (e.date === date || (e.after && e.after.date === date) || (e.before && e.before.date === date)) out.push(e); } catch (err) { /* skip */ }
    });
  });
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// snapshot: { date, takenAt, trains: [...] }, events: [...] (chronological)
// rateOf(templateId, linie) → historical cancel rate (from earlier days)
function buildRealDay({ snapshot, events, rateOf }) {
  const date = snapshot.date;
  const meta = { intentionalCancels: 0, compensatingCancels: 0, canceledBeforeDay: 0, lateAdditions: 0, disruptions: 0 };
  const snapTime = Date.parse(snapshot.takenAt) || 0;

  // ---- base plan: snapshot trains + trains added during the day (decided later whether they count)
  const base = new Map();
  (snapshot.trains || []).forEach(t => {
    if (t.canceled) { meta.canceledBeforeDay++; return; }
    base.set(t.uid, {
      uid: t.uid, templateId: t.templateId || null, linie: t.linie, ziel: t.ziel,
      plan: toMin(t.plan), plannedDauer: t.plannedDauer != null ? t.plannedDauer : (Number(t.dauer) || 0), addedAt: null,
    });
  });
  const initialState = (b) => ({ actual: toHHMM(b.plan), dauer: b.plannedDauer, canceled: false, deleted: false, checkedIn: false });
  const applyEvent = (state, e) => {
    const s = state.get(e.uid);
    if (!s) return;
    if (e.kind === 'deleted') { s.deleted = true; return; }
    const a = e.after || {};
    if (a.actual !== undefined) s.actual = a.actual;
    if (a.dauer !== undefined) s.dauer = Number(a.dauer) || 0;
    s.canceled = !!a.canceled;
    if (a.checkedIn) s.checkedIn = true;
  };

  events.forEach(e => {
    if (e.kind === 'created' && !base.has(e.uid) && e.after && e.after.plan && (e.after.date || e.date) === date) {
      base.set(e.uid, {
        uid: e.uid, templateId: null, linie: e.after.linie || '', ziel: e.after.ziel || '',
        plan: toMin(e.after.plan), plannedDauer: Number(e.after.dauer) || 0, addedAt: Date.parse(e.at),
      });
    }
  });
  const order = [...base.values()].filter(b => b.plan != null).sort((a, b) => a.plan - b.plan || (a.uid < b.uid ? -1 : 1));

  // ---- pass 1: final state, first time each train's lateness was recorded
  const state = new Map(order.map(b => [b.uid, initialState(b)]));
  const lateAt = new Map();
  events.forEach(e => {
    if (!state.has(e.uid)) return;
    applyEvent(state, e);
    const b = base.get(e.uid), s = state.get(e.uid);
    const late = delayOf(b.plan, s.actual) >= PRIMARY_MIN || s.dauer - b.plannedDauer >= OVERRUN_MIN;
    if (late && !lateAt.has(e.uid)) lateAt.set(e.uid, Date.parse(e.at));
  });

  // Conflict on `target` from the trains planned to FINISH before it starts
  // (planned-parallel trains like all-day blocks are ignored) — the same rule
  // the model uses. `stateOf` gives each train's current actual / dauer.
  const conflictOn = (target, stateOf, skip) => {
    let end = -Infinity;
    for (const b of order) {
      if (b.uid === target.uid || b.plan > target.plan) continue;
      if (skip && skip.has(b.uid)) continue;
      if (b.plan + b.plannedDauer > target.plan) continue; // planned in parallel
      const s = stateOf(b.uid);
      if (s.canceled || s.deleted || !(s.dauer > 0)) continue;
      end = Math.max(end, b.plan + delayOf(b.plan, s.actual) + s.dauer);
    }
    return Math.max(0, end - target.plan);
  };

  // primary disruptions on the final state: lateness the predecessors don't explain
  const disruptions = [];
  order.forEach(b => {
    const s = state.get(b.uid);
    if (s.canceled || s.deleted) return;
    const delay = delayOf(b.plan, s.actual);
    const conflict = conflictOn(b, uid => state.get(uid));
    if (delay >= PRIMARY_MIN && delay - conflict >= PRIMARY_MIN) disruptions.push({ uid: b.uid, type: 'delay', minutes: delay, linie: b.linie, plan: toHHMM(b.plan) });
    else if (s.dauer - b.plannedDauer >= OVERRUN_MIN) disruptions.push({ uid: b.uid, type: 'overrun', minutes: s.dauer - b.plannedDauer, linie: b.linie, plan: toHHMM(b.plan) });
  });
  if (!disruptions.length) return { date, skipped: 'no-disruption', meta };
  meta.disruptions = disruptions.length;
  const disruptedSet = new Set(disruptions.map(d => d.uid));
  // When the day started going wrong: the earliest moment a disruption was
  // known (recorded lateness; if never recorded, its actual start time).
  const [y, mo, d] = date.split('-').map(Number);
  const T0 = Math.min(...disruptions.map(dd => lateAt.get(dd.uid)
    ?? new Date(y, mo - 1, d, 0, base.get(dd.uid).plan + delayOf(base.get(dd.uid).plan, state.get(dd.uid).actual)).getTime()));

  // ---- pass 2: classify cancellations / deletions at the moment they were made
  const excluded = new Set();
  order.forEach(b => { if (b.addedAt != null && b.addedAt >= T0) { excluded.add(b.uid); meta.lateAdditions++; } });
  const live = new Map(order.map(b => [b.uid, initialState(b)]));
  const pressureOn = (uid) => conflictOn(base.get(uid), u => live.get(u), excluded);
  const decidedAt = new Map();
  events.forEach(e => {
    if (!live.has(e.uid) || excluded.has(e.uid)) return;
    const t = Date.parse(e.at);
    const s = live.get(e.uid);
    const wasGone = s.canceled || s.deleted;
    const becomesGone = e.kind === 'deleted' || !!(e.after && e.after.canceled);
    if (!wasGone && becomesGone) {
      const compensating = t >= T0 && (disruptedSet.has(e.uid) || pressureOn(e.uid) > 0);
      if (compensating) meta.compensatingCancels++;
      else { meta.intentionalCancels++; excluded.add(e.uid); }
    }
    if (t >= T0) decidedAt.set(e.uid, t);
    applyEvent(live, e);
  });

  // ---- the level
  const kept = order.filter(b => !excluded.has(b.uid));
  const entries = kept.map(b => {
    const s = live.get(b.uid);
    return {
      _uniqueId: b.uid, linie: b.linie, ziel: b.ziel,
      plan: toHHMM(b.plan), actual: s.actual, dauer: s.dauer,
      canceled: s.canceled || s.deleted, date,
    };
  });
  const scenario = {
    date,
    disruptions: disruptions.filter(dd => !excluded.has(dd.uid)),
    basePlan: Object.fromEntries(kept.map(b => [b.uid, toHHMM(b.plan)])),
    basePlannedDauer: Object.fromEntries(kept.map(b => [b.uid, b.plannedDauer])),
    baseCancelRate: Object.fromEntries(kept.map(b => [b.uid, rateOf ? rateOf(b.templateId, b.linie) : null])),
    decided: {},
  };
  if (!scenario.disruptions.length) return { date, skipped: 'disruption-excluded', meta };
  const decided = {};
  kept.forEach(b => { if (decidedAt.has(b.uid) || live.get(b.uid).checkedIn) decided[b.uid] = true; });
  return { date, entries, scenario, labels: { decided }, meta, snapshotTakenAt: snapTime };
}

module.exports = { listRecordedDays, loadEventsFor, buildRealDay };
