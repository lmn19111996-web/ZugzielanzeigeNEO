#!/usr/bin/env node
// Disruption drivers: what predicts that a train gets CANCELED or runs LATE?
//
// Focus: daily workload ("eventful days are overplanned"), plus weekday,
// time of day, planning lead time, item history and the previous evening.
// Read-only: reads train_logs/*.log, prints a report, writes nothing
// (except --json).
//
//   node scripts/disruption-drivers.js [--threshold 5] [--capacity-hours 16]
//        [--min-history 60] [--refit-every 14] [--lambda 1] [--reps 2000]
//        [--seed 42] [--json out.json]
//
// Every feature is causal: built from information available at the start of
// the service day (items created before 00:00 of that day, history of earlier
// days only). Items created at/after their own start are "retro-logged" —
// written down while or after doing them — and are excluded from the models,
// since nothing could have been predicted for them.

const fs = require('fs');
const L = require('./lib/train-log-data');

function parseArgs(argv) {
  const o = {
    logDir: L.DEFAULT_LOG_DIR, threshold: 5, capacityHours: 16, minHistory: 60,
    refitEvery: 14, lambda: 1, reps: 2000, seed: 42, json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--log-dir') { o.logDir = v; i++; }
    else if (a === '--threshold') { o.threshold = +v; i++; }
    else if (a === '--capacity-hours') { o.capacityHours = +v; i++; }
    else if (a === '--min-history') { o.minHistory = +v; i++; }
    else if (a === '--refit-every') { o.refitEvery = +v; i++; }
    else if (a === '--lambda') { o.lambda = +v; i++; }
    else if (a === '--reps') { o.reps = +v; i++; }
    else if (a === '--seed') { o.seed = +v; i++; }
    else if (a === '--json') { o.json = v; i++; }
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 18).join('\n'));
      process.exit(0);
    }
  }
  return o;
}

// ---------- day-level planning stats ----------

