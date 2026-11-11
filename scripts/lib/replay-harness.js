// Replay harness: rebuild every recorded sandbox level and score any model on
// it the way the app does, prequentially (predict at the level start, score,
// then let the model learn from the level), in the order the levels were played.
//
// A model is an object with
//   predict(level) → { delays: {uid: minutes}, cancels: {uid: bool}, endOfDay }
//   learn(level)   → optional
// where `level` = { ep, start, final, scenario, labels, tiers, truth }:
//   start     the day at level start (disruptions applied, nothing decided)
//   final     your final timetable
//   truth     { examples, cancelExamples, endOfDay } — the labels the app
//             trained and scored on (sandbox-model finalTimetable)
//
// Scores per level (same definitions as the app's episode record):
//   mae        mean |predicted − your delay| over labelled kept trains
//   dayErr     |predicted end of day − your end of day|
//   cancelHit  trains you canceled that were predicted canceled
//   falseCancel trains predicted canceled that you kept

const fs = require('fs');
const path = require('path');
const { loadSandboxModules, currentRanking, ROOT } = require('./sandbox-modules');

const avg = (xs) => { const v = xs.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

// Default: the archived levels of the v2 hurdle-model sandbox (the cost-model
// study of Nov 2026). New sandbox levels (v2 episodes) are evaluated by
// scripts/sandbox-eval.js.
const ARCHIVE_EPISODES = path.join(ROOT, 'sandbox_data/archive/2026-11-11_v2-hurdle-model/episodes.jsonl');
function loadEpisodes({ file = ARCHIVE_EPISODES, includeDiscarded = false } = {}) {
  const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return all
    .filter(ep => includeDiscarded || !ep.discarded)
    .sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
}

// One recorded level, rebuilt.
function buildLevel(ep, fallbackTiers) {
  const { SB, LV } = loadSandboxModules();
  const lvl = LV.levelFromEpisode(ep);
  if (!lvl) return null;
  const tiers = Array.isArray(ep.lineRanking) && ep.lineRanking.length ? ep.lineRanking : fallbackTiers;
  const excluded = new Set(ep.excludedTrains || []);
  const start = ep.baseDay.filter(b => !excluded.has(b.uid)).map(b => ({
    _uniqueId: b.uid, linie: b.linie, ziel: b.ziel, plan: b.plan,
    actual: b.actual, dauer: Number(b.dauer) || 0, canceled: false, date: ep.date,
  }));
  const truth = SB.finalTimetable(lvl.entries, lvl.scenario, tiers, lvl.labels);
  return { ep, start, final: lvl.entries, scenario: lvl.scenario, labels: lvl.labels, tiers, truth };
}

function scoreLevel(level, pred) {
  const scoredB = level.truth.examples.filter(e => e.weight > 0);
  const mae = avg(scoredB.map(e => {
    const p = pred.delays[e.uid];
    return p == null ? null : Math.abs(p - Math.round(e.y * 60));
  }));
  const scoredA = level.truth.cancelExamples.filter(e => e.weight > 0);
  const canceled = scoredA.filter(e => e.z === 1);
  const cancelHit = canceled.filter(e => pred.cancels[e.uid]).length;
  const falseCancel = scoredA.filter(e => e.z === 0 && pred.cancels[e.uid]).length;
  const dayErr = pred.endOfDay != null && level.truth.endOfDay != null ? Math.abs(pred.endOfDay - level.truth.endOfDay) : null;
  return { mae, dayErr, cancelHit, cancelN: canceled.length, falseCancel, keptN: scoredA.length - canceled.length };
}

// Run one model over all levels. Returns per-level rows and the levels.
function runReplay(model, { episodes, tiers } = {}) {
  const fallback = tiers || currentRanking();
  const eps = episodes || loadEpisodes();
  const rows = [];
  for (const ep of eps) {
    const level = buildLevel(ep, fallback);
    if (!level) continue;
    const pred = model.predict(level);
    rows.push(Object.assign({ level: ep.level, kind: ep.kind || 'active', blind: !!ep.blind, ep, pred }, scoreLevel(level, pred)));
    if (model.learn) model.learn(level);
  }
  return rows;
}

function summarize(rows) {
  const groups = {
    'blind (test + replay)': rows.filter(r => r.kind === 'probe' || r.kind === 'replay'),
    active: rows.filter(r => r.kind === 'active'),
    all: rows,
  };
  const out = {};
  for (const [name, g] of Object.entries(groups)) {
    const cancelN = g.reduce((s, r) => s + r.cancelN, 0);
    const keptN = g.reduce((s, r) => s + r.keptN, 0);
    out[name] = {
      n: g.length,
      mae: avg(g.map(r => r.mae)),
      dayErr: avg(g.map(r => r.dayErr)),
      cancelRecall: cancelN ? g.reduce((s, r) => s + r.cancelHit, 0) / cancelN : null,
      falseCancelRate: keptN ? g.reduce((s, r) => s + r.falseCancel, 0) / keptN : null,
      cancelN,
    };
  }
  return out;
}

// ---- built-in reference models ----
function fromRollout(r) {
  const delays = {}, cancels = {};
  Object.entries(r.predictions).forEach(([uid, p]) => {
    if (!p.disrupted) delays[uid] = p.minutes;
    if (p.cancel) cancels[uid] = true;
  });
  return { delays, cancels, endOfDay: r.endOfDay };
}

function pushModel() {
  const { SB } = loadSandboxModules();
  return { name: 'push', predict: (lvl) => fromRollout(SB.rolloutPush(lvl.start, lvl.scenario, lvl.tiers, {})) };
}

// The delay model as it ran in the sandbox: starts from model.base.json and
// learns each level after scoring it.
function currentModel({ baseFile = path.join(ROOT, 'sandbox_data/model.base.json') } = {}) {
  const { SB } = loadSandboxModules();
  let m;
  try { m = JSON.parse(fs.readFileSync(baseFile, 'utf8')); } catch (e) { m = null; }
  if (!SB.isValidModel(m)) m = SB.newModel();
  return {
    name: 'current (delay model)',
    predict: (lvl) => fromRollout(SB.rollout(lvl.start, lvl.scenario, m, lvl.tiers, {})),
    learn: (lvl) => SB.learn(m, lvl.truth.examples, lvl.truth.cancelExamples),
  };
}

// Reference, not a model: your own cancel choices, everything else pushed.
function oracleCancelModel() {
  const { SB } = loadSandboxModules();
  return {
    name: 'reference: your cancels + push',
    predict: (lvl) => {
      const canceled = new Set(lvl.final.filter(t => t.canceled).map(t => t._uniqueId));
      const start = lvl.start.map(t => (canceled.has(t._uniqueId) ? Object.assign({}, t, { canceled: true }) : t));
      const out = fromRollout(SB.rolloutPush(start, lvl.scenario, lvl.tiers, {}));
      canceled.forEach(uid => { out.cancels[uid] = true; });
      return out;
    },
  };
}

module.exports = { loadEpisodes, buildLevel, scoreLevel, runReplay, summarize, fromRollout, pushModel, currentModel, oracleCancelModel, avg };
