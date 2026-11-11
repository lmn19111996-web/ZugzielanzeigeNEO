// === SANDBOX BACKEND ===
// Serves the rescheduling sandbox: /sandbox.html (built on the fly from
// public/mobile.html, so the UI is always identical to the live app) and a
// self-contained /api/sandbox/* API whose data lives in sandbox_data/ only.
// Nothing here writes data.json, train_logs, push subscriptions or settings;
// train_logs are read (read-only) for realistic level generation.
//
// The model is the learned cost model (public/sandbox/engine/), refitted by
// sandbox-trainer.js — in a worker thread, in the background — after every
// finished, discarded or restored level.
// Levels of earlier sandbox generations live in sandbox_data/archive/.

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const express = require('express');
const { Worker } = require('worker_threads');
const { ENGINE_VERSION } = require('./sandbox-trainer');

const EPISODE_VERSION = 2;

function createSandbox({ rootDir, publicDir, readLatestLoggedTrains }) {
  const DATA_DIR = path.join(rootDir, 'sandbox_data');
  const STATE_FILE = path.join(DATA_DIR, 'state.json');
  const EPISODES_FILE = path.join(DATA_DIR, 'episodes.jsonl');
  const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
  const MODEL_FILE = path.join(DATA_DIR, 'cost-model.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Line ranking (tiers): only the starting point of the cost layers; every
  // level stores the ranking in force when it was made.
  const ranking = () => {
    try { return JSON.parse(fs.readFileSync(path.join(rootDir, 'app_settings.json'), 'utf8')).predictionModel.lineImportance || []; }
    catch (e) { return []; }
  };
  // The model is refitted in a worker thread (sandbox-trainer-worker.js): a
  // refit takes seconds and would otherwise freeze the whole server.
  let worker = null, nextId = 0;
  const waiting = new Map();
  function startWorker() {
    worker = new Worker(path.join(__dirname, 'sandbox-trainer-worker.js'), { workerData: { modelFile: MODEL_FILE, rootDir } });
    worker.on('message', ({ id, out, error }) => {
      const w = waiting.get(id); if (!w) return;
      waiting.delete(id);
      if (error) w.reject(new Error(error)); else w.resolve(out);
    });
    const fail = (err) => {
      waiting.forEach(w => w.reject(err || new Error('Trainer beendet')));
      waiting.clear();
      worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', (code) => { if (code !== 0) fail(new Error(`Trainer beendet (${code})`)); else worker = null; });
  }
  function fitInWorker(episodes) {
    if (!worker) startWorker();
    const id = ++nextId;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ id, episodes }); });
  }
  // One refit at a time; requests while one runs coalesce into a single
  // follow-up refit on the then-current levels.
  let running = null, again = false;
  function refitInBackground() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        let out;
        do { again = false; out = await fitInWorker(await readJsonl(EPISODES_FILE)); } while (again);
        return out;
      } finally { running = null; }
    })();
    running.catch(err => console.error('[sandbox] refit failed:', err.message));
    return running;
  }

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsPromises.readFile(file, 'utf8')); }
    catch (e) { return fallback; }
  }

  // Write to a temp file then rename, so a crash never leaves half a file.
  async function writeJson(file, data) {
    const tmp = file + '.tmp';
    await fsPromises.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsPromises.rename(tmp, file);
  }

  async function appendJsonl(file, records) {
    if (!records.length) return;
    await fsPromises.appendFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  async function readJsonl(file) {
    try {
      return (await fsPromises.readFile(file, 'utf8')).split('\n')
        .filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean);
    } catch (e) { return []; }
  }

  const EMPTY_STATE = () => ({
    schedule: { fixedSchedule: [], spontaneousEntries: [], projects: [], _meta: { version: 1, lastSaved: null } },
    scenario: null,
  });

  // Serialize state writes so overlapping saves can't interleave.
  let stateChain = Promise.resolve();
  function withState(fn) {
    const run = stateChain.then(async () => {
      const state = await readJson(STATE_FILE, EMPTY_STATE());
      const result = await fn(state);
      await writeJson(STATE_FILE, state);
      return result;
    });
    stateChain = run.catch(() => {});
    return run;
  }

  // ---- page ----
  async function servePage(req, res) {
    try {
      let html = await fsPromises.readFile(path.join(publicDir, 'mobile.html'), 'utf8');
      // Shim must run before ANY app script (clock, network, storage isolation).
      html = html.replace(/<head>/i, '<head>\n<script src="sandbox/sandbox-shim.js"></script>');
      html = html.replace(/<link rel="manifest"[^>]*>/i, '');
      html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>Sandbox · Umplanen</title>');
      html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="sandbox/sandbox.css">\n</head>');
      html = html.replace(/<body([^>]*)>/i, (m, attrs) => (/class="/.test(attrs)
        ? `<body${attrs.replace(/class="/, 'class="sandbox-mode ')}>`
        : `<body${attrs} class="sandbox-mode">`));
      // Guards: after all function-defining scripts, before init.js runs startup.
      html = html.replace(/<script src="js\/init\.js"><\/script>/i,
        '<script src="sandbox/sandbox-guards.js"></script>\n$&');
      html = html.replace(/<\/body>/i, [
        'sandbox/engine/candidates.js', 'sandbox/engine/patterns.js', 'sandbox/engine/cost-model.js',
        'sandbox/sandbox-levels.js', 'sandbox/sandbox-app.js',
      ].map(src => `<script src="${src}"></script>`).join('\n') + '\n</body>');
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).send('Sandbox page could not be built: ' + e.message);
    }
  }

  // ---- api ----
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));

  // A tab still running older sandbox code must not overwrite current data.
  const isCurrentScenario = (s) => !s || (typeof s === 'object' && s.version === EPISODE_VERSION);
  const stale = (res) => res.status(409).json({ error: 'Veraltete Sandbox-Version in diesem Tab — bitte neu laden.' });

  router.get('/state', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await readJson(STATE_FILE, EMPTY_STATE()));
  });

  // Full replace: used when a new level is created.
  router.put('/state', async (req, res) => {
    const body = req.body || {};
    if (!body.schedule || !Array.isArray(body.schedule.spontaneousEntries)) {
      return res.status(400).json({ error: 'schedule.spontaneousEntries required' });
    }
    if (!isCurrentScenario(body.scenario)) return stale(res);
    await withState(state => {
      state.schedule = { ...body.schedule, fixedSchedule: [] };
      state.scenario = body.scenario || null;
    });
    res.json({ success: true });
  });

  // Saves coming from the app's own saveSchedule() (rerouted by the shim).
  router.post('/schedule', async (req, res) => {
    const body = req.body || {};
    const version = body._meta && body._meta.newVersion;
    const savedAt = new Date().toISOString();
    await withState(state => {
      state.schedule = {
        fixedSchedule: [], // sandbox days never carry stems
        spontaneousEntries: Array.isArray(body.spontaneousEntries) ? body.spontaneousEntries : [],
        projects: Array.isArray(body.projects) ? body.projects : (state.schedule.projects || []),
        _meta: { version: version || Date.now(), lastSaved: savedAt },
      };
    });
    res.json({ success: true, version, savedAt });
  });

  router.put('/scenario', async (req, res) => {
    if (!isCurrentScenario(req.body)) return stale(res);
    await withState(state => { state.scenario = req.body || null; });
    res.json({ success: true });
  });

  // ---- model ----
  let episodesChain = Promise.resolve();
  function withEpisodes(fn) {
    const run = episodesChain.then(fn);
    episodesChain = run.catch(() => {});
    return run;
  }

  router.get('/cost-model', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      let m = await readJson(MODEL_FILE, null);
      // refit when missing or fitted by an older engine (features changed)
      // (the request waits, the server does not — the refit runs in the worker)
      if (!m || m.version !== 2 || m.engine !== ENGINE_VERSION) m = await refitInBackground();
      res.json(Object.assign({}, m, { refitting: !!running }));
    } catch (e) {
      res.status(500).json({ error: 'Modell konnte nicht berechnet werden: ' + e.message });
    }
  });

  // ---- levels ----
  router.get('/episodes', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await readJsonl(EPISODES_FILE));
  });

  // A finished level: stored at once, the answer comes right away; the model
  // is refitted with it in the background (the next level uses the latest
  // finished model — at worst one level behind, still learned from earlier
  // levels only).
  router.post('/episodes', async (req, res) => {
    const ep = req.body || {};
    if (ep.version !== EPISODE_VERSION || !Array.isArray(ep.baseDay) || !Array.isArray(ep.final)) return stale(res);
    try {
      // Idempotent: a level saved again (page reloaded or "Fertig" pressed
      // again while the refit was running) is not stored twice.
      const stored = await withEpisodes(async () => {
        const known = (await readJsonl(EPISODES_FILE)).some(e => e.scenarioId === ep.scenarioId);
        if (!known) await appendJsonl(EPISODES_FILE, [ep]);
        return !known;
      });
      if (stored) refitInBackground();
      res.json({ success: true, duplicate: !stored, refitting: !!running });
    } catch (e) {
      res.status(500).json({ error: 'Level nicht gespeichert: ' + e.message });
    }
  });

  // Discard / restore a finished level (e.g. "not realistic"). The record
  // stays, marked, so it can be restored and level numbers don't shift.
  router.post('/episodes/discard', async (req, res) => {
    const { scenarioId, discarded, reason } = req.body || {};
    if (!scenarioId) return res.status(400).json({ error: 'scenarioId required' });
    try {
      const found = await withEpisodes(async () => {
        const all = await readJsonl(EPISODES_FILE);
        const ep = all.find(e => e.scenarioId === scenarioId);
        if (!ep) return false;
        if (discarded) { ep.discarded = true; ep.discardedAt = new Date().toISOString(); ep.discardedReason = reason || null; }
        else { delete ep.discarded; delete ep.discardedAt; delete ep.discardedReason; }
        const tmp = EPISODES_FILE + '.tmp';
        await fsPromises.writeFile(tmp, all.map(e => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''));
        await fsPromises.rename(tmp, EPISODES_FILE);
        return true;
      });
      if (!found) return res.status(404).json({ error: 'Level nicht gefunden' });
      refitInBackground();
      res.json({ success: true, refitting: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/events', async (req, res) => {
    const events = Array.isArray(req.body && req.body.events) ? req.body.events : [];
    await appendJsonl(EVENTS_FILE, events);
    res.json({ success: true, count: events.length });
  });

  // ---- realistic level generation (read-only on train_logs) ----
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };

  // How your real days go wrong, for the level generator:
  //   primary late starts — a start ≥ 5 min late that no earlier train
  //     explains (everything planned before it had ended by its plan time):
  //     per template and per line, how often and by how much
  //   overruns — checked-out trains ≥ 10 min over the frozen planned duration
  //   perDay — primary disruptions per day (days with ≥ 3 kept trains)
  // Grouped per template, per task family (line + name, with the settings'
  // family merges — so a newly created template inherits its family's
  // history) and per line.
  router.get('/disruption-stats', async (req, res) => {
    try {
      const logged = await readLatestLoggedTrains();
      let overrides = {};
      try { overrides = JSON.parse(fs.readFileSync(path.join(rootDir, 'app_settings.json'), 'utf8')).predictionModel.familyOverrides || {}; } catch (e) { /* none */ }
      // Same rule as public/sandbox/engine/patterns.js (familyName / autoFamily).
      const familyName = (z) => String(z || '').replace(/\[[^\]]*\]/g, '').toLowerCase().replace(/[!?.,:;]/g, '').replace(/\s+/g, ' ').trim();
      const familyOf = (r) => (r._templateId && overrides[r._templateId]) || `${String(r.linie || '').toUpperCase()}|${familyName(r.ziel)}`;
      const days = new Map();
      for (const r of logged.values()) {
        if (!r || r.type || !r.serviceDate || r.canceled) continue;
        if (/_vorlage_preview$/.test(r._uniqueId || '')) continue;
        const plan = toMin(r.plan), act = toMin(r.actual);
        if (plan == null) continue;
        let delay = act == null ? 0 : act - plan;
        if (delay < -720) delay += 1440;
        if (delay > 720) delay -= 1440;
        const planned = Number(r.plannedDauer != null ? r.plannedDauer : r.dauer) || 0;
        const measured = r.checkedOut && r.plannedDauer != null ? Number(r.dauer) || 0 : null;
        if (!days.has(r.serviceDate)) days.set(r.serviceDate, []);
        days.get(r.serviceDate).push({ key: r._templateId || null, family: r._templateId ? familyOf(r) : null, line: r.linie || '', plan, delay, planned, measured });
      }
      const byTemplate = {}, byFamily = {}, byLine = {}, perDay = [];
      const bump = (map, k) => (map[k] = map[k] || { n: 0, late: [], overrun: [] });
      for (const list of days.values()) {
        list.sort((a, b) => a.plan - b.plan);
        let k = 0;
        list.forEach((t, i) => {
          const start = t.plan + Math.max(0, t.delay);
          t.end = start + (t.measured != null ? t.measured : t.planned);
          const explained = list.slice(0, i).some(p => p.plan + p.planned <= t.plan && p.end > t.plan + 2);
          const late = t.delay >= 5 && !explained;
          const over = t.measured != null && t.planned > 0 && t.measured - t.planned >= 10 ? t.measured - t.planned : null;
          [t.key ? bump(byTemplate, t.key) : null, t.family ? bump(byFamily, t.family) : null, bump(byLine, t.line)].forEach(s => {
            if (!s) return;
            s.n++;
            if (late) s.late.push(t.delay);
            if (over != null) s.overrun.push({ minutes: over, planned: t.planned });
          });
          if (late || over != null) k++;
        });
        if (list.length >= 3) perDay.push(k);
      }
      res.set('Cache-Control', 'no-store');
      res.json({ byTemplate, byFamily, byLine, perDay });
    } catch (e) {
      res.json({ byTemplate: {}, byFamily: {}, byLine: {}, perDay: [] });
    }
  });

  // One-off (non-recurring) trains from the logs (read-only), for the level
  // generator: grouped by line + destination with their typical duration and
  // the times they were planned at, plus how many one-offs a day usually has.
  // Left out: retro-logged trains (written down at/after their own start),
  // trains under 10 min or over 6 h, template preview artefacts.
  router.get('/one-offs', async (req, res) => {
    try {
      const logged = await readLatestLoggedTrains();
      const groups = new Map();
      const perDay = new Map(), daysWithTrains = new Set();
      for (const r of logged.values()) {
        if (!r || r.type || !r.serviceDate) continue;
        const plan = toMin(r.plan);
        if (plan == null) continue;
        daysWithTrains.add(r.serviceDate);
        if (r._templateId || /_vorlage_preview$/.test(r._uniqueId || '')) continue;
        const dauer = Number(r.plannedDauer != null ? r.plannedDauer : r.dauer) || 0;
        if (dauer < 10 || dauer > 360) continue;
        const created = /^train_[a-z0-9]+_(\d{13})/.exec(r._uniqueId || '');
        if (created) {
          const [y, m, d] = r.serviceDate.split('-').map(Number);
          const planMs = new Date(y, m - 1, d, 0, plan).getTime();
          if (Number(created[1]) >= planMs - 5 * 60000) continue; // retro-logged
        }
        const key = `${r.linie || ''}|${r.ziel || ''}`;
        if (!groups.has(key)) groups.set(key, { linie: r.linie || '', ziel: r.ziel || '', durations: [], plans: [], projectId: r.projectId || null });
        const g = groups.get(key);
        g.durations.push(dauer); g.plans.push(plan);
        perDay.set(r.serviceDate, (perDay.get(r.serviceDate) || 0) + 1);
      }
      const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      const items = [...groups.values()].map(g => ({
        linie: g.linie, ziel: g.ziel, n: g.durations.length, dauer: median(g.durations),
        plans: g.plans.slice(-30), projectId: g.projectId,
      }));
      res.set('Cache-Control', 'no-store');
      res.json({ items, perDayCounts: [...daysWithTrains].map(d => perDay.get(d) || 0) });
    } catch (e) {
      res.json({ items: [], perDayCounts: [] });
    }
  });

  return { router, servePage };
}

module.exports = { createSandbox };