function overlapMinutes(intervals) {
  const ev = [];
  for (const [s, e] of intervals) if (e > s) { ev.push([s, 1], [e, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0, last = 0, total = 0;
  for (const [x, d] of ev) {
    if (depth >= 2) total += x - last;
    depth += d; last = x;
  }
  return total;
}

const isAhead = (t, day) => t.createdAt == null || t.createdAt < L.localMs(day, 0);
const isRetro = (t) => !t.recurring && t.createdAt != null && t.createdAt >= t.planMs - 5 * 60000;

function dayStats(list, durs, filter) {
  const ts = list.filter(filter), ds = (durs || []).filter(filter);
  const planned = ts.reduce((s, t) => s + t.dauer, 0) + ds.reduce((s, t) => s + t.dauer, 0);
  const realized = ts.filter(t => !t.canceled).reduce((s, t) => s + t.dauer, 0)
    + ds.filter(t => !t.canceled).reduce((s, t) => s + t.dauer, 0);
  const lastEnd = ts.filter(t => !t.canceled).reduce((m, t) => Math.max(m, t.start + t.dauer), -Infinity);
  return {
    n: ts.length,
    plannedMin: planned,
    realizedMin: realized,
    overlapMin: overlapMinutes(ts.map(t => [t.plan, t.plan + t.dauer])),
    canceled: ts.filter(t => t.canceled).length,
    late: ts.filter(t => t.late).length,
    lastEnd: Number.isFinite(lastEnd) ? lastEnd : null,
  };
}

// ---------- causal feature build ----------

const FEATURES = [
  ['Mo', 1], ['Di', 1], ['Mi', 1], ['Do', 1], ['Fr', 1], ['Sa', 1],
  ['hour', 0], ['hourSq', 0], ['logDauer', 0], ['recurring', 1], ['project', 1],
  ['sameDayAdd', 1], ['logLeadDays', 0], ['position', 0],
  ['dayN', 0], ['dayPlanH', 0], ['dayOverlapH', 0],
  ['itemCancelLogit', 0], ['itemLateLogit', 0], ['itemRecentCancelLogit', 0], ['itemRecentLateLogit', 0],
  ['itemLogN', 0], ['itemStreak', 0],
  ['prevLastEndH', 0], ['prevMissing', 1], ['prevCancelShare', 0], ['prevPlanH', 0],
];
const FEATURE_TEXT = {
  Mo: 'Monday (vs Sunday)', Di: 'Tuesday', Mi: 'Wednesday', Do: 'Thursday', Fr: 'Friday', Sa: 'Saturday',
  hour: 'Planned hour of day', hourSq: 'Distance from 14:00 (squared)', logDauer: 'Planned duration',
  recurring: 'Recurring item', project: 'Linked to a project', sameDayAdd: 'One-off added on the day',
  logLeadDays: 'Planning lead time (one-offs)', position: 'Position in the day (0 first … 1 last)',
  dayN: 'Trains planned that day (ahead)', dayPlanH: 'Hours planned that day (ahead)',
  dayOverlapH: 'Planned overlap hours that day', itemCancelLogit: 'Item/line past cancel rate',
  itemLateLogit: 'Item/line past late rate',
  itemRecentCancelLogit: 'Item recent cancel rate (EWMA)', itemRecentLateLogit: 'Item recent late rate (EWMA)', itemLogN: 'Item past occurrences',
  itemStreak: 'Item canceled streak', prevLastEndH: 'Previous day: last end time',
  prevMissing: 'Previous day: no data', prevCancelShare: 'Previous day: cancel share',
  prevPlanH: 'Previous day: hours planned',
};

// Small hand-picked sets: few parameters, so less overfitting on ~1k rows.
// (Picked after looking at the single-factor tables, so slightly optimistic.)
const LEAN = {
  yC: ['itemRecentCancelLogit', 'itemStreak', 'dayPlanH', 'sameDayAdd', 'hour'],
  yL: ['itemRecentLateLogit', 'hour', 'dayN', 'Sa'],
};
const ALL_NAMES = FEATURES.map(f => f[0]);
const BINARY = new Set(FEATURES.filter(f => f[1]).map(f => f[0]));

function shrink(k, n, prior, m = 5) { return (k + m * prior) / (n + m); }
const clampP = (p) => Math.min(0.98, Math.max(0.02, p));

function buildRows(data) {
  const { days, durByDay } = data;
  const order = [...days.keys()].sort();
  const item = new Map(), line = new Map();
  const glob = { n: 0, c: 0, nn: 0, l: 0 };
  const bump = (map, k) => { if (!map.has(k)) map.set(k, { n: 0, c: 0, nn: 0, l: 0, streak: 0, eC: null, eL: null }); return map.get(k); };
  const ALPHA = 0.3; // EWMA weight of the newest occurrence
  const rows = [], dayRows = [];

  for (const day of order) {
    const list = days.get(day), durs = durByDay.get(day) || [];
    const ahead = dayStats(list, durs, t => isAhead(t, day));
    const all = dayStats(list, durs, () => true);
    const prevDay = L.shiftDay(day, -1);
    const prev = days.has(prevDay) ? dayStats(days.get(prevDay), durByDay.get(prevDay), () => true) : null;
    dayRows.push({ day, wd: L.weekday(day), ahead, all, prev });

    const gC = (glob.c + 1) / (glob.n + 2), gL = (glob.l + 1) / (glob.nn + 2);
    list.forEach((t, idx) => {
      const it = item.get(t.key) || { n: 0, c: 0, nn: 0, l: 0, streak: 0 };
      const ln = line.get(t.line) || { n: 0, c: 0, nn: 0, l: 0 };
      const pC = clampP(shrink(it.c, it.n, shrink(ln.c, ln.n, gC)));
      const pL = clampP(shrink(it.l, it.nn, shrink(ln.l, ln.nn, gL)));
      // recent rate: EWMA over the item's own occurrences, lightly pulled to the long-run rate
      const rC = it.eC == null ? pC : clampP(0.8 * it.eC + 0.2 * pC);
      const rL = it.eL == null ? pL : clampP(0.8 * it.eL + 0.2 * pL);
      const wd = L.weekday(day);
      const sameDay = !t.recurring && t.createdAt != null && !isAhead(t, day);
      const leadDays = !t.recurring && t.createdAt != null ? Math.max(0, (t.planMs - t.createdAt) / 864e5) : 0;
      const f = {
        Mo: +(wd === 1), Di: +(wd === 2), Mi: +(wd === 3), Do: +(wd === 4), Fr: +(wd === 5), Sa: +(wd === 6),
        hour: t.plan / 60, hourSq: (t.plan / 60 - 14) ** 2, logDauer: Math.log1p(t.dauer),
        recurring: +t.recurring, project: +Boolean(t.projectId), sameDayAdd: +sameDay,
        logLeadDays: Math.log1p(Math.min(leadDays, 60)), position: list.length > 1 ? idx / (list.length - 1) : 0.5,
        dayN: ahead.n, dayPlanH: ahead.plannedMin / 60, dayOverlapH: ahead.overlapMin / 60,
        itemCancelLogit: L.logit(pC), itemLateLogit: L.logit(pL),
        itemRecentCancelLogit: L.logit(rC), itemRecentLateLogit: L.logit(rL), itemLogN: Math.log1p(it.n), itemStreak: Math.min(it.streak, 5),
        prevLastEndH: prev && prev.lastEnd != null ? prev.lastEnd / 60 : 22, prevMissing: +!(prev && prev.lastEnd != null),
        prevCancelShare: prev && prev.n ? prev.canceled / prev.n : 0, prevPlanH: prev ? prev.plannedMin / 60 : 0,
      };
      rows.push({
        day, wd, t, f, retro: isRetro(t), sameDay, leadDays, prev,
        dayAhead: ahead, dayAll: all, pBaseC: pC, pBaseL: pL, pRecentC: rC, pRecentL: rL,
        yC: +t.canceled, yL: t.canceled ? null : +t.late, streak: it.streak,
      });
    });

    // update history after the whole day (no same-day leakage)
    for (const t of list) {
      for (const s of [bump(item, t.key), bump(line, t.line), glob]) {
        s.n++; s.c += +t.canceled;
        if (!t.canceled) { s.nn++; s.l += +t.late; }
      }
      const it = item.get(t.key);
      it.streak = t.canceled ? it.streak + 1 : 0;
      it.eC = it.eC == null ? +t.canceled : (1 - ALPHA) * it.eC + ALPHA * +t.canceled;
      if (!t.canceled) it.eL = it.eL == null ? +t.late : (1 - ALPHA) * it.eL + ALPHA * +t.late;
    }
  }
  return { rows, dayRows };
}

// ---------- logistic regression (L2, Newton) ----------

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

function fitLogistic(rows, yKey, lambda, names = ALL_NAMES) {
  const bin = names.map(n => (BINARY.has(n) ? 1 : 0));
  const raw = rows.map(r => names.map(n => r.f[n]));
  const y = rows.map(r => r[yKey]);
  const mu = names.map((_, j) => (bin[j] ? 0 : L.mean(raw.map(x => x[j]))));
  const sd = names.map((_, j) => {
    if (bin[j]) return 1;
    const v = L.mean(raw.map(x => (x[j] - mu[j]) ** 2));
    return v > 1e-12 ? Math.sqrt(v) : 1;
  });
  const X = raw.map(x => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]);
  const p = X[0].length;
  let w = new Array(p).fill(0);
  w[0] = L.logit(Math.min(0.99, Math.max(0.01, L.mean(y))));
  for (let it = 0; it < 30; it++) {
    const g = new Array(p).fill(0), H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i];
      let z = 0; for (let j = 0; j < p; j++) z += w[j] * xi[j];
      const pi = L.sigmoid(z), wi = pi * (1 - pi), e = pi - y[i];
      for (let j = 0; j < p; j++) {
        g[j] += e * xi[j];
        const a = wi * xi[j];
        for (let k = j; k < p; k++) H[j][k] += a * xi[k];
      }
    }
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) H[j][k] = H[k][j];
      if (j > 0) { g[j] += lambda * w[j]; H[j][j] += lambda; }
    }
    const step = solve(H, g);
    let maxStep = 0;
    for (let j = 0; j < p; j++) { w[j] -= step[j]; maxStep = Math.max(maxStep, Math.abs(step[j])); }
    if (maxStep < 1e-6) break;
  }
  return {
    names, bin, w, sd,
    predict(f) {
      let z = w[0];
      names.forEach((n, j) => { z += w[j + 1] * (f[n] - mu[j]) / sd[j]; });
      return L.sigmoid(z);
    },
  };
}

