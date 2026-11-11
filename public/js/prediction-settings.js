// === PREDICTION MODEL SETTINGS PAGE ===
// Configures the parameters the disruption prediction engine will use.
// Stored in AppSettings under `predictionModel` (server-side, shared by all
// devices). Same draft/apply pattern as the main settings page: edits live in a
// local draft until "Anwenden"; "Zurück" discards and returns to Einstellungen.
//
// predictionModel.lineImportance: array of ranks, index 0 = #1 (most
// important). Each rank is an array of line names; lines in the same rank are
// equally important. Lines in no rank are "nicht eingestuft" (lowest).
//
// Task families: recurring templates with the same role (e.g. the 7 weekday
// templates of Morning Ritual). Automatic family = line + name, ignoring case,
// punctuation and [..] prefixes (keep familyName() in sync with
// public/sandbox/engine/patterns.js). predictionModel.familyOverrides maps a
// template id to another family key ("merge"), or to "solo:<id>" (its own
// family). The cost model learns per family.
//
// predictionModel.dayStartFamilies: families that mark the start of the day
// (e.g. Morning Ritual) — the one explicit rule of the cost model: such a train
// is never cancelled or moved behind another, and nothing planned after it can
// start before it does (public/sandbox/engine/candidates.js).
// dayStartTemplates: older per-template marking, still honoured.
//
// predictionModel.appointmentFamilies: fixed appointments (classes, Tennis …)
// — second explicit rule: the end is fixed, arriving late means attending
// less, never moved behind other trains. Prediction model only; the editor
// never adjusts what you enter.

const PREDICTION_MODEL_DEFAULTS = {
  lineImportance: [],
  familyOverrides: {},
  dayStartFamilies: [],
  appointmentFamilies: [],
  dayStartTemplates: []
};

function getPredictionModelSettings() {
  const stored = window.AppSettings ? window.AppSettings.get('predictionModel') : null;
  const merged = Object.assign({}, PREDICTION_MODEL_DEFAULTS, stored || {});
  merged.lineImportance = Array.isArray(merged.lineImportance)
    ? merged.lineImportance.filter(Array.isArray).map(tier => tier.map(String))
    : [];
  const strList = (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : []);
  merged.dayStartFamilies = strList(merged.dayStartFamilies);
  merged.appointmentFamilies = strList(merged.appointmentFamilies);
  merged.dayStartTemplates = strList(merged.dayStartTemplates);
  merged.familyOverrides = merged.familyOverrides && typeof merged.familyOverrides === 'object' && !Array.isArray(merged.familyOverrides)
    ? Object.assign({}, merged.familyOverrides) : {};
  return merged;
}

const _pmFamilyName = (ziel) => String(ziel || '').replace(/\[[^\]]*\]/g, '').toLowerCase().replace(/[!?.,:;]/g, '').replace(/\s+/g, ' ').trim();
const _pmAutoFamily = (t) => `${String((t && t.linie) || '').toUpperCase()}|${_pmFamilyName(t && t.ziel)}`;
const _pmTemplateId = (t) => (t && (t.templateId || t._sbxTemplateId || t._uniqueId || t.id)) || null;

// Family key of a recurring template ({ _uniqueId | templateId, linie, ziel }).
function getTaskFamily(t, settings) {
  const s = settings || getPredictionModelSettings();
  const id = _pmTemplateId(t);
  const o = id ? s.familyOverrides[id] : null;
  return o || _pmAutoFamily(t);
}

// Is this template a fixed appointment (by family)?
function isAppointmentTemplate(t, settings) {
  const s = settings || getPredictionModelSettings();
  return s.appointmentFamilies.includes(getTaskFamily(t, s));
}

// Is this template a day-start train (by family, or the older per-template marking)?
function isDayStartTemplate(t, settings) {
  const s = settings || getPredictionModelSettings();
  const id = _pmTemplateId(t);
  return s.dayStartFamilies.includes(getTaskFamily(t, s)) || (!!id && s.dayStartTemplates.includes(id));
}

