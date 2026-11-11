#!/usr/bin/env node
// Learned cost model over candidate timetables ("From Delay Regression to a
// Learned Cost Model"):
//   1. prequential evaluation (refit before each level on earlier levels only)
//      of the cost model — on plain push/hold/cancel candidates and on the full
//      candidate set built from rescheduling patterns (linked pairs, breaks,
//      shrink, relocate, slack; scripts/lib/patterns.js) — against push and the
//      current delay model, on the replay harness
//   2. acceptance check on the blind (test + replay) levels
//   3. final fit on all levels: patterns, per-train costs with bootstrap ranges
//      (the learned tier list), shared costs
//   4. misfit review: the levels the costs explain worst
// Writes sandbox_data/cost-model.json. Reads only; changes nothing else.
//
//   node scripts/fit-cost-model.js [--bootstrap 30] [--misfits 5] [--no-write] [--slack-floor 60]

const fs = require('fs');
const path = require('path');
const H = require('./lib/replay-harness');
const CM = require('./lib/cost-model');
const P = require('./lib/patterns');
const C = require('./lib/candidates');
const { currentRanking, ROOT } = require('./lib/sandbox-modules');

const args = process.argv.slice(2);
const argNum = (name, d) => { const i = args.indexOf(name); return i !== -1 ? Number(args[i + 1]) : d; };
const BOOT = argNum('--bootstrap', 30), MISFITS = argNum('--misfits', 5), FLOOR = argNum('--slack-floor', P.SLACK_FLOOR);
const f1 = (v) => (v == null ? '–' : v.toFixed(1));
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const hhmm = (m) => { const v = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; };

const eps = H.loadEpisodes();
const tiers = currentRanking();

// ---------------------------------------------------------------- 1. prequential evaluation
const models = [
  H.pushModel(),
  H.currentModel(),
  CM.prequentialCostModel({ label: 'cost model, push/hold/cancel' }),
  CM.prequentialCostModel({ use: CM.ALL_PATTERNS, slackFloor: FLOOR, label: 'cost model + patterns' }),
  CM.prequentialCostModel({ use: CM.ALL_PATTERNS, slackFloor: FLOOR, prior: CM.PRIOR_PUSH, label: 'cost model + patterns (push-like prior)' }),
];
const results = models.map(m => { const t0 = Date.now(); const rows = H.runReplay(m, { episodes: eps, tiers }); return { name: m.name, rows, s: (Date.now() - t0) / 1000 }; });
console.log(`Prequential evaluation over ${eps.length} levels: each level predicted from earlier levels only.\n`);
const head = `${'model'.padEnd(46)}${'group'.padEnd(24)}${'n'.padStart(4)}${'MAE'.padStart(8)}${'day err'.padStart(9)}${'cancels caught'.padStart(16)}${'false cancels'.padStart(15)}`;
console.log(head); console.log('-'.repeat(head.length));
const summaries = {};
results.forEach(({ name, rows, s: secs }) => {
  const s = H.summarize(rows); summaries[name] = s;
  Object.entries(s).forEach(([g, v], i) => console.log(`${(i === 0 ? name : i === 1 ? `  (${secs.toFixed(0)} s)` : '').padEnd(46)}${g.padEnd(24)}${String(v.n).padStart(4)}${f1(v.mae).padStart(8)}${f1(v.dayErr).padStart(9)}${(`${pct(v.cancelRecall)} of ${v.cancelN}`).padStart(16)}${pct(v.falseCancelRate).padStart(15)}`));
});
console.log('\nMAE / day err in minutes, scored on labelled kept trains, same definitions as the sandbox.');

