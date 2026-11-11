// === DAY RECORDER ===
// Records what the weekly train logs cannot: WHEN things changed. This is
// what lets real days become training data for the delay model later.
//
//   day_logs/snapshots/YYYY-MM-DD.json   the day's timed trains as planned,
//                                        taken at 00:05 (or at the first save
//                                        of the day if the server was off)
//   day_logs/events/YYYY-MM.jsonl        every change to a train, one line
//                                        per change, with the server time
//   day_logs/templates/YYYY-MM.jsonl     every create / edit / delete of a
//                                        recurring template (fixedSchedule) —
//                                        the signal to reset what was learned
//                                        about that template
//
// With the snapshot as the base plan and the change times, a training script
// can tell an intentional cancellation (decided before anything went wrong,
// or with no pressure on the train) from one that compensates for a delay.
//
// Strictly additive: it only ever reads the schedule and writes into
// day_logs/. Every entry point swallows its own errors, so a recorder
// problem can never affect saving or serving the schedule.

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const TRACKED = ['plan', 'actual', 'dauer', 'canceled', 'date', 'checkedIn', 'checkedOut', 'linie', 'ziel', 'type'];
// Template fields whose change means "this task is now a different task":
// time, length, identity, recurrence. skippedDates is left out on purpose —
// dropping a single occurrence is not a reschedule.
const TEMPLATE_TRACKED = ['plan', 'dauer', 'linie', 'ziel', 'type', 'recurrence', 'startDate', 'endDate', 'openEnded'];

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(ds, delta) {
  const [y, m, d] = ds.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + delta));
}

