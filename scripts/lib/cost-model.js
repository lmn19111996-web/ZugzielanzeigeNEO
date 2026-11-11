// Node entry point for the cost model. The model itself lives in
// public/sandbox/engine/cost-model.js (shared with the browser sandbox); this
// file adds the prequential wrapper used by the offline scripts.

const M = require('../../public/sandbox/engine/cost-model.js');
const P = require('./patterns');
const { CostModel, choiceProblem, toPrediction, PRIOR, LAMBDA } = M;

// Prequential model for the replay harness: before each level, refit costs on
// all earlier levels only. With `use` (pattern switches), the patterns are
// refitted from earlier levels too — every `refreshEvery` levels, after which
// the choice sets of the earlier levels are rebuilt with them.
function prequentialCostModel({ use = null, label, prior = PRIOR, lambda = LAMBDA, refreshEvery = 5, slackFloor } = {}) {
  const history = [];
  const cache = new Map();
  let patterns = null, version = -1, theta = null;
  const problemOf = (l) => {
    const key = `${l.ep.scenarioId}|${use ? version : 'plain'}`;
    if (!cache.has(key)) cache.set(key, choiceProblem(l, { patterns: use ? patterns : null, use: use || {} }));
    return cache.get(key);
  };
  return {
    name: label || 'cost model',
    predict(level) {
      if (use) {
        const v = Math.floor(history.length / refreshEvery);
        if (v !== version) {
          version = v;
          patterns = P.fitPatterns(history, slackFloor != null ? { slackFloor } : {});
          for (const k of [...cache.keys()]) if (!k.endsWith(`|${version}`)) cache.delete(k);
        }
      }
      const model = new CostModel(prior, lambda);
      if (theta) model.theta = Object.assign({}, theta);
      if (history.length) { model.fit(history.map(problemOf)); theta = model.theta; }
      const problem = problemOf(level);
      return toPrediction(problem, model.choose(problem));
    },
    learn(level) { history.push(level); },
  };
}

module.exports = Object.assign({}, M, { prequentialCostModel });