// ---------------------------------------------------------------- 2. acceptance
const B = 'blind (test + replay)';
const push = summaries.push[B];
console.log(`\nAcceptance on the ${push.n} blind levels (cancels caught ≥ 70% · day error ≤ push · MAE ≤ push):`);
results.slice(2).forEach(({ name }) => {
  const s = summaries[name][B];
  const checks = [
    [`cancels caught ${pct(s.cancelRecall)}`, s.cancelRecall != null && s.cancelRecall >= 0.7],
    [`day err ${f1(s.dayErr)} vs ${f1(push.dayErr)}`, s.dayErr <= push.dayErr],
    [`MAE ${f1(s.mae)} vs ${f1(push.mae)}`, s.mae <= push.mae],
  ];
  console.log(`  ${name.padEnd(44)} ${checks.map(([t, ok]) => `${ok ? '✓' : '✗'} ${t}`).join('   ')}`);
});

// ---------------------------------------------------------------- 3. final fit on all levels
const levels = eps.map(e => H.buildLevel(e, tiers)).filter(Boolean);
const pats = P.fitPatterns(levels, { slackFloor: FLOOR });
const problems = levels.map(l => CM.choiceProblem(l, { patterns: pats, use: CM.ALL_PATTERNS }));
const model = new CM.CostModel().fit(problems);

// trains: task families of recurring templates, one-offs by line
const trains = new Map();
levels.forEach(l => {
  const base = new Map((l.ep.baseDay || []).map(b => [b.uid, b]));
  C.framing(l).decision.forEach(x => {
    const b = base.get(x.uid) || {};
    const family = P.familyKey(b);
    const key = family || `line:${x.linie}`;
    const t = trains.get(key) || { key, family, linie: x.linie, name: family ? String(b.ziel).slice(0, 24) : '(one-offs)', n: 0 };
    t.n++; trains.set(key, t);
  });
});
const trainList = [...trains.values()].filter(t => t.n >= 3).sort((a, b) => b.n - a.n);

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const boot = [];
for (let b = 0; b < BOOT; b++) {
  const sample = problems.map(() => problems[Math.floor(rnd() * problems.length)]);
  const m = new CM.CostModel().fit(sample, { iterations: 15 });
  boot.push(trainList.map(t => m.trainCosts(t.linie, tiers, null, t.family)));
}
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const costs = trainList.map((t, i) => {
  const c = model.trainCosts(t.linie, tiers, null, t.family);
  const d = boot.map(r => r[i].delayPer10), k = boot.map(r => r[i].cancel);
  return Object.assign(c, { name: t.name, n: t.n, delayLo: q(d, 0.1), delayHi: q(d, 0.9), cancelLo: q(k, 0.1), cancelHi: q(k, 0.9) });
});

console.log(`\nFitted on all ${levels.length} levels, full candidate set. Cost unit: 1 = 10 minutes of delay at the overall rate.`);
console.log(`Shared: relocation ${f1(model.value('relocate'))} · missing break ${f1(model.value('breakDeficit'))}/h · shortening ${f1(model.value('shrink:all'))}/h · overlap ${f1(model.value('overlap'))}/h · day ending late ${f1(model.value('endLate'))}/h`);
console.log(`\n  Per task family (seen ≥ 3× from the first disruption on), sorted by how often:`);
console.log(`  ${'train'.padEnd(32)}${'tier'.padEnd(6)}${'n'.padStart(4)}   ${'delay cost per 10 min'.padEnd(24)}${'cancel cost'.padEnd(24)}break-even`);
costs.forEach(c => {
  const breakEven = c.delayPer10 > 0.05 ? `${Math.round((c.cancel / c.delayPer10) * 10)} min` : '—';
  console.log(`  ${`${c.line} ${c.name}`.padEnd(32)}${c.tier.padEnd(6)}${String(c.n).padStart(4)}   ${(`${f1(c.delayPer10)}  [${f1(c.delayLo)}–${f1(c.delayHi)}]`).padEnd(24)}${(`${f1(c.cancel)}  [${f1(c.cancelLo)}–${f1(c.cancelHi)}]`).padEnd(24)}${breakEven}`);
});
console.log('  [ ] = 10–90% bootstrap range over levels. break-even = minutes of delay on that train that cost as much as cancelling it.');
console.log('  Cancel costs still sit in a narrow band (few cancellations per train): read delay cost as "how much you avoid moving it", not yet as a tier.');

