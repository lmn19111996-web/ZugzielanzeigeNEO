#!/usr/bin/env node
// Offline replay of all recorded sandbox levels (sandbox_data/episodes.jsonl).
// Scores models prequentially and checks that the stored scores are reproduced.
//
//   node scripts/replay.js [--json out.json] [--per-level]
//
// Models: push · the current delay model (from model.base.json, learning as it
// goes) · reference "your cancels + push" · reference "best candidate"
// (scripts/lib/candidates.js: the closest timetable the candidate geometry can
// build — the ceiling for any model that picks among those candidates).

const fs = require('fs');
const H = require('./lib/replay-harness');
const C = require('./lib/candidates');

const args = process.argv.slice(2);
const f1 = (v) => (v == null ? '–' : v.toFixed(1));
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);

// ---------------------------------------------------------------- 1. reproduction check
// Uses every level incl. discarded ones: the model learned from them back then.
const allEps = H.loadEpisodes({ includeDiscarded: true });
const pushRows = H.runReplay(H.pushModel(), { episodes: allEps });
let pushMatch = 0, pushChecked = 0, pushWorst = 0;
pushRows.forEach(r => {
  if (r.ep.maePush == null || r.mae == null) return;
  pushChecked++;
  const d = Math.abs(r.ep.maePush - r.mae);
  pushWorst = Math.max(pushWorst, d);
  if (d < 0.05) pushMatch++;
});
const curRows = H.runReplay(H.currentModel(), { episodes: allEps });
let predSame = 0, predTotal = 0, levelsIdentical = 0;
curRows.forEach(r => {
  const stored = r.ep.initialPredictions || {};
  let all = true;
  Object.keys(stored).forEach(uid => {
    predTotal++;
    if (r.pred.delays[uid] === stored[uid]) predSame++; else all = false;
  });
  if (all) levelsIdentical++;
});
console.log('Reproduction check (all 57 levels, incl. discarded):');
console.log(`  push: stored per-level MAE reproduced on ${pushMatch}/${pushChecked} levels (largest difference ${f1(pushWorst)} min)`);
console.log(`  current model: ${predSame}/${predTotal} stored predictions identical, ${levelsIdentical}/${curRows.length} levels fully identical`);
console.log('  (differences in the current model come from code changes between levels and the line ranking of the time,');
console.log('   which older levels did not store; push has no state, so it must match exactly.)\n');

// ---------------------------------------------------------------- 2. scores
const eps = H.loadEpisodes();
const models = [
  H.pushModel(),
  H.currentModel(),
  H.oracleCancelModel(),
  C.bestCandidateModel({ label: 'reference: best candidate' }),
  C.bestCandidateModel({ options: { minGap: () => 15 }, label: 'reference: best cand., 15-min gap' }),
];
const results = models.map(m => ({ name: m.name, rows: H.runReplay(m, { episodes: eps }) }));
console.log(`Scores over ${eps.length} levels (discarded levels left out), prequential:\n`);
const head = `${'model'.padEnd(36)}${'group'.padEnd(24)}${'n'.padStart(4)}${'MAE'.padStart(8)}${'day err'.padStart(9)}${'cancels caught'.padStart(16)}${'false cancels'.padStart(15)}`;
console.log(head);
console.log('-'.repeat(head.length));
results.forEach(({ name, rows }) => {
  const s = H.summarize(rows);
  Object.entries(s).forEach(([g, v], i) => {
    console.log(`${(i === 0 ? name : '').padEnd(36)}${g.padEnd(24)}${String(v.n).padStart(4)}${f1(v.mae).padStart(8)}${f1(v.dayErr).padStart(9)}${(`${pct(v.cancelRecall)} of ${v.cancelN}`).padStart(16)}${pct(v.falseCancelRate).padStart(15)}`);
  });
});
console.log('\nMAE / day err in minutes. "cancels caught" = trains you canceled that were predicted canceled.');