function auc(pairs) {
  const s = [...pairs].sort((a, b) => a.p - b.p);
  let rank = 0, sumPos = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < s.length;) {
    let j = i; while (j < s.length && s[j].p === s[i].p) j++;
    const avg = (i + j + 1) / 2; // average 1-based rank of ties
    for (let k = i; k < j; k++) { if (s[k].y) { sumPos += avg; nPos++; } else nNeg++; }
    rank = j; i = j;
  }
  return nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : NaN;
}

// Predictors compared out-of-sample: two plain rates and two fitted models.
function backtest(rows, yKey, opts, rng) {
  const baseKey = yKey === 'yC' ? 'pBaseC' : 'pBaseL', recentKey = yKey === 'yC' ? 'pRecentC' : 'pRecentL';
  const byDay = new Map();
  for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
  const order = [...byDay.keys()].sort();
  const perDay = [], preds = [];
  let full = null, lean = null, lastFit = -Infinity;
  for (let i = opts.minHistory; i < order.length; i++) {
    if (i - lastFit >= opts.refitEvery || !full) {
      const train = order.slice(0, i).flatMap(d => byDay.get(d));
      full = fitLogistic(train, yKey, opts.lambda);
      lean = fitLogistic(train, yKey, opts.lambda, LEAN[yKey]);
      lastFit = i;
    }
    const today = byDay.get(order[i]);
    const se = { base: 0, recent: 0, lean: 0, full: 0 };
    for (const r of today) {
      const y = r[yKey];
      const p = { base: r[baseKey], recent: r[recentKey], lean: lean.predict(r.f), full: full.predict(r.f) };
      for (const k in p) se[k] += (p[k] - y) ** 2;
      preds.push({ ...p, y });
    }
    perDay.push({ se, n: today.length });
  }
  const N = perDay.reduce((s, d) => s + d.n, 0);
  if (!N) return null;
  const KEYS = ['base', 'recent', 'lean', 'full'];
  const brier = {}, aucs = {}, skillCi = {};
  for (const k of KEYS) {
    brier[k] = perDay.reduce((s, d) => s + d.se[k], 0) / N;
    aucs[k] = auc(preds.map(p => ({ p: p[k], y: p.y })));
  }
  // skill relative to the long-run item rate, day-bootstrap CI
  for (const k of KEYS.slice(1)) {
    const sk = [];
    for (let b = 0; b < opts.reps; b++) {
      let sB = 0, sK = 0;
      for (let i = 0; i < perDay.length; i++) { const d = perDay[Math.floor(rng() * perDay.length)]; sB += d.se.base; sK += d.se[k]; }
      sk.push(1 - sK / sB);
    }
    sk.sort((a, b) => a - b);
    skillCi[k] = [L.quantile(sk, 0.025), L.quantile(sk, 0.975)];
  }
  return { days: perDay.length, N, brier, aucs, skillCi };
}

