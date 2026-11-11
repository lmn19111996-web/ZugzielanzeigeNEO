// === SANDBOX DELAY MODEL (v2: hurdle model) ===
// Predicts, for every train after the first disruption of a sandbox level,
// whether the user will CANCEL it and, if kept, how many minutes it will be
// DELAYED. Cancellation is the user's main way to absorb a delay, so it is
// modelled explicitly instead of being left out:
//
//   Stage A  P(cancel | state)   — online Bayesian logistic regression
//                                   (Laplace approximation, one Newton step
//                                   per example), 8 features
//   Stage B  delay | kept         — linear regression updated by recursive
//                                   least squares (RLS), 9 features
//
// Rollout: the day is walked train by train in planned order. For each train
// only what is already settled before it is used (trains you decided, the
// disruptions, and earlier predictions). If P(cancel) ≥ 0.5 the train is
// treated as canceled (occupies no time); otherwise its delay is predicted
// and it is settled at plan + delay. Training uses the same features on your
// final timetable (teacher forcing).
//
// Untrained, the model equals the classic push algorithm: stage B starts at
// weight 1 on "conflict", stage A predicts the train's own historical cancel
// rate clipped below 40 %, so it never cancels anything before learning.
//
// Units inside the model: hours (minutes / 60).

(function () {
  'use strict';

  // ---------------------------------------------------------------- config
  const MODEL_VERSION = 2;

  const FEATURES = [
    { key: 'bias',        label: 'Grundwert' },
    { key: 'conflict',    label: 'Konflikt (Überlappung über die geplante hinaus)' },
    { key: 'conflictImp', label: 'Konflikt × Wichtigkeit' },
    { key: 'prevDelay',   label: 'Verspätung des Vorgängers' },
    { key: 'carry',       label: 'Mitgeschleppte Verspätung (klingt mit Puffer ab)' },
    { key: 'carryImp',    label: 'Mitgeschleppt × Wichtigkeit' },
    { key: 'disruption',  label: 'Störung, abklingend ab ihrem tatsächlichen Ende' },
    { key: 'importance',  label: 'Wichtigkeit (Linienrang)' },
    { key: 'duration',    label: 'Geplante Dauer' },
  ];
  const CANCEL_FEATURES = [
    { key: 'bias',           label: 'Grundwert' },
    { key: 'conflict',       label: 'Konflikt (Überlappung mit Vorgängern)' },
    { key: 'importance',     label: 'Wichtigkeit (Linienrang)' },
    { key: 'conflictLowImp', label: 'Konflikt × (1 − Wichtigkeit)' },
    { key: 'baseRate',       label: 'Eigene Ausfallquote aus den Logs (logit)' },
    { key: 'loadAfter',      label: 'Restliche geplante Last danach' },
    { key: 'duration',       label: 'Geplante Dauer' },
    { key: 'ownDisruption',  label: 'Eigene Störung (Verspätung + Überlänge)' },
  ];
  const K = FEATURES.length, KA = CANCEL_FEATURES.length;

  // Stage B prior: mean = push; sd per feature = 0.25 h / typical |x_j|
  // (RMS over 680 predicted trains in 150 generated levels, Nov 2026), so a
  // weight can move a prediction by ~15 min a priori; conflict keeps a looser
  // 0.5 around its prior mean of 1.
  const PRIOR_MEAN = [0, 1, 0, 0, 0, 0, 0, 0, 0];
  const PRIOR_SD = [0.25, 0.5, 0.15, 0.11, 0.17, 0.26, 0.34, 0.48, 0.21];
  const B_EIG_CAP = 4 * Math.max(...PRIOR_SD) ** 2;     // 1.0
  // Stage A prior: mean = the train's own base rate (weight 1 on its logit);
  // sd per feature = 1 / typical |x_j| (RMS over 985 eligible trains in 150
  // generated conflict-free levels, Nov 2026), so each weight can move the
  // log-odds by ~1 a priori. A flat prior let large-valued features (planned
  // load after a train reaches 10–15 h) pick up spurious weights from a
  // handful of cancellations.
  const CANCEL_PRIOR_MEAN = [0, 0, 0, 0, 1, 0, 0, 0];
  const CANCEL_PRIOR_SD = [1, 1.8, 1.9, 3.1, 0.9, 0.33, 0.8, 1.2];
  const A_EIG_CAP = 4 * Math.max(...CANCEL_PRIOR_SD) ** 2;

  const LEVEL_FORGETTING = 0.97;      // per finished level: half-life ≈ 23 levels
  const SIGMA2_PRIOR = (15 / 60) ** 2; // user's own noise, starts at 15 min sd
  const SIGMA2_MIN = (5 / 60) ** 2, SIGMA2_MAX = 1;
  const SIGMA2_ALPHA = 0.05;
  const RATE_MIN = 0.02, RATE_MAX = 0.4, DEFAULT_RATE = 0.1;
  const CANCEL_THRESHOLD = 0.5;
  const ACCEPT_WEIGHT = 0.5;
  const CARRY_DECAY_MIN = 60;
  const DISRUPTION_DECAY_MIN = 120;

  // ---------------------------------------------------------------- math
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const matVec = (M, v) => M.map(row => dot(row, v));
  const eye = (n, d) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? d[i] : 0)));
  const logit = (p) => Math.log(p / (1 - p));
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Symmetric eigen-decomposition (cyclic Jacobi), fine for 8–9 dimensions.
  function symEig(A) {
    const n = A.length;
    const a = A.map(r => r.slice());
    const V = eye(n, new Array(n).fill(1));
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-18) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(a[p][q]) < 1e-15) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    return { values: a.map((r, i) => r[i]), vectors: V };
  }

  // Clip the covariance's eigenvalues to [1e-9, cap]: stops wind-up from
  // forgetting in directions the data never excites, without shrinking the
  // well-determined directions (unlike a global trace rescale).
  function capEigen(M, cap) {
    const { values, vectors: V } = symEig(M);
    if (values.every(v => v <= cap && v > 0)) return M;
    const lam = values.map(v => clamp(v, 1e-9, cap));
    const n = M.length;
    const out = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let s = 0; for (let k = 0; k < n; k++) s += V[i][k] * lam[k] * V[j][k];
      out[i][j] = s;
    }
    return out;
  }

  // ---------------------------------------------------------------- model object
  function newModel() {
    return {
      version: MODEL_VERSION,
      features: FEATURES.map(f => f.key),
      w: PRIOR_MEAN.slice(),
      P: eye(K, PRIOR_SD.map(s => s * s)),
      sigma2: SIGMA2_PRIOR,
      n: 0,
      scenarios: 0,
      cancel: {
        features: CANCEL_FEATURES.map(f => f.key),
        m: CANCEL_PRIOR_MEAN.slice(),
        S: eye(KA, CANCEL_PRIOR_SD.map(s => s * s)),
        n: 0,
      },
      updatedAt: null,
    };
  }

  // The push algorithm: stage B prior, no cancellations at all.
  function pushModel() { const m = newModel(); m.cancel = null; return m; }

  function isValidModel(m) {
    return !!(m && m.version === MODEL_VERSION && Array.isArray(m.w) && m.w.length === K
      && Array.isArray(m.P) && m.P.length === K && m.cancel && Array.isArray(m.cancel.m) && m.cancel.m.length === KA);
  }

  // ---------------------------------------------------------------- time helpers
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function toHHMM(min) {
    const v = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  }
  function delayMin(basePlanMin, actual) {
    const a = toMin(actual);
    if (a == null || basePlanMin == null) return 0;
    let d = a - basePlanMin;
    if (d < -720) d += 1440;
    if (d > 720) d -= 1440;
    return d;
  }

  // Importance in [0, 1]: rank #1 → 1, last rank → 1/R, unranked → 0.
  function importanceOf(linie, tiers) {
    if (!linie || !Array.isArray(tiers) || !tiers.length) return 0;
    const key = String(linie).toUpperCase();
    for (let i = 0; i < tiers.length; i++) {
      if ((tiers[i] || []).some(l => String(l).toUpperCase() === key)) return (tiers.length - i) / tiers.length;
    }
    return 0;
  }

  // scenario.disruptions: [{ uid, type: 'delay' | 'overrun', minutes }]
  function disruptionsOf(scenario) {
    if (Array.isArray(scenario.disruptions) && scenario.disruptions.length) return scenario.disruptions;
    return scenario.disruption ? [Object.assign({ type: 'delay' }, scenario.disruption)] : [];
  }

  // Historical cancel rate of the train's template (from the real logs,
  // stored on the level at creation), clipped to [2 %, 40 %].
  function baseRateOf(scenario, uid) {
    const r = scenario.baseCancelRate && scenario.baseCancelRate[uid];
    return clamp(r == null || !Number.isFinite(r) ? DEFAULT_RATE : r, RATE_MIN, RATE_MAX);
  }

  function buildDay(entries, scenario) {
    const basePlan = scenario.basePlan || {};
    return entries
      .filter(t => t && t._uniqueId && basePlan[t._uniqueId] != null && t.date === scenario.date)
      .map(t => ({ t, uid: t._uniqueId, plan: toMin(basePlan[t._uniqueId]) }))
      .filter(x => x.plan != null)
      .sort((a, b) => a.plan - b.plan || (a.uid < b.uid ? -1 : 1));
  }

  // ---------------------------------------------------------------- labels
  // Label classes at "Fertig":
  //   accepted   — the user tapped the model's prediction        → weight 0.5
  //   discarded  — the user cleared the actual time ("on time")  → weight 1, y = 0
  //   changed    — the user set / canceled the train themselves  → weight 1
  //   parallel   — untouched, overlap marked "parallel ok"       → weight 1, y = 0
  //   untouched  — untouched and feasible (no overlap)           → weight 1, y = 0
  //   unresolved — untouched but overlapping an earlier train    → excluded (both stages)
  function classify(uid, conflictMin, labels) {
    if (labels.accepted && labels.accepted[uid]) return { cls: 'accepted', weight: ACCEPT_WEIGHT };
    if (labels.discarded && labels.discarded[uid]) return { cls: 'discarded', weight: 1 };
    if (labels.decided && labels.decided[uid]) return { cls: 'changed', weight: 1 };
    if (labels.parallelOk && labels.parallelOk[uid]) return { cls: 'parallel', weight: 1 };
    if (conflictMin < 1) return { cls: 'untouched', weight: 1 };
    return { cls: 'unresolved', weight: 0 };
  }

  // ---------------------------------------------------------------- the walk
  function walk(entries, scenario, opts) {
    const { model, tiers, settled, training } = opts;
    const labels = opts.labels || {};
    const day = buildDay(entries, scenario);
    const out = { predictions: {}, cancelPredictions: {}, examples: [], cancelExamples: [], endOfDay: null };
    const disrupted = new Set(disruptionsOf(scenario).map(d => d.uid));
    const firstIdx = day.findIndex(x => disrupted.has(x.uid));
    if (firstIdx === -1) return out;

    const plannedDauerOf = (x) => {
      const v = scenario.basePlannedDauer && scenario.basePlannedDauer[x.uid];
      return v != null ? Number(v) || 0 : Math.max(0, Number(x.t.dauer) || 0);
    };
    // Planned load still to come after each train (base plan, all trains).
    const loadAfter = new Array(day.length).fill(0);
    for (let i = day.length - 2; i >= 0; i--) loadAfter[i] = loadAfter[i + 1] + plannedDauerOf(day[i + 1]);
    // A train can only be blocked by trains that were PLANNED to finish
    // before it starts. Trains planned in parallel with it (e.g. an all-day
    // block next to normal trains on a real day) are ignored. On a
    // conflict-free sandbox day every earlier train is such a predecessor, so
    // this equals "end of everything before me".
    const conflictOf = (x) => {
      let end = -Infinity;
      ctx.settledList.forEach(s => { if (s.plannedEnd <= x.plan && s.end > end) end = s.end; });
      return Math.max(0, end - x.plan);
    };

    const ctx = { frontierEnd: -Infinity, prev: null, pastDisruptions: [], settledList: [] };
    const settle = (x, startMin) => {
      const dauer = Math.max(0, Number(x.t.dauer) || 0);
      if (dauer > 0) {
        ctx.frontierEnd = Math.max(ctx.frontierEnd, startMin + dauer);
        ctx.settledList.push({ plannedEnd: x.plan + plannedDauerOf(x), end: startMin + dauer });
      }
      ctx.prev = { plan: x.plan, start: startMin, plannedDauer: plannedDauerOf(x) };
    };
    const ownMagnitude = (x, actualStart) => (disrupted.has(x.uid)
      ? Math.max(0, actualStart - x.plan) + Math.max(0, (Number(x.t.dauer) || 0) - plannedDauerOf(x))
      : 0);
    const registerDisruption = (x, actualStart) => {
      ctx.pastDisruptions.push({ magnitude: ownMagnitude(x, actualStart), end: actualStart + Math.max(0, Number(x.t.dauer) || 0) });
    };

    const delayFeatures = (x, idx) => {
      const h = 60;
      const conflict = conflictOf(x);
      const prev = ctx.prev;
      const prevDelay = prev ? Math.max(0, prev.start - prev.plan) : 0;
      const gapPrev = prev ? Math.max(0, x.plan - (prev.plan + prev.plannedDauer)) : Infinity;
      const carry = prevDelay * Math.exp(-gapPrev / CARRY_DECAY_MIN);
      let disruption = 0;
      ctx.pastDisruptions.forEach(d => { disruption += d.magnitude * Math.exp(-Math.max(0, x.plan - d.end) / DISRUPTION_DECAY_MIN); });
      const imp = importanceOf(x.t.linie, tiers);
      return {
        bias: 1,
        conflict: conflict / h,
        conflictImp: (conflict / h) * imp,
        prevDelay: prevDelay / h,
        carry: carry / h,
        carryImp: (carry / h) * imp,
        disruption: disruption / h,
        importance: imp,
        duration: plannedDauerOf(x) / h,
      };
    };
    const cancelFeatures = (x, idx, actualStart) => {
      const conflict = conflictOf(x) / 60;
      const imp = importanceOf(x.t.linie, tiers);
      return {
        bias: 1,
        conflict,
        importance: imp,
        conflictLowImp: conflict * (1 - imp),
        baseRate: logit(baseRateOf(scenario, x.uid)),
        loadAfter: loadAfter[idx] / 60,
        duration: plannedDauerOf(x) / 60,
        ownDisruption: ownMagnitude(x, actualStart) / 60,
      };
    };
    const vecB = (f) => FEATURES.map(k => f[k.key] || 0);
    const vecA = (f) => CANCEL_FEATURES.map(k => f[k.key] || 0);

    day.forEach((x, idx) => {
      const actualStart = x.plan + delayMin(x.plan, x.t.actual);
      if (idx < firstIdx) { if (!x.t.canceled) settle(x, actualStart); return; }
      const isD = disrupted.has(x.uid);
      const conflictMin = conflictOf(x);
      const fA = cancelFeatures(x, idx, actualStart);

      if (training) {
        // Stage A: every eligible train, canceled or not. A canceled or
        // disrupted train's fate is always an explicit outcome.
        const cA = x.t.canceled
          ? (labels.accepted && labels.accepted[x.uid] ? { cls: 'accepted', weight: ACCEPT_WEIGHT } : { cls: 'changed', weight: 1 })
          : isD ? { cls: labels.decided && labels.decided[x.uid] ? 'changed' : 'given', weight: 1 }
          : classify(x.uid, conflictMin, labels);
        out.cancelExamples.push({ uid: x.uid, linie: x.t.linie, x: vecA(fA), z: x.t.canceled ? 1 : 0, cls: cA.cls, weight: cA.weight, disrupted: isD });
        if (x.t.canceled) return;
        if (isD) { registerDisruption(x, actualStart); settle(x, actualStart); return; }
        const c = classify(x.uid, conflictMin, labels);
        out.examples.push({ uid: x.uid, linie: x.t.linie, x: vecB(delayFeatures(x, idx)), y: delayMin(x.plan, x.t.actual) / 60, cls: c.cls, weight: c.weight });
        settle(x, actualStart);
        return;
      }

      if (x.t.canceled) return; // canceled by the user: occupies nothing
      if (settled && settled[x.uid]) { if (isD) registerDisruption(x, actualStart); settle(x, actualStart); return; }

      const q = model.cancel ? sigmoid(dot(model.cancel.m, vecA(fA))) : 0;
      out.cancelPredictions[x.uid] = q;
      const cancel = q >= CANCEL_THRESHOLD;

      if (isD) {
        // A disrupted train's delay is given; only its cancellation is predicted.
        if (cancel) {
          out.predictions[x.uid] = { cancel: true, q, minutes: 0, sdMin: 0, time: toHHMM(actualStart), basePlan: toHHMM(x.plan), disrupted: true };
          return;
        }
        registerDisruption(x, actualStart);
        settle(x, actualStart);
        return;
      }

      const f = delayFeatures(x, idx);
      const vec = vecB(f);
      let predMin = Math.max(0, Math.round(dot(model.w, vec) * 60));
      // Order safety net: never predict a train to start before the train
      // planned ahead of it (Gym cannot happen before Morning Ritual) —
      // unless the two were planned to run in parallel anyway.
      if (ctx.prev && ctx.prev.plan + ctx.prev.plannedDauer <= x.plan && x.plan + predMin < ctx.prev.start) predMin = ctx.prev.start - x.plan;
      // Predictive spread: parameter uncertainty + the user's own noise.
      const sigma2 = model.sigma2 != null ? model.sigma2 : SIGMA2_PRIOR;
      const sdMin = Math.sqrt(Math.max(0, dot(vec, matVec(model.P, vec))) + sigma2) * 60;
      out.predictions[x.uid] = { cancel, q, minutes: predMin, sdMin, time: toHHMM(x.plan + predMin), basePlan: toHHMM(x.plan), features: f };
      if (cancel) return; // predicted canceled: occupies nothing
      settle(x, x.plan + predMin);
    });
    out.endOfDay = Number.isFinite(ctx.frontierEnd) ? ctx.frontierEnd : null;
    return out;
  }

  function rollout(entries, scenario, model, tiers, settled) {
    const r = walk(entries, scenario, { model, tiers, settled, training: false });
    return { predictions: r.predictions, cancelPredictions: r.cancelPredictions, endOfDay: r.endOfDay };
  }
  function predict(entries, scenario, model, tiers, settled) {
    return rollout(entries, scenario, model, tiers, settled).predictions;
  }
  function rolloutPush(entries, scenario, tiers, settled) {
    return rollout(entries, scenario, pushModel(), tiers, settled);
  }
  function predictPush(entries, scenario, tiers, settled) {
    return rolloutPush(entries, scenario, tiers, settled).predictions;
  }

  // The final timetable as training data. labels = { decided, accepted,
  // discarded, parallelOk } (uid → true).
  function finalTimetable(entries, scenario, tiers, labels) {
    const r = walk(entries, scenario, { tiers, training: true, labels: labels || {} });
    return { examples: r.examples, cancelExamples: r.cancelExamples, endOfDay: r.endOfDay };
  }
  function trainingExamples(entries, scenario, tiers, labels) {
    return finalTimetable(entries, scenario, tiers, labels).examples;
  }

  // ---------------------------------------------------------------- learning
  // Stage B: RLS with the user's noise variance σ̂² in the gain; an example
  // with weight ω counts as one with noise σ̂²/ω.
  function rlsUpdate(model, x, y, weight) {
    const P = model.P, w = model.w;
    const sigma2 = model.sigma2 != null ? model.sigma2 : SIGMA2_PRIOR;
    const Px = matVec(P, x);
    const xPx = dot(x, Px);
    const err = y - dot(w, x);
    const denom = sigma2 / weight + xPx;
    for (let i = 0; i < K; i++) w[i] += (Px[i] / denom) * err;
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) P[i][j] -= (Px[i] * Px[j]) / denom;
    // Running estimate of the user's own scatter around the model.
    const a = SIGMA2_ALPHA * weight;
    model.sigma2 = clamp((1 - a) * sigma2 + a * Math.max(0, err * err - xPx), SIGMA2_MIN, SIGMA2_MAX);
    model.n += 1;
  }

  // Stage A: one Newton step of Bayesian logistic regression (Laplace).
  function laplaceUpdate(cm, x, z, weight) {
    const S = cm.S, m = cm.m;
    const pi = sigmoid(dot(m, x));
    const v = weight * pi * (1 - pi);
    const Sx = matVec(S, x);
    const denom = 1 + v * dot(x, Sx);
    for (let i = 0; i < KA; i++) for (let j = 0; j < KA; j++) S[i][j] -= (v * Sx[i] * Sx[j]) / denom;
    const Sx2 = matVec(S, x);
    for (let i = 0; i < KA; i++) m[i] += weight * Sx2[i] * (z - pi);
    cm.n += 1;
  }

  // One finished level: all examples, then forgetting once per level (so a
  // level with 9 trains forgets as much as one with 3) and the eigenvalue cap.
  function learn(model, examples, cancelExamples) {
    (examples || []).forEach(e => {
      const w = e.weight == null ? 1 : e.weight;
      if (w > 0) rlsUpdate(model, e.x, e.y, w);
    });
    if (model.cancel) {
      (cancelExamples || []).forEach(e => {
        const w = e.weight == null ? 1 : e.weight;
        if (w > 0) laplaceUpdate(model.cancel, e.x, e.z, w);
      });
    }
    model.P = capEigen(model.P.map(r => r.map(v => v / LEVEL_FORGETTING)), B_EIG_CAP);
    if (model.cancel) model.cancel.S = capEigen(model.cancel.S.map(r => r.map(v => v / LEVEL_FORGETTING)), A_EIG_CAP);
    model.scenarios += 1;
    return model;
  }

  window.SandboxModel = {
    FEATURES, CANCEL_FEATURES, ACCEPT_WEIGHT, CANCEL_THRESHOLD, PRIOR_MEAN, CANCEL_PRIOR_MEAN,
    newModel, isValidModel, rollout, predict, rolloutPush, predictPush,
    finalTimetable, trainingExamples, learn, baseRateOf,
    toMin, toHHMM, delayMin, importanceOf, disruptionsOf, symEig, capEigen,
  };
})();
