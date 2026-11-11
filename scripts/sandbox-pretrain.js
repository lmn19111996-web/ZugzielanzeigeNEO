#!/usr/bin/env node
// RETIRED (11 Nov 2026): this pre-trained the old hurdle model (now in
// public/sandbox/legacy/). The sandbox uses the learned cost model and starts
// from zero; real days are deliberately not fed into it while the model is
// being tested. Kept for reference; runs only with --legacy.
if (!process.argv.includes('--legacy')) {
  console.error('sandbox-pretrain.js is retired (old hurdle model). Run with --legacy to use it anyway.');
  process.exit(1);
}
// Pre-train the sandbox delay model (v2) on everything recorded so far:
//
//   1. Real days from train_logs/ — converted into "levels": the day's
//      primary disruptions (a late start that earlier trains don't explain,
//      or a run ≥ 10 min over the frozen planned duration) are the givens;
//      every train after the first disruption becomes a training example.
//      Real days count with weight 0.5 (revealed behaviour, but noisy: few
//      check-ins, final states only). Cancel base rates are computed from
//      EARLIER days only, so a day never sees its own outcome.
//   2. Archived sandbox levels that carry a full snapshot
//      (sandbox_data/archive/*/episodes.jsonl) — replayed exactly, weight 1.
//
// Order is chronological (real days, then archived sandbox levels), with the
// model's normal per-level forgetting. That result is written as
// sandbox_data/model.base.json — the starting point the sandbox rebuilds from
// when a level is discarded. The levels played in the current sandbox
// (episodes.jsonl, discarded ones skipped) are then replayed on top and the
// result written as sandbox_data/model.json (previous file backed up), so
// re-running this script never drops played levels. Pre-training adds NO
// played levels: the level count and the probe scores stay untouched.
//
//   node scripts/sandbox-pretrain.js [--dry-run] [--show] [--real-cancel] [--real-delay] [--real-weight 0.5]
//
// RECORDED real days (day_logs/ snapshot + change log, from 10 Nov 2026 on,
// see day-recorder.js and scripts/lib/real-day-levels.js) are always used, at
// full weight: they separate intentional from compensating cancellations and
// planned from reactive changes, which the weekly logs alone cannot.
//
// LEGACY real days (weekly logs only, before the recorder existed) are NOT
// trained on by default (they are still read for the cancel base rates).
// Findings from the first runs (10 Nov 2026):
//   --real-delay:  in the real logs an overlap is usually genuine parallel
//                  work (all-day blocks next to normal trains) or a time that
//                  was never updated, so the delay stage learned "overlap
//                  causes no delay" (conflict weight 1.00 → −0.11) and the
//                  noise estimate hit its ±60 min ceiling.
//   --real-cancel: real cancellations are mostly unconditional (reading or
//                  gym skipped on an ordinary evening, abandoned templates),
//                  not responses to a disruption. The model then predicted
//                  "fällt aus" for conflict-free trains in every level
//                  (Circe 21:30 ~50 %). That habit already enters the model
//                  through the base-rate feature, which is the right place.
// Disrupted trains are always left out of real cancel examples: real
// disruptions are detected from late STARTS, so a disrupted real train has
// always run — its "not canceled" label is an artefact of the detection.

const fs = require('fs');
const path = require('path');
const L = require('./lib/train-log-data');
const RD = require('./lib/real-day-levels');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'sandbox_data');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const REAL_WEIGHT = args.includes('--real-weight') ? Number(args[args.indexOf('--real-weight') + 1]) || 0.5 : 0.5;
const REAL_DELAY = args.includes('--real-delay');
const REAL_CANCEL = args.includes('--real-cancel');
const ABSENCE_SHARE = 0.8;     // ≥ 80 % canceled = trip / absence day, not a disruption response
const PRIMARY_MIN = 5;         // minutes of unexplained lateness to count as a disruption
const OVERRUN_MIN = 10;        // minutes over the frozen planned duration

// Load the browser modules (they attach to window).
global.window = {};
const schedSrc = fs.readFileSync(path.join(ROOT, 'public/js/schedule.js'), 'utf8');
const grab = (name) => {
  const start = schedSrc.indexOf(`function ${name}(`);
  let depth = 0, i = schedSrc.indexOf('{', start);
  for (; i < schedSrc.length; i++) { if (schedSrc[i] === '{') depth++; else if (schedSrc[i] === '}' && --depth === 0) break; }
  return schedSrc.slice(start, i + 1);
};
global.isInformationTrain = (t) => t && t.type === 'information';
eval(grab('stemMatchesDate') + '\nglobal.stemMatchesDate = stemMatchesDate;');
eval(grab('hasScheduleContent') + '\nglobal.hasScheduleContent = hasScheduleContent;');
require(path.join(ROOT, 'public/sandbox/legacy/sandbox-model.js'));
require(path.join(ROOT, 'public/sandbox/legacy/sandbox-levels.js'));
const SB = window.SandboxModel, LV = window.SandboxLevels;

