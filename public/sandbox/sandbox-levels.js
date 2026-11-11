// === SANDBOX LEVEL GENERATOR (v5) ===
// Every level is a realistic disrupted day; which one is chosen depends on
// what the cost model (public/sandbox/engine/) is still missing.
//
//  1. Candidate days: a date in the next four weeks, its recurring trains made
//     conflict-free (all-day blocks left out, small overlaps shifted) plus
//     one-off trains from the logs placed into free gaps near a time they were
//     really planned at (arrangeDay; never a one-off that duplicates a
//     recurring task of the day).
//  2. Disruptions as in your real days (/api/sandbox/disruption-stats):
//       how many  — drawn from your real days with at least one disruption
//                   (at most MAX_DISRUPTIONS)
//       which     — a train is picked in proportion to how often it (its
//                   template, else task family, else line) really starts
//                   late without an earlier train explaining it; trains whose
//                   own history has no late start are rarely picked, and then
//                   only a little late (5–15 min)
//       how much  — a late start drawn from that train's real late starts
//                   (template → task family → line → all), capped at the
//                   pool's 90th percentile and at MAX_LATE; an overrun
//                   only where the logs contain overruns for that line
//     A day must force a decision: push has to move at least one other train.
//  3. Choice (active levels): for every candidate day the model's candidate
//     timetables are built and scored on what the model is missing —
//       uncertainty — several timetables cost about the same to the model
//       unknown     — trains the model has seen in few decisions so far
//       contrast    — trains that never competed for the same time before
//     ranked across candidates and combined. Every RANDOM_EVERY-th level is a
//     random realistic day instead (unbiased test of the model).
//
// Practice mode (toggle in the sandbox bar): days where a fixed appointment
// is at stake (10-45 min late to it); among them the one where the model is
// least sure whether you would attend late or skip.
//
// The level stores the model's prediction at the start (what it is scored
// against), push, and a full snapshot of the starting day — including each
// train's task family and whether it marks the start of the day
// (baseDay[].family / .dayStart / .appointment, from the settings).
// Fixed appointments are only ever disrupted by arriving late (it ends as
// planned, disruptions[].fixedEnd), never by a late start or an overrun.

