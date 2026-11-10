#!/usr/bin/env node
// Cascade-delay validity test.
//
// Question: does an early-day delay predict disruption (late or canceled) of
// LATER trains that the deterministic push algorithm says are NOT affected
// (no timetable conflict reaches them)? If yes, a learned prediction engine
// has something to add over "push until conflict-free". If no, it doesn't.
//
// Read-only: reads train_logs/*.log, prints a report, writes nothing.
//
//   node scripts/cascade-validity.js [--threshold 5] [--gap 60]
//        [--cutoffs 10,12,14] [--min-history 28] [--reps 2000]
//        [--min-pair-days 5] [--seed 42] [--json out.json]
//        [--outcome either|late|canceled]
//   late: canceled targets are dropped (they cannot be late).
//
// Causality assumption: logs hold each train's final state only, not when a
// delay was entered. A morning train (plan < cutoff) counts as "known late"
// at the cutoff, since by plan+threshold it visibly hasn't departed. Targets
// start >= cutoff + gap, so they are still in the future at that point.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const o = {
    logDir: path.join(ROOT, 'train_logs'),
    threshold: 5,
    gap: 60,
    cutoffs: [10, 12, 14],
    minHistory: 28,
    reps: 2000,
    minPairDays: 5,
    seed: 42,
    json: null,
    outcome: 'either', // either | late | canceled
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--log-dir') { o.logDir = v; i++; }
    else if (a === '--threshold') { o.threshold = +v; i++; }
    else if (a === '--gap') { o.gap = +v; i++; }
    else if (a === '--cutoffs') { o.cutoffs = v.split(',').map(Number); i++; }
    else if (a === '--min-history') { o.minHistory = +v; i++; }
    else if (a === '--reps') { o.reps = +v; i++; }
    else if (a === '--min-pair-days') { o.minPairDays = +v; i++; }
    else if (a === '--seed') { o.seed = +v; i++; }
    else if (a === '--json') { o.json = v; i++; }
    else if (a === '--outcome') { o.outcome = v; i++; }
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).join('\n'));
      process.exit(0);
    }
  }
  return o;
}

// ---------- helpers ----------

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

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ---------- load ----------

function loadTrains(opts) {
  const files = fs.readdirSync(opts.logDir).filter(f => /^train_history_.+\.log$/.test(f)).sort();
  const byId = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(opts.logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || !r.recordId) continue;
      const prev = byId.get(r.recordId);
      if (!prev || String(r.loggedAt || '') >= String(prev.loggedAt || '')) byId.set(r.recordId, r);
    }
  }

  const trains = [];
  for (const r of byId.values()) {
    if (r.type) continue; // notes, duration-only, todo, information
    const plan = hm(r.plan);
    if (plan == null || !r.serviceDate) continue;
    const act = hm(r.actual);
    let delay = act == null ? 0 : act - plan;
    if (delay < -720) delay += 1440;
    if (delay > 720) delay -= 1440;
    const canceled = Boolean(r.canceled);
    const late = !canceled && delay >= opts.threshold;
    trains.push({
      day: r.serviceDate,
      key: r._templateId || `${r.linie}|${r.ziel}`,
      label: `${r.linie || '?'} ${r.ziel || ''}`.trim(),
      recurring: Boolean(r._templateId),
      plan,
      start: plan + Math.max(delay, -plan),
      delay,
      dauer: Math.max(0, Number(r.dauer) || 0),
      canceled,
      late,
      disrupted: opts.outcome === 'late' ? late : opts.outcome === 'canceled' ? canceled : canceled || late,
      measured: Boolean(r.checkedIn),
    });
  }

  const days = new Map();
  for (const t of trains) {
    if (!days.has(t.day)) days.set(t.day, []);
    days.get(t.day).push(t);
  }
  for (const list of days.values()) list.sort((a, b) => a.plan - b.plan);
  return { trains, days, fileCount: files.length };
}

// ---------- push baseline ----------

// Deterministic "push later until conflict-free": walk trains in plan order;
// a train whose start is known keeps it, every other train starts at
// max(plan, end of everything before it). Canceled trains occupy nothing.
function pushStarts(list, isKnown, useActualForKnown) {
  const out = new Map();
  let frontier = -Infinity;
  for (const t of list) {
    if (t.canceled) continue;
    let s;
    if (isKnown(t)) s = useActualForKnown ? t.start : t.plan;
    else s = Math.max(t.plan, frontier);
    out.set(t, s);
    if (t.dauer > 0) frontier = Math.max(frontier, s + t.dauer);
  }
  return out;
}