// 1-based importance rank of a line, or null when it isn't ranked.
function getLineImportanceRank(linie) {
  if (!linie) return null;
  const key = String(linie).toUpperCase();
  const tiers = getPredictionModelSettings().lineImportance;
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i].some(l => l.toUpperCase() === key)) return i + 1;
  }
  return null;
}

window.PredictionModel = {
  getSettings: getPredictionModelSettings,
  getLineImportanceRank: getLineImportanceRank,
  getTaskFamily: getTaskFamily,
  isDayStartTemplate: isDayStartTemplate,
  isAppointmentTemplate: isAppointmentTemplate,
  DEFAULTS: PREDICTION_MODEL_DEFAULTS
};

let _pmDraft = null;

// Every line used anywhere in the schedule, plus lines already ranked (so a
// ranked line that's no longer scheduled can still be seen and removed).
function _pmKnownLines(draft) {
  const set = new Map(); // upper -> display
  const add = (l) => {
    const s = String(l || '').trim();
    if (s && !set.has(s.toUpperCase())) set.set(s.toUpperCase(), s);
  };
  if (typeof schedule !== 'undefined' && schedule) {
    (schedule.fixedSchedule || []).forEach(t => t && t.type !== 'note' && t.type !== 'information' && add(t.linie));
    (schedule.spontaneousEntries || []).forEach(t => t && t.type !== 'note' && t.type !== 'information' && add(t.linie));
  }
  draft.lineImportance.forEach(tier => tier.forEach(add));
  return [...set.values()].sort(_pmLineCompare);
}

// S2 < S10 < S41 < U1: letter prefix first, then the number numerically.
function _pmLineCompare(a, b) {
  const pa = /^([^\d]*)(\d*)(.*)$/.exec(a.toUpperCase());
  const pb = /^([^\d]*)(\d*)(.*)$/.exec(b.toUpperCase());
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  const na = pa[2] ? Number(pa[2]) : -1, nb = pb[2] ? Number(pb[2]) : -1;
  if (na !== nb) return na - nb;
  return pa[3] < pb[3] ? -1 : pa[3] > pb[3] ? 1 : 0;
}

function _pmRankedSet(draft) {
  const s = new Set();
  draft.lineImportance.forEach(tier => tier.forEach(l => s.add(l.toUpperCase())));
  return s;
}

function _pmRemoveLine(draft, line) {
  const key = line.toUpperCase();
  draft.lineImportance.forEach(tier => {
    const i = tier.findIndex(l => l.toUpperCase() === key);
    if (i !== -1) tier.splice(i, 1);
  });
}

// Moves `line` into rank `tierIdx`, or out of all ranks when tierIdx is null.
function _pmMoveLine(draft, line, tierIdx) {
  _pmRemoveLine(draft, line);
  if (tierIdx != null && draft.lineImportance[tierIdx]) {
    draft.lineImportance[tierIdx].push(line);
    draft.lineImportance[tierIdx].sort(_pmLineCompare);
  }
}

function _pmBuildChip(line, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'pm-chip';
  chip.draggable = true;
  chip.dataset.line = line;
  chip.title = line;

  const fallback = document.createElement('span');
  fallback.className = 'pm-chip-text';
  fallback.textContent = line;

  if (typeof getLineIconSrc === 'function') {
    const img = document.createElement('img');
    img.className = 'pm-chip-icon';
    img.alt = line;
    img.src = getLineIconSrc(line);
    img.addEventListener('error', function () { img.replaceWith(fallback); });
    chip.appendChild(img);
  } else {
    chip.appendChild(fallback);
  }

  if (onRemove) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pm-chip-remove';
    x.textContent = '✕';
    x.title = 'Einstufung entfernen';
    x.addEventListener('click', function (e) { e.stopPropagation(); onRemove(); });
    chip.appendChild(x);
  }

  chip.addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('text/plain', line);
    e.dataTransfer.effectAllowed = 'move';
    chip.classList.add('is-dragging');
  });
  chip.addEventListener('dragend', function () { chip.classList.remove('is-dragging'); });
  return chip;
}

