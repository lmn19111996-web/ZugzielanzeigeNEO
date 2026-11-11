#!/usr/bin/env node
// Results of the current sandbox (v2 levels, learned cost model) — does the
// model get better as you play?
//
// Every level stores the model's prediction made at its START, with the model
// trained on earlier levels only, so the stored scores are already an honest
// prequential evaluation. This script summarises them: random (test) levels
// vs. selected levels, model vs. push, and the trend in blocks of levels.
//
//   node scripts/sandbox-eval.js [--block 10] [--file sandbox_data/episodes.jsonl]
//
// Archived levels of earlier sandbox generations: scripts/replay.js and
// scripts/fit-cost-model.js (sandbox_data/archive/).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const arg = (name, d) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : d; };
const BLOCK = Number(arg('--block', 10));
const FILE = path.resolve(ROOT, arg('--file', 'sandbox_data/episodes.jsonl'));

const f1 = (v) => (v == null ? '–' : v.toFixed(1));
const avg = (xs) => { const v = xs.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

let eps = [];
try { eps = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { /* none yet */ }
const all = eps.filter(e => e.version === 2);
const kept = all.filter(e => !e.discarded && e.score);
console.log(`${all.length} levels (${all.length - kept.length} discarded) in ${path.relative(ROOT, FILE)}\n`);
if (!kept.length) { console.log('Nothing to evaluate yet.'); process.exit(0); }

function summary(list) {
  const s = (who, k) => avg(list.map(e => e.score[who][k]));
  const sum = (who, k) => list.reduce((t, e) => t + (e.score[who][k] || 0), 0);
  const hits = (who) => `${sum(who, 'hits')}/${sum(who, 'total')}`;
  return {
    n: list.length,
    model: { hits: hits('model'), stars: s('model', 'stars'), mae: s('model', 'mae'), dayErr: s('model', 'dayErr'), cancel: `${sum('model', 'cancelHit')}/${sum('model', 'cancelN')}`, falseCancel: `${sum('model', 'falseCancel')}/${sum('model', 'keptN')}` },
    push: { hits: hits('push'), stars: s('push', 'stars'), mae: s('push', 'mae'), dayErr: s('push', 'dayErr') },
  };
}
const head = `${'group'.padEnd(26)}${'n'.padStart(4)}  ${'trains right'.padEnd(22)}${'stars'.padEnd(14)}${'MAE (min)'.padEnd(16)}${'day err (min)'.padEnd(16)}cancels caught · false`;
console.log(head); console.log('-'.repeat(head.length + 4));
const row = (name, list) => {
  if (!list.length) { console.log(`${name.padEnd(26)}${'0'.padStart(4)}`); return; }
  const s = summary(list);
  console.log(`${name.padEnd(26)}${String(s.n).padStart(4)}  ${`${s.model.hits} vs ${s.push.hits}`.padEnd(22)}${`${f1(s.model.stars)} vs ${f1(s.push.stars)}`.padEnd(14)}${`${f1(s.model.mae)} vs ${f1(s.push.mae)}`.padEnd(16)}${`${f1(s.model.dayErr)} vs ${f1(s.push.dayErr)}`.padEnd(16)}${s.model.cancel} · ${s.model.falseCancel}`);
};
row('random (test) levels', kept.filter(e => e.kind === 'random'));
row('selected levels', kept.filter(e => e.kind !== 'random'));
row('all', kept);
console.log('\nmodel vs push. "trains right" = cancel decision matches and, if kept, start ≤ 10 min off.');

console.log(`\nTrend in blocks of ${BLOCK} levels (all kinds):`);
for (let i = 0; i < kept.length; i += BLOCK) {
  const b = kept.slice(i, i + BLOCK);
  const s = summary(b);
  console.log(`  levels ${String(b[0].level).padStart(3)}–${String(b[b.length - 1].level).padEnd(4)} model ${s.model.hits.padEnd(8)} push ${s.push.hits.padEnd(8)} MAE ${f1(s.model.mae)} vs ${f1(s.push.mae)} · cancels ${s.model.cancel}`);
}