const named = (key) => {
  if (key.startsWith('L:')) return `line ${key.slice(2)}`;
  for (const l of levels) { const b = (l.ep.baseDay || []).find(x => P.taskKey(x) === key); if (b) return `${b.linie} ${String(b.ziel).slice(0, 20)}`; }
  return key.slice(2);
};
console.log(`\nPatterns (from all levels):`);
console.log(`  break after a task: ${f1(pats.breaks.b)} min per hour it ran (${pats.breaks.n} gaps, median error ${f1(pats.breaks.mad)} min)`);
console.log(`  linked pairs: ${[...pats.links].map(k => k.split('>').map(named).join(' → ') + ` (${pats.linkTally.get(k).kept}/${pats.linkTally.get(k).n})`).join(' · ') || '—'}`);
console.log(`  slack (largest shift seen + 15 min, floor ${FLOOR} min; templates seen ≥ 3×):`);
[...pats.slack.maxShift.entries()].sort((a, b) => pats.slack.seen.get(b[0]).n - pats.slack.seen.get(a[0]).n)
  .forEach(([k, v]) => console.log(`    ${named(k).padEnd(30)} moves at most ${String(v).padStart(4)} min · shortest ${pats.slack.minDur.has(k) ? pats.slack.minDur.get(k) + ' min' : '50 %'} · seen ${pats.slack.seen.get(k).n}×`));

// ---------------------------------------------------------------- 4. misfit review
const gaps = problems.map(p => {
  const ch = model.choose(p);
  return { p, ch, gap: p.chosen >= 0 ? ch.costs[p.chosen] - ch.cost : null };
}).filter(x => x.gap != null).sort((a, b) => b.gap - a.gap);
console.log(`\nMisfit review — the ${MISFITS} levels the costs explain worst (cost gap = your timetable − the cheapest one):`);
const describe = (p, cand) => p.framing.decision.map(x => {
  if (cand.cancels.has(x.uid)) return `${x.linie} ✗`;
  const s = cand.starts[x.uid], d = cand.durs[x.uid];
  const moved = s != null && Math.abs(s - (x.disrupted ? x.givenStart : x.plan)) > 0.5;
  const shrunk = d != null && d < (x.disrupted ? x.givenDauer : x.plannedDauer);
  if (!moved && !shrunk) return null;
  return `${x.linie} ${hhmm(s)}${shrunk ? `/${d}′` : ''}${cand.relocated === x.uid ? ' ↷' : ''}`;
}).filter(Boolean).join(', ') || 'nothing changed';
gaps.slice(0, MISFITS).forEach(({ p, ch, gap }) => {
  const ep = p.level.ep;
  console.log(`\n  L${ep.level} ${ep.kind} ${ep.date} · gap ${f1(gap)} · disruption: ${(ep.disruptions || []).map(d => `${d.linie} ${d.plan} ${d.type === 'overrun' ? '+' + d.minutes + ' länger' : '+' + d.minutes}`).join(', ')}`);
  console.log(`    you (nearest candidate): ${describe(p, p.candidates[p.chosen])}`);
  console.log(`    model's cheapest:        ${describe(p, ch.cand)}`);
});
console.log('\n  ↷ = relocated, /N′ = shortened to N minutes.');

// ---------------------------------------------------------------- save
if (!args.includes('--no-write')) {
  const out = path.join(ROOT, 'sandbox_data', 'cost-model.json');
  fs.writeFileSync(out, JSON.stringify({
    fittedAt: new Date().toISOString(), levels: levels.length,
    model: model.toJSON(),
    trainCosts: costs,
    patterns: {
      breaks: pats.breaks,
      links: [...pats.links].map(k => ({ pair: k, names: k.split('>').map(named), ...pats.linkTally.get(k) })),
      slack: { floor: FLOOR, maxShift: Object.fromEntries(pats.slack.maxShift), minDur: Object.fromEntries(pats.slack.minDur) },
    },
    evaluation: summaries,
  }, null, 2));
  console.log(`\nWritten: ${path.relative(ROOT, out)}`);
}