function _pmMakeDropTarget(el, onDrop) {
  el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('is-drop-target'); });
  el.addEventListener('dragleave', function (e) {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop-target');
  });
  el.addEventListener('drop', function (e) {
    e.preventDefault();
    el.classList.remove('is-drop-target');
    const line = e.dataTransfer.getData('text/plain');
    if (line) onDrop(line);
  });
}

function _pmBuildImportanceSection() {
  const section = _buildSettingsSection(
    'Wichtigkeit nach Linie',
    'Rang #1 ist am wichtigsten. Linien im selben Rang sind gleich wichtig und teilen sich eine Zeile. ' +
    'Nicht eingestufte Linien gelten als am wenigsten wichtig. Linien per Drag & Drop verschieben oder über „+ Linie“ hinzufügen.'
  );

  const tableWrap = document.createElement('div');
  section.appendChild(tableWrap);

  function render() {
    tableWrap.innerHTML = '';
    const draft = _pmDraft;
    const known = _pmKnownLines(draft);
    const ranked = _pmRankedSet(draft);
    const unranked = known.filter(l => !ranked.has(l.toUpperCase()));

    const table = document.createElement('table');
    table.className = 'pm-rank-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th class="pm-col-rank">Rang</th><th>Linien</th><th class="pm-col-actions"></th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    draft.lineImportance.forEach(function (tier, idx) {
      const tr = document.createElement('tr');

      const rankTd = document.createElement('td');
      rankTd.className = 'pm-col-rank pm-rank-label';
      rankTd.textContent = '#' + (idx + 1);

      const linesTd = document.createElement('td');
      linesTd.className = 'pm-lines';
      tier.forEach(function (line) {
        linesTd.appendChild(_pmBuildChip(line, function () { _pmMoveLine(draft, line, null); render(); }));
      });
      if (!tier.length) {
        const empty = document.createElement('span');
        empty.className = 'pm-empty';
        empty.textContent = 'Leer — Linien hierher ziehen';
        linesTd.appendChild(empty);
      }
      if (unranked.length) {
        const select = document.createElement('select');
        select.className = 'settings-input pm-add-select';
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = '+ Linie';
        select.appendChild(ph);
        unranked.forEach(function (l) {
          const o = document.createElement('option');
          o.value = l;
          o.textContent = l;
          select.appendChild(o);
        });
        select.addEventListener('change', function () {
          if (select.value) { _pmMoveLine(draft, select.value, idx); render(); }
        });
        linesTd.appendChild(select);
      }
      _pmMakeDropTarget(linesTd, function (line) { _pmMoveLine(draft, line, idx); render(); });

      const actTd = document.createElement('td');
      actTd.className = 'pm-col-actions';
      const mkBtn = function (label, title, disabled, fn) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'settings-reason-remove pm-action';
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      actTd.append(
        mkBtn('↑', 'Rang nach oben', idx === 0, function () {
          const t = draft.lineImportance;
          [t[idx - 1], t[idx]] = [t[idx], t[idx - 1]];
          render();
        }),
        mkBtn('↓', 'Rang nach unten', idx === draft.lineImportance.length - 1, function () {
          const t = draft.lineImportance;
          [t[idx + 1], t[idx]] = [t[idx], t[idx + 1]];
          render();
        }),
        mkBtn('✕', 'Rang löschen (Linien werden nicht eingestuft)', false, function () {
          draft.lineImportance.splice(idx, 1);
          render();
        })
      );

      tr.append(rankTd, linesTd, actTd);
      tbody.appendChild(tr);
    });

    // Unranked pool
    const poolTr = document.createElement('tr');
    poolTr.className = 'pm-pool-row';
    const poolRank = document.createElement('td');
    poolRank.className = 'pm-col-rank pm-rank-label pm-rank-label--muted';
    poolRank.textContent = '—';
    const poolTd = document.createElement('td');
    poolTd.className = 'pm-lines';
    const poolLabel = document.createElement('span');
    poolLabel.className = 'pm-pool-label';
    poolLabel.textContent = 'Nicht eingestuft';
    poolTd.appendChild(poolLabel);
    unranked.forEach(function (l) { poolTd.appendChild(_pmBuildChip(l, null)); });
    if (!unranked.length) {
      const empty = document.createElement('span');
      empty.className = 'pm-empty';
      empty.textContent = 'Alle Linien sind eingestuft';
      poolTd.appendChild(empty);
    }
    _pmMakeDropTarget(poolTd, function (line) { _pmMoveLine(draft, line, null); render(); });
    poolTr.append(poolRank, poolTd, document.createElement('td'));
    tbody.appendChild(poolTr);

    table.appendChild(tbody);
    tableWrap.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'settings-add-reason';
    addBtn.textContent = '+ Rang hinzufügen';
    addBtn.addEventListener('click', function () {
      draft.lineImportance.push([]);
      render();
    });
    _pmMakeDropTarget(addBtn, function (line) {
      draft.lineImportance.push([]);
      _pmMoveLine(draft, line, draft.lineImportance.length - 1);
      render();
    });
    tableWrap.appendChild(addBtn);
  }

  render();
  return section;
}

