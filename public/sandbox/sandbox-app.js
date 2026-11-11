// === SANDBOX APP (level mode, cost model) ===
// Runs inside /sandbox.html after the normal app has booted.
//
// Game loop: every level is a realistic disrupted day chosen by the system
// (sandbox-levels.js) according to what the model is still missing. You
// resolve the day with the normal editor, the way you really would. "Fertig"
// stores your final timetable; the server refits the cost model on all levels
// (sandbox-trainer.js) and the next level is generated with the new model.
//
// Live prediction: the model (public/sandbox/engine/) picks, among the
// candidate timetables of the day, the cheapest one that agrees with what you
// have already decided — every train you moved, shortened or cancelled, and
// every train you confirmed as it is (tap its planned time). Its proposal for
// the remaining trains shows as yellow pills (tap = take it over) and in the
// right occupancy column. It updates after every change.
//
// Level types: active (chosen by information value) and random (every 4th:
// a random realistic day — the unbiased test of the model; its proposals
// stay hidden until "Fertig", then a reveal compares). Each level is
// scored against the model's prediction at the START of the level, made
// with the model trained on earlier levels only.
//
// The train list, editor drawer and all editing behaviour are the unmodified
// app; nothing here touches live data (see sandbox-shim.js).

(function () {
  'use strict';

  const M = window.SbxCostModel, P = window.SbxPatterns, LV = window.SandboxLevels;
  const sbx = window.__sbx;
  if (!M || !P || !LV || !sbx) { console.error('[sandbox] engine, levels or shim missing'); return; }

  const api = async (p, opts) => {
    const res = await sbx.realFetch('/api/sandbox/' + p, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!res.ok) {
      let msg = `Sandbox-API ${p}: ${res.status}`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* keep status */ }
      throw new Error(msg);
    }
    return res.json();
  };
  const putJson = (p, body) => api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const postJson = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  let scenario = sbx.bootState.scenario || null;
  let trained = null;            // sandbox_data/cost-model.json
  let model = new M.CostModel(); // costs from `trained`
  let problem = null;            // the open level's candidate timetables
  let live = null;               // { cand, exact } — current proposal
  let overlaps = [];             // uids of kept trains that overlap an earlier one
  let reviewMode = false;        // "Fertig" pressed once while overlaps exist
  let busy = false;
  let generationError = null;
  const pendingAccept = new Set();

  // Practice mode ("Übung: Feste Termine"): remembered per browser, applies
  // from the next level on. Storage may be unavailable; then it is just off.
  const PRACTICE_KEY = 'sbxPracticeMode';
  let practiceMode = (() => { try { return localStorage.getItem(PRACTICE_KEY) === 'appointments'; } catch (e) { return false; } })();
  function togglePractice() {
    practiceMode = !practiceMode;
    try { localStorage.setItem(PRACTICE_KEY, practiceMode ? 'appointments' : ''); } catch (e) { /* not remembered */ }
    updatePanel();
  }

  const tiers = () => (window.PredictionModel ? window.PredictionModel.getSettings().lineImportance : []);
  // Task family + day-start marking of a recurring template, from the settings.
  const roles = (tpl) => {
    const PM = window.PredictionModel;
    if (!PM || !PM.getTaskFamily) return { family: null, dayStart: false, appointment: false };
    const s = PM.getSettings();
    return { family: PM.getTaskFamily(tpl, s), dayStart: PM.isDayStartTemplate(tpl, s), appointment: !!(PM.isAppointmentTemplate && PM.isAppointmentTemplate(tpl, s)) };
  };
  const dayEntries = () => (typeof schedule !== 'undefined' && schedule && schedule.spontaneousEntries) || [];
  const realNow = () => new sbx.RealDate();
  const toMin = LV.toMin, toHHMM = LV.toHHMM;
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const fmtMin = (x) => (x == null ? '–' : `${x.toFixed(1).replace('.', ',')} min`);
  const fmt1 = (v) => (v == null ? '–' : v.toFixed(1).replace('.', ','));
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const fmtDate = (ds) => {
    const [y, m, d] = ds.split('-').map(Number);
    const dt = new sbx.RealDate(y, m - 1, d);
    return `${WD[dt.getDay()]}, ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
  };
  const isTest = () => !!(scenario && scenario.kind === 'random');
  const disruptedSet = () => new Set(scenario ? (scenario.disruptions || []).map(d => d.uid) : []);
  const baseOf = (uid) => (scenario && scenario.baseDay || []).find(b => b.uid === uid) || null;

  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(c => { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  // ===================== model =====================

  function useTrained(t) {
    trained = t || null;
    model = M.modelFromJSON(trained && trained.model);
    problem = null;
  }
  const levelNow = () => M.levelFromEpisode(LV.episodeOf(scenario, dayEntries()), tiers());

  function ensureProblem() {
    if (problem || !scenario || scenario.finished) return problem;
    const lvl = levelNow();
    if (!lvl) return null;
    problem = M.choiceProblem(lvl, { patterns: P.patternsFromJSON(trained && trained.patterns), use: M.ALL_PATTERNS });
    return problem;
  }

  // Trains you have decided: everything after the first disruption that you
  // cancelled, moved or resized, or confirmed as it is.
  function currentState(t) {
    const plan = toMin(scenario.basePlan[t._uniqueId]);
    return { cancel: !!t.canceled, start: plan + delayMin(plan, t.actual), dur: Number(t.dauer) || 0 };
  }
  function delayMin(plan, actual) { const a = toMin(actual); if (a == null || plan == null) return 0; let d = a - plan; if (d < -720) d += 1440; if (d > 720) d -= 1440; return d; }
  function decidedNow() {
    const fixed = {};
    if (!problem) return fixed;
    const byUid = new Map(dayEntries().map(t => [t._uniqueId, t]));
    problem.framing.decision.forEach(x => {
      const t = byUid.get(x.uid);
      if (!t) return;
      const now = currentState(t);
      const startNow = x.disrupted ? x.givenStart : x.plan;
      const durNow = x.disrupted ? x.givenDauer : x.plannedDauer;
      const changed = now.cancel || Math.abs(now.start - startNow) > 0.5 || Math.abs(now.dur - durNow) > 0.5;
      if (changed || (scenario.fixed && scenario.fixed[x.uid])) fixed[x.uid] = now;
    });
    return fixed;
  }

  // The model's proposal for one train, if it differs from how it stands now.
  function proposalFor(uid, fixed) {
    if (!live || !problem || fixed[uid] || isTest()) return null; // test levels: hidden until "Fertig"
    const x = problem.framing.decision.find(d => d.uid === uid);
    const t = dayEntries().find(e => e._uniqueId === uid);
    if (!x || !t) return null;
    const now = currentState(t);
    const c = live.cand;
    if (c.cancels.has(uid)) return now.cancel ? null : { cancel: true };
    const start = c.starts[uid], dur = c.durs[uid];
    if (start == null) return null;
    const moved = Math.abs(start - now.start) > 0.5, resized = dur != null && Math.abs(dur - now.dur) > 0.5;
    if (!moved && !resized && !now.cancel) return null;
    return { cancel: false, start, dur, time: toHHMM(start), moved, resized, relocated: c.relocated === uid };
  }

  function refreshState() {
    live = null; overlaps = [];
    if (!scenario || scenario.finished) return;
    ensureProblem();
    if (problem) live = M.chooseGiven(problem, model, decidedNow());
    overlaps = findOverlaps();
  }

  // Kept trains that start before an earlier kept train has ended — unless
  // the two were planned to run in parallel.
  function findOverlaps() {
    const items = dayEntries().filter(t => !t.canceled && scenario.basePlan[t._uniqueId] != null).map(t => {
      const s = currentState(t);
      const plan = toMin(scenario.basePlan[t._uniqueId]);
      return { uid: t._uniqueId, start: s.start, end: s.start + s.dur, plan, plannedEnd: plan + (Number(scenario.basePlannedDauer[t._uniqueId]) || 0) };
    }).sort((a, b) => a.start - b.start);
    const out = new Set();
    items.forEach((b, i) => items.slice(0, i).forEach(a => {
      if (a.end > b.start + 0.5 && !(a.plannedEnd > b.plan && b.plannedEnd > a.plan)) out.add(b.uid);
    }));
    return [...out];
  }

  // ===================== level generation =====================

  let statsCache = null, oneOffsCache = null;
  async function startNextLevel(previousResult) {
    busy = true;
    generationError = null;
    showLoader(previousResult ? `Level ${previousResult.level} geschafft ✓ — nächstes Level wird erstellt …` : 'Level wird erstellt …');
    try {
      const [liveRes, episodes] = await Promise.all([sbx.realFetch('/api/schedule', { cache: 'no-store' }), api('episodes')]);
      if (!liveRes.ok) throw new Error('Live-Fahrplan nicht lesbar');
      const liveSchedule = await liveRes.json();
      // the latest finished model (the refit after the last level runs in the
      // background on the server and may still be busy)
      try { useTrained(await api('cost-model')); } catch (e) { if (!trained) throw e; }
      if (!statsCache) statsCache = await api('disruption-stats').catch(() => null);
      if (!oneOffsCache) oneOffsCache = await api('one-offs').catch(() => null);
      // Let the loader paint before the (synchronous) candidate search.
      await new Promise(r => setTimeout(r, 30));
      const level = episodes.length + 1;
      const { entries, scenario: next } = LV.generate({
        live: liveSchedule, stats: statsCache, oneOffs: oneOffsCache, episodes: episodes.filter(e => !e.discarded),
        trained, tiers: tiers(), roles, practice: practiceMode ? 'appointments' : null, level, RealDate: sbx.RealDate,
      });
      next.previousResult = previousResult || null;
      await putJson('state', {
        schedule: { fixedSchedule: [], spontaneousEntries: entries, projects: liveSchedule.projects || [], _meta: { version: realNow().getTime(), lastSaved: null } },
        scenario: next,
      });
      location.reload(); // re-boots the app with the clock frozen on the new day
    } catch (err) {
      console.error('[sandbox] level generation failed', err);
      generationError = err.message;
      busy = false;
      hideLoader();
      updatePanel();
    }
  }

  // ===================== decoration =====================

  let decorateQueued = false;
  function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(() => { decorateQueued = false; decorate(); });
  }

  // "+25" / "−15" next to the carriage symbol when a train's duration differs
  // from its planned duration, in the style of a changed departure time.
  function decorateDuration(row, t) {
    const slot = row.querySelector('.carriage-slot');
    if (!slot) return;
    const base = scenario.basePlannedDauer ? scenario.basePlannedDauer[t._uniqueId] : null;
    const delta = base == null || t.canceled ? 0 : Math.round((Number(t.dauer) || 0) - Number(base));
    const text = delta ? `${delta > 0 ? '+' : '−'}${Math.abs(delta)}` : '';
    const badge = slot.querySelector('.sbx-dauer-delta');
    if ((badge ? badge.textContent : '') === text) return;
    if (badge) badge.remove();
    if (text) slot.appendChild(el('span', { class: 'delayed sbx-dauer-delta', title: `Dauer ${delta > 0 ? 'verlängert' : 'verkürzt'}: ${base} → ${Number(t.dauer) || 0} min`, text }));
  }

  function decorate() {
    if (!scenario) { updatePanel(); return; }
    refreshState();
    const disrupted = disruptedSet();
    const overlapSet = new Set(reviewMode ? overlaps : []);
    const fixed = decidedNow();
    const byUid = new Map(dayEntries().map(t => [t._uniqueId, t]));

    document.querySelectorAll('.train-entry[data-unique-id]').forEach(row => {
      const uid = row.dataset.uniqueId;
      if (disrupted.has(uid) && !row.classList.contains('sbx-disrupted')) row.classList.add('sbx-disrupted', 'fex-entry');
      row.classList.toggle('sbx-unresolved', overlapSet.has(uid));
      row.classList.toggle('sbx-confirmed', !!(scenario.fixed && scenario.fixed[uid]));
      const train = byUid.get(uid);
      if (train) decorateDuration(row, train);
      if (row.classList.contains('first-train')) return; // headline keeps its countdown

      // The app's 5-second ticker (init.js) rewrites [data-departure]; compare
      // against what is on screen, not a cached marker.
      const departure = row.querySelector('[data-departure]');
      if (!departure) return;
      const target = departure.querySelector('.departure-text') || departure;
      const p = scenario.finished ? null : proposalFor(uid, fixed);
      const sig = !p ? '' : p.cancel ? 'fällt aus' : p.moved ? `${p.relocated ? '↷ ' : ''}${p.time}` : `${p.dur} min`;
      const pill = target.querySelector('.sbx-predicted');
      if ((pill ? pill.textContent : '') === sig) return;

      if (sig) {
        target.textContent = '';
        const title = p.cancel ? 'Vorschlag: fällt aus — tippen zum Übernehmen'
          : `Vorschlag ${p.time}${p.resized ? `, ${p.dur} min` : ''}${p.relocated ? ' (nach hinten verlegt)' : ''} — tippen zum Übernehmen`;
        target.append(
          el('span', {
            class: 'sbx-plan-time', 'data-sbx-discard': uid,
            title: 'Antippen: so lassen, wie er ist — Vorschlag verwerfen',
            text: train ? (train.canceled ? train.plan : (train.actual || train.plan)) : '',
          }), ' ',
          el('span', { class: `delayed sbx-predicted${p.cancel ? ' sbx-predicted--cancel' : ''}`, 'data-sbx-accept': uid, title, text: sig })
        );
      } else {
        // Proposal gone: redraw the time the way the app itself does.
        const d = departure.dataset;
        const now = new Date();
        const canceled = d.canceled === 'true';
        const delay = canceled ? 0 : getDelay(d.plan || null, d.actual || null, now, d.date || null);
        target.textContent = '';
        target.appendChild(formatDeparture(d.plan || null, d.actual || null, now, delay, d.dauer ? Number(d.dauer) : 0, d.date || null));
      }
    });
    updatePanel();
    renderOccupancy();
  }

  // Re-decorate whenever rows are (re)rendered OR a departure time is
  // rewritten in place (init.js ticker). Departure rewrites are handled in a
  // microtask — before the browser paints — so the pill never flickers.
  let microQueued = false;
  new MutationObserver((muts) => {
    let rows = false, times = false;
    for (const m of muts) {
      const t = m.target;
      if (t.nodeType === 1 && t.closest && t.closest('[data-departure]')) times = true;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.matches('.train-entry') || n.querySelector('.train-entry'))) rows = true;
      }
    }
    if (times && !microQueued) {
      microQueued = true;
      queueMicrotask(() => { microQueued = false; decorate(); });
    } else if (rows) {
      queueDecorate();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ===================== actions on trains =====================

  function logEvents(events) {
    if (!events.length || !scenario) return;
    postJson('events', { events: events.map(e => Object.assign({ scenarioId: scenario.id, level: scenario.level || null, levelKind: scenario.kind || null, seq: ++scenario.seq, at: realNow().toISOString() }, e)) })
      .catch(err => console.warn('[sandbox] events not saved', err));
  }
  const saveScenario = () => putJson('scenario', scenario).catch(err => console.warn('[sandbox] scenario not saved', err));

  function acceptProposals(uids) {
    const fixed = decidedNow();
    let changed = 0;
    uids.forEach(uid => {
      const p = proposalFor(uid, fixed);
      const t = dayEntries().find(e => e._uniqueId === uid);
      if (!p || !t) return;
      if (p.cancel) t.canceled = true;
      else {
        t.canceled = false;
        t.actual = toHHMM(p.start);
        if (p.dur != null) t.dauer = p.dur;
      }
      pendingAccept.add(uid);
      changed++;
    });
    if (!changed) return;
    refreshUIOnly();
    saveSchedule();
  }
  const openProposals = () => {
    const fixed = decidedNow();
    return problem ? problem.framing.decision.map(x => x.uid).filter(uid => proposalFor(uid, fixed)) : [];
  };

  function cancelTrain(uid) {
    const t = dayEntries().find(e => e._uniqueId === uid);
    if (!t) return;
    t.canceled = true;
    refreshUIOnly();
    saveSchedule();
  }

  // Tap on the time next to a proposal: "leave this train as it is".
  function confirmAsIs(uid) {
    if (!scenario || scenario.finished) return;
    scenario.fixed = scenario.fixed || {};
    scenario.fixed[uid] = true;
    logEvents([{ uid, kind: 'confirm', source: 'time-click' }]);
    saveScenario();
    decorate();
  }

  // Clearing a train's actual time in the editor means "runs as planned".
  // The app's saveSchedule() refills an empty actual with the plan, so catch
  // it just before. saveSchedule is a global function declaration, so
  // reassigning it also redirects the editor's bare saveSchedule() calls.
  if (typeof window.saveSchedule === 'function') {
    const realSaveSchedule = window.saveSchedule;
    window.saveSchedule = function sandboxSaveSchedule(...args) {
      try {
        if (scenario && !scenario.finished) {
          const disrupted = disruptedSet();
          dayEntries().forEach(t => {
            const uid = t._uniqueId;
            if (scenario.basePlan[uid] == null || disrupted.has(uid) || t.canceled || t.actual) return;
            if (typeof isDurationOnlyTrain === 'function' && isDurationOnlyTrain(t)) return;
            scenario.fixed = scenario.fixed || {};
            if (!scenario.fixed[uid]) { scenario.fixed[uid] = true; logEvents([{ uid, kind: 'confirm', source: 'cleared-time' }]); saveScenario(); }
          });
        }
      } catch (err) { console.warn('[sandbox] confirm check failed', err); }
      return realSaveSchedule.apply(this, args);
    };
  }

  // ---- sandbox bar + occupancy actions ----
  // All bar buttons carry data-sbx-action and go through one dispatcher.
  //
  // Why not plain onclick: while the editor drawer is open, its "click
  // outside closes the drawer" handler fires on POINTERDOWN, saves, closes
  // and re-renders — which rebuilds this bar, so the button under the finger
  // is replaced before the click completes and the browser never delivers
  // the click. So a press noted on pointerdown while the drawer is open is
  // carried out once the drawer has closed, unless the real click ran it.
  function runAction(key) {
    const i = key.indexOf(':');
    const name = i === -1 ? key : key.slice(0, i), uid = i === -1 ? null : key.slice(i + 1);
    const fail = (err) => alert(err.message);
    switch (name) {
      case 'finish': return onFinishPressed();
      case 'accept-all': return acceptProposals(openProposals());
      case 'unrealistic': return skipUnrealistic();
      case 'practice': return togglePractice();
      case 'overview': return openLevelOverview().catch(fail);
      case 'model': return openModelDialog().catch(fail);
      case 'retry': return startNextLevel(scenario && scenario.lastResult);
      case 'accept': return acceptProposals([uid]);
      case 'cancel': return cancelTrain(uid);
      case 'occ-accept': return acceptProposals([uid]);
      case 'occ-open': return openTrainInEditor(uid);
      default: return undefined;
    }
  }

  function actionKeyOf(target) {
    const btn = target.closest && target.closest('.sbx-bar [data-sbx-action]');
    if (btn) return btn.disabled ? null : btn.dataset.sbxAction;
    const blk = target.closest && target.closest('.sbx-occupancy .sbx-occ-block');
    if (blk) return `${blk.dataset.accept === '1' ? 'occ-accept' : 'occ-open'}:${blk.dataset.uid}`;
    return null;
  }

  const editorDrawerOpen = () => {
    const p = document.getElementById('focus-panel');
    return !!(p && p.classList.contains('is-open') && p.innerHTML.trim());
  };

  let pendingAction = null;
  // Registered at load, i.e. before the editor's own pointerdown handler
  // (added each time the drawer opens), so it sees the press first.
  document.addEventListener('pointerdown', (e) => {
    const key = actionKeyOf(e.target);
    if (!key || !editorDrawerOpen()) return;
    const mine = { key };
    pendingAction = mine;
    const started = performance.now(); // Date.now() is frozen in the sandbox
    const tick = () => {
      if (pendingAction !== mine) return; // the real click came through and ran it
      if (editorDrawerOpen() && performance.now() - started < 3000) { setTimeout(tick, 50); return; }
      setTimeout(() => { if (pendingAction === mine) { pendingAction = null; runAction(key); } }, 250);
    };
    setTimeout(tick, 50);
  }, true);

  document.addEventListener('click', (e) => {
    const key = actionKeyOf(e.target);
    if (!key) return;
    e.preventDefault();
    pendingAction = null; // this click is the press — run it once, here
    runAction(key);
  });

  // Ctrl+S (caught by the shim) = pressing "Fertig", through the same path as
  // a real press, so nothing typed in an open editor drawer is lost.
  sbx.onSave = () => {
    const btn = document.querySelector('.sbx-bar [data-sbx-action="finish"]');
    if (!btn || btn.disabled || busy) return;
    if (editorDrawerOpen()) btn.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    else runAction('finish');
  };

  // Capture phase: runs before the row's own click handler opens the editor.
  document.addEventListener('click', (e) => {
    const plan = e.target.closest('[data-sbx-discard]');
    if (plan) { e.stopPropagation(); e.preventDefault(); confirmAsIs(plan.dataset.sbxDiscard); return; }
    const pill = e.target.closest('[data-sbx-accept]');
    if (!pill) return;
    e.stopPropagation();
    e.preventDefault();
    acceptProposals([pill.dataset.sbxAccept]);
  }, true);

  // ===================== decision log =====================

  window.addEventListener('sbx:saved', (e) => {
    if (!scenario || scenario.finished) return;
    const fixed = decidedNow();
    logEvents(e.detail.changes.map(c => ({
      uid: c.uid,
      kind: pendingAccept.has(c.uid) ? 'accept' : c.kind,
      fields: c.fields || null, before: c.before || null, after: c.after || null,
      tracked: scenario.basePlan[c.uid] != null, disrupted: disruptedSet().has(c.uid),
      decidedNow: !!fixed[c.uid],
    })));
    e.detail.changes.forEach(c => pendingAccept.delete(c.uid));
    saveScenario();
    decorate();
  });

  // ===================== finish level =====================

  async function onFinishPressed() {
    if (!scenario || scenario.finished || busy) return;
    await waitForSaves(); // a just-saved edit must count before the overlap check
    refreshState();
    if (overlaps.length && !reviewMode) {
      reviewMode = true; // first press: show the overlaps
      decorate();
      return;
    }
    finishLevel().catch(err => { busy = false; hideLoader(); alert('Speichern fehlgeschlagen: ' + err.message); updatePanel(); });
  }

  // Wait for a schedule save still in flight (e.g. the editor drawer just
  // saved on closing).
  async function waitForSaves(maxMs = 4000) {
    const started = performance.now();
    while (typeof saveInProgress !== 'undefined' && saveInProgress && performance.now() - started < maxMs) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async function finishLevel() {
    busy = true;
    updatePanel();
    await waitForSaves();
    const ep = LV.episodeOf(scenario, dayEntries());
    const lvl = M.levelFromEpisode(ep, tiers());
    const scoreModel = M.scoreLevel(lvl, scenario.initialPrediction);
    const scorePush = M.scoreLevel(lvl, scenario.pushPrediction);
    const result = {
      level: scenario.level, kind: scenario.kind,
      model: scoreModel, push: scorePush,
      overlapsLeft: overlaps.length,
    };
    showLoader('Level wird gespeichert …');
    const res = await postJson('episodes', {
      version: 2,
      scenarioId: scenario.id,
      level: scenario.level,
      kind: scenario.kind,
      date: scenario.date,
      createdAt: scenario.createdAt,
      finishedAt: realNow().toISOString(),
      generatorVersion: scenario.generatorVersion,
      disruptions: scenario.disruptions,
      baseDay: scenario.baseDay,
      basePlannedDauer: scenario.basePlannedDauer,
      lineRanking: scenario.lineRanking,
      focus: scenario.focus,
      practice: scenario.practice || null,
      selection: scenario.selection,
      modelLevels: scenario.modelLevels,
      final: ep.final,
      confirmed: Object.keys(scenario.fixed || {}),
      initialPrediction: scenario.initialPrediction,
      pushPrediction: scenario.pushPrediction,
      score: { model: scoreModel, push: scorePush },
      overlapsLeft: overlaps.length,
    });
    hideLoader();
    scenario.finished = true;
    scenario.lastResult = result;
    await putJson('scenario', scenario); // if generation fails, boot resumes from here

    if (isTest()) {
      busy = false;
      updatePanel();
      showReveal(lvl, result);
    } else {
      await startNextLevel(result);
    }
  }

  async function skipUnrealistic() {
    if (!scenario || busy || scenario.finished) return;
    const reason = prompt('Level als unrealistisch überspringen? Es wird nicht gelernt.\nWas ist unrealistisch? (optional)', '');
    if (reason === null) return;
    logEvents([{ kind: 'skip-unrealistic', reason: reason || null, disruptions: scenario.disruptions, date: scenario.date }]);
    await startNextLevel(null);
  }

  // ===================== UI =====================

  let panel = null;
  let loader = null;

  function showLoader(text) {
    if (!loader) {
      loader = el('div', { class: 'sbx-loader' }, [el('div', { class: 'sbx-loader-card' })]);
      document.body.appendChild(loader);
    }
    loader.firstChild.textContent = text;
  }
  function hideLoader() { if (loader) { loader.remove(); loader = null; } }

  const describeDisruption = (d) => (d.type === 'overrun' ? `${d.plan} · ${d.minutes} min länger`
    : d.fixedEnd ? `${d.plan} · ${d.minutes} min zu spät, endet planmäßig` : `${d.plan} · ${d.minutes} min später`);
  function trainLabel(uid) {
    const t = dayEntries().find(e => e._uniqueId === uid) || baseOf(uid);
    return t ? `${t.plan} ${t.linie} ${t.ziel}` : uid;
  }

  // Control bar in place of the top ribbon:
  //   [Level n] [date · focus / disruptions] [progress] [actions … Fertig]
  // The overlap review opens as a second row.
  function updatePanel() {
    if (!panel) return;
    panel.textContent = '';
    panel.classList.toggle('is-test', isTest());
    panel.classList.remove('is-ready');
    document.body.classList.remove('sbx-ready');
    const level = scenario && scenario.level ? scenario.level : null;
    const row = el('div', { class: 'sbx-bar-row' }, [
      el('div', { class: 'sbx-bar-id' }, [
        el('button', { class: 'sbx-level', type: 'button', title: 'Levelübersicht öffnen', 'data-sbx-action': 'overview' },
          [el('span', { class: 'sbx-level-word', text: isTest() ? 'Test' : 'Level' }), el('span', { class: 'sbx-level-num', text: level ? String(level) : '–' })]),
      ]),
    ]);
    panel.appendChild(row);

    if (generationError) {
      row.append(
        el('div', { class: 'sbx-bar-info' }, [el('div', { class: 'sbx-line sbx-error', text: generationError })]),
        el('div', { class: 'sbx-bar-actions' }, [el('button', { class: 'sbx-btn sbx-btn--primary sbx-btn--finish', type: 'button', text: 'Erneut versuchen', 'data-sbx-action': 'retry' })])
      );
      return;
    }
    if (!scenario || scenario.finished) {
      row.appendChild(el('div', { class: 'sbx-bar-info' }, [el('div', { class: 'sbx-line sbx-muted', text: scenario && scenario.finished ? 'Level abgeschlossen.' : 'Level wird vorbereitet …' })]));
      return;
    }

    const decisionUids = problem ? problem.framing.decision.map(x => x.uid) : [];
    const decided = Object.keys(decidedNow()).length;
    const open = openProposals().length;
    const ready = overlaps.length === 0;
    panel.classList.toggle('is-ready', ready);
    document.body.classList.toggle('sbx-ready', ready); // green frame: no overlaps left

    row.append(
      el('div', { class: 'sbx-bar-info' }, [
        el('div', {
          class: 'sbx-line sbx-muted',
          title: (scenario.arrangementNotes && scenario.arrangementNotes.length)
            ? `Startplan angepasst, damit er überschneidungsfrei ist:\n${scenario.arrangementNotes.join('\n')}`
            : 'Startplan ohne Überschneidungen',
        }, [
          fmtDate(scenario.date),
          scenario.oneOffCount ? ` · ${scenario.oneOffCount} Einzelfahrt${scenario.oneOffCount === 1 ? '' : 'en'}` : '',
          scenario.focus ? ` · ${scenario.focus}` : '',
        ]),
        el('div', { class: 'sbx-bar-disruptions' }, (scenario.disruptions || []).map(d => el('span', { class: 'sbx-disruption' }, [
          el('span', { class: 'sbx-disruption-dot' }),
          el('strong', { text: `${d.linie} ${d.ziel}` }),
          el('span', { class: 'sbx-muted', text: ` ${describeDisruption(d)}` }),
        ]))),
      ]),
      el('div', { class: 'sbx-bar-progress' }, [
        el('div', { class: 'sbx-progress' }, [el('div', { class: 'sbx-progress-bar', style: `width:${decisionUids.length ? Math.round((decided / decisionUids.length) * 100) : 0}%` })]),
        el('div', { class: 'sbx-muted', text: `${decided}/${decisionUids.length} entschieden · ${isTest() ? 'Vorschläge ausgeblendet (Testlevel)' : `${open} Vorschl${open === 1 ? 'ag' : 'äge'} offen`}${trained ? ` · Modell aus ${trained.levels} Level${trained.levels === 1 ? '' : 'n'}` : ''}` }),
      ])
    );

    const finishText = busy ? 'Speichere …'
      : reviewMode && overlaps.length ? `Trotzdem abschließen · ${overlaps.length} Überschneidung${overlaps.length === 1 ? '' : 'en'}`
      : 'Fertig – nächstes Level ▶';
    row.appendChild(el('div', { class: 'sbx-bar-actions' }, [
      isTest() ? null : el('button', { class: 'sbx-btn', type: 'button', text: 'Alle Vorschläge übernehmen', disabled: !open || busy, 'data-sbx-action': 'accept-all' }),
      el('button', {
        class: `sbx-btn sbx-btn--toggle${practiceMode ? ' is-on' : ''}`, type: 'button', 'aria-pressed': practiceMode ? 'true' : 'false',
        text: practiceMode ? 'Übung: Feste Termine ✓' : 'Übung: Feste Termine',
        title: 'Ab dem nächsten Level: Tage, an denen ein fester Termin auf der Kippe steht (10–45 min zu spät) — so lernt das Modell, ab wann du ausfallen lässt. Testlevel bleiben zufällig.',
        'data-sbx-action': 'practice',
      }),
      el('button', { class: 'sbx-btn', type: 'button', text: 'Unrealistisch', disabled: busy, title: 'Level überspringen, weil es so nicht vorkommt — wird nicht gelernt', 'data-sbx-action': 'unrealistic' }),
      el('button', { class: 'sbx-btn', type: 'button', text: 'Übersicht', 'data-sbx-action': 'overview' }),
      el('button', { class: 'sbx-btn', type: 'button', text: 'Modell', 'data-sbx-action': 'model' }),
      el('button', {
        class: `sbx-btn sbx-btn--primary sbx-btn--finish${reviewMode && overlaps.length ? ' is-armed' : ''}`,
        type: 'button', disabled: busy, text: finishText,
        title: 'Dein Endstand wird gespeichert; unveränderte Züge gelten als so gewollt.',
        'data-sbx-action': 'finish',
      }),
    ].filter(Boolean)));

    if (reviewMode && overlaps.length) {
      const list = el('div', { class: 'sbx-review' }, [
        el('div', { class: 'sbx-review-title', text: `${overlaps.length} Zug/Züge überschneiden sich noch mit einem früheren Zug:` }),
      ]);
      const fixed = decidedNow();
      overlaps.forEach(uid => {
        const p = proposalFor(uid, fixed);
        list.appendChild(el('div', { class: 'sbx-review-row' }, [
          el('span', { class: 'sbx-review-name', text: trainLabel(uid) }),
          el('span', { class: 'sbx-review-actions' }, [
            p ? el('button', { class: 'sbx-chip-btn', type: 'button', text: p.cancel ? 'Vorschlag: fällt aus' : `Vorschlag ${p.time}`, 'data-sbx-action': `accept:${uid}` }) : null,
            el('button', { class: 'sbx-chip-btn', type: 'button', text: 'Fällt aus', 'data-sbx-action': `cancel:${uid}` }),
          ].filter(Boolean)),
        ]));
      });
      list.appendChild(el('div', { class: 'sbx-hint', text: 'Oder im Editor verschieben. Absichtlich parallel? Dann einfach trotzdem abschließen.' }));
      panel.appendChild(list);
    }
  }

  // ===================== occupancy (Belegung) =====================
  // Two columns for the level's day, 00:00–24:00 squeezed into the pane
  // height: left = the timetable as it stands now, right = the model's
  // proposal for the whole day given your decisions (changed trains yellow).
  // Click a block to open that train in the editor; click a yellow block to
  // take over the proposal, right-click it to leave the train as it is.
  // Hovering a block shows a card with plan, now and the proposal.

  let occ = null;

  function layoutLanes(items) {
    const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    let cluster = [], clusterEnd = -Infinity;
    const flush = () => {
      const laneEnds = [];
      cluster.forEach(it => {
        let lane = laneEnds.findIndex(end => end <= it.start);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.end); } else laneEnds[lane] = it.end;
        it.lane = lane;
      });
      cluster.forEach(it => { it.lanes = laneEnds.length; });
      cluster = [];
    };
    sorted.forEach(it => {
      if (cluster.length && it.start >= clusterEnd) { flush(); clusterEnd = -Infinity; }
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.end);
    });
    if (cluster.length) flush();
    return sorted;
  }

  function renderOccupancy() {
    if (!occ) return;
    occ.textContent = '';
    if (!scenario) return;
    const disrupted = disruptedSet();
    const overlapSet = new Set(reviewMode ? overlaps : []);
    const trains = dayEntries().filter(t => scenario.basePlan[t._uniqueId] != null && t.date === scenario.date);
    const fixed = decidedNow();
    const DAY = 1440;
    occInfo = new Map();

    const itemsFor = (withProposal) => trains.map(t => {
      const uid = t._uniqueId;
      const now = currentState(t);
      let start = now.start, dauer = Math.max(0, now.dur), canceled = now.cancel;
      const p = withProposal && !scenario.finished ? proposalFor(uid, fixed) : null;
      if (p) { if (p.cancel) canceled = true; else { start = p.start; if (p.dur != null) dauer = p.dur; canceled = false; } }
      return { t, uid, start, end: start + Math.max(dauer, 6), dauer, proposed: !!p && !p.cancel, proposedCancel: !!p && p.cancel, canceled, p };
    }).filter(it => it.start != null && !Number.isNaN(it.start));

    const head = el('div', { class: 'sbx-occ-head' }, [
      el('span', { text: '' }),
      el('span', { text: 'Aktueller Plan' }),
      el('span', {}, isTest() && !scenario.finished ? ['Vorschlag (nach „Fertig“)'] : [el('span', { class: 'sbx-occ-legend' }), 'Vorschlag des Modells']),
    ]);
    const axis = el('div', { class: 'sbx-occ-axis' });
    for (let h = 0; h <= 24; h += 2) {
      axis.appendChild(el('div', { class: 'sbx-occ-hour', style: `top:${(h / 24) * 100}%;${h === 0 ? 'transform:none;' : h === 24 ? 'transform:translateY(-100%);' : ''}`, text: `${String(h).padStart(2, '0')}` }));
    }

    const column = (key, withProposal) => {
      const col = el('div', { class: 'sbx-occ-col', 'data-col': key });
      for (let h = 1; h < 24; h++) col.appendChild(el('div', { class: 'sbx-occ-grid', style: `top:${(h / 24) * 100}%` }));
      // Test level: the model's proposal stays hidden until "Fertig" (no bias).
      if (withProposal && isTest() && !scenario.finished) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'sbx-occ-hidden-x');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('aria-hidden', 'true');
        [['0', '0', '100', '100'], ['100', '0', '0', '100']].forEach(([x1, y1, x2, y2]) => {
          const line = document.createElementNS(ns, 'line');
          line.setAttribute('x1', x1); line.setAttribute('y1', y1);
          line.setAttribute('x2', x2); line.setAttribute('y2', y2);
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          svg.appendChild(line);
        });
        col.appendChild(el('div', { class: 'sbx-occ-hidden' }, [
          svg,
          el('div', { class: 'sbx-occ-hidden-text', text: 'Testlevel: Der Vorschlag des Modells wird erst nach „Fertig“ gezeigt.' }),
        ]));
        return col;
      }
      const items = itemsFor(withProposal);
      const kept = layoutLanes(items.filter(it => !it.canceled));
      const ghosts = items.filter(it => it.canceled);
      const pxPerMin = (occ.clientHeight || 600) / DAY;
      [...ghosts.map(it => Object.assign(it, { lane: 0, lanes: 1 })), ...kept].forEach(it => {
        const top = Math.max(0, Math.min(DAY, it.start));
        const bottom = Math.max(top, Math.min(DAY, it.start + it.dauer));
        const heightMin = Math.max(bottom - top, 4);
        const px = heightMin * pxPerMin;
        const color = typeof getLineColor === 'function' ? getLineColor(it.t.linie || '') : 'var(--color-bg-button)';
        const cls = ['sbx-occ-block'];
        if (it.proposed) cls.push('is-predicted');
        if (disrupted.has(it.uid)) cls.push('is-disrupted');
        if (!withProposal && overlapSet.has(it.uid)) cls.push('is-unresolved');
        if (it.canceled && !it.proposedCancel) cls.push('is-canceled');
        if (it.proposedCancel) cls.push('is-predicted-cancel');
        const startText = toHHMM(it.start);
        const label = px >= 26
          ? [el('div', { class: 'sbx-occ-time', text: `${startText} ${it.t.linie}` }), el('div', { text: it.t.ziel || '' })]
          : px >= 13 ? [`${it.t.linie} ${it.t.ziel || ''}`] : [];
        col.appendChild(el('div', {
          class: cls.join(' '),
          'data-uid': it.uid,
          'data-col': key,
          'data-accept': it.p ? '1' : null,
          style: `top:${(top / DAY) * 100}%;height:${(heightMin / DAY) * 100}%;left:calc(${(it.lane / it.lanes) * 100}% + 1px);width:calc(${100 / it.lanes}% - 2px);background:${color};`,
        }, label));
        occInfo.set(`${key}|${it.uid}`, { it, withProposal, decided: !!fixed[it.uid], confirmed: !!(scenario.fixed && scenario.fixed[it.uid]), overlap: overlapSet.has(it.uid) || overlaps.includes(it.uid) });
      });
      return col;
    };

    occ.append(head, el('div', { class: 'sbx-occ-body' }, [axis, column('plan', false), column('forecast', true)]));
    refreshOccTip();
  }

  // ---- hover card for the occupancy blocks ----
  // One floating card, filled from the block under the pointer: plan vs.
  // now, the disruption, the model's proposal and what a click does. The
  // occupancy re-renders often (every change, the app's ticker), so the card
  // re-reads the hovered block after each render.
  let occInfo = new Map();
  let occTip = null, occHover = null; // { key, x, y }

  function occTipContent(info) {
    const { it, withProposal } = info;
    const t = it.t, uid = it.uid;
    const planStart = toMin(scenario.basePlan[uid]);
    const planDur = Number(scenario.basePlannedDauer && scenario.basePlannedDauer[uid]) || 0;
    const now = currentState(t);
    const range = (s, d) => `${toHHMM(s)}–${toHHMM(s + d)} · ${d} min`;
    const rows = [['Plan', range(planStart, planDur)], ['Jetzt', now.cancel ? 'fällt aus' : range(now.start, now.dur)]];
    const d = (scenario.disruptions || []).find(x => x.uid === uid);
    if (d) rows.push(['Störung', d.type === 'overrun' ? `${d.minutes} min länger` : d.fixedEnd ? `${d.minutes} min zu spät, Ende fest` : `${d.minutes} min später`]);
    if (withProposal && !scenario.finished && !isTest()) {
      const p = it.p;
      if (p) rows.push(['Vorschlag', p.cancel ? 'fällt aus' : `${range(p.start, p.dur != null ? p.dur : now.dur)}${p.relocated ? ' · nach hinten verlegt' : ''}`]);
      else if (!info.decided) rows.push(['Vorschlag', 'so lassen']);
    }
    const notes = [];
    const b = baseOf(uid);
    if (b && b.dayStart) notes.push('Tagesbeginn');
    if (b && b.appointment) notes.push('fester Termin');
    if (info.confirmed) notes.push('von dir bestätigt');
    else if (info.decided) notes.push('von dir entschieden');
    if (info.overlap && !now.cancel) notes.push('überschneidet sich mit einem früheren Zug');
    const hint = scenario.finished ? '' : it.p ? 'Klick: Vorschlag übernehmen · Rechtsklick: so lassen' : 'Klick: im Editor öffnen';
    return [
      el('div', { class: 'sbx-occ-tip-title', text: `${t.linie} ${t.ziel || ''}`.trim() }),
      el('div', { class: 'sbx-occ-tip-rows' }, rows.flatMap(([k, v]) => [el('span', { class: 'sbx-occ-tip-key', text: k }), el('span', { class: k === 'Vorschlag' && it.p ? 'sbx-occ-tip-proposal' : '', text: v })])),
      notes.length ? el('div', { class: 'sbx-occ-tip-notes', text: notes.join(' · ') }) : null,
      hint ? el('div', { class: 'sbx-occ-tip-hint', text: hint }) : null,
    ].filter(Boolean);
  }

  function placeOccTip() {
    if (!occTip || !occHover) return;
    const pad = 14, w = occTip.offsetWidth, h = occTip.offsetHeight;
    let x = occHover.x + pad, y = occHover.y + pad;
    if (x + w > window.innerWidth - 8) x = occHover.x - w - pad;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    occTip.style.left = `${Math.max(8, x)}px`;
    occTip.style.top = `${Math.max(8, y)}px`;
  }

  function refreshOccTip() {
    if (!occTip) return;
    const info = occHover && occInfo.get(occHover.key);
    if (!info) { occTip.hidden = true; return; }
    occTip.textContent = '';
    occTipContent(info).forEach(n => occTip.appendChild(n));
    occTip.hidden = false;
    placeOccTip();
  }

  function wireOccTip() {
    occTip = el('div', { class: 'sbx-occ-tip', hidden: true, role: 'tooltip' });
    document.body.appendChild(occTip);
    occ.addEventListener('mousemove', (e) => {
      const blk = e.target.closest('.sbx-occ-block');
      if (!blk) { occHover = null; occTip.hidden = true; return; }
      const key = `${blk.dataset.col}|${blk.dataset.uid}`;
      const changed = !occHover || occHover.key !== key;
      occHover = { key, x: e.clientX, y: e.clientY };
      if (changed) refreshOccTip(); else placeOccTip();
    });
    occ.addEventListener('mouseleave', () => { occHover = null; occTip.hidden = true; });
    // Right-click on a proposal: leave the train as it is.
    occ.addEventListener('contextmenu', (e) => {
      const blk = e.target.closest('.sbx-occ-block[data-accept="1"]');
      if (!blk) return;
      e.preventDefault();
      confirmAsIs(blk.dataset.uid);
    });
  }

  function openTrainInEditor(uid) {
    const row = document.querySelector(`#train-list .train-entry[data-unique-id="${CSS.escape(uid)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.click();
  }

  function mountLayout() {
    panel = el('div', { class: 'sbx-bar' });
    const topBar = document.querySelector('.top-bar');
    if (topBar) topBar.prepend(panel); else document.body.prepend(panel);
    const list = document.getElementById('train-list');
    if (list && list.parentNode) {
      const split = el('div', { class: 'sbx-split' });
      list.parentNode.insertBefore(split, list);
      split.appendChild(list);
      occ = el('div', { class: 'sbx-occupancy' });
      split.appendChild(occ);
      if (window.ResizeObserver) new ResizeObserver(() => renderOccupancy()).observe(occ);
      wireOccTip();
    }
  }

  function starsEl(n, cls) {
    return el('span', { class: `sbx-stars ${cls || ''}`.trim(), title: n == null ? 'keine Wertung' : `${n} von 5 Sternen`, 'aria-label': n == null ? 'keine Wertung' : `${n} von 5 Sternen` },
      [1, 2, 3, 4, 5].map(i => el('span', { class: i <= (n || 0) ? 'is-on' : '', text: '★' })));
  }

  function showResultToast(r) {
    if (!r || r.kind === 'random' || !r.model) return; // tests had their reveal
    const key = 'toastShown:' + (scenario && scenario.id);
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    const toast = el('div', { class: 'sbx-toast' }, [
      el('strong', { text: `Level ${r.level} geschafft ✓` }),
      el('span', { text: ` Modell ${r.model.hits}/${r.model.total} richtig · Push ${r.push.hits}/${r.push.total} (Vorschlag beim Start)` }),
    ]);
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('is-out'), 5000);
    setTimeout(() => toast.remove(), 5600);
  }

  function openDialog(title, contentNodes, footerNodes, opts) {
    const dismissable = !(opts && opts.modal);
    const onKey = (e) => {
      if (e.key !== 'Escape' || !dismissable || !document.body.contains(overlay)) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
    document.addEventListener('keydown', onKey, true);
    const overlay = el('div', { class: 'sbx-overlay', onclick: (e) => { if (dismissable && e.target === overlay) close(); } }, [
      el('div', { class: `sbx-dialog${opts && opts.full ? ' sbx-dialog--full' : ''}` }, [
        el('div', { class: 'sbx-dialog-header' }, [
          el('h3', { text: title }),
          dismissable ? el('button', { class: 'sbx-icon-btn', type: 'button', text: '✕', onclick: close }) : null,
        ].filter(Boolean)),
        el('div', { class: 'sbx-dialog-body' }, contentNodes),
        el('div', { class: 'sbx-dialog-footer' }, footerNodes || []),
      ]),
    ]);
    document.body.appendChild(overlay);
    return close;
  }

  // Per train: you / model at the start / push.
  function comparisonTable(lvl, preds) {
    const C = window.SbxCandidates;
    const frame = C.framing(lvl);
    const user = C.userChoice(lvl, frame);
    // Start, plus the length whenever it differs from the plan (shortened /
    // a late arrival at a fixed appointment / an overrun).
    const planned = (x) => (x.disrupted ? x.givenDauer : x.plannedDauer);
    const fmt = (start, dur, x) => `${toHHMM(start)}${dur != null && Math.abs(dur - planned(x)) > 0.5 ? ` · ${Math.round(dur)} min` : ''}`;
    const cell = (pred, x) => {
      if ((pred.cancels || []).includes(x.uid)) return 'fällt aus';
      const s = pred.starts && pred.starts[x.uid] != null ? pred.starts[x.uid] : (x.disrupted ? x.givenStart : x.plan);
      const d = pred.durs && pred.durs[x.uid] != null ? pred.durs[x.uid] : planned(x);
      return fmt(s, d, x);
    };
    const you = (x) => (user.cancels.has(x.uid) ? 'fällt aus' : fmt(user.starts[x.uid], user.durs[x.uid], x));
    return el('table', { class: 'sbx-table' }, [
      el('tr', {}, [el('th', { text: 'Zug' }), el('th', { text: 'Du' }), ...preds.map(([name]) => el('th', { text: name }))]),
      ...frame.decision.map(x => {
        const y = you(x);
        return el('tr', {}, [
          el('td', {}, [`${x.linie} ${x.ziel || ''}`, x.disrupted ? el('span', { class: 'sbx-muted', text: ' · Störung' }) : '']),
          el('td', { text: y }),
          ...preds.map(([, p]) => { const v = cell(p, x); return el('td', { class: v === y ? 'sbx-hit' : '', text: v }); }),
        ]);
      }),
    ]);
  }

  // After a test level: how the model's start prediction did, in plain terms.
  async function showReveal(lvl, result) {
    const s = result.model, sp = result.push;
    let history = [];
    try { history = (await api('episodes')).filter(e => !e.discarded && e.kind === 'random' && e.score); } catch (e) { /* this level only */ }
    const avgOf = (k, who) => avg(history.map(e => e.score[who][k]).filter(v => v != null));
    const end = (m) => (m == null ? '–' : toHHMM(m));
    const lines = [];
    lines.push(s.hits > sp.hits ? `Besser als der einfache Push-Algorithmus (${sp.hits} von ${sp.total}).`
      : s.hits < sp.hits ? `Push lag diesmal besser (${sp.hits} von ${sp.total}).` : `Gleichauf mit Push (${sp.hits} von ${sp.total}).`);
    if (s.userEnd != null && scenario.initialPrediction && scenario.initialPrediction.end != null) {
      const diff = Math.round(Math.abs(scenario.initialPrediction.end - s.userEnd));
      lines.push(diff <= 5 ? `Dein Tag endet um ${end(s.userEnd)} — wie vom Modell erwartet.`
        : `Dein Tag endet um ${end(s.userEnd)}, das Modell hatte ${end(scenario.initialPrediction.end)} erwartet.`);
    }
    if (s.cancelN) lines.push(`Du hast ${s.cancelN} Zug${s.cancelN === 1 ? '' : 'züge'} ausfallen lassen — das Modell hat ${s.cancelHit ? `${s.cancelHit} davon` : 'keinen davon'} erwartet.`);
    else if (s.falseCancel) lines.push(`Das Modell hatte ${s.falseCancel} Ausfall${s.falseCancel === 1 ? '' : 'fälle'} erwartet — du hast alles behalten.`);
    const summary = history.length >= 2
      ? `In ${history.length} Testleveln: Modell Ø ${fmt1(avgOf('stars', 'model'))} Sterne, Push ${fmt1(avgOf('stars', 'push'))} · Ø Abweichung ${fmtMin(avgOf('mae', 'model'))} vs. ${fmtMin(avgOf('mae', 'push'))}.`
      : 'Ab dem nächsten Testlevel siehst du hier die Entwicklung.';
    const details = el('div', { class: 'sbx-reveal-details', hidden: true }, [
      el('p', { class: 'sbx-muted', text: 'Abfahrt je Zug (und Dauer, wo sie vom Plan abweicht): dein Endstand, der Vorschlag des Modells beim Start des Levels und Push.' }),
      comparisonTable(lvl, [['Modell', scenario.initialPrediction], ['Push', scenario.pushPrediction]]),
      el('p', { class: 'sbx-muted', text: `Ø Abweichung je behaltenem Zug: Modell ${fmtMin(s.mae)} · Push ${fmtMin(sp.mae)} · Tagesende: ${fmtMin(s.dayErr)} vs. ${fmtMin(sp.dayErr)}.` }),
    ]);
    const toggle = el('button', { class: 'sbx-btn', type: 'button', text: 'Details anzeigen' });
    toggle.addEventListener('click', () => { details.hidden = !details.hidden; toggle.textContent = details.hidden ? 'Details anzeigen' : 'Details ausblenden'; });
    const close = openDialog(`Testlevel ${scenario.level} geschafft`, [
      el('div', { class: 'sbx-reveal-hero' }, [
        starsEl(s.stars, 'sbx-stars--big'),
        el('div', { class: 'sbx-reveal-headline', text: `Das Modell lag bei ${s.hits} von ${s.total} Zügen richtig.` }),
        el('div', { class: 'sbx-muted', text: 'richtig = Ausfall erkannt bzw. höchstens 10 min daneben · Vorschlag beim Start des Levels' }),
      ]),
      el('ul', { class: 'sbx-reveal-lines' }, lines.map(t => el('li', { text: t }))),
      el('div', { class: 'sbx-reveal-progress' }, [el('p', { text: summary })]),
      details,
    ], [
      toggle,
      el('button', { class: 'sbx-btn sbx-btn--primary', type: 'button', text: 'Weiter ▶', onclick: () => { close(); startNextLevel(result); } }),
    ], { modal: true });
  }

  async function setDiscarded(ep, discarded) {
    let reason = null;
    if (discarded) {
      reason = prompt(`Level ${ep.level} verwerfen? Es zählt dann nicht mehr fürs Modell und die Ergebnisse; das Modell wird neu berechnet.\nGrund (optional):`, '');
      if (reason === null) return;
    } else if (!confirm(`Level ${ep.level} wiederherstellen? Das Modell wird mit diesem Level neu berechnet.`)) return;
    document.querySelector('.sbx-overlay')?.remove();
    showLoader('Level wird aktualisiert …');
    try {
      await postJson('episodes/discard', { scenarioId: ep.scenarioId, discarded, reason: reason || null });
      // the model is refitted in the background; the next level picks it up
    } catch (err) {
      alert('Fehlgeschlagen: ' + err.message);
    } finally {
      hideLoader();
    }
    openLevelOverview().catch(err => alert(err.message));
  }

  async function openLevelOverview() {
    const episodes = await api('episodes');
    const kept = episodes.filter(e => !e.discarded);
    const tests = kept.filter(e => e.kind === 'random');
    const next = LV.RANDOM_EVERY - (episodes.length % LV.RANDOM_EVERY);
    const summary = el('div', { class: 'sbx-ov-summary' }, [
      el('div', { class: 'sbx-ov-stat' }, [el('strong', { text: String(kept.length) }), el('span', { text: episodes.length > kept.length ? `geschafft (+${episodes.length - kept.length} verworfen)` : 'geschafft' })]),
      el('div', { class: 'sbx-ov-stat' }, [el('strong', { text: String(tests.length) }), el('span', { text: 'Testlevel' })]),
      el('div', { class: 'sbx-ov-stat' }, [el('strong', { text: next === LV.RANDOM_EVERY ? 'jetzt' : `in ${next}` }), el('span', { text: 'nächster Test' })]),
      el('div', { class: 'sbx-ov-stat' }, [el('strong', { text: String(kept.reduce((s, e) => s + (e.score ? e.score.model.cancelN : 0), 0)) }), el('span', { text: 'Ausfälle gesetzt' })]),
    ]);
    const rows = episodes.slice().reverse().map(ep => {
      const sc = ep.score || {};
      const disr = (ep.disruptions || []).map(d => `${d.linie} ${d.type === 'overrun' ? '+' + d.minutes + ' länger' : '+' + d.minutes}`).join(', ');
      const better = sc.model && sc.push ? (sc.model.hits > sc.push.hits ? 'better' : sc.model.hits < sc.push.hits ? 'worse' : '') : '';
      return el('tr', { class: [ep.kind === 'random' ? 'sbx-ov-test' : '', ep.discarded ? 'sbx-ov-discarded' : ''].join(' ').trim() }, [
        el('td', { class: 'sbx-ov-level', text: String(ep.level || '–') }),
        el('td', {}, [el('span', { class: `sbx-ov-kind sbx-ov-kind--${ep.kind === 'random' ? 'probe' : 'active'}`, text: ep.discarded ? 'verworfen' : ep.kind === 'random' ? 'Test' : 'Level', title: ep.discardedReason || ep.focus || '' })]),
        el('td', { text: ep.date ? fmtDate(ep.date) : '–' }),
        el('td', { class: 'sbx-ov-disr', text: disr || '–', title: ep.focus || '' }),
        el('td', { class: `sbx-ov-num ${ep.discarded ? '' : better}`, text: sc.model ? `${sc.model.hits}/${sc.model.total}` : '–' }),
        el('td', { class: 'sbx-ov-num', text: sc.push ? `${sc.push.hits}/${sc.push.total}` : '–' }),
        el('td', { class: 'sbx-ov-num', text: sc.model && sc.model.cancelN ? `${sc.model.cancelHit}/${sc.model.cancelN}` : '–' }),
        el('td', {}, [el('button', { class: 'sbx-chip-btn', type: 'button', text: ep.discarded ? 'Wiederherstellen' : 'Verwerfen', onclick: () => setDiscarded(ep, !ep.discarded) })]),
      ]);
    });
    openDialog('Levelübersicht', [
      summary,
      episodes.length
        ? el('div', { class: 'sbx-ov-scroll' }, [el('table', { class: 'sbx-table sbx-ov-table' }, [
          el('tr', {}, [
            el('th', { text: '#' }), el('th', { text: 'Typ' }), el('th', { text: 'Tag' }), el('th', { text: 'Störung' }),
            el('th', { text: 'Modell', title: 'Züge richtig (Vorschlag beim Start des Levels)' }),
            el('th', { text: 'Push', title: 'Züge richtig mit dem einfachen Push-Algorithmus' }),
            el('th', { text: 'Ausfall ✓', title: 'Deine Ausfälle, die das Modell beim Start erwartet hat' }),
            el('th', { text: '' }),
          ]),
          ...rows,
        ])])
        : el('p', { class: 'sbx-muted', text: 'Noch kein Level geschafft.' }),
      el('p', { class: 'sbx-muted', text: 'Modell grün = mehr Züge richtig als Push. Gewertet wird immer der Vorschlag beim Start des Levels, gelernt nur aus früheren Leveln. Testlevel sind zufällige realistische Tage — nur sie messen das Modell unverzerrt.' }),
    ], [], { full: true });
  }

  async function openModelDialog() {
    const episodes = (await api('episodes')).filter(e => !e.discarded && e.score);
    const tests = episodes.filter(e => e.kind === 'random'), actives = episodes.filter(e => e.kind !== 'random');
    const meanOf = (list, who, k) => avg(list.map(e => e.score[who][k]).filter(v => v != null));
    const rate = (list, who) => {
      const hit = list.reduce((s, e) => s + e.score[who].cancelHit, 0), n = list.reduce((s, e) => s + e.score[who].cancelN, 0);
      return n ? `${hit}/${n}` : '–';
    };
    const resultTable = (list, label) => el('table', { class: 'sbx-table' }, [
      el('tr', {}, [el('th', { text: `${list.length} ${label}` }), el('th', { text: 'Modell' }), el('th', { text: 'Push' })]),
      el('tr', {}, [el('td', { text: 'Ø Sterne' }), el('td', { text: fmt1(meanOf(list, 'model', 'stars')) }), el('td', { text: fmt1(meanOf(list, 'push', 'stars')) })]),
      el('tr', {}, [el('td', { text: 'Ø Abweichung je Zug' }), el('td', { text: fmtMin(meanOf(list, 'model', 'mae')) }), el('td', { text: fmtMin(meanOf(list, 'push', 'mae')) })]),
      el('tr', {}, [el('td', { text: 'Ø Abweichung Tagesende' }), el('td', { text: fmtMin(meanOf(list, 'model', 'dayErr')) }), el('td', { text: fmtMin(meanOf(list, 'push', 'dayErr')) })]),
      el('tr', {}, [el('td', { text: 'Ausfälle erkannt' }), el('td', { text: rate(list, 'model') }), el('td', { class: 'sbx-muted', text: '–' })]),
    ]);

    const shown = episodes.slice(-30);
    const curve = el('div', { class: 'sbx-curve' });
    shown.forEach(ep => {
      const h = (v) => `${Math.min(100, ((v || 0) / 60) * 100)}%`;
      curve.appendChild(el('div', { class: `sbx-curve-col${ep.kind === 'random' ? ' is-test' : ''}`, title: `Level ${ep.level}${ep.kind === 'random' ? ' (Test)' : ''}: Modell ${fmtMin(ep.score.model.mae)}, Push ${fmtMin(ep.score.push.mae)}` }, [
        el('div', { class: 'sbx-curve-bar sbx-curve-bar--push', style: `height:${h(ep.score.push.mae)}` }),
        el('div', { class: 'sbx-curve-bar sbx-curve-bar--model', style: `height:${h(ep.score.model.mae)}` }),
      ]));
    });

    // Learned costs per task family (one-offs: per line).
    const names = new Map();
    episodes.forEach(ep => (ep.baseDay || []).forEach(b => names.set(M.taskKeyOf(b), b)));
    const seen = (trained && trained.stats && trained.stats.taskSeen) || {};
    const costRows = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([key, n]) => {
      const b = names.get(key) || { linie: key.replace(/^line:/, '') };
      const c = model.trainCosts(b.linie, tiers(), null, b.templateId ? P.familyKey(b) : null);
      const be = c.delayPer10 > 0.05 ? `${Math.round((c.cancel / c.delayPer10) * 10)} min` : '—';
      return el('tr', {}, [
        el('td', { text: `${b.linie} ${b.templateId ? b.ziel : '(Einzelfahrten)'}` }),
        el('td', { class: 'sbx-ov-num', text: String(n) }),
        el('td', { class: 'sbx-ov-num', text: fmt1(c.delayPer10) }),
        el('td', { class: 'sbx-ov-num', text: fmt1(c.cancel) }),
        el('td', { class: 'sbx-ov-num', text: be }),
      ]);
    });
    // Fixed appointments: from how many minutes late skipping is cheaper.
    const apptFamilies = new Map();
    episodes.forEach(ep => (ep.baseDay || []).forEach(b => { if (b.appointment && b.templateId) apptFamilies.set(P.familyKey(b), b); }));
    const apptRows = [...apptFamilies.entries()].map(([fam, b]) => {
      const c = model.trainCosts(b.linie, tiers(), null, fam);
      return { b, n: seen[M.taskKeyOf(b)] || 0, skip: c.skipAfterMin };
    }).sort((a, b) => b.n - a.n).map(r => el('tr', {}, [
      el('td', { text: `${r.b.linie} ${r.b.ziel}` }),
      el('td', { class: 'sbx-ov-num', text: String(r.n) }),
      el('td', { class: 'sbx-ov-num', text: r.skip == null ? '—' : `${Math.round(r.skip)} min` }),
    ]));
    const pats = P.patternsFromJSON(trained && trained.patterns);
    const named = (key) => {
      for (const b of names.values()) if (P.taskKey(b) === key) return b.templateId ? `${b.linie} ${b.ziel}` : `${b.linie} (Einzelfahrten)`;
      return key.slice(2);
    };
    const links = [...pats.links].map(k => k.split('>').map(named).join(' → '));

    openDialog('Kostenmodell', [
      el('p', { text: trained ? `Gelernt aus ${trained.levels} Level${trained.levels === 1 ? '' : 'n'} · Muster aus den ersten ${trained.patternsFromLevels} (alle ${trained.patternRefresh} Level neu).` : 'Noch nicht trainiert.' }),
      el('h4', { text: 'Testlevel (zufällige realistische Tage)' }),
      tests.length ? resultTable(tests, 'Testlevel') : el('p', { class: 'sbx-muted', text: `Noch kein Testlevel — jedes ${LV.RANDOM_EVERY}. Level ist eins.` }),
      el('h4', { text: 'Ausgewählte Level (schwierige Fälle)' }),
      actives.length ? resultTable(actives, 'Level') : el('p', { class: 'sbx-muted', text: 'Noch keins.' }),
      el('p', { class: 'sbx-muted', text: 'Gewertet wird der Vorschlag beim Start jedes Levels, gelernt nur aus früheren Leveln. Du siehst die Vorschläge beim Lösen — das kann deine Lösung in Richtung Modell ziehen.' }),
      el('div', { class: 'sbx-curve-legend' }, [el('span', { class: 'sbx-swatch sbx-swatch--model' }), ' Modell ', el('span', { class: 'sbx-swatch sbx-swatch--push' }), ' Push · Ø Abweichung je Level · Testlevel unterstrichen']),
      curve,
      el('h4', { text: 'Gelernte Muster' }),
      el('ul', { class: 'sbx-reveal-lines' }, [
        el('li', { text: `Pause nach einer Aufgabe: ${fmt1(pats.breaks.b)} min je Stunde Dauer${pats.breaks.n ? ` (aus ${pats.breaks.n} Lücken)` : ' (noch keine Daten)'}` }),
        el('li', { text: links.length ? `Gekoppelte Züge: ${links.join(' · ')}` : 'Gekoppelte Züge: noch keine' }),
        el('li', { text: pats.slack.maxShift.size ? `Höchstens verschoben: ${[...pats.slack.maxShift.entries()].map(([k, v]) => `${named(k)} ${v} min`).join(' · ')}` : `Spielraum je Zug: noch unbegrenzt (ab 3 Entscheidungen, mindestens ${pats.slack.floor} min)` }),
      ]),
      el('h4', { text: 'Gelernte Kosten je Aufgabenfamilie' }),
      costRows.length ? el('table', { class: 'sbx-table' }, [
        el('tr', {}, [el('th', { text: 'Zug' }), el('th', { text: 'gesehen' }), el('th', { text: 'Verspätung je 10 min', title: 'Wie ungern du ihn verschiebst' }), el('th', { text: 'Ausfall' }), el('th', { text: 'Gleichstand', title: 'So viele Minuten Verspätung kosten so viel wie ein Ausfall' })]),
        ...costRows,
      ]) : el('p', { class: 'sbx-muted', text: 'Noch keine.' }),
      el('h4', { text: 'Feste Termine: ab wann ausfallen lassen' }),
      apptRows.length ? el('table', { class: 'sbx-table' }, [
        el('tr', {}, [el('th', { text: 'Termin' }), el('th', { text: 'gesehen' }), el('th', { text: 'Ausfall ab', title: 'So viele Minuten zu spät kostet so viel wie ganz ausfallen lassen' })]),
        ...apptRows,
      ]) : el('p', { class: 'sbx-muted', text: 'Noch keine festen Termine markiert oder gespielt.' }),
      el('p', { class: 'sbx-muted', text: `Gemeinsam: Verlegen ${fmt1(model.value('relocate'))} · fehlende Pause ${fmt1(model.value('breakDeficit'))}/h · Kürzen ${fmt1(model.value('shrink:all'))}/h · Überschneidung ${fmt1(model.value('overlap'))}/h. Einheit: 1 = 10 min Verspätung zum Startwert.` }),
    ], []);
  }

  // ===================== boot =====================

  async function boot() {
    mountLayout();
    try { useTrained(await api('cost-model')); }
    catch (e) { console.warn('[sandbox] cost model not loaded, using starting costs', e); useTrained(null); }

    // A level from an older sandbox generation can't be used any more.
    if (scenario && scenario.version !== 2) { console.info('[sandbox] replacing a level from an older sandbox version'); scenario = null; }
    if (!scenario || scenario.finished) {
      await startNextLevel(scenario && scenario.finished ? scenario.lastResult : null);
      return;
    }
    scenario.fixed = scenario.fixed || {};
    scenario.seq = scenario.seq || 0;
    // An open level always follows the current family / day-start settings
    // (changed in Einstellungen → Prognosemodell while it was open); what is
    // set when you press "Fertig" is stored. Its start prediction stays as it
    // was made.
    let rolesChanged = false;
    (scenario.baseDay || []).forEach(b => {
      const r = b.templateId ? roles({ templateId: b.templateId, linie: b.linie, ziel: b.ziel }) : { family: null, dayStart: false, appointment: false };
      if ((b.family || null) !== (r.family || null) || !!b.dayStart !== !!r.dayStart || !!b.appointment !== !!r.appointment) rolesChanged = true;
      b.family = r.family || null;
      b.dayStart = !!r.dayStart;
      b.appointment = !!r.appointment;
    });
    if (rolesChanged || !scenario.rolesApplied) { scenario.rolesApplied = true; saveScenario(); }
    decorate();
    showResultToast(scenario.previousResult);
  }

  if (window.AppSettings && window.AppSettings.ready) window.AppSettings.ready.then(boot, boot);
  else boot();
})();