let tiers = [];
try { tiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'app_settings.json'), 'utf8')).predictionModel.lineImportance || []; } catch (e) { /* unranked */ }

const model = SB.newModel();
const DAY_LOG_DIR = path.join(ROOT, 'day_logs');
const recordedDays = new Set(RD.listRecordedDays(DAY_LOG_DIR));
const recStats = { days: 0, used: 0, skipped: 0, delay: 0, cancel: 0, compensating: 0, intentional: 0, lateAdditions: 0 };

// One recorded real day → train both stages at full weight.
function trainRecordedDay(day, rateOf) {
  recStats.days++;
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(path.join(DAY_LOG_DIR, 'snapshots', `${day}.json`), 'utf8')); } catch (e) { recStats.skipped++; return; }
  const r = RD.buildRealDay({ snapshot, events: RD.loadEventsFor(DAY_LOG_DIR, day), rateOf });
  recStats.compensating += r.meta.compensatingCancels;
  recStats.intentional += r.meta.intentionalCancels;
  recStats.lateAdditions += r.meta.lateAdditions;
  if (r.skipped) { recStats.skipped++; return; }
  const final = SB.finalTimetable(r.entries, r.scenario, tiers, r.labels);
  const nB = final.examples.filter(e => e.weight > 0).length, nA = final.cancelExamples.filter(e => e.weight > 0).length;
  if (!nB && !nA) { recStats.skipped++; return; }
  SB.learn(model, final.examples, final.cancelExamples);
  recStats.used++; recStats.delay += nB; recStats.cancel += nA;
}

const stats = { realDays: 0, realDaysUsed: 0, skippedNoDisruption: 0, skippedAbsence: 0, retroExcluded: 0,
  realB: 0, realA: 0, realCancels: 0, reasonCancelsExcluded: 0, unresolved: 0, disruptions: { delay: 0, overrun: 0 },
  sandboxLevels: 0, sandboxB: 0, sandboxA: 0, sandboxSkipped: 0 };

// ---------------------------------------------------------------- 1. real days
const data = L.loadLog({ threshold: 5 });
const counts = { byTemplate: {}, byLine: {}, global: { n: 0, c: 0 } };
const bump = (map, k, c) => { if (!k) return; if (!map[k]) map[k] = { n: 0, c: 0 }; map[k].n++; if (c) map[k].c++; };
const isRetro = (t) => !t.recurring && t.createdAt != null && t.createdAt >= t.planMs - 5 * 60000;