// Extra push each unknown train receives because the known trains ran as they
// actually did instead of to plan. Planned overlaps cancel out.
function incrementalPush(list, isKnown) {
  const real = pushStarts(list, isKnown, true);
  const ideal = pushStarts(list, isKnown, false);
  const inc = new Map();
  for (const t of list) {
    if (t.canceled || isKnown(t)) continue;
    inc.set(t, Math.max(0, (real.get(t) || 0) - (ideal.get(t) || 0)));
  }
  return inc;
}

// ---------- test 1: morning signal → conflict-free later trains ----------

function buildCutoffRows(days, cutoffMin, gap, outcome) {
  const rows = [];
  let reachable = 0, skippedDays = 0;
  for (const [day, list] of days) {
    const morning = list.filter(t => t.plan < cutoffMin);
    if (!morning.length) { skippedDays++; continue; }
    const lateMorning = morning.filter(t => t.late);
    const signal = lateMorning.length > 0;
    const isKnown = (t) => t.plan < cutoffMin;
    const inc = incrementalPush(list, isKnown);
    for (const t of list) {
      if (t.plan < cutoffMin + gap) continue;
      if (outcome === 'late' && t.canceled) continue;
      if (!t.canceled && (inc.get(t) || 0) >= 1) { reachable++; continue; }
      rows.push({
        day, wd: weekday(day), key: t.key, label: t.label,
        y: t.disrupted ? 1 : 0, late: t.late, canceled: t.canceled,
        signal, lateCount: lateMorning.length,
        lateMinutes: lateMorning.reduce((s, x) => s + x.delay, 0),
      });
    }
  }
  return { rows, reachable, skippedDays };
}

function riskDiff(rows, sigOf = (r) => r.signal) {
  let n1 = 0, k1 = 0, n0 = 0, k0 = 0;
  for (const r of rows) {
    if (sigOf(r)) { n1++; k1 += r.y; } else { n0++; k0 += r.y; }
  }
  const p1 = n1 ? k1 / n1 : NaN, p0 = n0 ? k0 / n0 : NaN;
  return { n1, k1, n0, k0, p1, p0, rd: p1 - p0, rr: p1 / p0 };
}

function groupByDay(rows) {
  const g = new Map();
  for (const r of rows) {
    if (!g.has(r.day)) g.set(r.day, []);
    g.get(r.day).push(r);
  }
  return g;
}

// Cluster bootstrap over days (rows within a day are not independent).
function bootstrapRD(rows, reps, rng) {
  const groups = [...groupByDay(rows).values()];
  const rds = [];
  for (let b = 0; b < reps; b++) {
    const sample = [];
    for (let i = 0; i < groups.length; i++) sample.push(...groups[Math.floor(rng() * groups.length)]);
    const r = riskDiff(sample);
    if (Number.isFinite(r.rd)) rds.push(r.rd);
  }
  rds.sort((a, b) => a - b);
  return [quantile(rds, 0.025), quantile(rds, 0.975)];
}

// Shuffle the day-level signal among days of the same weekday. Keeps each
// day's targets and weekday mix fixed, breaks any morning→later link.
function permutationP(rows, reps, rng) {
  const obs = riskDiff(rows).rd;
  const daySignal = new Map(), dayWd = new Map();
  for (const r of rows) { daySignal.set(r.day, r.signal); dayWd.set(r.day, r.wd); }
  const strata = new Map();
  for (const [day, wd] of dayWd) {
    if (!strata.has(wd)) strata.set(wd, []);
    strata.get(wd).push(day);
  }
  let extreme = 0;
  for (let b = 0; b < reps; b++) {
    const perm = new Map();
    for (const daysOfWd of strata.values()) {
      const sigs = daysOfWd.map(d => daySignal.get(d));
      for (let i = sigs.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [sigs[i], sigs[j]] = [sigs[j], sigs[i]];
      }
      daysOfWd.forEach((d, i) => perm.set(d, sigs[i]));
    }
    const rd = riskDiff(rows, (r) => perm.get(r.day)).rd;
    if (Math.abs(rd) >= Math.abs(obs) - 1e-12) extreme++;
  }
  return (extreme + 1) / (reps + 1);
}

