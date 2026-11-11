// Shared loader + small stats helpers for the train_logs analysis scripts
// (cascade-validity.js, disruption-drivers.js). Read-only.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOG_DIR = path.join(ROOT, 'train_logs');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hm(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const pct = (x) => (x == null || !Number.isFinite(x) ? '  n/a' : (100 * x).toFixed(1).padStart(5) + '%');
const num = (x, d = 3) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const weekday = (day) => new Date(day + 'T12:00:00Z').getUTCDay();
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function median(xs) {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

function shiftDay(day, delta) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Local (machine time zone) epoch ms for a service day + minutes after midnight.
function localMs(day, minutes) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, 0, minutes || 0).getTime();
}

// IDs embed their creation time: train_<rand>_<13-digit ms>[suffix],
// stem_<rand>_<13-digit ms>_<date> (template creation for recurring items).
function createdAtFromId(id) {
  const m = /^(?:train|stem|note)_[a-z0-9]+_(\d{13})/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

function cancelReasonOf(r) {
  for (const s of r.zwischenhalte || []) {
    const m = String(s).match(/\[([^\]]+)\]/);
    if (m) return m[1].trim();
  }
  return '';
}

function loadLog({ logDir = DEFAULT_LOG_DIR, threshold = 5 } = {}) {
  const files = fs.readdirSync(logDir).filter(f => /^train_history_.+\.log$/.test(f)).sort();
  const byId = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || !r.recordId) continue;
      const prev = byId.get(r.recordId);
      if (!prev || String(r.loggedAt || '') >= String(prev.loggedAt || '')) byId.set(r.recordId, r);
    }
  }

  const trains = [], durationOnly = [];
  for (const r of byId.values()) {
    if (!r.serviceDate) continue;
    const id = r._uniqueId || '';
    if (/_vorlage_preview$/.test(id)) continue; // template preview artefacts
    const base = {
      id,
      day: r.serviceDate,
      line: r.linie || '?',
      label: `${r.linie || '?'} ${r.ziel || ''}`.trim(),
      key: r._templateId || `${r.linie}|${r.ziel}`,
      recurring: Boolean(r._templateId),
      // Planned duration: frozen value when checked out (since plannedDauer
      // exists), else the logged dauer, which is the plan for non-checked-out
      // trains and the measured duration for older checked-out ones.
      dauer: Math.max(0, Number(r.plannedDauer != null ? r.plannedDauer : r.dauer) || 0),
      measuredDauer: r.checkedOut ? Math.max(0, Number(r.dauer) || 0) : null,
      canceled: Boolean(r.canceled),
      projectId: r.projectId || null,
      createdAt: createdAtFromId(r._templateId || id) || createdAtFromId(id),
      measured: Boolean(r.checkedIn),
      cancelReason: r.canceled ? cancelReasonOf(r) : '',
      delayReason: r.delayReason || '',
    };
    if (r.type === 'duration-only') { durationOnly.push(base); continue; }
    if (r.type) continue; // notes, todo, information
    const plan = hm(r.plan);
    if (plan == null) continue;
    const act = hm(r.actual);
    let delay = act == null ? 0 : act - plan;
    if (delay < -720) delay += 1440;
    if (delay > 720) delay -= 1440;
    // One-off items carry their own creation time; recurring instances inherit
    // the template's, which says nothing about when *this* day was planned.
    const ownCreated = createdAtFromId(id);
    trains.push({
      ...base,
      createdAt: base.recurring ? base.createdAt : ownCreated,
      plan,
      planMs: localMs(r.serviceDate, plan),
      start: plan + Math.max(delay, -plan),
      delay,
      late: !base.canceled && delay >= threshold,
    });
  }

  const days = new Map();
  for (const t of trains) {
    if (!days.has(t.day)) days.set(t.day, []);
    days.get(t.day).push(t);
  }
  for (const list of days.values()) list.sort((a, b) => a.plan - b.plan);
  const durByDay = new Map();
  for (const t of durationOnly) {
    if (!durByDay.has(t.day)) durByDay.set(t.day, []);
    durByDay.get(t.day).push(t);
  }
  return { trains, durationOnly, days, durByDay, fileCount: files.length };
}

module.exports = {
  DEFAULT_LOG_DIR, mulberry32, hm, pct, num, mean, median, quantile, weekday, WEEKDAYS,
  logit, sigmoid, shiftDay, localMs, createdAtFromId, loadLog,
};