// ---------------------------------------------------------------- 3. candidate coverage
// How often the candidates contain your timetable, and which trains fall
// outside them (and in which direction).
if (args.includes('--coverage')) {
  // Candidate coverage, piece by piece: how often the candidates contain your
  // timetable once each rescheduling pattern is added. Patterns are fitted on
  // ALL levels here (this measures what the candidates can express, not how
  // well they predict — the prequential evaluation is in fit-cost-model.js).
  const { currentRanking } = require('./lib/sandbox-modules');
  const P = require('./lib/patterns');
  const levels = eps.map(ep => H.buildLevel(ep, currentRanking())).filter(Boolean);
  const pats = P.fitPatterns(levels);
  const stages = [
    ['push / hold / cancel', {}],
    ['+ linked pairs', { links: true }],
    ['+ breaks (≤ planned gap)', { links: true, breaks: true }],
    ['+ full break after a late task', { links: true, breaks: true, rest: true }],
    ['+ shrink to fit', { links: true, breaks: true, rest: true, shrink: true }],
    ['+ relocate behind', { links: true, breaks: true, rest: true, shrink: true, relocate: true }],
    ['+ slack limits', { links: true, breaks: true, rest: true, shrink: true, relocate: true, slack: true }],
  ];
  console.log(`\nCandidate coverage over ${levels.length} levels (patterns fitted on all of them):`);
  console.log(`  break = ${f1(pats.breaks.b)} min per hour of task (median error ${f1(pats.breaks.mad)} min, ${pats.breaks.n} gaps) · ${pats.links.size} linked pairs · slack floor ${pats.slack.floor} min`);
  const head2 = `  ${'candidates'.padEnd(34)}${'levels reproduced'.padStart(18)}${'trains later'.padStart(14)}${'earlier'.padStart(9)}${'cancels off'.padStart(13)}${'cands/level'.padStart(13)}${'max'.padStart(8)}${'s'.padStart(6)}`;
  console.log(head2);
  let lastDetail = null;
  stages.forEach(([name, use]) => {
    const t0 = Date.now();
    let exact = 0, cancelOff = 0, counts = [];
    const later = [], earlier = [];
    levels.forEach(lvl => {
      const e = C.enumerate(lvl, P.candidateOptions(pats, lvl, use));
      const user = C.userChoice(lvl, e.framing);
      const n = C.nearest(e, user);
      counts.push(e.candidates.length);
      let levelExact = n.dist < 1000;
      if (n.dist >= 1000) cancelOff++;
      e.framing.decision.forEach(x => {
        if (user.cancels.has(x.uid) || n.cand.cancels.has(x.uid)) return;
        const diff = (user.starts[x.uid] || 0) - (n.cand.starts[x.uid] || 0);
        if (Math.abs(diff) > 5 || Math.abs((user.durs[x.uid] || 0) - (n.cand.durs[x.uid] || 0)) > 5) levelExact = false;
        if (x.disrupted) return;
        if (diff > 5) later.push({ level: lvl.ep.level, linie: x.linie, ziel: x.ziel, diff, user: user.delays[x.uid], cand: n.cand.delays[x.uid] || 0 });
        if (diff < -5) earlier.push({ level: lvl.ep.level, linie: x.linie, ziel: x.ziel, diff, user: user.delays[x.uid], cand: n.cand.delays[x.uid] || 0 });
      });
      if (levelExact) exact++;
    });
    console.log(`  ${name.padEnd(34)}${`${exact}/${levels.length}`.padStart(18)}${String(later.length).padStart(14)}${String(earlier.length).padStart(9)}${String(cancelOff).padStart(13)}${f1(H.avg(counts)).padStart(13)}${String(Math.max(...counts)).padStart(8)}${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}`);
    lastDetail = { later, earlier };
  });
  console.log('  reproduced = same cancellations and every kept train (incl. disrupted ones) within 5 min, start and duration.');
  console.log('  later / earlier = non-disrupted trains you placed > 5 min later / earlier than the nearest candidate.');
  const show = (xs, label) => {
    console.log(`  ${label} (full candidate set):`);
    xs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 8).forEach(m => console.log(`    L${m.level} ${m.linie} ${String(m.ziel).slice(0, 26)}: you ${m.user >= 0 ? '+' : ''}${m.user}, nearest candidate ${m.cand >= 0 ? '+' : ''}${m.cand}`));
  };
  show(lastDetail.later, 'largest "later"');
  show(lastDetail.earlier, 'largest "earlier"');
}

if (args.includes('--per-level')) {
  console.log('\nPer level (MAE): ' + results.map(r => r.name).join(' | '));
  results[0].rows.forEach((row, i) => {
    console.log(`  L${String(row.level).padStart(2)} ${row.kind.padEnd(7)} ` + results.map(r => f1(r.rows[i].mae).padStart(6)).join(' '));
  });
}

const jsonIdx = args.indexOf('--json');
if (jsonIdx !== -1 && args[jsonIdx + 1]) {
  fs.writeFileSync(args[jsonIdx + 1], JSON.stringify(results.map(r => ({ name: r.name, summary: H.summarize(r.rows), levels: r.rows.map(x => ({ level: x.level, kind: x.kind, mae: x.mae, dayErr: x.dayErr, cancelHit: x.cancelHit, cancelN: x.cancelN, falseCancel: x.falseCancel })) })), null, 2));
  console.log(`JSON written to ${args[jsonIdx + 1]}`);
}
