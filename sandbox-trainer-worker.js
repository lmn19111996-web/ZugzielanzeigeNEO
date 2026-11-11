// === SANDBOX TRAINER WORKER ===
// Runs sandbox-trainer.js in its own thread, so a refit (10 s and growing when
// all levels are recomputed) never blocks the server: Node handles requests on
// one thread, and a synchronous refit there froze the sandbox and the live app
// until it was done — saves timed out.
//
// Messages in:  { id, episodes }   → refit on these levels
// Messages out: { id, out } | { id, error }
// Keeps its trainer (and its cache of candidate sets) between refits.

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { createTrainer } = require('./sandbox-trainer');

const { modelFile, rootDir } = workerData;
const ranking = () => {
  try { return JSON.parse(fs.readFileSync(path.join(rootDir, 'app_settings.json'), 'utf8')).predictionModel.lineImportance || []; }
  catch (e) { return []; }
};
const trainer = createTrainer({ modelFile, ranking });

parentPort.on('message', ({ id, episodes }) => {
  try { parentPort.postMessage({ id, out: trainer.fit(episodes) }); }
  catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