// Mantel-Haenszel odds ratio stratified by target item: is the item MORE
// disrupted on bad-morning days than on its own good-morning days?
function mantelHaenszel(rows) {
  const strata = new Map();
  for (const r of rows) {
    if (!strata.has(r.key)) strata.set(r.key, { a: 0, b: 0, c: 0, d: 0 });
    const s = strata.get(r.key);
    if (r.signal) r.y ? s.a++ : s.b++;
    else r.y ? s.c++ : s.d++;
  }
  let num = 0, den = 0, used = 0;
  for (const s of strata.values()) {
    const n = s.a + s.b + s.c + s.d;
    if (s.a + s.b === 0 || s.c + s.d === 0) continue;
    used++;
    num += (s.a * s.d) / n;
    den += (s.b * s.c) / n;
  }
  return { or: den > 0 ? num / den : NaN, strata: used };
}

// ---------- test 2: rolling-origin backtest ----------

function backtest(rows, minHistory) {
  const byDay = groupByDay(rows);
  const order = [...byDay.keys()].sort();
  const m = 5; // smoothing strength (pseudo-observations)
  const hist = [];
  const perDay = []; // { day, se0, se1, se2, n }
  const preds = [];

  for (let i = 0; i < order.length; i++) {
    const today = byDay.get(order[i]);
    if (i >= minHistory) {
      let n = 0, k = 0, n1 = 0, k1 = 0, n0 = 0, k0 = 0;
      const item = new Map();
      for (const r of hist) {
        n++; k += r.y;
        if (r.signal) { n1++; k1 += r.y; } else { n0++; k0 += r.y; }
        if (!item.has(r.key)) item.set(r.key, { n: 0, k: 0, n1: 0, k1: 0, n0: 0, k0: 0 });
        const s = item.get(r.key);
        s.n++; s.k += r.y;
        if (r.signal) { s.n1++; s.k1 += r.y; } else { s.n0++; s.k0 += r.y; }
      }
      const gAll = (k + 1) / (n + 2);
      const g1 = (k1 + 1) / (n1 + 2), g0 = (k0 + 1) / (n0 + 2);
      let se0 = 0, se1 = 0, se2 = 0;
      for (const r of today) {
        const s = item.get(r.key) || { n: 0, k: 0, n1: 0, k1: 0, n0: 0, k0: 0 };
        const pBase = (s.k + m * gAll) / (s.n + m);
        const lift = (r.signal ? g1 : g0) / gAll;
        const prior = Math.min(0.999, Math.max(0.001, pBase * lift));
        const nS = r.signal ? s.n1 : s.n0, kS = r.signal ? s.k1 : s.k0;
        const pSig = (kS + m * prior) / (nS + m);
        se0 += (0 - r.y) ** 2;          // push baseline: conflict-free ⇒ predicts on time
        se1 += (pBase - r.y) ** 2;      // item base rate
        se2 += (pSig - r.y) ** 2;       // base rate + morning signal
        preds.push({ p: pSig, y: r.y, signal: r.signal });
      }
      perDay.push({ day: order[i], se0, se1, se2, n: today.length });
    }
    hist.push(...today);
  }

  const N = perDay.reduce((s, d) => s + d.n, 0);
  const B = (f) => perDay.reduce((s, d) => s + d[f], 0) / N;
  return { perDay, N, b0: B('se0'), b1: B('se1'), b2: B('se2'), preds };
}

function bootstrapBrierGain(perDay, reps, rng) {
  const gains = [];
  for (let b = 0; b < reps; b++) {
    let s1 = 0, s2 = 0, n = 0;
    for (let i = 0; i < perDay.length; i++) {
      const d = perDay[Math.floor(rng() * perDay.length)];
      s1 += d.se1; s2 += d.se2; n += d.n;
    }
    if (n) gains.push(1 - s2 / s1);
  }
  gains.sort((a, b) => a - b);
  return [quantile(gains, 0.025), quantile(gains, 0.975)];
}

// ---------- test 3: item pairs ----------

const LF = [0];
function logFact(n) { while (LF.length <= n) LF.push(LF[LF.length - 1] + Math.log(LF.length)); return LF[n]; }
function fisherTwoSided(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const lp = (x) => logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1)
    - logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - c1 + x);
  const pObs = lp(a);
  let p = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const l = lp(x);
    if (l <= pObs + 1e-9) p += Math.exp(l);
  }
  return Math.min(1, p);
}

