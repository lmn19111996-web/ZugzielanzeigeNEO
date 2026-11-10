// === ITEM BINS: RECYCLE BIN (AND LATER ARCHIVE) ===
// Client side of item-bins.js on the server. A bin holds removed objects of
// any type as { id, kind, typeLabel, label, detail, payload, addedAt }.
//
// Kinds stored on the server (journal-entry, lovemeter-point, log-entry) are
// trashed and restored by the server itself. Kinds that live in the browser's
// schedule (projects, entries, templates, ...) are registered below with a
// restore() that puts the payload back into `schedule`; after that the item is
// released from the bin. To make something new recoverable:
//   1. ItemBins.trash([{ kind, typeLabel, label, detail, payload }]) on delete
//   2. ItemBins.registerKind(kind, { restore(payload), commit() }) here

(function () {
  const _kinds = {};

  function registerKind(kind, handler) {
    _kinds[kind] = handler;
  }

  async function _json(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }

  async function list(bin) {
    return _json(await fetch('/api/bins/' + bin, { cache: 'no-store' }));
  }

  // Add items to a bin. Never blocks the delete that triggered it: offline,
  // the request goes through the outbox and is replayed on reconnect.
  async function put(bin, items) {
    const req = {
      url: '/api/bins/' + bin,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    };
    try {
      if (typeof window.isAppOnline === 'function' && !window.isAppOnline()) throw new Error('offline');
      return await _json(await fetch(req.url, req));
    } catch (e) {
      console.warn('[bins] Could not add to ' + bin + ', queueing:', e.message);
      if (window.offlineOutbox) await window.offlineOutbox.queue(req);
      return null;
    }
  }

  async function remove(bin, ids) {
    return _json(await fetch('/api/bins/' + bin, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids === 'all' ? { all: true } : { ids })
    }));
  }

  async function move(bin, ids, to) {
    return _json(await fetch('/api/bins/' + bin + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, to })
    }));
  }

  // Restore a mixed set of items: client kinds are put back locally (then
  // committed once per kind group and released), the rest go to the server.
  async function restore(bin, items) {
    const clientItems = items.filter(it => _kinds[it.kind]);
    const serverIds = items.filter(it => !_kinds[it.kind]).map(it => it.id);
    const failed = [];

    const released = [];
    const commits = new Set();
    for (const it of clientItems) {
      try {
        _kinds[it.kind].restore(it.payload, it);
        released.push(it.id);
        if (_kinds[it.kind].commit) commits.add(_kinds[it.kind].commit);
      } catch (e) {
        failed.push(it.label || it.id);
        console.error('[bins] Restore failed for', it, e);
      }
    }
    for (const commit of commits) await commit();
    if (released.length) await remove(bin, released);

    if (serverIds.length) {
      const result = await _json(await fetch('/api/bins/' + bin + '/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: serverIds })
      }));
      (result.failed || []).forEach(f => failed.push(f.id));
      (result.skipped || []).forEach(id => failed.push(id));
    }
    return { failed };
  }

  window.ItemBins = {
    registerKind, list, put, remove, move, restore,
    trash: items => put('trash', items),
  };

  // ── Trash helpers for schedule objects (call before removing them) ──────────

  const _clone = obj => JSON.parse(JSON.stringify(obj));

  function _entryTypeLabel(entry) {
    if (entry.type === 'note') return 'Notiz';
    if (typeof isInformationTrain === 'function' && isInformationTrain(entry)) return 'Information';
    return 'Zug';
  }

  // extra: { stemId, date } when deleting one instance of a recurring train
  window.trashScheduleEntry = function (entry, typeLabel, extra) {
    const typeName = typeLabel || _entryTypeLabel(entry);
    const label = typeName === 'Zug'
      ? [entry.linie, entry.ziel].filter(Boolean).join(' → ')
      : (entry.ziel || entry.linie || '');
    return ItemBins.trash([{
      kind: 'schedule-entry',
      typeLabel: typeName,
      label: label || typeName,
      detail: [entry.date, entry.plan].filter(Boolean).join(' · '),
      payload: { entry: _clone(entry), ...(extra || {}) }
    }]);
  };

  window.trashTemplate = function (stem, children) {
    return ItemBins.trash([{
      kind: 'template',
      typeLabel: 'Vorlage',
      label: [stem.linie, stem.ziel].filter(Boolean).join(' → ') || 'Vorlage',
      detail: [stem.plan, stem.startDate && ('ab ' + stem.startDate)].filter(Boolean).join(' · '),
      payload: { stem: _clone(stem), children: _clone(children || []) }
    }]);
  };

  // ── Client-owned kinds (schedule / data.json) ───────────────────────────────

  function _commitSchedule() {
    if (typeof materializeFromStems === 'function') materializeFromStems();
    regenerateTrainsFromSchedule();
    processTrainData(schedule);
    return saveSchedule();
  }

  function _pushUnique(arr, obj) {
    if (!obj || !obj._uniqueId) throw new Error('Missing _uniqueId');
    if (!arr.some(x => x._uniqueId === obj._uniqueId)) arr.push(obj);
  }

  // A single spontaneous entry: train, information, note, project task/todo.
  // For a deleted recurring instance, `stemId` + `date` undo its skipped date.
  registerKind('schedule-entry', {
    restore({ entry, stemId, date }) {
      schedule.spontaneousEntries = schedule.spontaneousEntries || [];
      if (stemId) {
        const stem = (schedule.fixedSchedule || []).find(s => s._uniqueId === stemId);
        if (stem && Array.isArray(stem.skippedDates)) {
          stem.skippedDates = stem.skippedDates.filter(d => d !== date);
        }
      }
      if (entry.projectId && !(schedule.projects || []).some(p => p._uniqueId === entry.projectId)) {
        entry.projectId = null;
      }
      _pushUnique(schedule.spontaneousEntries, entry);
    },
    commit: _commitSchedule
  });

  // A project; its trains were orphaned on delete and get re-attached if
  // they still exist and haven't been given another project since.
  registerKind('project', {
    restore({ project, orphanedIds }) {
      schedule.projects = schedule.projects || [];
      _pushUnique(schedule.projects, project);
      const ids = new Set(orphanedIds || []);
      (schedule.spontaneousEntries || []).forEach(t => {
        if (ids.has(t._uniqueId) && !t.projectId) t.projectId = project._uniqueId;
      });
    },
    commit: _commitSchedule
  });

  // A recurring template plus the instances removed with it. Future
  // instances are re-materialized from the template on commit anyway.
  registerKind('template', {
    restore({ stem, children }) {
      schedule.fixedSchedule = schedule.fixedSchedule || [];
      schedule.spontaneousEntries = schedule.spontaneousEntries || [];
      _pushUnique(schedule.fixedSchedule, stem);
      (children || []).forEach(c => {
        if (!schedule.spontaneousEntries.some(x => x._uniqueId === c._uniqueId)) schedule.spontaneousEntries.push(c);
      });
    },
    commit: _commitSchedule
  });

  registerKind('lovemeter-preset', {
    restore(preset) {
      const presets = lmPresetsLoad();
      if (!presets.some(p => p.id === preset.id)) presets.push(preset);
      lmPresetsSave(presets);
    }
  });

  // ── Recycle bin page ────────────────────────────────────────────────────────

  let _binFilterKind = '';      // '' = all kinds
  const _binSelected = new Set();

  function _fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function _daysLeft(iso, retentionDays) {
    if (!retentionDays || !iso) return null;
    const ms = Date.parse(iso) + retentionDays * 86400000 - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
  }

  function _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  async function _run(action) {
    try {
      const result = await action();
      if (result && result.failed && result.failed.length) {
        alert(result.failed.length + ' Einträge konnten nicht wiederhergestellt werden.');
      }
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
    _binSelected.clear();
    if (typeof window.refreshJournalDot === 'function') window.refreshJournalDot();
    renderRecycleBinPage();
  }

  async function renderRecycleBinPage() {
    const trainListEl = document.getElementById('train-list');
    if (!trainListEl) return;

    let data = { items: [], retentionDays: null };
    let loadError = null;
    try {
      data = await list('trash');
    } catch (e) {
      loadError = e;
      console.error('Failed to load trash:', e);
    }
    if (currentWorkspaceMode !== 'recycle-bin') return;

    const items = data.items || [];
    const byId = new Map(items.map(it => [it.id, it]));
    for (const id of [..._binSelected]) if (!byId.has(id)) _binSelected.delete(id);

    const typeLabels = new Map();
    items.forEach(it => { if (!typeLabels.has(it.kind)) typeLabels.set(it.kind, it.typeLabel || it.kind); });
    if (_binFilterKind && !typeLabels.has(_binFilterKind)) _binFilterKind = '';
    const shown = _binFilterKind ? items.filter(it => it.kind === _binFilterKind) : items;

    trainListEl.innerHTML = '';
    const page = _el('div', 'bin-page');

    // Header
    const header = _el('div', 'bin-header');
    header.appendChild(_el('h2', 'bin-title', 'Papierkorb'));
    if (items.length) {
      const emptyBtn = _el('button', 'bin-btn bin-btn--danger', 'Papierkorb leeren');
      emptyBtn.addEventListener('click', () => {
        if (!confirm(items.length + ' Einträge endgültig löschen? Das kann nicht rückgängig gemacht werden.')) return;
        _run(() => remove('trash', 'all'));
      });
      header.appendChild(emptyBtn);
    }
    page.appendChild(header);
    if (data.retentionDays) {
      page.appendChild(_el('div', 'bin-sub', 'Gelöschte Einträge werden nach ' + data.retentionDays + ' Tagen endgültig entfernt.'));
    }

    // Kind filter
    if (typeLabels.size > 1) {
      const filterBar = _el('div', 'reviews-filter-bar');
      const addChip = (kind, label) => {
        const btn = _el('button', 'reviews-filter-btn' + (_binFilterKind === kind ? ' active' : ''), label);
        btn.addEventListener('click', () => { _binFilterKind = kind; renderRecycleBinPage(); });
        filterBar.appendChild(btn);
      };
      addChip('', 'Alle (' + items.length + ')');
      typeLabels.forEach((label, kind) => {
        addChip(kind, label + ' (' + items.filter(it => it.kind === kind).length + ')');
      });
      page.appendChild(filterBar);
    }

    // Bulk action bar
    if (_binSelected.size) {
      const bar = _el('div', 'bin-bulk-bar');
      bar.appendChild(_el('span', 'bin-bulk-count', _binSelected.size + ' ausgewählt'));
      const selItems = () => [..._binSelected].map(id => byId.get(id)).filter(Boolean);
      const restoreBtn = _el('button', 'bin-btn', 'Wiederherstellen');
      restoreBtn.addEventListener('click', () => _run(() => restore('trash', selItems())));
      const deleteBtn = _el('button', 'bin-btn bin-btn--danger', 'Endgültig löschen');
      deleteBtn.addEventListener('click', () => {
        if (!confirm(_binSelected.size + ' Einträge endgültig löschen?')) return;
        _run(() => remove('trash', [..._binSelected]));
      });
      const clearBtn = _el('button', 'bin-btn bin-btn--ghost', 'Auswahl aufheben');
      clearBtn.addEventListener('click', () => { _binSelected.clear(); renderRecycleBinPage(); });
      bar.append(restoreBtn, deleteBtn, clearBtn);
      page.appendChild(bar);
    }

    // List
    const listEl = _el('div', 'bin-list');
    if (loadError) {
      listEl.appendChild(_el('div', 'reviews-empty', 'Papierkorb konnte nicht geladen werden.'));
    } else if (!shown.length) {
      listEl.appendChild(_el('div', 'reviews-empty', 'Der Papierkorb ist leer.'));
    } else {
      shown.forEach(it => listEl.appendChild(_buildRow(it, data.retentionDays)));
    }
    page.appendChild(listEl);

    trainListEl.appendChild(page);
    if (typeof updateBackToTopButton === 'function') updateBackToTopButton();
  }

  function _buildRow(it, retentionDays) {
    const row = _el('div', 'bin-row' + (_binSelected.has(it.id) ? ' is-selected' : ''));

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'bin-check';
    check.checked = _binSelected.has(it.id);
    check.setAttribute('aria-label', 'Auswählen');
    check.addEventListener('change', () => {
      if (check.checked) _binSelected.add(it.id); else _binSelected.delete(it.id);
      renderRecycleBinPage();
    });

    const body = _el('div', 'bin-row-body');
    const top = _el('div', 'bin-row-top');
    top.appendChild(_el('span', 'bin-type', it.typeLabel || it.kind));
    top.appendChild(_el('span', 'bin-label', it.label || '–'));
    body.appendChild(top);
    if (it.detail) body.appendChild(_el('div', 'bin-detail', it.detail));
    const left = _daysLeft(it.addedAt, retentionDays);
    body.appendChild(_el('div', 'bin-meta',
      'Gelöscht am ' + _fmtDate(it.addedAt) + (left !== null ? ' · noch ' + left + (left === 1 ? ' Tag' : ' Tage') : '')));

    const actions = _el('div', 'bin-row-actions');
    const restoreBtn = _el('button', 'bin-btn', 'Wiederherstellen');
    restoreBtn.addEventListener('click', () => _run(() => restore('trash', [it])));
    const deleteBtn = _el('button', 'bin-btn bin-btn--danger bin-btn--icon', '✕');
    deleteBtn.title = 'Endgültig löschen';
    deleteBtn.addEventListener('click', () => {
      if (!confirm('„' + (it.label || it.typeLabel) + '" endgültig löschen?')) return;
      _run(() => remove('trash', [it.id]));
    });
    actions.append(restoreBtn, deleteBtn);

    row.append(check, body, actions);
    return row;
  }

  window.renderRecycleBinPage = renderRecycleBinPage;
})();