for (const day of [...data.days.keys()].sort()) {
  const all = data.days.get(day);
  stats.realDays++;
  const rateOf = LV.cancelRateLookup(counts); // only days before this one
  const list = all.filter(t => { const r = isRetro(t); if (r) stats.retroExcluded++; return !r; });

  const done = () => all.forEach(t => {
    bump(counts.byTemplate, t.recurring ? t.key : null, t.canceled);
    bump(counts.byLine, t.line, t.canceled);
    counts.global.n++; if (t.canceled) counts.global.c++;
  });

  if (recordedDays.has(day)) { trainRecordedDay(day, rateOf); recordedDays.delete(day); done(); continue; }

  if (list.length < 2) { done(); continue; }
  if (list.filter(t => t.canceled).length / list.length >= ABSENCE_SHARE) { stats.skippedAbsence++; done(); continue; }

  // Primary disruptions along the actual timeline.
  const sorted = list.slice().sort((a, b) => a.plan - b.plan);
  let frontier = -Infinity;
  const disruptions = [];
  sorted.forEach(t => {
    if (t.canceled) return;
    const actualDauer = t.measuredDauer != null ? t.measuredDauer : t.dauer;
    const conflict = Math.max(0, frontier - t.plan);
    if (t.delay >= PRIMARY_MIN && t.delay - conflict >= PRIMARY_MIN) {
      disruptions.push({ uid: t.id, type: 'delay', minutes: t.delay, linie: t.line, plan: SB.toHHMM(t.plan) });
    } else if (actualDauer - t.dauer >= OVERRUN_MIN) {
      disruptions.push({ uid: t.id, type: 'overrun', minutes: actualDauer - t.dauer, linie: t.line, plan: SB.toHHMM(t.plan) });
    }
    if (actualDauer > 0) frontier = Math.max(frontier, t.start + actualDauer);
  });
  if (!disruptions.length) { stats.skippedNoDisruption++; done(); continue; }
  disruptions.forEach(d => { stats.disruptions[d.type]++; });

  const entries = list.map(t => ({
    _uniqueId: t.id,
    linie: t.line,
    ziel: t.label,
    plan: SB.toHHMM(t.plan),
    actual: SB.toHHMM(t.plan + t.delay),
    dauer: t.measuredDauer != null ? t.measuredDauer : t.dauer,
    canceled: t.canceled,
    date: day,
  }));
  const scenario = {
    date: day,
    disruptions,
    basePlan: Object.fromEntries(list.map(t => [t.id, SB.toHHMM(t.plan)])),
    basePlannedDauer: Object.fromEntries(list.map(t => [t.id, t.dauer])),
    baseCancelRate: Object.fromEntries(list.map(t => [t.id, rateOf(t.recurring ? t.key : null, t.line)])),
    decided: {},
  };
  // A real train counts as decided if anything about it was recorded:
  // a check-in, a changed time, or a cancellation. Untouched ones follow the
  // sandbox rule (feasible → planmäßig, overlapping → excluded).
  const decided = Object.fromEntries(list.filter(t => t.measured || t.delay !== 0 || t.canceled).map(t => [t.id, true]));
  const final = SB.finalTimetable(entries, scenario, tiers, { decided });
  const reasoned = new Set(list.filter(t => t.canceled && t.cancelReason).map(t => t.id));

  const exB = REAL_DELAY ? final.examples.map(e => Object.assign({}, e, { weight: e.weight * REAL_WEIGHT })) : [];
  const exA = !REAL_CANCEL ? [] : final.cancelExamples.map(e => Object.assign({}, e, {
    // planned absences are not disruption responses; disrupted real trains
    // always ran (see header), so their label carries no information
    weight: reasoned.has(e.uid) || e.disrupted ? 0 : e.weight * REAL_WEIGHT,
  }));
  stats.reasonCancelsExcluded += final.cancelExamples.filter(e => reasoned.has(e.uid)).length;
  stats.unresolved += final.cancelExamples.filter(e => e.cls === 'unresolved').length;
  const usedB = exB.filter(e => e.weight > 0), usedA = exA.filter(e => e.weight > 0);
  if (usedB.length || usedA.length) {
    SB.learn(model, exB, exA);
    stats.realDaysUsed++;
    stats.realB += usedB.length;
    stats.realA += usedA.length;
    stats.realCancels += usedA.filter(e => e.z).length;
  }
  done();
}
// Recorded days not (yet) in the weekly logs — the most recent ones.
[...recordedDays].sort().forEach(day => trainRecordedDay(day, LV.cancelRateLookup(counts)));
const afterReal = { w: model.w.slice(), m: model.cancel.m.slice(), sigma2: model.sigma2 };

// ---------------------------------------------------------------- 2. archived sandbox levels
const finalRates = LV.cancelRateLookup(counts);
const archiveDir = path.join(DATA_DIR, 'archive');
const episodes = [];
if (fs.existsSync(archiveDir)) {
  for (const sub of fs.readdirSync(archiveDir).sort()) {
    const f = path.join(archiveDir, sub, 'episodes.jsonl');
    if (!fs.existsSync(f)) continue;
    fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach(line => {
      try { episodes.push(JSON.parse(line)); } catch (e) { /* skip */ }
    });
  }
}
const replayable = episodes.filter(ep => LV.levelFromEpisode(ep, finalRates));
stats.sandboxSkipped = episodes.length - replayable.length;
stats.sandboxLevels = LV.replayEpisodes(model, replayable, tiers, finalRates);

