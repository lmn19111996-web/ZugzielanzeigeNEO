// === SANDBOX LEVEL GENERATOR ===
// Picks the next level so that each one teaches the model as much as
// possible (active learning):
//
//  1. Build ~80 candidate days: a date in the next four weeks, its recurring
//     trains made conflict-free (all-day blocks left out, small overlaps
//     shifted) plus one-off trains from the logs placed into free gaps near a
//     time they were really planned at (arrangeDay), and 1–3 disrupted trains
//     (late start or longer duration, sizes drawn from your real logged
//     delays where possible). The starting plan never has an overlap.
//  2. Describe every candidate as a pattern: disruption size, time of day,
//     number of disruptions, delay vs. overrun, importance of the next train,
//     buffer after the disruption, weekday vs. weekend.
//  3. Score:  coverage    — patterns you've practised least score highest,
//             uncertainty — where the model's prediction spread is largest,
//             decisions   — the day must actually force choices.
//  4. Take the best candidate; its rarest pattern values become the "Fokus".
//
// Difficulty ramps up: levels 1–3 have one disruption, 4–8 up to two, then up
// to three.

(function () {
  'use strict';

  const SB = window.SandboxModel;
  const CANDIDATES = 80;
  // 1 = first level generator; 2 = multi-disruption + overruns; 3 = conflict-free
  // starting plan with one-off trains (arrangeDay). Stored on every level.
  const GENERATOR_VERSION = 4; // 4: no one-off that duplicates a recurring task of the day
  const HORIZON_DAYS = 28;

  const DIMENSIONS = {
    size: { S: 'kleine Störung', M: 'mittlere Störung', L: 'große Störung', XL: 'sehr große Störung' },
    time: { morning: 'am Vormittag', midday: 'am Nachmittag', evening: 'am Abend' },
    count: { 1: 'eine Störung', 2: 'zwei Störungen', 3: 'drei Störungen' },
    type: { delay: 'späterer Beginn', overrun: 'längere Dauer' },
    follower: { high: 'wichtiger Folgezug', mid: 'mittelwichtiger Folgezug', low: 'unwichtiger Folgezug' },
    slack: { tight: 'knapper Puffer', buffer: 'etwas Puffer', wide: 'viel Puffer' },
    daytype: { weekday: 'Werktag', weekend: 'Wochenende' },
  };
  const SIZE_BUCKETS = { S: [5, 15], M: [16, 45], L: [46, 120], XL: [121, 240] };
  const SIZE_WEIGHTS = { S: 0.2, M: 0.35, L: 0.3, XL: 0.15 };

  const pickWeighted = (weights, rnd) => {
    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    let r = rnd() * total;
    for (const [k, w] of Object.entries(weights)) { if ((r -= w) <= 0) return k; }
    return Object.keys(weights)[0];
  };
  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
  const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sizeBucket = (m) => (m <= 15 ? 'S' : m <= 45 ? 'M' : m <= 120 ? 'L' : 'XL');

  // Recurring timed trains of one date, from the live templates.
  function buildDay(live, ds, RealDate) {
    const [y, m, d] = ds.split('-').map(Number);
    const day = new RealDate(y, m - 1, d);
    const entries = [];
    for (const stem of live.fixedSchedule || []) {
      if (!stem || !stem._uniqueId || stem.type) continue;
      if (SB.toMin(stem.plan) == null) continue;
      if (typeof hasScheduleContent === 'function' && !hasScheduleContent(stem)) continue;
      const start = stem.startDate ? new RealDate(stem.startDate + 'T00:00:00') : new RealDate(day);
      start.setHours(0, 0, 0, 0);
      if (day < start) continue;
      if ((stem.skippedDates || []).includes(ds)) continue;
      if (stem.endDate && ds > stem.endDate) continue;
      if (!stemMatchesDate(stem, start, day)) continue;
      entries.push({
        _uniqueId: `sbx_${stem._uniqueId}_${ds}`,
        _sbxTemplateId: stem._uniqueId,
        linie: stem.linie,
        ziel: stem.ziel || '',
        plan: stem.plan,
        actual: stem.plan,
        dauer: Number(stem.dauer) || 0,
        zwischenhalte: Array.isArray(stem.zwischenhalte) ? stem.zwischenhalte.slice() : [],
        projectId: stem.projectId || undefined,
        canceled: false,
        date: ds,
        plannedDate: ds,
      });
    }
    return entries.sort((a, b) => SB.toMin(a.plan) - SB.toMin(b.plan));
  }

  // ---- arranging a conflict-free starting plan ----
  const DAY_START = 6 * 60, DAY_END = 23 * 60 + 30;
  const MAX_BLOCK = 8 * 60;   // longer = all-day background block, left out
  const MAX_SHIFT = 60;       // a recurring overlap is shifted at most this far
  const BUFFER = 5;           // minutes kept free around inserted one-offs
  const ceil5 = (m) => Math.ceil(m / 5) * 5, floor5 = (m) => Math.floor(m / 5) * 5, round5 = (m) => Math.round(m / 5) * 5;
  const byPlan = (a, b) => SB.toMin(a.plan) - SB.toMin(b.plan) || (a._uniqueId < b._uniqueId ? -1 : 1);
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  function isConflictFree(entries) {
    let frontier = -Infinity;
    for (const e of entries.slice().sort(byPlan)) {
      const s = SB.toMin(e.plan);
      if (s < frontier) return false;
      frontier = Math.max(frontier, s + Math.max(0, Number(e.dauer) || 0));
    }
    return true;
  }

  // Free intervals between the kept trains, inside [06:00, 23:30], with a
  // buffer on both sides of every train.
  function freeGaps(entries) {
    const gaps = [];
    let cursor = DAY_START;
    entries.slice().sort(byPlan).forEach(e => {
      const s = SB.toMin(e.plan), end = s + Math.max(0, Number(e.dauer) || 0);
      if (s - BUFFER > cursor) gaps.push([cursor, s - BUFFER]);
      cursor = Math.max(cursor, end + BUFFER);
    });
    if (DAY_END > cursor) gaps.push([cursor, DAY_END]);
    return gaps;
  }

  // The level's starting plan: the date's recurring trains made conflict-free,
  // plus one-off trains from the logs placed into free gaps near a time they
  // were really planned at. Returns the entries and notes on what was changed.
  function arrangeDay(recurring, oneOffs, ds, rnd) {
    const notes = [];
    const kept = [];
    let frontier = -Infinity;
    recurring.map(e => Object.assign({}, e)).sort(byPlan).forEach(e => {
      if ((Number(e.dauer) || 0) > MAX_BLOCK) { notes.push(`${e.linie} ${e.ziel}: ganztägig, weggelassen`); return; }
      let start = SB.toMin(e.plan);
      if (start < frontier) {
        const moved = ceil5(frontier);
        if (moved - start <= MAX_SHIFT && moved + (Number(e.dauer) || 0) <= 24 * 60) {
          notes.push(`${e.linie} ${e.ziel}: ${e.plan} → ${SB.toHHMM(moved)} (Überschneidung im Plan)`);
          start = moved;
          e.plan = e.actual = SB.toHHMM(start);
        } else {
          notes.push(`${e.linie} ${e.ziel}: überschneidet sich im Plan, weggelassen`);
          return;
        }
      }
      kept.push(e);
      frontier = Math.max(frontier, start + Math.max(0, Number(e.dauer) || 0));
    });

    // A one-off with the same task as a recurring train of the day (e.g.
    // "[ZF] Journaling" next to Journaling) would only be a duplicate.
    const taskName = (z) => String(z || '').replace(/\[[^\]]*\]/g, '').trim().toLowerCase();
    const recurringNames = new Set(kept.map(e => taskName(e.ziel)));
    const items = ((oneOffs && oneOffs.items) || []).filter(it => !recurringNames.has(taskName(it.ziel)));
    if (items.length) {
      const counts = oneOffs.perDayCounts && oneOffs.perDayCounts.length ? oneOffs.perDayCounts : [1];
      const k = Math.min(4, pick(counts, rnd));
      const totalW = items.reduce((s, it) => s + it.n, 0);
      const chosen = [];
      for (let tries = 0; chosen.length < k && tries < 40; tries++) {
        let r = rnd() * totalW, it = items[0];
        for (const cand of items) { if ((r -= cand.n) <= 0) { it = cand; break; } }
        if (!chosen.includes(it)) chosen.push(it);
      }
      chosen.forEach((it, i) => {
        const dauer = Number(it.dauer) || 0;
        const pref = it.plans && it.plans.length ? pick(it.plans, rnd) : 12 * 60;
        let best = null;
        freeGaps(kept).forEach(([gs, ge]) => {
          if (ge - gs < dauer) return;
          let s = round5(Math.min(Math.max(pref, gs), ge - dauer));
          if (s < gs) s = ceil5(gs);
          if (s + dauer > ge) s = floor5(ge - dauer);
          if (s < gs || s + dauer > ge) return;
          const dist = Math.abs(s - pref);
          if (!best || dist < best.dist) best = { start: s, dist };
        });
        if (!best) { notes.push(`${it.linie} ${it.ziel}: kein freier Platz, weggelassen`); return; }
        kept.push({
          _uniqueId: `sbx_once_${hash(`${it.linie}|${it.ziel}`)}_${ds}_${i}`,
          _sbxOneOff: true,
          linie: it.linie,
          ziel: it.ziel,
          plan: SB.toHHMM(best.start),
          actual: SB.toHHMM(best.start),
          dauer,
          zwischenhalte: [],
          projectId: it.projectId || undefined,
          canceled: false,
          date: ds,
          plannedDate: ds,
        });
      });
    }
    return { entries: kept.sort(byPlan), notes };
  }

  function sampleMinutes(bucket, linie, samples, rnd) {
    const [lo, hi] = SIZE_BUCKETS[bucket];
    const inBucket = samples.filter(s => s.delay >= lo && s.delay <= hi);
    const forLine = inBucket.filter(s => s.line === linie);
    const pool = forLine.length >= 3 ? forLine : inBucket;
    const raw = pool.length ? pick(pool, rnd).delay : lo + rnd() * (hi - lo);
    return Math.min(hi, Math.max(lo, Math.round(raw / 5) * 5 || lo));
  }

  function describe(entries, disruptions, tiers, ds, RealDate) {
    const byUid = new Map(entries.map(e => [e._uniqueId, e]));
    const plan = (uid) => SB.toMin(byUid.get(uid).plan);
    const main = disruptions.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    const first = disruptions.reduce((a, b) => (plan(b.uid) < plan(a.uid) ? b : a));
    const disrupted = new Set(disruptions.map(d => d.uid));
    const mainPlan = plan(main.uid);
    const mainEnd = mainPlan + (Number(byUid.get(main.uid).baseDauer) || 0);
    const follower = entries.find(e => !disrupted.has(e._uniqueId) && SB.toMin(e.plan) > mainPlan);
    const imp = follower ? SB.importanceOf(follower.linie, tiers) : 0;
    const gap = follower ? SB.toMin(follower.plan) - mainEnd : Infinity;
    const firstPlan = plan(first.uid);
    const [y, m, d] = ds.split('-').map(Number);
    const dow = new RealDate(y, m - 1, d).getDay();
    return {
      size: sizeBucket(main.minutes),
      time: firstPlan < 12 * 60 ? 'morning' : firstPlan < 17 * 60 ? 'midday' : 'evening',
      count: String(disruptions.length),
      type: disruptions.some(x => x.type === 'overrun') ? 'overrun' : 'delay',
      follower: imp >= 0.67 ? 'high' : imp > 0 ? 'mid' : 'low',
      slack: gap < 15 ? 'tight' : gap <= 60 ? 'buffer' : 'wide',
      daytype: dow === 0 || dow === 6 ? 'weekend' : 'weekday',
    };
  }

  function coverageCounts(episodes) {
    const counts = {};
    Object.keys(DIMENSIONS).forEach(dim => { counts[dim] = {}; });
    (episodes || []).forEach(ep => {
      if (!ep.pattern) return;
      Object.keys(DIMENSIONS).forEach(dim => {
        const v = ep.pattern[dim];
        if (v != null) counts[dim][v] = (counts[dim][v] || 0) + 1;
      });
    });
    return counts;
  }

  // plain = true: probe level — the first valid random candidate, no scoring,
  // so probe scores estimate error on a typical day, not on hand-picked ones.
  function generate({ live, model, tiers, episodes, samples, cancelRates, oneOffs, level, RealDate, rnd = Math.random, plain = false }) {
    const counts = coverageCounts(episodes);
    const rateOf = cancelRateLookup(cancelRates);
    const maxCount = level <= 3 ? 1 : level <= 8 ? 2 : 3;
    const today = new RealDate();
    const dayCache = new Map();
    const dates = Array.from({ length: HORIZON_DAYS }, (_, i) => dateStr(new RealDate(today.getFullYear(), today.getMonth(), today.getDate() + i)));

    const candidates = [];
    for (let attempt = 0; attempt < CANDIDATES * 3 && candidates.length < CANDIDATES; attempt++) {
      const ds = pick(dates, rnd);
      if (!dayCache.has(ds)) dayCache.set(ds, buildDay(live, ds, RealDate));
      const arranged = arrangeDay(dayCache.get(ds), oneOffs, ds, rnd);
      if (arranged.entries.length < 3 || !isConflictFree(arranged.entries)) continue;

      const entries = arranged.entries.map(e => Object.assign({}, e, { baseDauer: e.dauer }));
      const lastPlan = SB.toMin(entries[entries.length - 1].plan);
      const pool = entries.filter(e => SB.toMin(e.plan) < lastPlan);
      const k = Math.min(1 + Math.floor(rnd() * maxCount), pool.length);
      const chosen = [];
      while (chosen.length < k) {
        const e = pick(pool, rnd);
        if (!chosen.includes(e)) chosen.push(e);
      }

      const disruptions = chosen.map(e => {
        const type = rnd() < 0.3 && e.dauer > 0 ? 'overrun' : 'delay';
        const minutes = sampleMinutes(pickWeighted(SIZE_WEIGHTS, rnd), e.linie, samples || [], rnd);
        if (type === 'delay') e.actual = SB.toHHMM(SB.toMin(e.plan) + minutes);
        else e.dauer = e.dauer + minutes;
        e._sbxDisrupted = true;
        return { uid: e._uniqueId, type, minutes, linie: e.linie, ziel: e.ziel, plan: e.plan };
      });

      const disrupted = new Set(disruptions.map(d => d.uid));
      const firstPlan = Math.min(...chosen.map(e => SB.toMin(e.plan)));
      const decisions = entries.filter(e => !disrupted.has(e._uniqueId) && SB.toMin(e.plan) >= firstPlan).length;
      if (decisions < 2) continue;

      // decided starts empty: the disrupted trains' delays are givens, but
      // whether you cancel them is still a decision the model predicts.
      const scenario = {
        date: ds,
        disruptions,
        basePlan: Object.fromEntries(entries.map(e => [e._uniqueId, e.plan])),
        basePlannedDauer: Object.fromEntries(entries.map(e => [e._uniqueId, e.baseDauer])),
        baseCancelRate: Object.fromEntries(entries.map(e => [e._uniqueId, rateOf(e._sbxTemplateId, e.linie)])),
        decided: {},
      };
      const preds = SB.predict(entries, scenario, model, tiers, scenario.decided);
      const push = SB.predictPush(entries, scenario, tiers, scenario.decided);
      const predList = Object.values(preds).filter(p => !p.disrupted && p.sdMin != null);
      if (!predList.length) continue;

      const pattern = describe(entries, disruptions, tiers, ds, RealDate);
      // Novelty 1/(1+n) per dimension: an unpractised value counts 1, a value
      // seen 3 times only 0.25 — so rare patterns clearly win.
      const coverage = Object.keys(DIMENSIONS)
        .reduce((s, dim) => s + 1 / (1 + (counts[dim][pattern[dim]] || 0)), 0) / Object.keys(DIMENSIONS).length;
      // Spread grows with the disruption's size in minutes; normalise so a big
      // disruption doesn't look "uncertain" just for being big.
      const maxDisruptionH = Math.max(...disruptions.map(d => d.minutes)) / 60;
      const uncertainty = predList.reduce((s, p) => s + p.sdMin, 0) / predList.length / (1 + maxDisruptionH);
      const affected = Object.values(push).filter(p => p.minutes > 0).length;

      entries.forEach(e => { delete e.baseDauer; });
      scenario.arrangementNotes = arranged.notes;
      scenario.oneOffCount = entries.filter(e => e._sbxOneOff).length;
      candidates.push({ entries, scenario, preds, push, pattern, coverage, uncertainty, affected });
      if (plain) break; // probe level: the first valid random candidate, no scoring
    }
    if (!candidates.length) throw new Error('Kein Szenario möglich: an den nächsten 4 Wochen gibt es keinen Tag mit mindestens 3 wiederkehrenden Zügen.');

    if (plain) {
      const c = candidates[0];
      return {
        entries: c.entries,
        scenario: finalizeScenario(c.entries, c.scenario, { model, tiers, level, kind: 'probe', RealDate, pattern: c.pattern, focus: 'Testlevel · zufällig, ohne Prognose' }),
        candidatesConsidered: 1,
      };
    }

    // Rank-based scores (0…1): raw uncertainty grows with disruption size in
    // minutes and would otherwise always favour the biggest disruption.
    const rankOf = (key) => {
      const sorted = candidates.map(c => c[key]).sort((a, b) => a - b);
      return (v) => (sorted.length > 1 ? sorted.lastIndexOf(v) / (sorted.length - 1) : 1);
    };
    const covRank = rankOf('coverage'), uncRank = rankOf('uncertainty');
    const recentDates = new Set((episodes || []).slice(-5).map(ep => ep.date).filter(Boolean));
    candidates.forEach(c => {
      c.score = 0.55 * covRank(c.coverage)
        + 0.25 * uncRank(c.uncertainty)
        + 0.12 * Math.min(c.affected, 4) / 4
        - (recentDates.has(c.scenario.date) ? 0.15 : 0) // vary the day
        + 0.03 * rnd(); // tie-break / variety
    });
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));

    // Fokus = the two rarest pattern values in this level.
    const focusDims = Object.keys(DIMENSIONS)
      .map(dim => ({ dim, n: counts[dim][best.pattern[dim]] || 0 }))
      .sort((a, b) => a.n - b.n)
      .slice(0, 2);
    const focus = focusDims.map(f => DIMENSIONS[f.dim][best.pattern[f.dim]]).join(' · ');

    const scenario = finalizeScenario(best.entries, best.scenario, { model, tiers, level, kind: 'active', RealDate, pattern: best.pattern, focus });
    scenario.modelUncertaintyMin = Math.round(best.uncertainty);
    return { entries: best.entries, scenario, candidatesConsidered: candidates.length };
  }

  // Smoothed historical cancel rate per template: template → line → global,
  // each shrunk toward the next with 5 pseudo-observations.
  function cancelRateLookup(rates) {
    const r = rates || {};
    const g = r.global && r.global.n ? (r.global.c + 1) / (r.global.n + 2) : 0.1;
    return (templateId, linie) => {
      const l = (r.byLine && r.byLine[linie]) || { n: 0, c: 0 };
      const lineRate = (l.c + 5 * g) / (l.n + 5);
      const t = (r.byTemplate && templateId && r.byTemplate[templateId]) || { n: 0, c: 0 };
      return (t.c + 5 * lineRate) / (t.n + 5);
    };
  }

  // Everything a level needs besides its trains: id, type, the initial model
  // and push predictions (what the level is scored against), their predicted
  // end of day, and a full snapshot of the starting day so the level can be
  // replayed or recomputed exactly later.
  function finalizeScenario(entries, scenario, { model, tiers, level, kind, RealDate, pattern, focus, replayOf }) {
    // Delay "if kept" for every non-disrupted train, even where the model
    // predicts a cancellation — stage B is scored on the trains you kept.
    const toMinutes = (preds) => Object.fromEntries(Object.entries(preds).filter(([, p]) => !p.disrupted).map(([u, p]) => [u, p.minutes]));
    const m = SB.rollout(entries, scenario, model, tiers, scenario.decided);
    const p = SB.rolloutPush(entries, scenario, tiers, scenario.decided);
    return Object.assign(scenario, {
      id: 'sc_' + new RealDate().getTime(),
      level,
      kind,                       // 'active' | 'probe' | 'replay'
      blind: kind !== 'active',   // probes and replays hide predictions
      replayOf: replayOf || null,
      createdAt: new RealDate().toISOString(),
      seq: 0,
      pattern,
      focus,
      accepted: {},
      discarded: {},
      parallelOk: {},
      modelScenariosAtStart: model.scenarios,
      // The line ranking in force when the level was made: cost groups must be
      // rebuilt with the ranking of the time if lines get re-ranked later.
      lineRanking: Array.isArray(tiers) ? tiers.map(t => (Array.isArray(t) ? t.slice() : [])) : [],
      generatorVersion: GENERATOR_VERSION,
      initialPredictions: toMinutes(m.predictions),
      pushPredictions: toMinutes(p.predictions),
      initialCancel: m.cancelPredictions,       // uid → P(cancel) at level start
      initialEndOfDay: m.endOfDay,
      pushEndOfDay: p.endOfDay,
      baseDay: entries.map(e => ({
        uid: e._uniqueId, templateId: e._sbxTemplateId || null, linie: e.linie, ziel: e.ziel,
        plan: e.plan, actual: e.actual, dauer: e.dauer,
        zwischenhalte: Array.isArray(e.zwischenhalte) ? e.zwischenhalte.slice() : [],
        projectId: e.projectId || null, disrupted: !!e._sbxDisrupted, oneOff: !!e._sbxOneOff,
        cancelRate: scenario.baseCancelRate ? scenario.baseCancelRate[e._uniqueId] : null,
      })),
    });
  }

  // Rebuild an earlier probe level exactly (same date, trains, disruptions) —
  // used to measure how consistent the user is with themselves.
  function replayLevel({ episode, model, tiers, level, RealDate }) {
    const base = episode.baseDay || [];
    if (!base.length || !Array.isArray(episode.disruptions) || !episode.disruptions.length) {
      throw new Error('Wiederholung nicht möglich: Level ohne Momentaufnahme.');
    }
    const entries = base.map(b => ({
      _uniqueId: b.uid,
      _sbxTemplateId: b.templateId || undefined,
      linie: b.linie,
      ziel: b.ziel || '',
      plan: b.plan,
      actual: b.actual,
      dauer: Number(b.dauer) || 0,
      zwischenhalte: Array.isArray(b.zwischenhalte) ? b.zwischenhalte.slice() : [],
      projectId: b.projectId || undefined,
      canceled: false,
      date: episode.date,
      plannedDate: episode.date,
      ...(b.disrupted ? { _sbxDisrupted: true } : {}),
      ...(b.oneOff ? { _sbxOneOff: true } : {}),
    }));
    const disruptions = episode.disruptions.map(d => Object.assign({}, d));
    // Base planned values come from the templates, i.e. before the disruption.
    const plannedDauer = (b) => {
      const d = disruptions.find(x => x.uid === b.uid && x.type === 'overrun');
      return (Number(b.dauer) || 0) - (d ? d.minutes : 0);
    };
    const scenario = {
      date: episode.date,
      disruptions,
      basePlan: Object.fromEntries(base.map(b => [b.uid, b.plan])),
      basePlannedDauer: Object.fromEntries(base.map(b => [b.uid, plannedDauer(b)])),
      baseCancelRate: Object.fromEntries(base.map(b => [b.uid, b.cancelRate != null ? b.cancelRate : null])),
      decided: {},
    };
    const finalized = finalizeScenario(entries, scenario, {
      model, tiers, level, kind: 'replay', RealDate,
      pattern: episode.pattern || null,
      focus: 'Testlevel · Wiederholung eines früheren Testlevels',
      replayOf: episode.scenarioId,
    });
    return { entries, scenario: finalized };
  }

  // A finished level's final timetable, rebuilt from its stored snapshot
  // (base day + final state). Used to retrain the model from scratch — e.g.
  // after a level is discarded — and by scripts/sandbox-pretrain.js.
  // Returns null for levels without a complete snapshot.
  function levelFromEpisode(ep, rateOf) {
    if (!ep || !Array.isArray(ep.baseDay) || !ep.baseDay.length || !Array.isArray(ep.final) || !ep.labelState) return null;
    // Trains marked as data errors are left out of the level entirely.
    if (Array.isArray(ep.excludedTrains) && ep.excludedTrains.length) {
      const ex = new Set(ep.excludedTrains);
      ep = Object.assign({}, ep, { baseDay: ep.baseDay.filter(b => !ex.has(b.uid)), final: ep.final.filter(t => !ex.has(t.uid)) });
    }
    const fin = new Map(ep.final.map(t => [t.uid, t]));
    const entries = ep.baseDay.map(b => {
      const f = fin.get(b.uid) || {};
      return {
        _uniqueId: b.uid, linie: b.linie, ziel: b.ziel, plan: b.plan,
        actual: f.actual != null ? f.actual : b.actual,
        dauer: f.dauer != null ? f.dauer : b.dauer,
        canceled: !!f.canceled, date: ep.date,
      };
    });
    const rate = (b) => (ep.baseCancelRate && ep.baseCancelRate[b.uid] != null ? ep.baseCancelRate[b.uid]
      : b.cancelRate != null ? b.cancelRate : rateOf ? rateOf(b.templateId, b.linie) : null);
    const scenario = {
      date: ep.date,
      disruptions: ep.disruptions || [],
      basePlan: Object.fromEntries(ep.baseDay.map(b => [b.uid, b.plan])),
      basePlannedDauer: ep.basePlannedDauer || Object.fromEntries(ep.baseDay.map(b => [b.uid, b.dauer])),
      baseCancelRate: Object.fromEntries(ep.baseDay.map(b => [b.uid, rate(b)])),
      decided: {},
    };
    return { entries, scenario, labels: ep.labelState };
  }

  // Replay finished levels (oldest first, discarded ones skipped) onto a
  // model — the exact way they were learned when played.
  function replayEpisodes(model, episodes, tiers, rateOf) {
    let used = 0;
    (episodes || []).filter(ep => !ep.discarded)
      .slice().sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')))
      .forEach(ep => {
        const lvl = levelFromEpisode(ep, rateOf);
        if (!lvl) return;
        const f = SB.finalTimetable(lvl.entries, lvl.scenario, tiers, lvl.labels);
        SB.learn(model, f.examples, f.cancelExamples);
        used++;
      });
    return used;
  }

  window.SandboxLevels = { generate, replayLevel, buildDay, arrangeDay, isConflictFree, describe, coverageCounts, cancelRateLookup, levelFromEpisode, replayEpisodes, DIMENSIONS };
})();