// Recurring timed templates, for the family and day-start sections.
const _PM_WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function _pmWhen(t) {
  const r = t.recurrence || {};
  const p = r.pattern || 'weekdays';
  const wd = t.startDate ? _PM_WD[new Date(t.startDate + 'T12:00:00').getDay()] : '?';
  if (p === 'daily') return 'täglich';
  if (p === 'weekdays') return 'Mo–Fr';
  if (p === 'weekly') return wd;
  if (p === 'biweekly') return `${wd} (14-tägig)`;
  if (p === 'custom') return (r.days || []).map(d => _PM_WD[d]).join(', ') || '–';
  if (p === 'monthly') return 'monatlich';
  if (p === 'yearly') return 'jährlich';
  return p;
}
function _pmTimedTemplates() {
  const list = (typeof schedule !== 'undefined' && schedule && schedule.fixedSchedule) || [];
  return list
    .filter(t => t && t._uniqueId && !t.type && /^\d{1,2}:\d{2}/.test(String(t.plan || '')))
    .map(t => ({ _uniqueId: t._uniqueId, linie: t.linie || '', ziel: t.ziel || '', plan: String(t.plan).slice(0, 5), when: _pmWhen(t) }))
    .sort((a, b) => _pmLineCompare(a.linie, b.linie) || a.ziel.localeCompare(b.ziel) || a.plan.localeCompare(b.plan));
}

// Families as the draft defines them: key → { key, label, templates }.
function _pmFamilies(draft) {
  const fams = new Map();
  _pmTimedTemplates().forEach(t => {
    const key = getTaskFamily(t, draft);
    if (!fams.has(key)) fams.set(key, { key, templates: [] });
    fams.get(key).templates.push(t);
  });
  fams.forEach(f => {
    const counts = new Map();
    f.templates.forEach(t => { const l = `${t.linie} ${t.ziel}`.trim(); counts.set(l, (counts.get(l) || 0) + 1); });
    f.label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    f.linie = f.templates[0].linie;
  });
  return fams;
}

