// === ITEM BINS ===
// Generic holding areas for removed objects of any type - the recycle bin
// today, an archive later. Each bin is one JSON file:
//   { items: [ { id, kind, typeLabel, label, detail, payload, addedAt } ] }
//
// `kind` names the type of object (journal-entry, project, ...) and `payload`
// is whatever that kind needs to put the object back. A bin doesn't know
// anything about the objects it holds; restoring hands the payload to the
// kind's restore handler:
//   - kinds whose data lives on the server (journal, lovemeter, logs)
//     register a handler here via registerKind();
//   - kinds owned by the browser (schedule objects in data.json) are restored
//     client-side, which then releases the item with DELETE.
//
// Routes (bin = "trash" | "archive" | ...):
//   GET    /api/bins/:bin           list items (expired ones purged first)
//   POST   /api/bins/:bin           { items: [{ kind, label, payload, ... }] } add
//   POST   /api/bins/:bin/restore   { ids } restore server-owned kinds
//   POST   /api/bins/:bin/move      { ids, to } move items into another bin
//   DELETE /api/bins/:bin           { ids } or { all: true } remove for good

const fsPromises = require('fs').promises;
const path = require('path');
const express = require('express');

const DAY_MS = 24 * 60 * 60 * 1000;

const bins = new Map();   // name -> { file, retentionDays }
const kinds = new Map();  // kind -> { restore(payload) }
const queues = new Map(); // name -> tail promise, serialises read-modify-write

function defineBin(name, { file, retentionDays = null }) {
  bins.set(name, { file, retentionDays });
}

function registerKind(kind, handler) {
  kinds.set(kind, handler);
}

function _withLock(name, fn) {
  const prev = queues.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(name, next.catch(() => {}));
  return next;
}

async function _read(name) {
  const bin = bins.get(name);
  let data;
  try {
    data = JSON.parse(await fsPromises.readFile(bin.file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') data = { items: [] };
    else throw e;
  }
  if (!Array.isArray(data.items)) data.items = [];
  if (bin.retentionDays) {
    const cutoff = Date.now() - bin.retentionDays * DAY_MS;
    data.items = data.items.filter(it => !it.addedAt || Date.parse(it.addedAt) >= cutoff);
  }
  return data;
}

async function _write(name, data) {
  await fsPromises.writeFile(bins.get(name).file, JSON.stringify(data, null, 2), 'utf8');
}

function _newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function _normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || !raw.kind) return null;
  return {
    id: _newId(),
    kind: raw.kind,
    typeLabel: typeof raw.typeLabel === 'string' ? raw.typeLabel.slice(0, 60) : '',
    label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : '',
    detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 300) : '',
    payload: raw.payload === undefined ? null : raw.payload,
    addedAt: new Date().toISOString(),
  };
}

// Add items to a bin. Usable from server code (e.g. a DELETE route moving
// its object into the trash) as well as through the POST route.
function addItems(name, rawItems) {
  return _withLock(name, async () => {
    const data = await _read(name);
    const added = rawItems.map(_normalizeItem).filter(Boolean);
    data.items.unshift(...added);
    await _write(name, data);
    return added;
  });
}

function removeItems(name, ids) {
  return _withLock(name, async () => {
    const data = await _read(name);
    const idSet = ids === 'all' ? null : new Set(ids);
    const removed = idSet ? data.items.filter(it => idSet.has(it.id)) : data.items;
    data.items = idSet ? data.items.filter(it => !idSet.has(it.id)) : [];
    await _write(name, data);
    return removed;
  });
}

// Restore server-owned items. Items whose kind has no server handler are
// left in the bin and reported back as `skipped` for the client to handle.
function restoreItems(name, ids) {
  return _withLock(name, async () => {
    const data = await _read(name);
    const idSet = new Set(ids);
    const restored = [];
    const skipped = [];
    const failed = [];
    for (const item of data.items.filter(it => idSet.has(it.id))) {
      const handler = kinds.get(item.kind);
      if (!handler || typeof handler.restore !== 'function') { skipped.push(item.id); continue; }
      try {
        await handler.restore(item.payload, item);
        restored.push(item.id);
      } catch (e) {
        failed.push({ id: item.id, error: e.message });
      }
    }
    const restoredSet = new Set(restored);
    data.items = data.items.filter(it => !restoredSet.has(it.id));
    await _write(name, data);
    return { restored, skipped, failed };
  });
}

async function moveItems(from, to, ids) {
  const moved = await removeItems(from, ids);
  if (!moved.length) return [];
  await _withLock(to, async () => {
    const data = await _read(to);
    const now = new Date().toISOString();
    data.items.unshift(...moved.map(it => ({ ...it, addedAt: now })));
    await _write(to, data);
  });
  return moved;
}

function _idsFrom(body) {
  if (body && body.all === true) return 'all';
  if (body && Array.isArray(body.ids)) return body.ids.filter(id => typeof id === 'string');
  return null;
}

function createRouter() {
  const router = express.Router();

  router.param('bin', (req, res, next, name) => {
    if (!bins.has(name)) return res.status(404).json({ error: 'Unknown bin: ' + name });
    next();
  });

  router.get('/:bin', async (req, res) => {
    try {
      const { bin } = req.params;
      const data = await _withLock(bin, () => _read(bin));
      res.json({ bin, retentionDays: bins.get(bin).retentionDays, items: data.items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:bin', async (req, res) => {
    try {
      const items = req.body && Array.isArray(req.body.items) ? req.body.items : null;
      if (!items || !items.length) return res.status(400).json({ error: 'expected { items: [...] }' });
      const added = await addItems(req.params.bin, items);
      res.json({ ok: true, items: added });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:bin/restore', async (req, res) => {
    try {
      const ids = _idsFrom(req.body);
      if (!Array.isArray(ids)) return res.status(400).json({ error: 'expected { ids: [...] }' });
      res.json({ ok: true, ...(await restoreItems(req.params.bin, ids)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:bin/move', async (req, res) => {
    try {
      const ids = _idsFrom(req.body);
      const to = req.body && req.body.to;
      if (!ids) return res.status(400).json({ error: 'expected { ids: [...] } or { all: true }' });
      if (!bins.has(to) || to === req.params.bin) return res.status(400).json({ error: 'invalid target bin' });
      const moved = await moveItems(req.params.bin, to, ids);
      res.json({ ok: true, count: moved.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/:bin', async (req, res) => {
    try {
      const ids = _idsFrom(req.body);
      if (!ids) return res.status(400).json({ error: 'expected { ids: [...] } or { all: true }' });
      const removed = await removeItems(req.params.bin, ids);
      res.json({ ok: true, count: removed.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { defineBin, registerKind, addItems, removeItems, restoreItems, moveItems, createRouter };
