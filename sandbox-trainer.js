// === SANDBOX TRAINER ===
// Fits the learned cost model (public/sandbox/engine/) on every finished,
// non-discarded sandbox level and writes sandbox_data/cost-model.json, which
// the sandbox page loads for its live predictions and level choice.
//
// Called by sandbox-server.js after a level is finished, discarded or
// restored. Rescheduling patterns (breaks, linked pairs, slack) are refitted
// every PATTERN_REFRESH levels from the levels up to that point; in between,
// every level's candidate set is cached, so a refit only enumerates the new
// level. The cost fit starts from the previous costs (same optimum, fewer
// steps).
//
// Starts from zero: no levels → the starting costs (PRIOR) and no patterns.
// Real days are not used (deliberately, while the model is being tested).

const fs = require('fs');
const path = require('path');
const P = require('./public/sandbox/engine/patterns.js');
const M = require('./public/sandbox/engine/cost-model.js');

const PATTERN_REFRESH = 5;

const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

function createTrainer({ modelFile, ranking }) {
  const cache = new Map();   // `${scenarioId}|${patternsKey}` → choice problem
  let last = null;           // { patternsKey, patterns, theta }

  function fit(episodes) {
    const t0 = Date.now();
    const kept = (episodes || []).filter(e => e && e.version === 2 && !e.discarded);
    const levels = kept.map(e => M.levelFromEpisode(e, ranking())).filter(Boolean);
    const upTo = Math.floor(levels.length / PATTERN_REFRESH) * PATTERN_REFRESH;
    const patternsKey = hash(levels.slice(0, upTo).map(l => l.ep.scenarioId).join(','));
    const patterns = last && last.patternsKey === patternsKey ? last.patterns : P.fitPatterns(levels.slice(0, upTo));
    for (const k of [...cache.keys()]) if (!k.endsWith(`|${patternsKey}`)) cache.delete(k);

    const problems = levels.map(l => {
      const key = `${l.ep.scenarioId}|${patternsKey}`;
      if (!cache.has(key)) cache.set(key, M.choiceProblem(l, { patterns, use: M.ALL_PATTERNS }));
      return cache.get(key);
    });
    const model = new M.CostModel();
    if (last && last.theta) model.theta = Object.assign({}, last.theta);
    if (problems.length) model.fit(problems);
    else model.theta = {};
    last = { patternsKey, patterns, theta: model.theta };

    const out = {
      version: 2,
      engine: M.ENGINE_VERSION,
      fittedAt: new Date().toISOString(),
      levels: levels.length,
      patternsFromLevels: upTo,
      patternRefresh: PATTERN_REFRESH,
      model: M.modelToJSON(model),
      patterns: P.patternsToJSON(patterns),
      stats: M.trainingStats(problems),
      fitMs: Date.now() - t0,
    };
    const tmp = modelFile + '.tmp';
    fs.mkdirSync(path.dirname(modelFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, modelFile);
    return out;
  }

  return { fit };
}

module.exports = { createTrainer, PATTERN_REFRESH, ENGINE_VERSION: M.ENGINE_VERSION };