function _pmBuildFamiliesSection(onChange) {
  const section = _buildSettingsSection(
    'Aufgabenfamilien',
    'Vorlagen mit derselben Rolle bilden eine Familie, z. B. die sieben Morning Rituals der Woche. Das Modell lernt je Familie — ' +
    'was ein Wochentag zeigt, gilt für alle, und neue Vorlagen mit demselben Namen erben das Gelernte. ' +
    'Automatisch: gleiche Linie und gleicher Name (Groß-/Kleinschreibung, Satzzeichen und [..]-Vorsätze egal). ' +
    'Hier kannst du Familien zusammenführen oder eine Vorlage abtrennen.'
  );
  const wrap = document.createElement('div');
  section.appendChild(wrap);

  function setOverride(t, key) {
    const draft = _pmDraft;
    if (!key || key === _pmAutoFamily(t)) delete draft.familyOverrides[t._uniqueId];
    else draft.familyOverrides[t._uniqueId] = key;
  }

  function familyRow(f, fams) {
    const draft = _pmDraft;
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.className = 'pm-family-name';
    nameTd.textContent = f.label;
    const tplTd = document.createElement('td');
    tplTd.className = 'pm-lines';
    f.templates.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'pm-chip';
      const overridden = !!draft.familyOverrides[t._uniqueId];
      const name = `${t.linie} ${t.ziel}`.trim();
      chip.title = `${t.when} ${t.plan} · ${name}${overridden ? ' · von Hand zugeordnet' : ''}`;
      const text = document.createElement('span');
      text.className = 'pm-chip-text';
      text.textContent = `${t.when} ${t.plan}${name !== f.label ? ` · ${t.ziel}` : ''}${overridden ? ' ✎' : ''}`;
      chip.appendChild(text);
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pm-chip-remove';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', function (e) { e.stopPropagation(); fn(); render(); onChange(); });
        chip.appendChild(b);
      };
      if (overridden) mk('↺', 'Zurück in die automatische Familie', () => setOverride(t, null));
      else if (f.templates.length > 1) mk('✕', 'Aus der Familie abtrennen (eigene Familie)', () => setOverride(t, 'solo:' + t._uniqueId));
      tplTd.appendChild(chip);
    });
    const actTd = document.createElement('td');
    const others = [...fams.values()].filter(o => o.key !== f.key).sort((a, b) => _pmLineCompare(a.linie, b.linie) || a.label.localeCompare(b.label));
    if (others.length) {
      const select = document.createElement('select');
      select.className = 'settings-input pm-add-select';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = 'Zusammenführen mit …';
      select.appendChild(ph);
      others.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.key;
        opt.textContent = `${o.label} (${o.templates.length})`;
        select.appendChild(opt);
      });
      select.addEventListener('change', function () {
        if (!select.value) return;
        // Day-start / appointment marking follows the merged family.
        ['dayStartFamilies', 'appointmentFamilies'].forEach(list => {
          if (draft[list].includes(f.key) && !draft[list].includes(select.value)) draft[list].push(select.value);
          draft[list] = draft[list].filter(k => k !== f.key);
        });
        f.templates.forEach(t => setOverride(t, select.value));
        render(); onChange();
      });
      actTd.appendChild(select);
    }
    tr.append(nameTd, tplTd, actTd);
    return tr;
  }

  function table(rows) {
    const t = document.createElement('table');
    t.className = 'pm-rank-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Familie</th><th>Vorlagen</th><th class="pm-col-actions"></th></tr>';
    const tbody = document.createElement('tbody');
    rows.forEach(r => tbody.appendChild(r));
    t.append(thead, tbody);
    return t;
  }

  function render() {
    wrap.innerHTML = '';
    const draft = _pmDraft;
    const fams = _pmFamilies(draft);
    const list = [...fams.values()].sort((a, b) => _pmLineCompare(a.linie, b.linie) || a.label.localeCompare(b.label));
    const relevant = list.filter(f => f.templates.length > 1 || f.templates.some(t => draft.familyOverrides[t._uniqueId]));
    const singles = list.filter(f => !relevant.includes(f));
    if (relevant.length) wrap.appendChild(table(relevant.map(f => familyRow(f, fams))));
    else {
      const empty = document.createElement('p');
      empty.className = 'pm-empty';
      empty.textContent = 'Keine Familie mit mehreren Vorlagen.';
      wrap.appendChild(empty);
    }
    if (singles.length) {
      const details = document.createElement('details');
      details.className = 'pm-family-singles';
      const summary = document.createElement('summary');
      summary.textContent = `Einzelne Vorlagen (${singles.length}) — einer Familie zuordnen`;
      details.append(summary, table(singles.map(f => familyRow(f, fams))));
      wrap.appendChild(details);
    }
    const stale = Object.keys(draft.familyOverrides).filter(id => !_pmTimedTemplates().some(t => t._uniqueId === id));
    if (stale.length) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-add-reason';
      btn.textContent = `${stale.length} Zuordnung${stale.length === 1 ? '' : 'en'} gelöschter Vorlagen entfernen`;
      btn.addEventListener('click', function () { stale.forEach(id => delete draft.familyOverrides[id]); render(); onChange(); });
      wrap.appendChild(btn);
    }
  }

  render();
  section._pmRender = render;
  return section;
}