// ---------- report helpers ----------

function table(title, rows, binOf, order) {
  const g = new Map();
  for (const r of rows) {
    const b = binOf(r);
    if (b == null) continue;
    if (!g.has(b)) g.set(b, { n: 0, c: 0, nn: 0, l: 0 });
    const s = g.get(b);
    s.n++; s.c += r.yC;
    if (r.yL != null) { s.nn++; s.l += r.yL; }
  }
  console.log(`\n  ${title}`);
  console.log(`    ${''.padEnd(16)}${'n'.padStart(6)}${'canceled'.padStart(10)}${'late*'.padStart(9)}`);
  for (const b of order.filter(b => g.has(b))) {
    const s = g.get(b);
    console.log(`    ${String(b).padEnd(16)}${String(s.n).padStart(6)}${L.pct(s.c / s.n).padStart(10)}${L.pct(s.nn ? s.l / s.nn : NaN).padStart(9)}`);
  }
}

function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
      for (let k = i; k < j; k++) r[idx[k][1]] = (i + j - 1) / 2;
      i = j;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys), mx = L.mean(rx), my = L.mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}

function spearmanPerm(xs, ys, reps, rng) {
  const obs = spearman(xs, ys);
  const y = [...ys];
  let ext = 0;
  for (let b = 0; b < reps; b++) {
    for (let i = y.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [y[i], y[j]] = [y[j], y[i]]; }
    if (Math.abs(spearman(xs, y)) >= Math.abs(obs) - 1e-12) ext++;
  }
  return { rho: obs, p: (ext + 1) / (reps + 1) };
}