// The model so far = the starting point for rebuilds in the sandbox
// (model.base.json). Then the levels played in the current sandbox are
// replayed on top, so re-running this script never drops played levels.
const baseModel = JSON.parse(JSON.stringify(model));
let current = [];
try {
  current = fs.readFileSync(path.join(DATA_DIR, 'episodes.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
} catch (e) { /* none yet */ }
const currentUsed = LV.replayEpisodes(model, current, tiers, finalRates);
const currentDiscarded = current.filter(e => e.discarded).length;

model.updatedAt = new Date().toISOString();
model.pretrain = {
  at: model.updatedAt,
  realWeight: REAL_WEIGHT,
  realStages: [REAL_CANCEL && 'cancel', REAL_DELAY && 'delay'].filter(Boolean).join('+') || 'none (base rates only)',
  recordedDays: recStats.used,
  recordedDelayExamples: recStats.delay,
  recordedCancelExamples: recStats.cancel,
  realDays: stats.realDaysUsed,
  realDelayExamples: stats.realB,
  realCancelExamples: stats.realA,
  sandboxLevels: stats.sandboxLevels,
};
baseModel.updatedAt = model.updatedAt;
baseModel.pretrain = Object.assign({}, model.pretrain);
model.pretrain.currentLevels = currentUsed;

// ---------------------------------------------------------------- report
console.log(`Recorded real days (snapshot + change log): ${recStats.days} found, ${recStats.used} used, ${recStats.skipped} without a usable disruption`);
console.log(`  examples (weight 1): ${recStats.delay} delay, ${recStats.cancel} cancel · cancellations: ${recStats.compensating} compensating (trained), ${recStats.intentional} intentional (removed) · ${recStats.lateAdditions} late additions left out`);
console.log(`Legacy real days (weekly logs only): ${stats.realDays - recStats.days} logged, ${stats.realDaysUsed} used`);
console.log(`  skipped: ${stats.skippedNoDisruption} without a primary disruption, ${stats.skippedAbsence} absence days (≥ 80 % canceled)`);
console.log(`  disruptions found: ${stats.disruptions.delay} late starts, ${stats.disruptions.overrun} overruns`);
console.log(`  examples used (weight ${REAL_WEIGHT}): ${stats.realB} delay${REAL_DELAY ? '' : ' [off]'}, ${stats.realA} cancel${REAL_CANCEL ? ` (${stats.realCancels} canceled)` : ' [off]'}`);
console.log(`  excluded: ${stats.retroExcluded} retro-logged trains, ${stats.reasonCancelsExcluded} cancellations with a stated reason, ${stats.unresolved} untouched overlaps`);
console.log(`Archived sandbox levels replayed: ${stats.sandboxLevels}; ${stats.sandboxSkipped} without snapshot skipped`);
console.log(`Current sandbox levels replayed on top: ${currentUsed}${currentDiscarded ? ` (${currentDiscarded} discarded, left out)` : ''}`);
console.log(`\nDelay weights (start → after real days → final):`);
console.log(SB.FEATURES.map((f, i) => `    ${f.label.padEnd(50)} ${SB.PRIOR_MEAN[i].toFixed(2).padStart(6)} ${afterReal.w[i].toFixed(2).padStart(6)} ${model.w[i].toFixed(2).padStart(6)}`).join('\n'));
console.log(`\nCancel weights (start → after real days → final):`);
console.log(SB.CANCEL_FEATURES.map((f, i) => `    ${f.label.padEnd(50)} ${SB.CANCEL_PRIOR_MEAN[i].toFixed(2).padStart(6)} ${afterReal.m[i].toFixed(2).padStart(6)} ${model.cancel.m[i].toFixed(2).padStart(6)}`).join('\n'));
console.log(`\nUser noise estimate: ±${Math.round(Math.sqrt(model.sigma2) * 60)} min (start ±15)`);

// Sanity check: predictions on a few generated levels, model vs push.
if (args.includes('--show')) {
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data.json'), 'utf8'));
  const samples = []; for (let d = 15; d <= 120; d += 15) samples.push({ line: '', delay: d });
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 4; i++) {
    const g = LV.generate({ live, model: SB.newModel(), tiers, episodes: [], samples, cancelRates: counts, level: 5, RealDate: Date, rnd, plain: true });
    const rm = SB.rollout(g.entries, g.scenario, model, tiers, {});
    const rp = SB.rolloutPush(g.entries, g.scenario, tiers, {});
    console.log(`\n${g.scenario.date} — ${g.scenario.disruptions.map(d => `${d.linie} ${d.plan} ${d.type} +${d.minutes}`).join(', ')}`);
    g.entries.forEach(e => {
      const m = rm.predictions[e._uniqueId], p = rp.predictions[e._uniqueId];
      if (!m && !p) return;
      const mt = !m ? '—' : m.cancel ? `fällt aus (${Math.round(m.q * 100)}%)` : `+${m.minutes} (Ausfall ${Math.round(m.q * 100)}%)`;
      console.log(`   ${e.plan} ${String(e.linie).padEnd(5)} ${String(e.ziel).slice(0, 24).padEnd(24)} push ${p ? ('+' + p.minutes).padStart(4) : '   —'}   model ${mt}`);
    });
  }
}

if (DRY) { console.log('\n--dry-run: nothing written.'); process.exit(0); }
fs.mkdirSync(DATA_DIR, { recursive: true });
const target = path.join(DATA_DIR, 'model.json');
if (fs.existsSync(target)) fs.copyFileSync(target, path.join(DATA_DIR, `model.backup-${Date.now()}.json`));
fs.writeFileSync(target, JSON.stringify(model, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'model.base.json'), JSON.stringify(baseModel, null, 2));
console.log(`\nWritten: ${path.relative(ROOT, target)} and model.base.json (starting point for rebuilds)`);