function pairTable(days, gap, minPairDays, outcome) {
  const pairs = new Map();
  for (const list of days.values()) {
    for (const e of list) {
      if (e.canceled) continue;
      const inc = incrementalPush(list, (t) => t === e);
      for (const l of list) {
        if (l === e || l.key === e.key || l.plan < e.plan + gap) continue;
        if (outcome === 'late' && l.canceled) continue;
        if (!l.canceled && (inc.get(l) || 0) >= 1) continue; // conflict-reachable: push already covers it
        const k = e.key + '→' + l.key;
        if (!pairs.has(k)) pairs.set(k, { eLabel: e.label, lLabel: l.label, a: 0, b: 0, c: 0, d: 0 });
        const s = pairs.get(k);
        if (e.late) l.disrupted ? s.a++ : s.b++;
        else l.disrupted ? s.c++ : s.d++;
      }
    }
  }
  const tested = [];
  for (const s of pairs.values()) {
    if (s.a + s.b < minPairDays || s.c + s.d < minPairDays) continue;
    s.p1 = s.a / (s.a + s.b); s.p0 = s.c / (s.c + s.d);
    s.p = fisherTwoSided(s.a, s.b, s.c, s.d);
    tested.push(s);
  }
  // Benjamini-Hochberg
  tested.sort((x, y) => x.p - y.p);
  let minQ = 1;
  for (let i = tested.length - 1; i >= 0; i--) {
    minQ = Math.min(minQ, (tested[i].p * tested.length) / (i + 1));
    tested[i].q = minQ;
  }
  return { tested, total: pairs.size };
}