// A list of task families stored under draft[key] (day start, fixed
// appointments): chips with ✕ plus a "+ Familie" picker.
function _pmBuildFamilyPickSection(title, desc, key) {
  const section = _buildSettingsSection(title, desc);
  const wrap = document.createElement('div');
  wrap.className = 'pm-lines pm-family-pick';
  section.appendChild(wrap);

  function render() {
    wrap.innerHTML = '';
    const draft = _pmDraft;
    const fams = _pmFamilies(draft);
    draft[key].forEach(function (fk) {
      const f = fams.get(fk);
      const chip = document.createElement('span');
      chip.className = 'pm-chip';
      chip.title = f ? f.templates.map(t => `${t.when} ${t.plan}`).join(' · ') : 'Keine Vorlage in dieser Familie';
      const text = document.createElement('span');
      text.className = 'pm-chip-text';
      text.textContent = f ? `${f.label} (${f.templates.length} Vorlage${f.templates.length === 1 ? '' : 'n'})` : `${fk} (keine Vorlage)`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pm-chip-remove';
      x.textContent = '✕';
      x.title = 'Markierung entfernen';
      x.addEventListener('click', function () {
        draft[key] = draft[key].filter(v => v !== fk);
        render();
      });
      chip.append(text, x);
      wrap.appendChild(chip);
    });
    if (!draft[key].length) {
      const empty = document.createElement('span');
      empty.className = 'pm-empty';
      empty.textContent = 'Keine Familie markiert';
      wrap.appendChild(empty);
    }
    const free = [...fams.values()].filter(f => !draft[key].includes(f.key))
      .sort((a, b) => _pmLineCompare(a.linie, b.linie) || a.label.localeCompare(b.label));
    if (free.length) {
      const select = document.createElement('select');
      select.className = 'settings-input pm-add-select';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '+ Familie';
      select.appendChild(ph);
      free.forEach(function (f) {
        const o = document.createElement('option');
        o.value = f.key;
        o.textContent = `${f.label} (${f.templates.length})`;
        select.appendChild(o);
      });
      select.addEventListener('change', function () {
        if (select.value) { draft[key].push(select.value); render(); }
      });
      wrap.appendChild(select);
    }
  }

  render();
  section._pmRender = render;
  return section;
}

function _pmBuildDayStartSection() {
  return _pmBuildFamilyPickSection(
    'Tagesbeginn',
    'Familien, die markieren, wann du aufstehst (z. B. Morning Ritual). Das Modell lässt sie nie ausfallen und verlegt sie nie, ' +
    'und kein später geplanter Zug kann vor ihnen beginnen — wer verschläft, kann das Verpasste nicht nachholen, indem er das Ritual auslässt.',
    'dayStartFamilies'
  );
}

