// Loads the LEGACY browser-side sandbox modules (v2 hurdle model + its level
// generator, public/sandbox/legacy/) into Node, for the offline scripts that
// analyse the archived levels. They attach themselves to `window`; the two helpers
// they need from the app (stemMatchesDate, hasScheduleContent) are taken
// verbatim from public/js/schedule.js so the scripts use the app's own logic.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let loaded = null;

function loadSandboxModules() {
  if (loaded) return loaded;
  if (!global.window) global.window = {};
  const src = fs.readFileSync(path.join(ROOT, 'public/js/schedule.js'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
  };
  if (!global.isInformationTrain) global.isInformationTrain = (t) => t && t.type === 'information';
  if (!global.stemMatchesDate) global.stemMatchesDate = new Function(`${grab('stemMatchesDate')}; return stemMatchesDate;`)();
  if (!global.hasScheduleContent) global.hasScheduleContent = new Function('isInformationTrain', 'isDurationOnlyTrain', `${grab('hasScheduleContent')}; return hasScheduleContent;`)(global.isInformationTrain, (t) => t && t.type === 'duration-only');
  require(path.join(ROOT, 'public/sandbox/legacy/sandbox-model.js'));
  require(path.join(ROOT, 'public/sandbox/legacy/sandbox-levels.js'));
  loaded = { SB: window.SandboxModel, LV: window.SandboxLevels, ROOT };
  return loaded;
}

function currentRanking() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'app_settings.json'), 'utf8')).predictionModel.lineImportance || [];
  } catch (e) { return []; }
}

module.exports = { loadSandboxModules, currentRanking, ROOT };