// ---------- report ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rng = mulberry32(opts.seed);
  const { trains, days, fileCount } = loadTrains(opts);
  const dayKeys = [...days.keys()].sort();
  const result = { opts: { ...opts, logDir: undefined }, cutoffs: [] };

  const late = trains.filter(t => t.late).length;
  const canc = trains.filter(t => t.canceled).length;
  console.log('\n=== Cascade-delay validity test ===');
  console.log(`Logs: ${fileCount} weekly files, ${trains.length} timed trains, ${days.size} days (${dayKeys[0]} … ${dayKeys[dayKeys.length - 1]})`);
  console.log(`Late (≥${opts.threshold} min): ${pct(late / trains.length)}   canceled: ${pct(canc / trains.length)}   measured by check-in: ${pct(trains.filter(t => t.measured).length / trains.length)}   recurring: ${pct(trains.filter(t => t.recurring).length / trains.length)}`);
  console.log(`Targets = trains starting ≥ cutoff+${opts.gap} min that the push algorithm does NOT delay.`);
  const outcomeText = { either: `late (≥${opts.threshold} min) or canceled`, late: `late (≥${opts.threshold} min), canceled targets dropped`, canceled: 'canceled' }[opts.outcome];
  console.log(`Outcome = target ${outcomeText}. Signal = any train before cutoff was late.\n`);

  for (const h of opts.cutoffs) {
    const cutoffMin = h * 60;
    const { rows, reachable, skippedDays } = buildCutoffRows(days, cutoffMin, opts.gap, opts.outcome);
    console.log(`--- Cutoff ${String(h).padStart(2, '0')}:00 ---`);
    if (rows.length < 30) { console.log(`  Too few target rows (${rows.length}); skipped.\n`); continue; }

    const rd = riskDiff(rows);
    const ci = bootstrapRD(rows, opts.reps, rng);
    const pPerm = permutationP(rows, opts.reps, rng);
    const mh = mantelHaenszel(rows);
    const sigDays = new Set(rows.filter(r => r.signal).map(r => r.day)).size;
    const allDays = new Set(rows.map(r => r.day)).size;

    console.log(`  Days used: ${allDays} (bad morning: ${sigDays}), no morning trains: ${skippedDays}`);
    console.log(`  Target rows: ${rows.length} conflict-free   (${reachable} conflict-reachable excluded — push already handles those)`);
    console.log(`  P(disrupted | bad morning)  = ${pct(rd.p1)}  (${rd.k1}/${rd.n1})`);
    console.log(`  P(disrupted | good morning) = ${pct(rd.p0)}  (${rd.k0}/${rd.n0})`);
    console.log(`  Risk difference: ${pct(rd.rd)}  95% CI [${pct(ci[0])}, ${pct(ci[1])}]   risk ratio ${num(rd.rr, 2)}`);
    console.log(`  Permutation p (within weekday): ${num(pPerm, 4)}`);
    console.log(`  Odds ratio within the same item (Mantel-Haenszel): ${num(mh.or, 2)} over ${mh.strata} items`);

    const split = (f) => riskDiff(rows.map(r => ({ ...r, y: r[f] ? 1 : 0 })));
    const sl = split('late'), sc = split('canceled');
    console.log(`    split → late only:     ${pct(sl.p1)} vs ${pct(sl.p0)}`);
    console.log(`    split → canceled only: ${pct(sc.p1)} vs ${pct(sc.p0)}`);

    const dose = [0, 1, 2, 3].map(c => {
      const sub = rows.filter(r => (c < 3 ? r.lateCount === c : r.lateCount >= 3));
      return `${c < 3 ? c : '3+'}: ${pct(mean(sub.map(r => r.y)))} (n=${sub.length})`;
    });
    console.log(`  Dose-response by # late morning trains → ${dose.join('   ')}`);

    const bt = backtest(rows, opts.minHistory);
    let bss = NaN, bssCi = [NaN, NaN];
    if (bt.N) {
      bss = 1 - bt.b2 / bt.b1;
      bssCi = bootstrapBrierGain(bt.perDay, opts.reps, rng);
      console.log(`  Rolling backtest (${bt.perDay.length} days, ${bt.N} predictions, trained only on earlier days):`);
      console.log(`    Brier  push baseline ${num(bt.b0)}   item base rate ${num(bt.b1)}   base rate + morning signal ${num(bt.b2)}`);
      console.log(`    Skill of signal model over base rate: ${pct(bss)}  95% CI [${pct(bssCi[0])}, ${pct(bssCi[1])}]`);
    } else {
      console.log(`  Rolling backtest: not enough history (need ${opts.minHistory} days).`);
    }

    const verdict =
      pPerm < 0.05 && ci[0] > 0 && bssCi[0] > 0 ? 'SIGNAL: early delays predict later disruption beyond the push baseline, and it holds up out-of-sample.'
      : pPerm < 0.05 && ci[0] > 0 ? 'PARTIAL: association is significant, but it does not (yet) improve out-of-sample predictions reliably.'
      : pPerm < 0.10 || (ci[0] > -0.02 && rd.rd > 0) ? 'WEAK: suggestive but not significant — more data or a sharper signal needed.'
      : 'NONE: no evidence beyond the push baseline at this cutoff.';
    console.log(`  → ${verdict}\n`);

    result.cutoffs.push({
      cutoff: h, rows: rows.length, reachable, days: allDays, badMorningDays: sigDays,
      ...rd, ci, pPerm, mhOr: mh.or, mhStrata: mh.strata,
      brier: bt.N ? { push: bt.b0, base: bt.b1, signal: bt.b2, skill: bss, skillCi: bssCi } : null,
      verdict,
    });
  }

  const pt = pairTable(days, opts.gap, opts.minPairDays, opts.outcome);
  console.log(`--- Item pairs (early train late → later conflict-free train disrupted) ---`);
  console.log(`  ${pt.total} pairs seen, ${pt.tested.length} with ≥${opts.minPairDays} days in both groups tested. q = false-discovery-adjusted p.`);
  const show = pt.tested.slice(0, 15);
  if (!show.length) console.log('  (none with enough support)');
  for (const s of show) {
    console.log(`  ${s.q < 0.1 ? '*' : ' '} ${s.eLabel.slice(0, 26).padEnd(26)} → ${s.lLabel.slice(0, 26).padEnd(26)}  ${pct(s.p1)} (${s.a}/${s.a + s.b}) vs ${pct(s.p0)} (${s.c}/${s.c + s.d})  p=${num(s.p, 4)} q=${num(s.q, 3)}`);
  }
  console.log(`  (* = q < 0.10. With ${pt.tested.length} tests, ~${Math.round(pt.tested.length * 0.05)} would hit p<0.05 by chance alone.)\n`);
  result.pairs = pt.tested.slice(0, 50);

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(result, null, 2));
    console.log(`JSON written to ${opts.json}`);
  }
}

main();