function createdAtFromId(id) {
  const m = /^(?:train|stem)_[a-z0-9]+_(\d{13})/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

const isTimed = (t) => t && t._uniqueId && !t.type && typeof t.plan === 'string' && /^\d{1,2}:\d{2}/.test(t.plan);

function pick(t) {
  const o = {};
  TRACKED.forEach(f => { if (t[f] !== undefined && t[f] !== null && t[f] !== '') o[f] = t[f]; });
  return o;
}

function createDayRecorder({ rootDir, getSchedule }) {
  const DIR = path.join(rootDir, 'day_logs');
  const SNAP_DIR = path.join(DIR, 'snapshots');
  const EVENT_DIR = path.join(DIR, 'events');
  const TEMPLATE_DIR = path.join(DIR, 'templates');
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.mkdirSync(EVENT_DIR, { recursive: true });
    fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  } catch (e) { /* reported on use */ }

  let chain = Promise.resolve(); // serialize writes

  function snapshotTrains(list, date) {
    return (list || []).filter(t => isTimed(t) && t.date === date).map(t => ({
      uid: t._uniqueId,
      templateId: t._templateId || null,
      linie: t.linie || '',
      ziel: t.ziel || '',
      plan: t.plan,
      actual: t.actual || t.plan,
      dauer: Number(t.dauer) || 0,
      plannedDauer: t.plannedDauer != null ? Number(t.plannedDauer) : null,
      canceled: !!t.canceled,
      checkedIn: !!t.checkedIn,
      projectId: t.projectId || null,
      createdAt: createdAtFromId(t._uniqueId) || createdAtFromId(t._templateId),
    }));
  }

  async function ensureSnapshot(date, list, reason) {
    const file = path.join(SNAP_DIR, `${date}.json`);
    try { await fsPromises.access(file); return false; } catch (e) { /* missing → write */ }
    const snap = { date, takenAt: new Date().toISOString(), reason, trains: snapshotTrains(list, date) };
    await fsPromises.writeFile(file + '.tmp', JSON.stringify(snap, null, 2));
    await fsPromises.rename(file + '.tmp', file);
    return true;
  }

  function diff(prevList, nextList, nowIso, minDate) {
    const prev = new Map((prevList || []).filter(t => t && t._uniqueId).map(t => [t._uniqueId, t]));
    const events = [];
    const seen = new Set();
    for (const t of nextList || []) {
      if (!t || !t._uniqueId) continue;
      seen.add(t._uniqueId);
      if (t.type) continue; // notes, duration-only, information: not trains
      const before = prev.get(t._uniqueId);
      const date = t.date || (before && before.date) || null;
      if (!date || date < minDate) continue;
      if (!before) { events.push({ at: nowIso, uid: t._uniqueId, date, kind: 'created', after: pick(t) }); continue; }
      const fields = TRACKED.filter(f => String(before[f] ?? '') !== String(t[f] ?? ''));
      if (fields.length) events.push({ at: nowIso, uid: t._uniqueId, date, kind: 'changed', fields, before: pick(before), after: pick(t) });
    }
    for (const [uid, before] of prev) {
      if (seen.has(uid) || before.type) continue;
      if (!before.date || before.date < minDate) continue;
      events.push({ at: nowIso, uid, date: before.date, kind: 'deleted', before: pick(before) });
    }
    return events;
  }

  function pickTemplate(t) {
    const o = {};
    TEMPLATE_TRACKED.forEach(f => { if (t[f] !== undefined && t[f] !== null && t[f] !== '') o[f] = t[f]; });
    return o;
  }

  function diffTemplates(prevList, nextList, nowIso) {
    const prev = new Map((prevList || []).filter(t => t && t._uniqueId).map(t => [t._uniqueId, t]));
    const events = [];
    const seen = new Set();
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    for (const t of nextList || []) {
      if (!t || !t._uniqueId) continue;
      seen.add(t._uniqueId);
      const before = prev.get(t._uniqueId);
      if (!before) { events.push({ at: nowIso, templateId: t._uniqueId, kind: 'created', after: pickTemplate(t) }); continue; }
      const fields = TEMPLATE_TRACKED.filter(f => !same(before[f], t[f]));
      if (fields.length) events.push({ at: nowIso, templateId: t._uniqueId, kind: 'changed', fields, before: pickTemplate(before), after: pickTemplate(t) });
    }
    for (const [id, before] of prev) {
      if (!seen.has(id)) events.push({ at: nowIso, templateId: id, kind: 'deleted', before: pickTemplate(before) });
    }
    return events;
  }

  // Called after every successful schedule save with the recurring templates
  // before and after it. Fire-and-forget like recordSave.
  function recordTemplates(prevFixed, nextFixed) {
    chain = chain.then(async () => {
      if (!Array.isArray(prevFixed)) return; // no "before" known: nothing to compare
      const now = new Date();
      const events = diffTemplates(prevFixed, nextFixed, now.toISOString());
      if (!events.length) return;
      const file = path.join(TEMPLATE_DIR, `${localDate(now).slice(0, 7)}.jsonl`);
      await fsPromises.appendFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    }).catch(err => console.warn('[day-recorder] template change not recorded:', err.message));
  }

  // Called after every successful schedule save, with the entries before
  // and after it. Fire-and-forget: never throws, never awaited by the caller.
  function recordSave(prevList, nextList) {
    chain = chain.then(async () => {
      const now = new Date();
      const today = localDate(now);
      // The plan for today as it stood BEFORE this save (first save of the day
      // only, and only if the 00:05 snapshot didn't run).
      await ensureSnapshot(today, prevList && prevList.length ? prevList : nextList, 'first-save');
      // Changes from yesterday on (late check-outs of overnight trains) — far
      // past days are history edits, not decisions.
      const events = diff(prevList, nextList, now.toISOString(), shiftDate(today, -1));
      if (events.length) {
        const file = path.join(EVENT_DIR, `${today.slice(0, 7)}.jsonl`);
        await fsPromises.appendFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
      }
    }).catch(err => console.warn('[day-recorder] save not recorded:', err.message));
  }

  // Snapshot at 00:05 local time every day (and once at start-up for today).
  function startDailySnapshots() {
    const take = (reason) => {
      chain = chain.then(async () => {
        const data = await getSchedule();
        const date = localDate();
        if (await ensureSnapshot(date, (data && data.spontaneousEntries) || [], reason)) {
          console.log(`📸 [day-recorder] snapshot ${date} (${reason})`);
        }
      }).catch(err => console.warn('[day-recorder] snapshot failed:', err.message));
    };
    take('startup');
    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
      setTimeout(() => { take('daily'); scheduleNext(); }, next - now);
    };
    scheduleNext();
  }

  return { recordSave, recordTemplates, startDailySnapshots, diff, diffTemplates, snapshotTrains };
}

module.exports = { createDayRecorder };
