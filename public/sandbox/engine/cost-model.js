(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./candidates.js'), require('./patterns.js'));
  else root.SbxCostModel = factory(root.SbxCandidates, root.SbxPatterns);
})(typeof self !== 'undefined' ? self : this, function (C, P) {
'use strict';

// Learned cost model: you are modelled as choosing, among the candidate
// timetables of a level (candidates.js), the one that costs least by your own
// standard. The costs are learned from the timetables you actually chose.
//
//   cost(T) = Σ_trains  δ · delay hours  +  κ · cancellations  +  σ · hours shortened
//           + μ · hours missed of fixed appointments (arriving late)  +  ψ · skipped appointments
//           + ρ · relocations  +  β · hours of break missing
//           + ω · overlap hours  +  ε · hours the day ends later than planned
//
// δ, κ, σ, μ and ψ are layered: δ_train = δ_all + δ_tier(line) + δ_line + δ_family
// + δ_template, each layer pulled toward 0 (= the layer above) — a template
// behaves like its task family (e.g. all 7 weekday Morning Rituals) unless
// your choices show a difference, a family with little data like its line, a
// line like its ranking tier, a tier like everything. One-off trains stop at
// their line. This is how a per-train tier list ("anchor", "absorber", "sacrificial")
// is learned instead of declared: an anchor ends up with high δ, a
// sacrificial train with low κ.
//
// P(T) ∝ exp(−cost(T)) (multinomial logit). Fit: maximum likelihood with an
// L2 pull toward the starting values, Newton steps (the problem is convex).
// Prediction: the cheapest candidate.
//
// Starting values: a cancellation, a relocation and an hour of shortening each
// cost about an hour of delay, an hour of overlap 3 h, an hour of missing
// break or of the day ending late half an hour. The push-like start
// (PRIOR_PUSH: cancellation = 10 h of delay, so the untrained model never
// cancels) learned too few cancellations on the recorded levels (14 % vs 25 %
// caught, MAE 12.3 vs 10.3) and is kept as a sensitivity check.
//
// Layer pull (LAMBDA): line 3, family 3 (tested on the archived levels as the
// template layer: same prequential scores as 6 / 8 but more separation; 2 / 1
// gave some trains negative delay costs — noise being fitted), template 6 (a
// weekday differs from its family only with clear evidence).

// cost units: 1 = 10 minutes of delay
// missed / skip: minutes missed from a fixed appointment (arriving late) and
// skipping it — their own costs, not ordinary delay and cancellation, so the
// threshold "from how late on do I skip" is learned from appointment
// decisions only. Starting values: skipping costs as much as missing 20 min
// (the user's stated threshold).
const PRIOR = { 'delay:all': 6, 'cancel:all': 6, 'missed:all': 18, 'skip:all': 6, 'shrink:all': 6, relocate: 6, breakDeficit: 3, overlap: 18, endLate: 3 };
const PRIOR_PUSH = { 'delay:all': 6, 'cancel:all': 60, 'missed:all': 180, 'skip:all': 60, 'shrink:all': 12, relocate: 30, breakDeficit: 0, overlap: 120, endLate: 0 };
const LAMBDA = { global: 0.5, tier: 2, line: 3, family: 3, task: 6 };
// Bumped whenever features change: the server refits a stored model of an
// older engine version (sandbox-trainer.js).
const ENGINE_VERSION = 4;
// Feature switches, kept switchable for offline comparisons. Tested on the
// first 40 sandbox levels (prequential): own costs for appointments 69 → 72 %
// trains right, appointment decisions 29 → 35 of 40; pricing the given late
// start of every disrupted train made it worse (65 %), of disrupted fixed
// appointments only it is neutral (72 %) — and needed to learn from how late
// on you skip a class you arrive late to.
const FEATURES = { disruptedLateness: 'appointments', appointmentCosts: true };
// Every pattern switched on — the full candidate set.
const ALL_PATTERNS = { links: true, breaks: true, rest: true, shrink: true, relocate: true, slack: true };

function tierOf(linie, tiers) {
  const key = String(linie || '').toUpperCase();
  const i = (tiers || []).findIndex(t => (t || []).some(l => String(l).toUpperCase() === key));
  return i === -1 ? 'none' : `#${i + 1}`;
}

// Feature dictionary for one candidate (sparse: name → value).
function features(cand, fr, tiers, plannedEnd, taskOf, familyOf) {
  const f = {};
  const add = (k, v) => { if (v) f[k] = (f[k] || 0) + v; };
  add('overlap', cand.overlapMin / 60);
  add('endLate', Math.max(0, (cand.end || 0) - plannedEnd) / 60);
  add('breakDeficit', (cand.deficitMin || 0) / 60);
  if (cand.relocated) add('relocate', 1);
  fr.decision.forEach(x => {
    const tier = tierOf(x.linie, tiers);
    const task = taskOf(x.uid);
    const family = familyOf ? familyOf(x.uid) : null;
    const layered = (kind, v) => {
      add(`${kind}:all`, v); add(`${kind}:tier:${tier}`, v); add(`${kind}:line:${x.linie}`, v);
      if (family) add(`${kind}:family:${family}`, v);
      if (task) add(`${kind}:task:${task}`, v);
    };
    if (cand.cancels.has(x.uid)) { layered(x.appointment && FEATURES.appointmentCosts ? 'skip' : 'cancel', 1); return; }
    if (cand.shrinkMin && cand.shrinkMin[x.uid]) layered('shrink', cand.shrinkMin[x.uid] / 60);
    // Late start of a kept train. For a fixed appointment it is minutes missed
    // (its end is fixed) — also when the late arrival is the disruption itself,
    // since that is what skipping it avoids. A disrupted ordinary train's own
    // late start is not priced (see FEATURES).
    if (x.disrupted && !(FEATURES.disruptedLateness === true || (FEATURES.disruptedLateness === 'appointments' && x.appointment))) return;
    const startNow = cand.starts[x.uid] != null ? cand.starts[x.uid] : (x.disrupted ? x.givenStart : x.plan);
    const d = Math.max(0, startNow - x.plan) / 60;
    if (d > 0) layered(x.appointment && FEATURES.appointmentCosts ? 'missed' : 'delay', d);
  });
  return f;
}

// One level as choice problem: candidates with feature dicts, your choice.
// `patterns` (fitted on earlier levels) and `use` pick the candidate set;
// without patterns: plain push / hold / cancel.
function choiceProblem(level, { patterns = null, use = {} } = {}) {
  const e = C.enumerate(level, patterns ? P.candidateOptions(patterns, level, use) : {});
  const user = C.userChoice(level, e.framing);
  const near = C.nearest(e, user);
  const plannedEnd = Math.max(...e.framing.day.map(x => x.plan + x.plannedDauer));
  const base = new Map((level.ep.baseDay || []).map(b => [b.uid, b]));
  const taskOf = (uid) => { const b = base.get(uid); return b && b.templateId ? b.templateId : null; };
  const familyOf = (uid) => P.familyKey(base.get(uid));
  const feats = e.candidates.map(c => features(c, e.framing, level.tiers, plannedEnd, taskOf, familyOf));
  const chosen = e.candidates.indexOf(near.cand);
  return {
    level, framing: e.framing, candidates: e.candidates, feats, chosen,
    // a level whose cancel decisions no candidate reproduces counts half
    weight: near.dist < 1000 ? 1 : 0.5, nearestDist: near.dist,
  };
}

class CostModel {
  constructor(prior = PRIOR, lambda = LAMBDA) { this.prior = prior; this.lambda = lambda; this.theta = {}; this.names = []; }

  lambdaOf(name) {
    if (name.includes(':tier:')) return this.lambda.tier;
    if (name.includes(':line:')) return this.lambda.line;
    if (name.includes(':family:')) return this.lambda.family != null ? this.lambda.family : LAMBDA.family;
    if (name.includes(':task:')) return this.lambda.task;
    return this.lambda.global;
  }
  priorOf(name) { return this.prior[name] || 0; }
  value(name) { return this.theta[name] != null ? this.theta[name] : this.priorOf(name); }
  cost(f) { let c = 0; for (const k in f) c += this.value(k) * f[k]; return c; }

  // Maximum likelihood + L2 toward the prior, Newton with backtracking.
  // Starts from the current theta (warm start when refitting).
  fit(problems, { iterations = 30 } = {}) {
    const names = new Set(Object.keys(this.prior));
    problems.forEach(p => p.feats.forEach(f => Object.keys(f).forEach(k => names.add(k))));
    this.names = [...names].sort();
    const idx = new Map(this.names.map((n, i) => [n, i]));
    const K = this.names.length;
    let th = this.names.map(n => this.value(n));
    const prior = this.names.map(n => this.priorOf(n));
    const lam = this.names.map(n => this.lambdaOf(n));
    // sparse feature vectors: per candidate parallel index / value arrays
    const sparse = problems.map(p => p.feats.map(f => {
      const ks = Object.keys(f).filter(k => f[k]);
      return { i: Int32Array.from(ks.map(k => idx.get(k))), v: Float64Array.from(ks.map(k => f[k])) };
    }));
    const costOf = (t, c) => { let s = 0; for (let j = 0; j < c.i.length; j++) s += t[c.i[j]] * c.v[j]; return s; };

    const objective = (t) => {
      let L = 0;
      problems.forEach((p, pi) => {
        const cs = sparse[pi].map(c => costOf(t, c));
        let m = Infinity; for (const c of cs) if (c < m) m = c;
        let z = 0; for (const c of cs) z += Math.exp(-(c - m));
        L += p.weight * (cs[p.chosen] - (m - Math.log(z))); // −log P(chosen)
      });
      for (let j = 0; j < K; j++) L += 0.5 * lam[j] * (t[j] - prior[j]) ** 2;
      return L;
    };

    let obj = objective(th);
    for (let it = 0; it < iterations; it++) {
      const g = new Float64Array(K), H = Array.from({ length: K }, () => new Float64Array(K));
      problems.forEach((p, pi) => {
        const cands = sparse[pi];
        const cs = cands.map(c => costOf(th, c));
        let m = Infinity; for (const c of cs) if (c < m) m = c;
        const ws = cs.map(c => Math.exp(-(c - m)));
        let Z = 0; for (const w of ws) Z += w;
        const mean = new Float64Array(K);
        const touched = new Set();
        cands.forEach((c, ci) => {
          const pr = ws[ci] / Z;
          if (pr < 1e-12) return;
          const w = p.weight * pr;
          for (let x = 0; x < c.i.length; x++) {
            const a = c.i[x], va = c.v[x];
            mean[a] += pr * va; touched.add(a);
            for (let y = 0; y < c.i.length; y++) H[a][c.i[y]] += w * va * c.v[y];
          }
        });
        const ch = cands[p.chosen];
        for (let x = 0; x < ch.i.length; x++) g[ch.i[x]] += p.weight * ch.v[x];
        const tl = [...touched];
        for (const a of tl) {
          g[a] -= p.weight * mean[a];
          for (const b of tl) H[a][b] -= p.weight * mean[a] * mean[b];
        }
      });
      for (let j = 0; j < K; j++) { g[j] += lam[j] * (th[j] - prior[j]); H[j][j] += lam[j]; }
      const step = solve(H, g);
      let alpha = 1, next, nobj;
      for (let ls = 0; ls < 20; ls++) {
        next = th.map((v, j) => v - alpha * step[j]);
        nobj = objective(next);
        if (nobj <= obj) break;
        alpha /= 2;
      }
      if (!(nobj <= obj)) break; // converged: no step improves any more
      const gain = obj - nobj;
      const moved = Math.max(...step.map(s => Math.abs(s * alpha)));
      th = next; obj = nobj;
      if (moved < 1e-6 || gain < 1e-9) break;
    }
    this.theta = Object.fromEntries(this.names.map((n, j) => [n, th[j]]));
    this.objective = obj;
    return this;
  }

  // Cheapest candidate, plus how sure the model is (entropy over candidates).
  choose(problem) {
    const cs = problem.feats.map(f => this.cost(f));
    let best = 0;
    cs.forEach((c, i) => { if (c < cs[best]) best = i; });
    const m = cs[best];
    const ws = cs.map(c => Math.exp(-(c - m)));
    const Z = ws.reduce((s, w) => s + w, 0);
    const entropy = -ws.reduce((s, w) => { const p = w / Z; return p > 0 ? s + p * Math.log(p) : s; }, 0);
    return { index: best, cand: problem.candidates[best], cost: m, costs: cs, entropy, pChosen: problem.chosen >= 0 ? ws[problem.chosen] / Z : null };
  }

  // Effective costs of one train: overall + tier + line (+ task) layer.
  trainCosts(linie, tiers, task = null, family = null) {
    const t = tierOf(linie, tiers);
    const v = (kind) => this.value(`${kind}:all`) + this.value(`${kind}:tier:${t}`) + this.value(`${kind}:line:${linie}`) + (family ? this.value(`${kind}:family:${family}`) : 0) + (task ? this.value(`${kind}:task:${task}`) : 0);
    // Delay / shrink / missed features are in hours, so their costs are per
    // hour; reported per 10 minutes (cost unit: 1 = 10 min of delay at the
    // starting rate).
    const perHour = { delay: v('delay'), shrink: v('shrink'), missed: v('missed') };
    return {
      line: linie, tier: t, family, task,
      delayPer10: perHour.delay / 6, shrinkPer10: perHour.shrink / 6, missedPer10: perHour.missed / 6,
      cancel: v('cancel'),
      // minutes of delay that cost as much as cancelling
      breakEvenMin: perHour.delay > 0.05 ? (v('cancel') / perHour.delay) * 60 : null,
      skip: v('skip'),
      // fixed appointment: minutes late from which skipping is cheaper
      skipAfterMin: perHour.missed > 0.05 ? (v('skip') / perHour.missed) * 60 : null,
    };
  }
  lineCosts(lines, tiers) { return lines.map(l => this.trainCosts(l, tiers)); }

  toJSON() { return { theta: this.theta, prior: this.prior, lambda: this.lambda, units: '1 = cost of 10 minutes of delay (global prior)' }; }
}

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

// Prediction in the replay harness's format.
function toPrediction(problem, choice) {
  const delays = {}, cancels = {};
  problem.framing.decision.forEach(x => {
    if (choice.cand.cancels.has(x.uid)) { cancels[x.uid] = true; return; }
    if (!x.disrupted) delays[x.uid] = choice.cand.delays[x.uid] || 0;
  });
  return { delays, cancels, endOfDay: choice.cand.end, entropy: choice.entropy };
}


// ======================================================================
// Sandbox v2: levels, scoring, live prediction, persistence, level choice
// ======================================================================

// Task for level selection and reports: the family of a recurring train, the
// line for one-offs.
const taskKeyOf = (b) => (b && b.templateId ? `fam:${P.familyKey(b)}` : `line:${(b && b.linie) || '?'}`);

// A level object (the shape candidates / patterns work on) from a v2 episode
// — or from the open level: pass the scenario with `final` = current trains.
//   ep: { baseDay, final: [{uid, actual, dauer, canceled}], disruptions,
//         basePlannedDauer, lineRanking, excludedTrains }
function levelFromEpisode(ep, fallbackTiers) {
  if (!ep || !Array.isArray(ep.baseDay) || !ep.baseDay.length || !Array.isArray(ep.final)) return null;
  const ex = new Set(ep.excludedTrains || []);
  const base = ep.baseDay.filter(b => !ex.has(b.uid));
  const fin = new Map(ep.final.map(t => [t.uid, t]));
  const pd = ep.basePlannedDauer || {};
  const start = base.map(b => ({ _uniqueId: b.uid, linie: b.linie, ziel: b.ziel, plan: b.plan, actual: b.actual, dauer: Number(b.dauer) || 0 }));
  const final = base.map(b => {
    const f = fin.get(b.uid) || {};
    return {
      _uniqueId: b.uid, linie: b.linie, ziel: b.ziel, plan: b.plan,
      actual: f.actual != null ? f.actual : b.actual,
      dauer: f.dauer != null ? Number(f.dauer) || 0 : Number(b.dauer) || 0,
      canceled: !!f.canceled,
    };
  });
  const scenario = {
    date: ep.date,
    disruptions: (ep.disruptions || []).filter(d => !ex.has(d.uid)),
    basePlan: Object.fromEntries(base.map(b => [b.uid, b.plan])),
    basePlannedDauer: Object.fromEntries(base.map(b => [b.uid, pd[b.uid] != null ? Number(pd[b.uid]) : Number(b.dauer) || 0])),
  };
  const tiers = Array.isArray(ep.lineRanking) && ep.lineRanking.length ? ep.lineRanking : (fallbackTiers || []);
  return { ep: Object.assign({}, ep, { baseDay: base }), start, final, scenario, tiers };
}

// A timetable in plain terms (stored with every level, compared at the end).
function timetableOf(cand, extra) {
  return Object.assign({
    starts: Object.assign({}, cand.starts), durs: Object.assign({}, cand.durs),
    cancels: [...cand.cancels], end: cand.end,
    special: cand.special ? Object.assign({}, cand.special) : null, rest: !!cand.rest,
  }, extra || {});
}

// Push: every train kept, starts once its planned predecessors are done, no gap.
function pushTimetable(level) {
  const fr = C.framing(level);
  const actions = {};
  fr.decision.forEach(x => { actions[x.uid] = x.disrupted ? 'keep' : 'push'; });
  return timetableOf(Object.assign({ cancels: new Set() }, C.build(fr, { actions }, {})));
}

// Your day end: latest end of a kept train.
function dayEndOf(level) {
  let end = null;
  level.final.forEach(t => {
    if (t.canceled) return;
    const plan = C.toMin(level.scenario.basePlan[t._uniqueId]);
    if (plan == null) return;
    const e = plan + C.delayOf(plan, t.actual) + (Number(t.dauer) || 0);
    end = end == null ? e : Math.max(end, e);
  });
  return end;
}

// How close a predicted timetable came to yours. A train counts as a hit when
// the cancel decision matches and, if kept, its start is ≤ hitMin minutes off.
// mae: start error on trains you and the prediction both kept (not disrupted).
function scoreLevel(level, pred, { hitMin = 10 } = {}) {
  const fr = C.framing(level);
  const user = C.userChoice(level, fr);
  const pc = new Set(pred.cancels || []);
  let hits = 0, total = 0, cancelN = 0, cancelHit = 0, falseCancel = 0, keptN = 0;
  const errs = [];
  fr.decision.forEach(x => {
    total++;
    const uc = user.cancels.has(x.uid), pcx = pc.has(x.uid);
    if (uc) { cancelN++; if (pcx) { cancelHit++; hits++; } return; }
    keptN++;
    if (pcx) { falseCancel++; return; }
    const ps = pred.starts && pred.starts[x.uid] != null ? pred.starts[x.uid] : (x.disrupted ? x.givenStart : x.plan);
    const e = Math.abs(ps - user.starts[x.uid]);
    if (!x.disrupted) errs.push(e);
    if (e <= hitMin) hits++;
  });
  const end = dayEndOf(level);
  return {
    hits, total, stars: total ? Math.max(1, Math.round((5 * hits) / total)) : null,
    mae: errs.length ? errs.reduce((s, v) => s + v, 0) / errs.length : null,
    dayErr: pred.end != null && end != null ? Math.abs(pred.end - end) : null,
    cancelHit, cancelN, falseCancel, keptN, userEnd: end,
  };
}

// Live prediction: the cheapest candidate that agrees with what you have
// already decided. fixed: uid → { cancel, start, dur }. A candidate that
// disagrees pays a penalty far above any real cost, so the closest one wins
// when none agrees exactly.
function chooseGiven(problem, model, fixed) {
  if (!problem._costs || problem._costsFor !== model) {
    problem._costs = problem.feats.map(f => model.cost(f));
    problem._costsFor = model;
  }
  const keys = Object.keys(fixed || {});
  let best = -1, bestV = Infinity, bestPen = 0;
  problem.candidates.forEach((c, i) => {
    let pen = 0;
    for (const uid of keys) {
      const f = fixed[uid];
      const cc = c.cancels.has(uid);
      if (cc !== !!f.cancel) { pen += 1e5; continue; }
      if (cc) continue;
      if (f.start != null && c.starts[uid] != null) pen += 100 * Math.max(0, Math.abs(c.starts[uid] - f.start) - 2);
      if (f.dur != null && c.durs[uid] != null) pen += 100 * Math.max(0, Math.abs(c.durs[uid] - f.dur) - 2);
    }
    const v = problem._costs[i] + pen;
    if (v < bestV) { bestV = v; best = i; bestPen = pen; }
  });
  return best === -1 ? null : { index: best, cand: problem.candidates[best], exact: bestPen === 0 };
}

// ---- persistence ----
function modelToJSON(model) { return { theta: model.theta, prior: model.prior, lambda: model.lambda }; }
// A model saved before a cost existed gets that cost's starting value.
function modelFromJSON(json) {
  const m = new CostModel(Object.assign({}, PRIOR, (json && json.prior) || {}), Object.assign({}, LAMBDA, (json && json.lambda) || {}));
  m.theta = Object.assign({}, (json && json.theta) || {});
  return m;
}

// ---- choosing the next level: what is the model missing? ----
// stats (from the trainer): taskSeen = decisions seen per task (template, or
// line for one-offs); pairSeen = task pairs that already shared a decision.
function decisionTasks(problem) {
  const base = new Map((problem.level.ep.baseDay || []).map(b => [b.uid, b]));
  return problem.framing.decision.map(x => taskKeyOf(base.get(x.uid) || { linie: x.linie }));
}
function informationOf(problem, model, stats) {
  const st = stats || {};
  const seen = st.taskSeen || {};
  const pairs = new Set(st.pairSeen || []);
  const ch = model.choose(problem);
  const tasks = [...new Set(decisionTasks(problem))];
  const unknown = tasks.reduce((s, t) => s + 1 / (1 + (seen[t] || 0)), 0);
  let newPairs = 0, allPairs = 0;
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    allPairs++;
    if (!pairs.has([tasks[i], tasks[j]].sort().join('|'))) newPairs++;
  }
  return { uncertainty: ch.entropy, unknown, contrast: allPairs ? newPairs / allPairs : 0, choice: ch };
}
function trainingStats(problems) {
  const taskSeen = {}, pairSeen = new Set();
  problems.forEach(p => {
    const tasks = [...new Set(decisionTasks(p))];
    tasks.forEach(t => { taskSeen[t] = (taskSeen[t] || 0) + 1; });
    for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) pairSeen.add([tasks[i], tasks[j]].sort().join('|'));
  });
  return { taskSeen, pairSeen: [...pairSeen] };
}

return {
  CostModel, choiceProblem, features, tierOf, toPrediction, PRIOR, PRIOR_PUSH, LAMBDA, ALL_PATTERNS,
  levelFromEpisode, timetableOf, pushTimetable, dayEndOf, scoreLevel, chooseGiven,
  modelToJSON, modelFromJSON, informationOf, trainingStats, taskKeyOf, ENGINE_VERSION, FEATURES,
};
});