const binBy = (edges, labels) => (x) => {
  for (let i = 0; i < edges.length; i++) if (x < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

// ---------- main ----------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rng = L.mulberry32(opts.seed);
  const data = L.loadLog({ logDir: opts.logDir, threshold: opts.threshold });
  const { rows: allRows, dayRows } = buildRows(data);
  const rows = allRows.filter(r => !r.retro);
  const out = { opts: { ...opts, logDir: undefined } };

  console.log('\n=== Disruption drivers: cancellations, lateness, workload ===');
  console.log(`${data.trains.length} timed trains + ${data.durationOnly.length} duration-only entries over ${data.days.size} days.`);
  console.log(`Retro-logged (created at/after their own start, excluded from models): ${allRows.length - rows.length}.`);
  console.log(`Analysed: ${rows.length} trains. "late*" = late ≥${opts.threshold} min among trains that ran.`);

  // ---- 1. what are cancellations? ----
  console.log('\n--- 1. Cancellation overview ---');
  const canc = rows.filter(r => r.yC);
  console.log(`  ${canc.length} canceled (${L.pct(canc.length / rows.length).trim()}).`);
  const reasons = new Map();
  for (const r of canc) { const k = r.t.cancelReason || '(no reason)'; reasons.set(k, (reasons.get(k) || 0) + 1); }
  console.log('  Top reasons: ' + [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · '));
  table('By item type', rows, r => (r.t.recurring ? 'recurring' : r.sameDay ? 'one-off, same day' : 'one-off, ahead'),
    ['recurring', 'one-off, ahead', 'one-off, same day']);

  // ---- 2. workload / overplanning (day level) ----
  console.log('\n--- 2. Workload: are full days overplanned? (one row per day) ---');
  const cap = opts.capacityHours;
  const usable = dayRows.filter(d => d.all.n >= 1);
  const hb = binBy([3, 6, 9, 12], ['<3h', '3–6h', '6–9h', '9–12h', '12h+']);
  const groups = new Map();
  for (const d of usable) {
    const b = hb(d.all.plannedMin / 60);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(d);
  }
  console.log(`    ${'planned'.padEnd(9)}${'days'.padStart(6)}${'median planned'.padStart(16)}${'median done'.padStart(13)}${'done share'.padStart(12)}${'canceled'.padStart(10)}${'late*'.padStart(9)}`);
  for (const b of ['<3h', '3–6h', '6–9h', '9–12h', '12h+'].filter(b => groups.has(b))) {
    const ds = groups.get(b);
    const pl = L.median(ds.map(d => d.all.plannedMin / 60)), dn = L.median(ds.map(d => d.all.realizedMin / 60));
    const share = L.mean(ds.filter(d => d.all.plannedMin > 0).map(d => d.all.realizedMin / d.all.plannedMin));
    const cs = L.mean(ds.map(d => d.all.canceled / d.all.n));
    const ran = ds.filter(d => d.all.n > d.all.canceled);
    const ls = L.mean(ran.map(d => d.all.late / (d.all.n - d.all.canceled)));
    console.log(`    ${b.padEnd(9)}${String(ds.length).padStart(6)}${(pl.toFixed(1) + 'h').padStart(16)}${(dn.toFixed(1) + 'h').padStart(13)}${L.pct(share).padStart(12)}${L.pct(cs).padStart(10)}${L.pct(ls).padStart(9)}`);
  }
  const realizedSorted = usable.map(d => d.all.realizedMin / 60).sort((a, b) => a - b);
  console.log(`  Hours actually done per day: median ${L.quantile(realizedSorted, 0.5).toFixed(1)}h, 75th pct ${L.quantile(realizedSorted, 0.75).toFixed(1)}h, 90th pct ${L.quantile(realizedSorted, 0.9).toFixed(1)}h, max ${realizedSorted[realizedSorted.length - 1].toFixed(1)}h`);
  const p90 = L.quantile(realizedSorted, 0.9);
  const over = usable.filter(d => d.ahead.plannedMin / 60 > p90);
  if (over.length) {
    console.log(`  Days planned ahead beyond your 90th-pct done (${p90.toFixed(1)}h): ${over.length}, canceled share ${L.pct(L.mean(over.map(d => d.ahead.n ? d.ahead.canceled / d.ahead.n : 0))).trim()} vs ${L.pct(L.mean(usable.filter(d => d.ahead.plannedMin / 60 <= p90 && d.ahead.n).map(d => d.ahead.canceled / d.ahead.n))).trim()} on other days.`);
  }

  const dAhead = usable.filter(d => d.ahead.n >= 2);
  const s1 = spearmanPerm(dAhead.map(d => d.ahead.plannedMin), dAhead.map(d => d.ahead.canceled / d.ahead.n), opts.reps, rng);
  const s2 = spearmanPerm(dAhead.map(d => d.ahead.overlapMin), dAhead.map(d => d.ahead.canceled / d.ahead.n), opts.reps, rng);
  const s3 = spearmanPerm(dAhead.map(d => d.ahead.plannedMin), dAhead.map(d => d.ahead.realizedMin), opts.reps, rng);
  console.log(`  Correlations over ${dAhead.length} days with ≥2 items planned ahead (rank correlation, permutation p):`);
  console.log(`    hours planned ahead  ↔ canceled share: ρ=${L.num(s1.rho, 2)}  p=${L.num(s1.p, 4)}`);
  console.log(`    planned overlap      ↔ canceled share: ρ=${L.num(s2.rho, 2)}  p=${L.num(s2.p, 4)}`);
  console.log(`    hours planned ahead  ↔ hours done:      ρ=${L.num(s3.rho, 2)}  p=${L.num(s3.p, 4)}   (≈1 = you do what you plan; flat = capacity ceiling)`);
  out.workload = { rhoPlanCancel: s1, rhoOverlapCancel: s2, rhoPlanDone: s3, doneP90: p90 };

  // ---- 3. single-factor tables (train level) ----
  console.log('\n--- 3. Single factors (one row per train) ---');
  table('Weekday', rows, r => L.WEEKDAYS[r.wd], ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
  table('Planned start', rows, r => binBy([9, 12, 15, 18, 21], ['<09', '09–12', '12–15', '15–18', '18–21', '21+'])(r.t.plan / 60),
    ['<09', '09–12', '12–15', '15–18', '18–21', '21+']);
  table('Hours planned that day (ahead)', rows, r => hb(r.dayAhead.plannedMin / 60), ['<3h', '3–6h', '6–9h', '9–12h', '12h+']);
  table('Hours planned that day (incl. same-day adds)', rows, r => hb(r.dayAll.plannedMin / 60), ['<3h', '3–6h', '6–9h', '9–12h', '12h+']);
  table('Planned overlap that day (ahead)', rows, r => binBy([1, 30, 90], ['none', '<30 min', '30–90 min', '90+ min'])(r.dayAhead.overlapMin),
    ['none', '<30 min', '30–90 min', '90+ min']);
  table('Trains planned that day (ahead)', rows, r => binBy([3, 5, 7, 9], ['1–2', '3–4', '5–6', '7–8', '9+'])(r.dayAhead.n),
    ['1–2', '3–4', '5–6', '7–8', '9+']);
  table('Position in the day', rows, r => binBy([1 / 3, 2 / 3], ['first third', 'middle', 'last third'])(r.f.position),
    ['first third', 'middle', 'last third']);
  table('Planned duration', rows, r => binBy([31, 61, 121, 241], ['≤30 min', '31–60', '61–120', '121–240', '240+'])(r.t.dauer),
    ['≤30 min', '31–60', '61–120', '121–240', '240+']);
  table('Planning lead time', rows, r => (r.t.recurring ? 'recurring' : r.sameDay ? 'same day' : binBy([3, 8], ['1–2 days', '3–7 days', '8+ days'])(r.leadDays)),
    ['same day', '1–2 days', '3–7 days', '8+ days', 'recurring']);
  table('Previous day ended (last train end)', rows, r => (!r.prev || r.prev.lastEnd == null ? 'no data'
    : binBy([21 * 60, 23 * 60, 25 * 60], ['before 21', '21–23', '23–01', 'after 01'])(r.prev.lastEnd)),
    ['before 21', '21–23', '23–01', 'after 01', 'no data']);
  table('Previous day canceled share', rows, r => (!r.prev || !r.prev.n ? 'no data'
    : binBy([0.001, 0.34, 0.67], ['0%', '1–33%', '34–66%', '67%+'])(r.prev.canceled / r.prev.n)),
    ['0%', '1–33%', '34–66%', '67%+', 'no data']);
  table('Item canceled streak (previous occurrences)', rows, r => (r.streak >= 3 ? '3+' : String(r.streak)), ['0', '1', '2', '3+']);

  // ---- 4. multivariable models ----
  console.log('\n--- 4. Combined model (logistic regression, all factors at once) ---');
  out.models = {};
  for (const [label, yKey, subset] of [
    ['CANCELED', 'yC', rows],
    ['LATE (trains that ran)', 'yL', rows.filter(r => r.yL != null)],
  ]) {
    const full = fitLogistic(subset, yKey, opts.lambda);
    const coefs = full.names.map((n, j) => ({ n, w: full.w[j + 1], bin: full.bin[j] }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    console.log(`\n  ${label}: ${subset.length} trains, rate ${L.pct(L.mean(subset.map(r => r[yKey]))).trim()}`);
    console.log('    Effect sizes, full-data fit (odds ×, per +1 SD for numbers, yes-vs-no for flags):');
    for (const c of coefs.slice(0, 12)) {
      const or = Math.exp(c.w);
      const bar = (or >= 1 ? '+' : '−').repeat(Math.min(10, Math.round(Math.abs(c.w) / 0.1)));
      console.log(`      ${FEATURE_TEXT[c.n].padEnd(36)} ×${or.toFixed(2).padEnd(6)} ${bar}`);
    }
    const bt = backtest(subset, yKey, opts, rng);
    if (bt) {
      console.log(`    Rolling backtest (${bt.days} days, ${bt.N} predictions, models refit every ${opts.refitEvery} days on past only):`);
      console.log(`      ${'predictor'.padEnd(46)}${'Brier'.padStart(7)}${'AUC'.padStart(6)}   skill vs long-run rate [95% CI]`);
      const TXT = { base: 'item/line long-run rate', recent: 'item recent rate (EWMA)', lean: 'lean model: ' + LEAN[yKey].join(', '), full: 'full model (all factors)' };
      for (const k of ['base', 'recent', 'lean', 'full']) {
        const sk = k === 'base' ? '—' : `${L.pct(1 - bt.brier[k] / bt.brier.base).trim()} [${L.pct(bt.skillCi[k][0]).trim()}, ${L.pct(bt.skillCi[k][1]).trim()}]`;
        console.log(`      ${TXT[k].slice(0, 46).padEnd(46)}${L.num(bt.brier[k]).padStart(7)}${L.num(bt.aucs[k], 2).padStart(6)}   ${sk}`);
      }
    }
    out.models[yKey] = { coefs: coefs.map(c => ({ feature: c.n, oddsRatio: Math.exp(c.w) })), backtest: bt };
  }

  console.log('\nNotes: a checked-in train\'s logged duration is the measured one, not the planned one, so "hours planned" is slightly');
  console.log('distorted on days with check-ins. Items deleted instead of canceled are invisible here, which hides some overplanning.\n');

  if (opts.json) { fs.writeFileSync(opts.json, JSON.stringify(out, null, 2)); console.log(`JSON written to ${opts.json}`); }
}

main();