function _pmBuildAppointmentSection() {
  return _pmBuildFamilyPickSection(
    'Feste Termine',
    'Familien mit fester Uhrzeit, z. B. Vorlesungen, Übungen, Tennis. Ihr Ende steht fest: Sie enden nie später und schieben nichts danach. ' +
    'Wer zu spät kommt, ist kürzer dabei; wer erst nach dem Ende frei ist, kann nur ausfallen lassen. Sie werden nie nach hinten verlegt. ' +
    'Gilt nur fürs Prognosemodell — deine Eingaben im Editor werden nie automatisch angepasst.',
    'appointmentFamilies'
  );
}

function _pmReturnToSettings() {
  if (typeof window.setWorkspaceMode === 'function') window.setWorkspaceMode('settings');
}

function _pmBuildFooter() {
  const footer = document.createElement('div');
  footer.className = 'settings-footer';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'settings-footer-btn settings-footer-btn--discard';
  backBtn.textContent = 'Zurück';
  backBtn.addEventListener('click', function () {
    _pmDraft = null;
    _pmReturnToSettings();
  });

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'settings-footer-btn settings-footer-btn--apply';
  applyBtn.textContent = 'Anwenden';
  applyBtn.addEventListener('click', function () {
    const draft = _pmDraft;
    _pmDraft = null;
    draft.lineImportance = draft.lineImportance.filter(tier => tier.length); // drop empty ranks
    window.AppSettings.set('predictionModel', draft);
    applyBtn.disabled = true;
    backBtn.disabled = true;
    applyBtn.textContent = '✓ Gespeichert';
    setTimeout(_pmReturnToSettings, 500);
  });

  footer.append(backBtn, applyBtn);
  return footer;
}

async function renderPredictionSettingsPage() {
  const trainListEl = document.getElementById('train-list');
  if (!trainListEl) return;
  if (window.AppSettings && window.AppSettings.ready) await window.AppSettings.ready;

  // Keep an in-progress draft across re-renders (SSE refreshes re-run this).
  if (!_pmDraft) {
    _pmDraft = JSON.parse(JSON.stringify(getPredictionModelSettings()));
    // Older per-template day-start marking → the templates' families.
    if (_pmDraft.dayStartTemplates.length) {
      _pmTimedTemplates().forEach(t => {
        if (!_pmDraft.dayStartTemplates.includes(t._uniqueId)) return;
        const key = getTaskFamily(t, _pmDraft);
        if (!_pmDraft.dayStartFamilies.includes(key)) _pmDraft.dayStartFamilies.push(key);
      });
      _pmDraft.dayStartTemplates = [];
    }
  }

  trainListEl.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'settings-page';
  const scroll = document.createElement('div');
  scroll.className = 'settings-scroll';

  const header = document.createElement('div');
  header.className = 'settings-page-header';
  const titleEl = document.createElement('h2');
  titleEl.className = 'settings-page-title';
  titleEl.textContent = 'Prognosemodell';
  header.appendChild(titleEl);
  scroll.appendChild(header);

  scroll.appendChild(_pmBuildImportanceSection());
  // Day start lists families, so it re-renders when families change.
  const dayStart = _pmBuildDayStartSection();
  const appointments = _pmBuildAppointmentSection();
  scroll.appendChild(_pmBuildFamiliesSection(function () { dayStart._pmRender(); appointments._pmRender(); }));
  scroll.appendChild(dayStart);
  scroll.appendChild(appointments);

  page.appendChild(scroll);
  page.appendChild(_pmBuildFooter());
  trainListEl.appendChild(page);
}

window.renderPredictionSettingsPage = renderPredictionSettingsPage;
// Called by setWorkspaceMode when entering the page, so a draft abandoned via
// the nav rail (instead of Zurück) doesn't resurface on the next visit.
window.resetPredictionSettingsDraft = function () { _pmDraft = null; };