(function () {
  'use strict';

  const M = window.SbxCostModel, P = window.SbxPatterns;
  const GENERATOR_VERSION = 5;
  const HORIZON_DAYS = 28;
  const CANDIDATE_DAYS = 24;
  const RANDOM_EVERY = 4;
  const MAX_DISRUPTIONS = 3;
  const MAX_LATE = 180;

  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const toHHMM = (min) => { const v = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; };
  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
  const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const byPlan = (a, b) => toMin(a.plan) - toMin(b.plan) || (a._uniqueId < b._uniqueId ? -1 : 1);
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  // Recurring timed trains of one date, from the live templates.
  function buildDay(live, ds, RealDate) {
    const [y, m, d] = ds.split('-').map(Number);
    const day = new RealDate(y, m - 1, d);
    const entries = [];
    for (const stem of live.fixedSchedule || []) {
      if (!stem || !stem._uniqueId || stem.type) continue;
      if (toMin(stem.plan) == null) continue;
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
    return entries.sort(byPlan);
  }

  // ---- arranging a conflict-free starting plan ----
  const DAY_START = 6 * 60, DAY_END = 23 * 60 + 30;
  const MAX_BLOCK = 8 * 60;   // longer = all-day background block, left out
  const MAX_SHIFT = 60;       // a recurring overlap is shifted at most this far
  const BUFFER = 5;           // minutes kept free around inserted one-offs
  const ceil5 = (m) => Math.ceil(m / 5) * 5, floor5 = (m) => Math.floor(m / 5) * 5, round5 = (m) => Math.round(m / 5) * 5;

  function isConflictFree(entries) {
    let frontier = -Infinity;
    for (const e of entries.slice().sort(byPlan)) {
      const s = toMin(e.plan);
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
      const s = toMin(e.plan), end = s + Math.max(0, Number(e.dauer) || 0);
      if (s - BUFFER > cursor) gaps.push([cursor, s - BUFFER]);
      cursor = Math.max(cursor, end + BUFFER);
    });
    if (DAY_END > cursor) gaps.push([cursor, DAY_END]);
    return gaps;
  }

  // The date's recurring trains made conflict-free, plus one-off trains from
  // the logs placed into free gaps near a time they were really planned at.
  function arrangeDay(recurring, oneOffs, ds, rnd) {
    const notes = [];
    const kept = [];
    let frontier = -Infinity;
    recurring.map(e => Object.assign({}, e)).sort(byPlan).forEach(e => {
      if ((Number(e.dauer) || 0) > MAX_BLOCK) { notes.push(`${e.linie} ${e.ziel}: ganztägig, weggelassen`); return; }
      let start = toMin(e.plan);
      if (start < frontier) {
        const moved = ceil5(frontier);
        if (moved - start <= MAX_SHIFT && moved + (Number(e.dauer) || 0) <= 24 * 60) {
          notes.push(`${e.linie} ${e.ziel}: ${e.plan} → ${toHHMM(moved)} (Überschneidung im Plan)`);
          start = moved;
          e.plan = e.actual = toHHMM(start);
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
          plan: toHHMM(best.start),
          actual: toHHMM(best.start),
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

  // ---- realistic disruptions ----
  // familyOf(entry) → task family key (from the settings), for the lookup
  // template (≥ 5 days) → family (≥ 5 days) → line → everything.
  function disruptionModel(stats, familyOf) {
    const st = stats || {};
    const byT = st.byTemplate || {}, byF = st.byFamily || {}, byL = st.byLine || {};
    const lines = Object.values(byL);
    const allN = lines.reduce((s, x) => s + x.n, 0), allLate = lines.reduce((s, x) => s + x.late.length, 0);
    const globalRate = allN ? allLate / allN : 0.15;
    const globalLate = lines.flatMap(x => x.late);
    // The train's own history (template, else task family; ≥ 5 recorded days),
    // or — only for trains without one — its line.
    const statsOf = (e) => {
      const t = e._sbxTemplateId && byT[e._sbxTemplateId];
      if (t && t.n >= 5) return { s: t, own: true };
      const fk = e._sbxTemplateId && familyOf ? familyOf(e) : null;
      const f = fk && byF[fk];
      if (f && f.n >= 5) return { s: f, own: true };
      return byL[e.linie] ? { s: byL[e.linie], own: false } : null;
    };
    const perDay = (st.perDay || []).filter(k => k >= 1);
    return {
      // Late-start rate with 2 pseudo-observations at the overall rate: a
      // train whose own history has no late start (e.g. a class) is rarely
      // picked.
      rate: (e) => { const x = statsOf(e); return x ? (x.s.late.length + 2 * globalRate) / (x.s.n + 2) : globalRate; },
      count: (rnd) => Math.min(MAX_DISRUPTIONS, perDay.length ? pick(perDay, rnd) : 1),
      // Fixed appointment: mostly 5–20 min late; sometimes so late that
      // skipping becomes the question. Always leaves at least 5 min of it.
      lateArrival: (e, rnd) => {
        const dur = Number(e.dauer) || 0;
        if (dur < 15) return null;
        const m = rnd() < 0.8 ? pick([5, 10, 15, 20], rnd) : pick([30, 45, 60, 90], rnd);
        return { type: 'delay', fixedEnd: true, minutes: Math.min(m, dur - 5) };
      },
      disrupt: (e, rnd) => {
        const x = statsOf(e);
        const s = x ? x.s : { late: [], overrun: [] };
        const over = (s.overrun || []).length >= 3 ? s.overrun : [];
        const overShare = over.length / Math.max(1, over.length + s.late.length);
        if (over.length && (Number(e.dauer) || 0) > 0 && rnd() < overShare) {
          const o = pick(over, rnd);
          const minutes = Math.max(10, Math.min(e.dauer, 120, round5((o.minutes / Math.max(1, o.planned)) * e.dauer)));
          return { type: 'overrun', minutes };
        }
        // Size from the train's own late starts; with its own history but no
        // late start in it, only a little late (5–15 min) — never sizes
        // borrowed from another task of the line.
        let pool;
        if (s.late.length >= 3 || (x && x.own && s.late.length)) pool = s.late;
        else if (x && x.own) pool = [5, 10, 15];
        else pool = globalLate;
        // Typical, not extreme: capped at the pool's 90th percentile.
        const sorted = pool.slice().sort((a, b) => a - b);
        const p90 = sorted.length >= 5 ? sorted[Math.floor(0.9 * (sorted.length - 1))] : Infinity;
        const raw = pool.length ? Math.min(pick(pool, rnd), p90) : 30;
        return { type: 'delay', minutes: Math.max(5, Math.min(MAX_LATE, round5(raw))) };
      },
    };
  }

  // Weighted pick of k distinct entries.
  function pickWeighted(entries, weightOf, k, rnd) {
    const pool = entries.slice(), out = [];
    while (out.length < k && pool.length) {
      const w = pool.map(weightOf), total = w.reduce((s, x) => s + x, 0);
      let r = rnd() * total, i = 0;
      for (; i < pool.length - 1; i++) { if ((r -= w[i]) <= 0) break; }
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  // The open level as an episode-like record (for the engine), with the
  // trains as they stand now.
  function episodeOf(scenario, entries) {
    return Object.assign({}, scenario, {
      final: (entries || []).filter(t => scenario.basePlan[t._uniqueId] != null)
        .map(t => ({ uid: t._uniqueId, plan: t.plan, actual: t.actual, dauer: Number(t.dauer) || 0, canceled: !!t.canceled })),
    });
  }

  // True if no disrupted train would already be pushed by the disruptions
  // planned before it (checked one by one, with the later ones undone).
  function independentDisruptions(scenario, entries, ranking) {
    const ds = scenario.disruptions.slice().sort((a, b) => toMin(scenario.basePlan[a.uid]) - toMin(scenario.basePlan[b.uid]));
    for (let i = 1; i < ds.length; i++) {
      const earlier = new Set(ds.slice(0, i).map(d => d.uid));
      const target = ds[i].uid;
      const baseDay = scenario.baseDay.map(b => (earlier.has(b.uid) ? b : Object.assign({}, b, {
        actual: b.plan, dauer: Number(scenario.basePlannedDauer[b.uid]) || 0, disrupted: false,
      })));
      const ep = Object.assign({}, scenario, {
        baseDay, disruptions: ds.slice(0, i),
        final: baseDay.map(b => ({ uid: b.uid, actual: b.actual, dauer: b.dauer, canceled: false })),
      });
      const push = M.pushTimetable(M.levelFromEpisode(ep, ranking));
      if (push.starts[target] != null && push.starts[target] > toMin(scenario.basePlan[target]) + 0.5) return false;
    }
    return true;
  }

  // ---- generation ----
  // roles(tpl) → { family, dayStart, appointment } for a recurring template, from the
  // settings (task families, day-start marking); stored on every level.
  // practice = 'appointments': practice mode for fixed appointments (see
  // PRACTICE below); test levels stay random.
  function generate({ live, stats, oneOffs, episodes, trained, tiers, roles, practice, level, RealDate, rnd = Math.random }) {
    const roleOf = (e) => (e._sbxTemplateId && roles ? roles({ templateId: e._sbxTemplateId, linie: e.linie, ziel: e.ziel }) : { family: null, dayStart: false, appointment: false });
    const random = level % RANDOM_EVERY === 0;
    const practicing = practice === 'appointments' && !random;
    const model = M.modelFromJSON(trained && trained.model);
    const patterns = P.patternsFromJSON(trained && trained.patterns);
    const dm = disruptionModel(stats, (e) => roleOf(e).family || P.autoFamily({ linie: e.linie, ziel: e.ziel }));
    const ranking = Array.isArray(tiers) ? tiers.map(t => (Array.isArray(t) ? t.slice() : [])) : [];
    const today = new RealDate();
    const dates = Array.from({ length: HORIZON_DAYS }, (_, i) => dateStr(new RealDate(today.getFullYear(), today.getMonth(), today.getDate() + i)));
    const dayCache = new Map();

    const candidates = [];
    const target = random ? 1 : CANDIDATE_DAYS;
    for (let attempt = 0; attempt < target * 6 && candidates.length < target; attempt++) {
      const ds = pick(dates, rnd);
      if (!dayCache.has(ds)) dayCache.set(ds, buildDay(live, ds, RealDate));
      const arranged = arrangeDay(dayCache.get(ds), oneOffs, ds, rnd);
      const entries = arranged.entries;
      if (entries.length < 3 || !isConflictFree(entries)) continue;

      const plannedDauer = Object.fromEntries(entries.map(e => [e._uniqueId, Number(e.dauer) || 0]));
      const lastPlan = toMin(entries[entries.length - 1].plan);
      const pool = entries.filter(e => toMin(e.plan) < lastPlan);
      // A fixed appointment never starts late or overruns: you arrive late,
      // it ends as planned.
      const planned = practicing
        ? practiceDisruption(entries, roleOf, rnd)
        : pickWeighted(pool, dm.rate, Math.min(dm.count(rnd), pool.length), rnd)
          .map(e => ({ e, d: roleOf(e).appointment ? dm.lateArrival(e, rnd) : dm.disrupt(e, rnd) }));
      if (!planned || !planned.length) continue;
      const disruptions = [];
      let fits = true;
      planned.forEach(({ e, d }) => {
        if (!d) { fits = false; return; }
        if (d.fixedEnd) {
          e.actual = toHHMM(toMin(e.plan) + d.minutes);
          e.plannedDauer = Number(e.dauer) || 0;
          e.dauer = e.plannedDauer - d.minutes;
          e._sbxDisrupted = true;
          disruptions.push({ uid: e._uniqueId, type: 'delay', fixedEnd: true, minutes: d.minutes, linie: e.linie, ziel: e.ziel, plan: e.plan });
          return;
        }
        const start = toMin(e.plan) + (d.type === 'delay' ? d.minutes : 0);
        const dur = (Number(e.dauer) || 0) + (d.type === 'overrun' ? d.minutes : 0);
        if (start + dur > 24 * 60) { fits = false; return; }
        if (d.type === 'delay') e.actual = toHHMM(start);
        else { e.plannedDauer = Number(e.dauer) || 0; e.dauer = dur; } // the editor shows plan and actual end
        e._sbxDisrupted = true;
        disruptions.push({ uid: e._uniqueId, type: d.type, minutes: d.minutes, linie: e.linie, ziel: e.ziel, plan: e.plan });
      });
      if (!fits || !disruptions.length) continue;

      const scenario = {
        version: 2,
        date: ds,
        disruptions,
        basePlan: Object.fromEntries(entries.map(e => [e._uniqueId, e.plan])),
        basePlannedDauer: plannedDauer,
        lineRanking: ranking,
        baseDay: entries.map(e => ({
          uid: e._uniqueId, templateId: e._sbxTemplateId || null, linie: e.linie, ziel: e.ziel,
          plan: e.plan, actual: e.actual, dauer: Number(e.dauer) || 0,
          zwischenhalte: Array.isArray(e.zwischenhalte) ? e.zwischenhalte.slice() : [],
          projectId: e.projectId || null, disrupted: !!e._sbxDisrupted, oneOff: !!e._sbxOneOff,
          family: roleOf(e).family || null,
          dayStart: !!roleOf(e).dayStart,
          appointment: !!roleOf(e).appointment,
        })),
        rolesApplied: true,
        arrangementNotes: arranged.notes,
        oneOffCount: entries.filter(e => e._sbxOneOff).length,
      };
      // Every disruption must stand on its own: a disrupted train that an
      // earlier disruption already pushes would read as knock-on, not as a
      // disruption of its own (its late start would be ambiguous).
      if (!independentDisruptions(scenario, entries, ranking)) continue;
      const lvl = M.levelFromEpisode(episodeOf(scenario, entries), ranking);
      // The day must force a decision: push moves at least one other train.
      const push = M.pushTimetable(lvl);
      const pushed = Object.entries(push.starts).filter(([uid, s]) => !disruptions.some(d => d.uid === uid) && s > toMin(scenario.basePlan[uid]) + 0.5).length;
      // (In practice mode the decision is attend-late vs. skip, which needs no push.)
      if (!pushed && !practicing) continue;
      let stake = null;
      if (practicing) {
        stake = appointmentAtStake(scenario, push);
        if (!stake) continue;
      }
      const problem = M.choiceProblem(lvl, { patterns, use: M.ALL_PATTERNS });
      const info = M.informationOf(problem, model, trained && trained.stats);
      candidates.push({ entries, scenario, push, problem, info, stake });
    }
    if (!candidates.length) throw new Error('Kein Szenario möglich: in den nächsten 4 Wochen gibt es keinen Tag mit mindestens 3 Zügen, an dem eine Störung etwas verschiebt.');

    let best = candidates[0];
    if (practicing) {
      // The day where the model is least sure whether you would attend or skip.
      const recent = new Set((episodes || []).slice(-5).map(ep => ep.date).filter(Boolean));
      candidates.forEach(c => {
        const cs = c.info.choice.costs, m = Math.min(...cs);
        const w = cs.map(x => Math.exp(-(x - m))), Z = w.reduce((a, b) => a + b, 0);
        c.stake.pSkip = c.problem.candidates.reduce((sum, cand, i) => sum + (cand.cancels.has(c.stake.uid) ? w[i] / Z : 0), 0);
        c.parts = { practice: 1 - 2 * Math.abs(c.stake.pSkip - 0.5) };
        c.score = c.parts.practice - (recent.has(c.scenario.date) ? 0.15 : 0) + 0.05 * rnd();
      });
      best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    } else if (!random) {
      const rankOf = (key) => {
        const vals = candidates.map(c => c.info[key]).sort((a, b) => a - b);
        return (v) => (vals.length > 1 ? vals.lastIndexOf(v) / (vals.length - 1) : 1);
      };
      const rU = rankOf('uncertainty'), rK = rankOf('unknown'), rC = rankOf('contrast');
      const recent = new Set((episodes || []).slice(-5).map(ep => ep.date).filter(Boolean));
      candidates.forEach(c => {
        c.parts = { uncertainty: 0.4 * rU(c.info.uncertainty), unknown: 0.35 * rK(c.info.unknown), contrast: 0.25 * rC(c.info.contrast) };
        c.score = c.parts.uncertainty + c.parts.unknown + c.parts.contrast - (recent.has(c.scenario.date) ? 0.15 : 0) + 0.02 * rnd();
      });
      best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    }
    return { entries: best.entries, scenario: finalize(best, { level, random, practice: practicing ? practice : null, trained, RealDate }) };
  }

  // ---- practice mode: fixed appointments ----
  // Days where a fixed appointment is at stake: you would be PRACTICE_LATE
  // min late to it, either because you arrive late yourself, or because the
  // train before it starts late. Each answer refines from how late on you skip.
  const PRACTICE_LATE = [10, 15, 20, 25, 30, 35, 40, 45];

  function practiceDisruption(entries, roleOf, rnd) {
    const appts = entries.filter(e => roleOf(e).appointment && (Number(e.dauer) || 0) >= 30);
    if (!appts.length) return null;
    const a = pick(appts, rnd);
    const late = pick(PRACTICE_LATE, rnd);
    const aPlan = toMin(a.plan);
    const before = entries.filter(e => e !== a && !roleOf(e).appointment && toMin(e.plan) + (Number(e.dauer) || 0) <= aPlan)
      .sort((x, y) => (toMin(y.plan) + (Number(y.dauer) || 0)) - (toMin(x.plan) + (Number(x.dauer) || 0)))[0];
    // mostly the richer case: the train before runs late (shorten it, join
    // late or skip); otherwise you simply arrive late (attend or skip)
    if (before && rnd() < 0.7) {
      // the train before starts late enough to make you `late` minutes late
      const gap = aPlan - (toMin(before.plan) + (Number(before.dauer) || 0));
      const minutes = gap + late;
      if (minutes <= 120 && toMin(before.plan) + minutes + (Number(before.dauer) || 0) <= 24 * 60) return [{ e: before, d: { type: 'delay', minutes } }];
    }
    return [{ e: a, d: { type: 'delay', fixedEnd: true, minutes: Math.min(late, (Number(a.dauer) || 0) - 5) } }];
  }

  function appointmentAtStake(scenario, push) {
    let best = null;
    scenario.baseDay.forEach(b => {
      if (!b.appointment) return;
      const d = scenario.disruptions.find(x => x.uid === b.uid);
      const plan = toMin(b.plan), dur = Number(scenario.basePlannedDauer[b.uid]) || 0;
      const late = d ? (d.fixedEnd ? d.minutes : null) : (push.starts[b.uid] != null ? push.starts[b.uid] - plan : null);
      if (late == null || late < 10 || late > 45 || late >= dur) return;
      if (!best || Math.abs(late - 25) < Math.abs(best.late - 25)) best = { uid: b.uid, late, name: `${b.linie} ${b.ziel}` };
    });
    return best;
  }

  // Why this level: the strongest of its selection reasons, in words.
  function focusText(c, random, trained) {
    if (random) return 'Testlevel · zufälliger realistischer Tag';
    if (c.stake) return `Übung Feste Termine: ${c.stake.name} · ${Math.round(c.stake.late)} min zu spät — gehst du noch hin? (Nichts tun = ja, ausfallen lassen = nein)`;
    const seen = (trained && trained.stats && trained.stats.taskSeen) || {};
    const base = new Map(c.scenario.baseDay.map(b => [b.uid, b]));
    const dec = c.problem.framing.decision.map(x => base.get(x.uid)).filter(Boolean);
    const top = Object.entries(c.parts).sort((a, b) => b[1] - a[1])[0][0];
    if (top === 'unknown') {
      const rare = dec.slice().sort((a, b) => (seen[M.taskKeyOf(a)] || 0) - (seen[M.taskKeyOf(b)] || 0))[0];
      return rare ? `Neu fürs Modell: ${rare.linie} ${rare.ziel}` : 'Wenig bekannte Züge';
    }
    if (top === 'contrast') return 'Neue Kombination von Zügen';
    return `Modell unsicher · ${Math.max(2, Math.round(Math.exp(c.info.uncertainty)))} Varianten fast gleich gut`;
  }

  function finalize(c, { level, random, practice, trained, RealDate }) {
    const initial = M.timetableOf(c.info.choice.cand, { entropy: c.info.choice.entropy });
    return Object.assign(c.scenario, {
      id: 'sc_' + new RealDate().getTime(),
      level,
      kind: random ? 'random' : 'active',
      practice: practice || null,
      createdAt: new RealDate().toISOString(),
      generatorVersion: GENERATOR_VERSION,
      modelLevels: trained ? trained.levels : 0,
      selection: random ? null : { score: c.score, parts: c.parts, uncertainty: c.info.uncertainty, unknown: c.info.unknown, contrast: c.info.contrast, stake: c.stake || null },
      focus: focusText(c, random, trained),
      initialPrediction: initial,
      pushPrediction: c.push,
      fixed: {},
      seq: 0,
    });
  }

  window.SandboxLevels = { generate, buildDay, arrangeDay, isConflictFree, episodeOf, disruptionModel, toMin, toHHMM, GENERATOR_VERSION, RANDOM_EVERY };
})();
