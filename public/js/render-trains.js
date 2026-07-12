// === TRAIN LIST & BELEGUNGSPLAN RENDERING ===

    // Marquee for long/combined notice tags (cancel + delayReason + auto-suggestions).
    // Unlike dashboard.js's applyViaScrolling (which scrolls to the end, pauses, then
    // resets), this scrolls infinitely: the text is duplicated back-to-back and the
    // loop point lands exactly where the duplicate lines up with the original, so it
    // never visibly "resets" — see startInfiniteMarquee (utils.js).
    function applyCancelNoticeScrolling(root) {
      (root || document).querySelectorAll('.cancel-notice-text').forEach(span => {
        if (typeof span._marqueeCancel === 'function') span._marqueeCancel();

        const container = span.parentElement;
        if (!container) return;
        const originalText = span.dataset.notice || '';
        if (!originalText) return;

        span.style.transition = 'none';
        span.style.transform = '';
        span.textContent = originalText;

        const scrollDist = span.scrollWidth - container.clientWidth;
        if (scrollDist <= 0) return;

        const segment = `${originalText}   +++   `;
        span.textContent = segment;
        const segmentWidth = span.scrollWidth;
        span.textContent = segment + segment;

        startInfiniteMarquee(span, segmentWidth);
      });
    }

    function renderHeadlineTrain() {
      const now = new Date();
      const firstTrainContainer = document.getElementById('first-train-container');
      const currentTrain = processedTrainData.currentTrain;
      const topRibbon = document.querySelector('.top-ribbon');
      
      if (currentTrain) {
        const existingEntry = firstTrainContainer.querySelector('.train-entry');
        const expandedCurrentZiel = expandDestinationPrefix(currentTrain.ziel || '');
        
        // Check if the train has changed - compare all train attributes
        const existingDeparture = existingEntry ? existingEntry.querySelector('[data-departure]') : null;
        const trainChanged = !existingDeparture || 
                           !existingEntry ||
                           existingEntry.dataset.linie !== (currentTrain.linie || '') ||
                           existingDeparture.dataset.plan !== currentTrain.plan ||
                           existingDeparture.dataset.actual !== (currentTrain.actual || '') ||
                           existingDeparture.dataset.date !== (currentTrain.date || '') ||
                           existingDeparture.dataset.dauer !== String(currentTrain.dauer || '') ||
                           existingDeparture.dataset.canceled !== String(currentTrain.canceled ? 'true' : 'false') ||
                           !existingEntry.querySelector('.zugziel') ||
                           (currentTrain.canceled
                             ? !existingEntry.querySelector('.canceled-ziel-toggle')
                             : existingEntry.querySelector('.zugziel').textContent !== expandedCurrentZiel);
        
        if (trainChanged) {
          // Only recreate if train changed
          const firstEntry = createTrainEntry(currentTrain, now, true);
          firstTrainContainer.innerHTML = '';
          firstTrainContainer.appendChild(firstEntry);
          requestAnimationFrame(() => applyCancelNoticeScrolling(firstTrainContainer));

          // Apply line color to top ribbon bottom border and update accent color
          if (topRibbon) {
            const lineColor = getLineColor(currentTrain.linie || 'S1');
            topRibbon.style.borderBottom = `0.4vh solid ${lineColor}`;
            currentAccentColor = lineColor; // Update global accent color for note headers
            
            // Update add button border color on mobile
            const addBtn = document.getElementById('add-train-button');
            if (addBtn) {
              addBtn.style.borderColor = lineColor;
            }
          }
        }
        // If train hasn't changed, updateClock() will handle the countdown update
      } else {
        firstTrainContainer.innerHTML = '';
        // Reset to default border color when no train
        if (topRibbon) {
          topRibbon.style.borderBottom = '0.3vh solid var(--color-divider)';
          currentAccentColor = 'var(--color-divider)'; // Reset accent color
          
          // Reset add button border color
          const addBtn = document.getElementById('add-train-button');
          if (addBtn) {
            addBtn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
          }
        }
      }
    }


    function renderTrains() {
      if (currentViewMode === 'belegungsplan') {
        renderBelegungsplan();
      } else {
        renderTrainList();
      }
    }
    
    /**
     * Conditional rendering - only render trains if in appropriate workspace mode, but always update header.
     * @deprecated Use renderCurrentWorkspaceView() instead for most cases, as it handles all workspace modes uniformly.
     * This function is kept for specific cases where you only want to update the train list without other panels.
     */
    function renderTrainsIfAppropriate() {
      renderHeadlineTrain(); // Always update header
      
      // Only render train content if in train-related workspace modes
      if (currentWorkspaceMode === 'list' || currentWorkspaceMode === 'occupancy') {
        renderTrains();
      }
    }

    let logViewerState = {
      from: '',
      to: '',
      rows: [],
      rawEntries: [],
      loading: false,
      loadedOnce: false,
      error: '',
      preset: '',
      query: '',
      searchOpen: false
    };

    function normalizeUmlautsForSearch(s) {
      return (s || '')
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss');
    }

    function filterLogViewerRows(rows, query) {
      const q = normalizeUmlautsForSearch((query || '').trim());
      if (!q) return rows;
      return rows.filter(t => {
        if (!t) return false;
        const stops = Array.isArray(t.zwischenhalte) ? t.zwischenhalte.join(' ') : '';
        return (
          normalizeUmlautsForSearch(t.linie || '').includes(q) ||
          normalizeUmlautsForSearch(t.ziel || '').includes(q) ||
          normalizeUmlautsForSearch(t.delayReason || '').includes(q) ||
          normalizeUmlautsForSearch(stops).includes(q)
        );
      });
    }

    function filterLogViewerRawEntries(entries, query) {
      const q = normalizeUmlautsForSearch((query || '').trim());
      if (!q) return entries;
      return entries.filter(e => {
        if (!e) return false;
        const rawStops = e.zwischenhalte != null ? e.zwischenhalte : e.stops;
        const stops = Array.isArray(rawStops) ? rawStops.join(' ') : String(rawStops || '');
        return (
          normalizeUmlautsForSearch(e.linie || '').includes(q) ||
          normalizeUmlautsForSearch(e.ziel || '').includes(q) ||
          normalizeUmlautsForSearch(e.delayReason || '').includes(q) ||
          normalizeUmlautsForSearch(stops).includes(q)
        );
      });
    }

    // Strips a raw log record down to what actually happened, for manual export
    // only (server-side diagnostic logs keep the full record). Drops id fields,
    // recurrence/template bookkeeping, the source week file, and the separate
    // delayReason/autoDelayReasons in favor of the single combined `notice`.
    function cleanLogEntryForExport(e) {
      return {
        date: e.date || e.serviceDate || e.plannedDate || '',
        linie: e.linie || '',
        ziel: e.ziel || '',
        plan: e.plan || '',
        actual: e.actual || '',
        dauer: Number(e.dauer) || 0,
        zwischenhalte: Array.isArray(e.zwischenhalte) ? e.zwischenhalte : [],
        canceled: Boolean(e.canceled),
        notice: e.notice || null,
        checkinTime: e.checkinTime || null,
        checkoutTime: e.checkoutTime || null,
        projectName: e.projectName || null
      };
    }

    // Exports the currently loaded date range as a single merged JSON file,
    // instead of the per-week .log files the server stores history in. Only
    // entries for what actually happened are kept - recurring-train stems,
    // duration-only templates, and note entries are template/meta data, not
    // occurrences, so they're excluded.
    function exportLogViewerRange() {
      const filtered = filterLogViewerRawEntries(logViewerState.rawEntries, logViewerState.query);
      const entries = filtered
        .filter(e => e && e.scheduleType !== 'fixed' && e.type !== 'duration-only' && e.type !== 'note')
        .map(cleanLogEntryForExport);
      const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `train_history_${logViewerState.from}_bis_${logViewerState.to}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // Log entries are historical records, not live schedule trains. The focus
    // panel (editor.js renderFocusMode) shows the same drawer as any other
    // train but only lets actual/dauer/canceled be edited (isLogEdit branches
    // there); these three functions are what it calls to persist those
    // changes and deletions to /api/train-history/entry - touching only the
    // one relevant weekly log file, never data.json.

    // Reflect a change in the already-loaded log viewer state so the list
    // behind the drawer is correct without a refetch.
    function applyLogEntryEditLocally(recordId, { actual, dauer, canceled, projectId, projectName }) {
      const raw = logViewerState.rawEntries.find(e => e && e.recordId === recordId);
      if (raw) {
        raw.actual = actual;
        raw.dauer = dauer;
        raw.canceled = canceled;
        if (projectId !== undefined) raw.projectId = projectId;
        if (projectName !== undefined) raw.projectName = projectName;
      }
      const row = logViewerState.rows.find(t => t && t._logRecordId === recordId);
      if (row) {
        row.actual = actual || row.plan;
        row.dauer = dauer;
        row.canceled = canceled;
        if (projectId !== undefined) row.projectId = projectId;
        if (projectName !== undefined) row.projectName = projectName;
      }
      if (currentWorkspaceMode === 'log-viewer') renderLogViewerWorkspace();
    }

    function removeLogEntryLocally(recordId) {
      logViewerState.rawEntries = logViewerState.rawEntries.filter(e => !e || e.recordId !== recordId);
      logViewerState.rows = logViewerState.rows.filter(t => !t || t._logRecordId !== recordId);
      if (currentWorkspaceMode === 'log-viewer') renderLogViewerWorkspace();
    }

    async function saveLogEntryEdit(train) {
      if (!train._logRecordId) {
        console.warn('Log entry has no recordId, cannot save:', train);
        return;
      }
      const project = train.projectId ? (schedule.projects || []).find(p => p._uniqueId === train.projectId) : null;
      const projectName = project ? (project.name || null) : null;
      try {
        const res = await fetch('/api/train-history/entry', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordId: train._logRecordId,
            date: train.date,
            actual: train.actual || '',
            dauer: Number(train.dauer) || 0,
            canceled: !!train.canceled,
            projectId: train.projectId || null,
            projectName
          })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        train.projectName = projectName;
        applyLogEntryEditLocally(train._logRecordId, {
          actual: train.actual || '',
          dauer: Number(train.dauer) || 0,
          canceled: !!train.canceled,
          projectId: train.projectId || null,
          projectName
        });
      } catch (err) {
        console.error('Failed to save log entry:', err);
        alert('Fehler beim Speichern: ' + (err.message || 'Unbekannter Fehler'));
      } finally {
        renderFocusMode(train);
      }
    }

    async function toggleLogEntryCanceled(train) {
      if (!train._logRecordId) return;
      const nextCanceled = !train.canceled;
      try {
        const res = await fetch('/api/train-history/entry', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordId: train._logRecordId, date: train.date, canceled: nextCanceled })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        train.canceled = nextCanceled;
        applyLogEntryEditLocally(train._logRecordId, {
          actual: train.actual || '',
          dauer: Number(train.dauer) || 0,
          canceled: nextCanceled
        });
      } catch (err) {
        console.error('Failed to toggle log entry cancellation:', err);
        alert('Fehler beim Speichern: ' + (err.message || 'Unbekannter Fehler'));
      } finally {
        renderFocusMode(train);
      }
    }

    async function deleteLogEntry(train, panel) {
      if (!train._logRecordId) return;
      try {
        const res = await fetch('/api/train-history/entry', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordId: train._logRecordId, date: train.date })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        removeLogEntryLocally(train._logRecordId);
        desktopFocusedTrainId = null;
        if (panel) panel.innerHTML = '<div style="color: white; padding: 2vh; text-align: center;">Log-Eintrag gelöscht</div>';
        closeEditorDrawer();
      } catch (err) {
        console.error('Failed to delete log entry:', err);
        alert('Fehler beim Löschen: ' + (err.message || 'Unbekannter Fehler'));
      }
    }

    // Ctrl+F inside the log viewer toggles this local search instead of the
    // global train search (openSearch() in mobile.html), which would otherwise
    // replace the log viewer page with unrelated results from the live schedule.
    function toggleLogViewerSearch() {
      const input = document.getElementById('log-viewer-search-input');
      if (!input) return;
      if (document.activeElement === input) {
        input.value = '';
        logViewerState.query = '';
        input.blur();
        renderLogViewerWorkspace();
      } else {
        logViewerState.searchOpen = true;
        input.focus();
        input.select();
      }
    }
    let durationOnlyExpandedByDate = {};

    function toDateInputValue(date) {
      const d = date instanceof Date ? date : new Date(date);
      if (Number.isNaN(d.getTime())) return '';
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }

    function ensureLogViewerDefaults() {
      if (!logViewerState.from || !logViewerState.to) {
        const now = new Date();
        const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        logViewerState.from = toDateInputValue(from);
        logViewerState.to = toDateInputValue(now);
        if (!logViewerState.preset) logViewerState.preset = 'week';
      }
    }

    function normalizeLogEntryToTrain(entry, index) {
      const now = new Date();
      const rawStops = entry && (entry.zwischenhalte != null ? entry.zwischenhalte : entry.stops);
      const stopsArr = Array.isArray(rawStops)
        ? rawStops.map(s => String(s).trim()).filter(Boolean)
        : (typeof rawStops === 'string'
            ? rawStops.split(/\n|\u2022|\|/).map(s => s.trim()).filter(Boolean)
            : []);

      const dateStr = (entry && (entry.date || entry.plannedDate)) || '';
      const ts = parseTime((entry && (entry.actual || entry.plan)) || '', now, dateStr);
      const isPast = !!(ts && ts < now);

      return {
        _uniqueId: (entry && (entry._uniqueId || entry.trainKey)) || `log_${index}_${Date.now()}`,
        linie: (entry && entry.linie) || 'LOG',
        ziel: (entry && entry.ziel) || '(ohne Ziel)',
        plan: (entry && (entry.plan || entry.actual)) || '',
        actual: (entry && (entry.actual || entry.plan)) || '',
        dauer: Number(entry && entry.dauer) || 0,
        date: (entry && (entry.date || entry.plannedDate)) || '',
        type: (entry && entry.type) || 'normal',
        projectId: (entry && entry.projectId) || null,
        projectName: (entry && entry.projectName) || null,
        zwischenhalte: stopsArr,
        canceled: !!(entry && entry.canceled),
        // Carry the persisted manual reason and the save-time auto-suggestion
        // snapshot through to Templates.trainEntry, which already combines them
        // (+ any inline "[...]" Zwischenhalt notice) into the notice tag —
        // no template changes needed, just feeding it the right field names
        // (the log record calls the auto list `autoDelayReasons`, the live train
        // object calls it `_delayReasonAuto`).
        delayReason: (entry && entry.delayReason) || '',
        _delayReasonAuto: (entry && Array.isArray(entry.autoDelayReasons)) ? entry.autoDelayReasons : [],
        _readOnly: true,
        _showDurationColumn: true,
        _isPastTrain: isPast,
        checkinTime: entry && entry.checkinTime ? entry.checkinTime : null,
        checkoutTime: entry && entry.checkoutTime ? entry.checkoutTime : null,
        _logRecordId: (entry && entry.recordId) || null,
        source: 'log'
      };
    }

    function applyLogViewerPreset(preset) {
      const now = new Date();
      const to = new Date(now);
      let from = new Date(now);

      if (preset === 'week') {
        from.setDate(from.getDate() - 7);
      } else if (preset === 'month') {
        from.setMonth(from.getMonth() - 1);
      } else if (preset === 'year') {
        from.setFullYear(from.getFullYear() - 1);
      } else if (preset === 'all') {
        from = new Date(0);
      } else {
        from.setDate(from.getDate() - 7);
        preset = 'week';
      }

      logViewerState.from = toDateInputValue(from);
      logViewerState.to = toDateInputValue(to);
      logViewerState.preset = preset;
    }

    async function fetchLogViewerRange() {
      ensureLogViewerDefaults();

      logViewerState.loading = true;
      logViewerState.error = '';
      renderLogViewerWorkspace();

      try {
        const fromIso = new Date(`${logViewerState.from}T00:00:00`).toISOString();
        const toIso = new Date(`${logViewerState.to}T23:59:59.999`).toISOString();
        const url = `/api/train-history/range?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&fromDate=${encodeURIComponent(logViewerState.from)}&toDate=${encodeURIComponent(logViewerState.to)}&limit=10000`;
        const res = await fetch(url);
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        logViewerState.rawEntries = entries;
        logViewerState.rows = entries.map(normalizeLogEntryToTrain).filter(t => t.plan || t.actual);
        logViewerState.loadedOnce = true;
      } catch (err) {
        console.error('Failed to load log viewer range:', err);
        logViewerState.rawEntries = [];
        logViewerState.rows = [];
        logViewerState.error = err && err.message ? err.message : 'Unbekannter Fehler';
        logViewerState.loadedOnce = true;
      } finally {
        logViewerState.loading = false;
        renderLogViewerWorkspace();
      }
    }

    function renderLogViewerWorkspace() {
      const trainListEl = document.getElementById('train-list');
      if (!trainListEl) return;

      renderHeadlineTrain();
      trainListEl.innerHTML = '';
      trainListEl.classList.add('log-viewer-mode');
      ensureLogViewerDefaults();

      const page = document.createElement('div');
      page.className = 'log-viewer-page';

      const header = document.createElement('div');
      header.className = 'log-viewer-page-header';
      header.innerHTML = `
        <div>
          <h2 class="log-viewer-page-title">Log Viewer</h2>
        </div>
      `;
      page.appendChild(header);

      const actions = document.createElement('div');
      actions.className = 'log-viewer-page-actions';
      actions.innerHTML = `
        <div class="log-viewer-date-row">
          <label class="log-viewer-label" for="log-viewer-from">Von</label>
          <input id="log-viewer-from" class="log-viewer-input" type="date" value="${logViewerState.from}">
          <span class="log-viewer-date-sep" aria-hidden="true">-</span>
          <label class="log-viewer-label" for="log-viewer-to">Bis</label>
          <input id="log-viewer-to" class="log-viewer-input" type="date" value="${logViewerState.to}">
          <button id="log-viewer-load" class="log-viewer-load-btn" type="button">Laden</button>
          <button id="log-viewer-export" class="log-viewer-export-btn" type="button" ${logViewerState.loadedOnce ? '' : 'disabled'}>Exportieren</button>
        </div>
      `;
      page.appendChild(actions);

      const presets = document.createElement('div');
      presets.className = 'log-viewer-filter-bar';
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', 'Zeitraum presets');
      presets.innerHTML = `
        <button class="log-viewer-preset-btn${logViewerState.preset === 'week' ? ' active' : ''}" data-preset="week" type="button">Letzte Woche</button>
        <button class="log-viewer-preset-btn${logViewerState.preset === 'month' ? ' active' : ''}" data-preset="month" type="button">Letzter Monat</button>
        <button class="log-viewer-preset-btn${logViewerState.preset === 'year' ? ' active' : ''}" data-preset="year" type="button">Letztes Jahr</button>
        <button class="log-viewer-preset-btn${logViewerState.preset === 'all' ? ' active' : ''}" data-preset="all" type="button">Alles</button>
        <div class="log-viewer-search-wrap">
          <svg class="log-viewer-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/></svg>
          <input type="text" id="log-viewer-search-input" class="log-viewer-search-input" placeholder="Linie, Ziel, Zwischenhalt …" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${logViewerState.query.replace(/"/g, '&quot;')}">
        </div>
      `;
      page.appendChild(presets);

      const status = document.createElement('div');
      status.className = 'log-viewer-status';
      if (logViewerState.loading) {
        status.textContent = 'Lade Logs...';
      } else if (logViewerState.error) {
        status.textContent = `Fehler: ${logViewerState.error}`;
      } else if (logViewerState.loadedOnce) {
        status.textContent = `${logViewerState.rows.length} Einträge im gewählten Zeitraum`;
      } else {
        status.textContent = 'Bereit';
      }
      page.appendChild(status);

      const results = document.createElement('div');
      results.className = 'log-viewer-list';
      page.appendChild(results);

      trainListEl.appendChild(page);

      const fromInput = actions.querySelector('#log-viewer-from');
      const toInput = actions.querySelector('#log-viewer-to');
      const loadBtn = actions.querySelector('#log-viewer-load');
      const exportBtn = actions.querySelector('#log-viewer-export');
      const presetButtons = presets.querySelectorAll('.log-viewer-preset-btn');
      if (fromInput) {
        fromInput.addEventListener('change', () => {
          logViewerState.from = fromInput.value;
          logViewerState.preset = '';
        });
      }
      if (toInput) {
        toInput.addEventListener('change', () => {
          logViewerState.to = toInput.value;
          logViewerState.preset = '';
        });
      }
      presetButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          applyLogViewerPreset(btn.dataset.preset || 'week');
          renderLogViewerWorkspace();
          fetchLogViewerRange();
        });
      });
      if (loadBtn) {
        loadBtn.disabled = logViewerState.loading;
        loadBtn.addEventListener('click', () => {
          if (fromInput && fromInput.value) logViewerState.from = fromInput.value;
          if (toInput && toInput.value) logViewerState.to = toInput.value;
          fetchLogViewerRange();
        });
      }
      if (exportBtn) {
        exportBtn.disabled = logViewerState.loading || !logViewerState.loadedOnce;
        exportBtn.addEventListener('click', () => {
          exportLogViewerRange();
        });
      }

      const handleEnterToLoad = (evt) => {
        if (evt.key !== 'Enter') return;
        evt.preventDefault();
        if (fromInput && fromInput.value) logViewerState.from = fromInput.value;
        if (toInput && toInput.value) logViewerState.to = toInput.value;
        fetchLogViewerRange();
      };

      const handleDateTabOrder = (evt) => {
        if (evt.key !== 'Tab' || !fromInput || !toInput) return;
        if (evt.target === fromInput && !evt.shiftKey) {
          evt.preventDefault();
          toInput.focus();
          return;
        }
        if (evt.target === toInput && evt.shiftKey) {
          evt.preventDefault();
          fromInput.focus();
        }
      };

      if (fromInput) {
        fromInput.addEventListener('keydown', handleEnterToLoad);
        fromInput.addEventListener('keydown', handleDateTabOrder);
      }
      if (toInput) {
        toInput.addEventListener('keydown', handleEnterToLoad);
        toInput.addEventListener('keydown', handleDateTabOrder);
      }

      function renderLogViewerResults() {
        results.innerHTML = '';
        const filteredRows = filterLogViewerRows(logViewerState.rows, logViewerState.query);
        if (!logViewerState.loading && filteredRows.length > 0) {
          renderTrainListWithEntries(filteredRows, {
            showHeadline: false,
            preserveScroll: false,
            enableSwipe: false,
            enableDateJump: false,
            append: false,
            targetEl: results
          });
        } else if (!logViewerState.loading && logViewerState.loadedOnce && !logViewerState.error) {
          const empty = document.createElement('div');
          empty.className = 'log-viewer-empty';
          empty.textContent = logViewerState.query
            ? 'Keine Einträge für diese Suche.'
            : 'Keine Einträge im gewählten Zeitraum.';
          results.appendChild(empty);
        }
      }
      renderLogViewerResults();

      const searchInput = presets.querySelector('#log-viewer-search-input');
      if (searchInput) {
        if (logViewerState.searchOpen) {
          searchInput.focus();
          const v = searchInput.value;
          searchInput.value = '';
          searchInput.value = v;
          logViewerState.searchOpen = false;
        }
        searchInput.addEventListener('input', () => {
          logViewerState.query = searchInput.value;
          renderLogViewerResults();
        });
        searchInput.addEventListener('keydown', (evt) => {
          if (evt.key === 'Escape') {
            searchInput.value = '';
            logViewerState.query = '';
            searchInput.blur();
            renderLogViewerResults();
          }
        });
      }

      if (!logViewerState.loadedOnce && !logViewerState.loading) {
        fetchLogViewerRange();
      }
    }

    /**
     * Unified decision helper function that checks the current workspace mode
     * and calls the correct rendering functions.
     * 
     * WORKSPACE MODES (main panel content):
     * - 'list' or 'occupancy': Train workspace (list or belegungsplan view)
    * - 'projects': Projects workspace
     * - 'reviews': Rezensionen workspace
    * - 'log-viewer': Time-range log viewer workspace
     * 
     * Non-workspace modes (drawers/overlays):
     * - 'announcements', 'db-api' are NOT workspaces
     * 
     * @param {Object} options - Optional configuration
     * @param {boolean} options.includeAnnouncements - Whether to render announcements panel (default: true)
     * @param {boolean} options.includeHeadline - Whether to render headline train (default: true)
     */
    function renderCurrentWorkspaceView(options = {}) {
      const { 
        includeAnnouncements = true,
        includeHeadline = true 
      } = options;

      // Refresh dashboard if it is currently open
      if (typeof window.renderDashboardIfOpen === 'function') window.renderDashboardIfOpen();
      
      // Render based on current workspace mode (only 3 actual workspaces)
      switch (currentWorkspaceMode) {
        case 'list':
        case 'occupancy':
          // Train workspace (list or occupancy view)
          renderTrains();
          if (includeAnnouncements) {
            renderComprehensiveAnnouncementPanel();
          }
          break;
          
        case 'projects':
          // Projects workspace
          if (includeHeadline) {
            renderHeadlineTrain(); // Still show current train in headline
          }
          renderProjectsPage();
          if (includeAnnouncements) {
            renderComprehensiveAnnouncementPanel();
          }
          break;
          
        case 'reviews':
          // Reviews workspace
          if (includeHeadline) {
            renderHeadlineTrain();
          }
          renderReviewsPage();
          if (includeAnnouncements) {
            renderComprehensiveAnnouncementPanel();
          }
          break;

        case 'log-viewer':
          // Log viewer workspace
          if (includeHeadline) {
            renderHeadlineTrain();
          }
          renderLogViewerWorkspace();
          if (includeAnnouncements) {
            renderComprehensiveAnnouncementPanel();
          }
          break;

        case 'vorlagen':
          // Recurring trains dashboard
          if (includeHeadline) {
            renderHeadlineTrain();
          }
          renderVorlagenPage();
          if (includeAnnouncements) {
            renderComprehensiveAnnouncementPanel();
          }
          break;

        case 'settings':
          // Settings workspace
          if (includeHeadline) {
            renderHeadlineTrain();
          }
          renderSettingsPage();
          if (includeAnnouncements) {
            renderComprehensiveAnnouncementPanel();
          }
          break;

        case 'note-editor':
          // Inline note editor owns #train-list directly (via renderFocusMode) while
          // active - re-rendering here would clobber it, so this is intentionally a no-op.
          break;

        default:
          // Should not happen - defensive fallback
          console.warn('Unknown workspace mode:', currentWorkspaceMode);
          break;
      }
    }

    // Belegungsplan (Occupancy Plan) - unified day/week view.
    // A shared header (toggle button + date label opening a date picker + prev/next)
    // sits above the content area, which renders either a single-day timeline
    // or a Monday-Sunday week grid depending on belegungsplanDisplayMode.
    const DAY_HOUR_HEIGHT_VH = 7;   // day view: 1 hour = 7vh (content scrolls, so a fixed scale is fine)

    let belegungsplanDisplayMode = 'day'; // 'day' | 'week'
    let belegungsplanSelectedDate = new Date(); // any date within the viewed day/week

    function getIsoWeekNumber(date) {
      const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    }

    function getMondayOf(date) {
      const day = date.getDay() || 7; // Sunday -> 7
      const monday = new Date(date);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - (day - 1));
      return monday;
    }

    // Renders overlap-detected train blocks into a container. dayTrains items carry
    // pos.top/pos.height as plain numbers (in `unit`s); shared by both the day and
    // week content builders, which use 'vh' and '%' respectively.
    function renderOverlappingTrainBlocks(containerEl, dayTrains, now, unit = 'vh') {
      const activeOverlapBlocks = []; // { end, level }
      dayTrains.forEach((item) => {
        for (let i = activeOverlapBlocks.length - 1; i >= 0; i--) {
          if (activeOverlapBlocks[i].end <= item.pos.start) activeOverlapBlocks.splice(i, 1);
        }
        let maxActiveLevel = -1;
        for (const b of activeOverlapBlocks) {
          if (b.level > maxActiveLevel) maxActiveLevel = b.level;
        }
        const overlapLevel = Math.min(maxActiveLevel + 1, 3); // Max 4 levels (0-3)
        item.overlapLevel = overlapLevel;
        activeOverlapBlocks.push({ end: item.pos.end, level: overlapLevel });
      });

      dayTrains.forEach(({ train, pos, overlapLevel }) => {
        const cssPos = { top: `${pos.top}${unit}`, height: `${pos.height}${unit}` };
        const htmlString = Templates.belegungsplanBlock(train, cssPos, overlapLevel, now);
        const template = document.createElement('template');
        template.innerHTML = htmlString.trim();
        const block = template.content.firstChild;
        block.addEventListener('click', () => {
          renderFocusMode(train);
          document.querySelectorAll('.belegungsplan-train-block').forEach(b => b.classList.remove('selected'));
          block.classList.add('selected');
        });
        containerEl.appendChild(block);
      });
    }

    // Builds the day view: one continuous hour-by-hour timeline (unchanged from the
    // original Belegungsplan - spans from today onward, or further back/forward if the
    // selected date falls outside that range). The header's date navigation doesn't
    // change *what's* rendered - it only scrolls this continuous list to that day's
    // position. Returns { currentTimeLineEl, selectedDayMarkerEl } so the caller can
    // decide where to scroll.
    function buildBelegungsplanDayContent(contentEl, selectedDate, now) {
      const belegungsplan = document.createElement('div');
      belegungsplan.className = 'belegungsplan';

      const allScheduledTrains = processedTrainData.scheduledTrains.filter(t => !t.canceled);

      const todayMidnight = new Date(now);
      todayMidnight.setHours(0, 0, 0, 0);

      // Start at today's midnight, or earlier still if a currently-occupying train
      // started before that (e.g. an overnight service that began yesterday).
      // The rendered range is driven purely by actual data - it never stretches
      // to reach an out-of-range selected date (there'd just be empty space to
      // scroll through); see the scroll-target guard in renderBelegungsplan.
      let startHour = todayMidnight;

      const currentTrain = processedTrainData.currentTrain;
      if (currentTrain) {
        const currentTrainTime = parseTime(currentTrain.actual || currentTrain.plan, now, currentTrain.date);
        if (currentTrainTime) {
          const currentTrainHour = new Date(currentTrainTime);
          currentTrainHour.setMinutes(0, 0, 0);
          if (currentTrainHour < startHour) startHour = currentTrainHour;
        }
      }

      // Always show at least a full 24h day, plus a 2h buffer past the latest
      // scheduled train end.
      let latestTime = new Date(todayMidnight.getTime() + 24 * 60 * 60 * 1000);
      allScheduledTrains.forEach(train => {
        const trainEnd = getOccupancyEnd(train, now);
        if (trainEnd && trainEnd > latestTime) latestTime = trainEnd;
      });
      const endTime = new Date(latestTime.getTime() + 2 * 60 * 60 * 1000);

      const totalHours = Math.ceil((endTime - startHour) / (60 * 60 * 1000));
      const totalHeight = totalHours * DAY_HOUR_HEIGHT_VH;
      belegungsplan.style.minHeight = `${totalHeight}vh`;

      let lastDate = null;
      let selectedDayMarkerEl = null;
      const selectedDateStr = selectedDate.toLocaleDateString('sv-SE');
      for (let i = 0; i <= totalHours; i++) {
        const markerTime = new Date(startHour.getTime() + i * 60 * 60 * 1000);
        const markerY = i * DAY_HOUR_HEIGHT_VH;
        const isNewDay = markerTime.getHours() === 0;
        const currentDate = markerTime.toLocaleDateString('sv-SE');

        if (isNewDay && currentDate !== lastDate) {
          const dateSeparatorHTML = Templates.belegungsplanDateSeparator(markerTime, markerY);
          const template = document.createElement('template');
          template.innerHTML = dateSeparatorHTML.trim();
          const separatorEl = template.content.firstChild;
          belegungsplan.appendChild(separatorEl);
          lastDate = currentDate;
          if (currentDate === selectedDateStr) selectedDayMarkerEl = separatorEl;
        }

        const hourLineHTML = Templates.belegungsplanHourLine(markerTime, markerY, isNewDay);
        const template = document.createElement('template');
        template.innerHTML = hourLineHTML.trim();
        while (template.content.firstChild) {
          belegungsplan.appendChild(template.content.firstChild);
        }
      }

      let currentTimeLineEl = null;
      const currentTimeOffsetHours = (now - startHour) / (60 * 60 * 1000);
      const currentTimeY = currentTimeOffsetHours * DAY_HOUR_HEIGHT_VH;
      if (currentTimeY >= 0 && currentTimeY <= totalHeight) {
        const currentTimeLineHTML = Templates.belegungsplanCurrentTimeLine(`${currentTimeY}vh`);
        const template = document.createElement('template');
        template.innerHTML = currentTimeLineHTML.trim();
        currentTimeLineEl = template.content.firstChild;
        belegungsplan.appendChild(currentTimeLineEl);
      }

      const getBlockPosition = (train) => {
        const trainStart = parseTime(train.actual || train.plan, now, train.date);
        if (!trainStart) return null;
        const duration = Number(train.dauer) || 0;
        if (duration <= 0) return null;
        const offsetHours = (trainStart - startHour) / (60 * 60 * 1000);
        const topVh = offsetHours * DAY_HOUR_HEIGHT_VH;
        const heightVh = (duration / 60) * DAY_HOUR_HEIGHT_VH;
        return { top: topVh, height: heightVh, start: trainStart, end: new Date(trainStart.getTime() + duration * 60000) };
      };

      const trainData = allScheduledTrains
        .map(train => ({ train, pos: getBlockPosition(train) }))
        .filter(item => item.pos && item.pos.top + item.pos.height >= 0)
        .sort((a, b) => a.pos.start - b.pos.start);

      renderOverlappingTrainBlocks(belegungsplan, trainData, now);

      contentEl.appendChild(belegungsplan);
      return { currentTimeLineEl, selectedDayMarkerEl };
    }

    // Builds the 7-column Monday-Sunday week grid into contentEl. Fills the full
    // available height (contentEl is a flex child sized by its container) - hour
    // positions are expressed as % of a 24h day so the grid always exactly fits,
    // rather than a fixed vh-per-hour that could fall short of or overflow the screen.
    function buildBelegungsplanWeekContent(contentEl, selectedDate, now) {
      const gridWrapper = document.createElement('div');
      gridWrapper.className = 'week-grid-wrapper';

      const monday = getMondayOf(selectedDate);
      const weekDates = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        return d;
      });

      // Axis: a spacer matching the day-column header height, then hour labels
      // positioned by % so they line up exactly with each day column's gridlines.
      const hourAxis = document.createElement('div');
      hourAxis.className = 'week-hour-axis';

      const axisSpacer = document.createElement('div');
      axisSpacer.className = 'week-hour-axis-spacer';
      hourAxis.appendChild(axisSpacer);

      const axisLabels = document.createElement('div');
      axisLabels.className = 'week-hour-axis-labels';
      for (let h = 0; h < 24; h++) {
        const topPct = (h / 24) * 100;
        const label = document.createElement('div');
        label.className = 'week-hour-label';
        label.style.top = `${topPct}%`;
        label.textContent = `${String(h).padStart(2, '0')}:00`;
        axisLabels.appendChild(label);
      }
      hourAxis.appendChild(axisLabels);
      gridWrapper.appendChild(hourAxis);

      const dayColumns = document.createElement('div');
      dayColumns.className = 'week-day-columns';

      const todayStr = now.toLocaleDateString('sv-SE');
      const allScheduledTrains = processedTrainData.scheduledTrains.filter(t => !t.canceled);

      weekDates.forEach(dateObj => {
        const dateStr = dateObj.toLocaleDateString('sv-SE');
        const isToday = dateStr === todayStr;

        const columnEl = document.createElement('div');
        columnEl.className = 'week-day-column' + (isToday ? ' is-today' : '');
        columnEl.innerHTML = Templates.belegungsplanWeekDayHeader(dateObj, isToday);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'week-day-body';

        // A train's occupancy segment for *this* column is whatever portion of
        // [start, end) falls within this calendar day - trains crossing midnight
        // are clipped and continue as their own segment in the next day's column,
        // rather than only ever appearing (and overflowing) in their start day.
        const dayStart = new Date(dateObj);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        const dayTrains = allScheduledTrains
          .map(train => {
            const start = parseTime(train.actual || train.plan, now, train.date);
            if (!start) return null;
            const duration = Number(train.dauer) || 0;
            if (duration <= 0) return null;
            const end = new Date(start.getTime() + duration * 60000);
            if (end <= dayStart || start >= dayEnd) return null; // no overlap with this day

            const segStart = start < dayStart ? dayStart : start;
            const segEnd = end > dayEnd ? dayEnd : end;
            const offsetHours = (segStart - dayStart) / (60 * 60 * 1000);
            const durHours = (segEnd - segStart) / (60 * 60 * 1000);
            const top = (offsetHours / 24) * 100;
            const height = (durHours / 24) * 100;
            return {
              train,
              pos: {
                top, height, start: segStart, end: segEnd,
                continuesFromPrevDay: segStart > start,
                continuesToNextDay: segEnd < end,
              },
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.pos.start - b.pos.start);

        renderOverlappingTrainBlocks(bodyEl, dayTrains, now, '%');

        if (isToday) {
          const dayStart = new Date(dateObj);
          dayStart.setHours(0, 0, 0, 0);
          const nowOffsetHours = (now - dayStart) / (60 * 60 * 1000);
          if (nowOffsetHours >= 0 && nowOffsetHours <= 24) {
            const currentTimeLineHTML = Templates.belegungsplanCurrentTimeLine(`${(nowOffsetHours / 24) * 100}%`);
            const template = document.createElement('template');
            template.innerHTML = currentTimeLineHTML.trim();
            bodyEl.appendChild(template.content.firstChild);
          }
        }

        columnEl.appendChild(bodyEl);
        dayColumns.appendChild(columnEl);
      });

      gridWrapper.appendChild(dayColumns);
      contentEl.appendChild(gridWrapper);
    }

    // Custom tooltip for train tiles too short/narrow to show their destination
    // text (mainly the compact week view). Anchored above/below the tile rather
    // than at the cursor, so the mouse never sits on top of it.
    let belegungsplanTooltipWired = false;

    function ensureBelegungsplanTooltipEl() {
      let tooltip = document.getElementById('belegungsplan-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'belegungsplan-tooltip';
        tooltip.className = 'belegungsplan-tooltip';
        document.body.appendChild(tooltip);
      }
      return tooltip;
    }

    // Only tiles that can't show their own destination text in full need the
    // tooltip: either the header wasn't rendered at all (tile too short), or
    // the destination label is there but ellipsis-truncated (tile too narrow).
    function belegungsplanTileTextIsHidden(tileEl) {
      const destEl = tileEl.querySelector('.belegungsplan-destination');
      if (!destEl) return true;
      return destEl.scrollWidth > destEl.clientWidth + 1;
    }

    function showBelegungsplanTooltip(tileEl) {
      if (!belegungsplanTileTextIsHidden(tileEl)) return;
      const text = tileEl.getAttribute('data-tooltip');
      if (!text) return;
      const tooltip = ensureBelegungsplanTooltipEl();
      tooltip.textContent = text;
      tooltip.style.display = 'block';

      const rect = tileEl.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const gap = 8;

      // Prefer above the tile; fall back to below if there's no room, so the
      // tooltip is always fully clear of both the tile and the cursor on it.
      let top = rect.top - tooltipRect.height - gap;
      if (top < 4) top = rect.bottom + gap;

      let left = rect.left;
      const maxLeft = window.innerWidth - tooltipRect.width - 4;
      if (left > maxLeft) left = maxLeft;
      if (left < 4) left = 4;

      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
    }

    function hideBelegungsplanTooltip() {
      const tooltip = document.getElementById('belegungsplan-tooltip');
      if (tooltip) tooltip.style.display = 'none';
    }

    function wireBelegungsplanTooltip(trainListEl) {
      if (belegungsplanTooltipWired) return;
      belegungsplanTooltipWired = true;
      trainListEl.addEventListener('mouseover', (e) => {
        const tile = e.target.closest('.belegungsplan-train-block');
        if (tile) showBelegungsplanTooltip(tile);
      });
      trainListEl.addEventListener('mouseout', (e) => {
        const tile = e.target.closest('.belegungsplan-train-block');
        if (tile && !tile.contains(e.relatedTarget)) hideBelegungsplanTooltip();
      });
      trainListEl.addEventListener('scroll', hideBelegungsplanTooltip);
    }

    // The date range actually covered by the day view's continuous timeline (see
    // buildBelegungsplanDayContent) - used to bound the date picker so users can't
    // pick a day so far out of range that navigating to it would never scroll.
    function getBelegungsplanDataDateBounds(now) {
      const todayMidnight = new Date(now);
      todayMidnight.setHours(0, 0, 0, 0);

      let startHour = todayMidnight;
      const currentTrain = processedTrainData.currentTrain;
      if (currentTrain) {
        const currentTrainTime = parseTime(currentTrain.actual || currentTrain.plan, now, currentTrain.date);
        if (currentTrainTime) {
          const currentTrainHour = new Date(currentTrainTime);
          currentTrainHour.setMinutes(0, 0, 0);
          if (currentTrainHour < startHour) startHour = currentTrainHour;
        }
      }

      let latestTime = new Date(todayMidnight.getTime() + 24 * 60 * 60 * 1000);
      processedTrainData.scheduledTrains.filter(t => !t.canceled).forEach(train => {
        const trainEnd = getOccupancyEnd(train, now);
        if (trainEnd && trainEnd > latestTime) latestTime = trainEnd;
      });

      return { minDateStr: startHour.toLocaleDateString('sv-SE'), maxDateStr: latestTime.toLocaleDateString('sv-SE') };
    }

    // Render Belegungsplan (Occupancy Plan) - header (toggle + date picker + nav)
    // plus either a single-day timeline or a week grid, per belegungsplanDisplayMode.
    function renderBelegungsplan(options = {}) {
      const { jumpToSelectedDate = false } = options;
      const now = new Date();
      const trainListEl = document.getElementById('train-list');
      trainListEl.classList.remove('log-viewer-mode');
      wireBelegungsplanTooltip(trainListEl);
      hideBelegungsplanTooltip();

      const savedScrollPosition = trainListEl.scrollTop;
      trainListEl.innerHTML = '';

      renderHeadlineTrain();

      const selectedDate = new Date(belegungsplanSelectedDate);
      selectedDate.setHours(0, 0, 0, 0);

      const pageEl = document.createElement('div');
      pageEl.className = 'belegungsplan-page';

      let headerLabel;
      if (belegungsplanDisplayMode === 'week') {
        const monday = getMondayOf(selectedDate);
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);
        headerLabel = `KW ${getIsoWeekNumber(monday)} · ${monday.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}–${sunday.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
      } else {
        headerLabel = selectedDate.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
      }
      const dateInputValue = selectedDate.toLocaleDateString('sv-SE');
      const { minDateStr, maxDateStr } = getBelegungsplanDataDateBounds(now);
      pageEl.innerHTML = Templates.belegungsplanHeader(headerLabel, belegungsplanDisplayMode, dateInputValue, minDateStr, maxDateStr);

      const contentEl = document.createElement('div');
      contentEl.className = 'belegungsplan-content';

      let dayCurrentTimeLineEl = null;
      let daySelectedMarkerEl = null;
      if (belegungsplanDisplayMode === 'week') {
        buildBelegungsplanWeekContent(contentEl, selectedDate, now);
      } else {
        const dayResult = buildBelegungsplanDayContent(contentEl, selectedDate, now);
        dayCurrentTimeLineEl = dayResult.currentTimeLineEl;
        daySelectedMarkerEl = dayResult.selectedDayMarkerEl;
      }

      pageEl.appendChild(contentEl);
      trainListEl.appendChild(pageEl);

      // The week grid's hour axis/gridlines are positioned in % of the grid
      // wrapper's height. Percentage heights resolved through several nested
      // flex layers (page -> content -> grid-wrapper) are unreliable across
      // browsers, so pin the wrapper to an explicit pixel height once its
      // header siblings are actually laid out, rather than relying on that
      // chain to resolve correctly.
      if (belegungsplanDisplayMode === 'week') {
        const pageHeaderEl = pageEl.querySelector('.belegungsplan-page-header');
        const gridWrapperEl = contentEl.querySelector('.week-grid-wrapper');
        if (pageHeaderEl && gridWrapperEl) {
          const availablePx = trainListEl.clientHeight - pageHeaderEl.offsetHeight;
          gridWrapperEl.style.height = `${Math.max(0, availablePx)}px`;
        }
      }

      // Wire header controls
      const toggleBtn = pageEl.querySelector('#belegungsplan-toggle-btn');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          belegungsplanDisplayMode = belegungsplanDisplayMode === 'day' ? 'week' : 'day';
          renderBelegungsplan({ jumpToSelectedDate: true });
        });
      }

      const dateInput = pageEl.querySelector('#belegungsplan-date-input');
      const dateLabel = pageEl.querySelector('#belegungsplan-date-label');
      if (dateLabel && dateInput) {
        dateLabel.addEventListener('click', () => {
          if (typeof dateInput.showPicker === 'function') {
            dateInput.showPicker();
          } else {
            dateInput.focus();
            dateInput.click();
          }
        });
        dateInput.addEventListener('change', () => {
          if (dateInput.value) {
            const [y, m, d] = dateInput.value.split('-').map(Number);
            belegungsplanSelectedDate = new Date(y, m - 1, d);
            renderBelegungsplan({ jumpToSelectedDate: true });
          }
        });
      }

      const todayBtn = pageEl.querySelector('#belegungsplan-today-btn');
      if (todayBtn) {
        todayBtn.addEventListener('click', () => {
          belegungsplanSelectedDate = new Date();
          renderBelegungsplan({ jumpToSelectedDate: true });
        });
      }

      const stepDays = belegungsplanDisplayMode === 'week' ? 7 : 1;
      const prevBtn = pageEl.querySelector('#belegungsplan-prev-btn');
      const nextBtn = pageEl.querySelector('#belegungsplan-next-btn');
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          const d = new Date(belegungsplanSelectedDate);
          d.setDate(d.getDate() - stepDays);
          belegungsplanSelectedDate = d;
          renderBelegungsplan({ jumpToSelectedDate: true });
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          const d = new Date(belegungsplanSelectedDate);
          d.setDate(d.getDate() + stepDays);
          belegungsplanSelectedDate = d;
          renderBelegungsplan({ jumpToSelectedDate: true });
        });
      }

      // Wait for DOM to fully render, then restore/set scroll position
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!jumpToSelectedDate) {
            if (savedScrollPosition > 0) trainListEl.scrollTop = savedScrollPosition;
            return;
          }
          // Explicit date navigation (prev/next/date-picker): scroll smoothly to
          // the selected day's marker (or, if it's today, to "now"). If that day
          // isn't actually present in the rendered range, leave the scroll
          // position alone rather than jumping somewhere unrelated.
          const isSelectedToday = selectedDate.toLocaleDateString('sv-SE') === now.toLocaleDateString('sv-SE');
          const targetEl = isSelectedToday
            ? (dayCurrentTimeLineEl || contentEl.querySelector('.belegungsplan-current-time-line'))
            : daySelectedMarkerEl;
          if (targetEl) {
            const viewportHeight = trainListEl.clientHeight;
            trainListEl.scrollTo({ top: Math.max(0, targetEl.offsetTop - viewportHeight / 3), behavior: 'smooth' });
          }
        }, 50);
      });
    }

    function renderTrainListWithEntries(remainingTrains, options = {}) {
      const {
        showHeadline = true,
        preserveScroll = true,
        enableSwipe = true,
        enableDateJump = true,
        append = false,
        targetEl = null,
        durationOnlyEntries = []
      } = options;

      const now = new Date();
      const listRoot = targetEl || document.getElementById('train-list');
      if (!listRoot) return;
      if (listRoot.id === 'train-list' && currentWorkspaceMode !== 'log-viewer') {
        listRoot.classList.remove('log-viewer-mode');
      }

      // Save scroll position BEFORE any DOM manipulation
      const savedScrollPosition = preserveScroll ? listRoot.scrollTop : 0;

      if (!append) {
        listRoot.innerHTML = '';
      }

      // Update headline train
      if (showHeadline) {
        renderHeadlineTrain();
      }

      // Pre-group all list entries by date so each day section can render
      // separator -> duration-only trains -> timed trains.
      const trainsByDate = {};
      const timedByDate = {};
      const durationByDate = {};

      const allForGrouping = [
        ...(processedTrainData.currentTrain ? [processedTrainData.currentTrain] : []),
        ...remainingTrains,
        ...durationOnlyEntries
      ];

      allForGrouping.forEach((t) => {
        if (!t || !t.date) return;
        if (!trainsByDate[t.date]) trainsByDate[t.date] = [];
        trainsByDate[t.date].push(t);
      });

      remainingTrains.forEach((t) => {
        if (!t || !t.date) return;
        if (!timedByDate[t.date]) timedByDate[t.date] = [];
        timedByDate[t.date].push(t);
      });

      durationOnlyEntries.forEach((t) => {
        if (!t || !t.date) return;
        if (!durationByDate[t.date]) durationByDate[t.date] = [];
        durationByDate[t.date].push(t);
      });

      const orderedDates = Array.from(new Set([
        ...Object.keys(timedByDate),
        ...Object.keys(durationByDate)
      ])).sort();

      orderedDates.forEach((date) => {
        const separatorHTML = Templates.daySeparator(date, trainsByDate[date] || []);
        const separatorTemplate = document.createElement('template');
        separatorTemplate.innerHTML = separatorHTML.trim();
        listRoot.appendChild(separatorTemplate.content.firstChild);

        const durationTrainsForDay = durationByDate[date] || [];
        if (durationTrainsForDay.length > 0) {
          const dayGroup = document.createElement('div');
          const isExpanded = !!durationOnlyExpandedByDate[date];
          dayGroup.className = `duration-only-day-group${isExpanded ? ' expanded' : ''}`;

          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'duration-only-day-toggle';
          toggleBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
          toggleBtn.innerHTML = `
            <span class="duration-only-day-chevron">▸</span>
            <span class="duration-only-day-title">FÜSQ</span>
          `;
          dayGroup.appendChild(toggleBtn);

          const content = document.createElement('div');
          content.className = 'duration-only-day-content';
          durationTrainsForDay.forEach((train) => {
            const entry = createTrainEntry(train, now, false);
            content.appendChild(entry);
          });
          dayGroup.appendChild(content);

          toggleBtn.addEventListener('click', () => {
            const nextExpanded = !dayGroup.classList.contains('expanded');
            dayGroup.classList.toggle('expanded', nextExpanded);
            durationOnlyExpandedByDate[date] = nextExpanded;
            toggleBtn.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
          });

          listRoot.appendChild(dayGroup);
        }

        (timedByDate[date] || []).forEach((train) => {
          const entry = createTrainEntry(train, now, false);
          listRoot.appendChild(entry);
        });
      });
      
      // Attach swipe gestures on mobile after list is populated
      if (enableSwipe) {
        setupMobileSwipe();
      }

      // Attach jump-to-date handler (delegated, replaced each render)
      if (enableDateJump) {
        listRoot._jumpHandler && listRoot.removeEventListener('click', listRoot._jumpHandler);
        listRoot._jumpHandler = function(e) {
          const dateSpan = e.target.closest('[data-jump-date]');
          if (!dateSpan) return;
          e.preventDefault();
          e.stopPropagation();
          openDateJumpPopup(dateSpan, listRoot);
        };
        listRoot.addEventListener('click', listRoot._jumpHandler);
      } else if (listRoot._jumpHandler) {
        listRoot.removeEventListener('click', listRoot._jumpHandler);
        listRoot._jumpHandler = null;
      }

      requestAnimationFrame(() => applyCancelNoticeScrolling(listRoot));

      // Wait for DOM to fully render, then restore scroll and show
      if (preserveScroll) {
        requestAnimationFrame(() => {
          setTimeout(() => {
            // Set scroll position
            if (savedScrollPosition > 0) {
              listRoot.scrollTop = savedScrollPosition;
            }
          }, 50);
        });
      }
    }

    // Legacy render function for reference
    function renderTrainList() {
      renderTrainListWithEntries(processedTrainData.remainingTrains, {
        showHeadline: true,
        preserveScroll: true,
        enableSwipe: true,
        enableDateJump: true,
        append: false,
        durationOnlyEntries: processedTrainData.durationOnlyTrains
      });
      renderPinnedProjectsInSidebar();
    }

    // ===== DATE JUMP POPUP =====
    function openDateJumpPopup(anchorEl, listEl) {
      // Remove any existing popup
      const existing = document.getElementById('date-jump-popup');
      if (existing) existing.remove();

      const initialDate = anchorEl.dataset.jumpDate || '';

      // Collect all available dates from separators in the list
      const available = Array.from(listEl.querySelectorAll('[data-jump-date]'))
        .map(el => el.dataset.jumpDate)
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();

      const popup = document.createElement('div');
      popup.id = 'date-jump-popup';
      popup.className = 'date-jump-popup';
      popup.innerHTML = `
        <div class="date-jump-popup-label">Zu Datum springen</div>
        <input type="date" class="date-jump-input" id="date-jump-input"
          value="${initialDate}"
          min="${available[0] || ''}"
          max="${available[available.length - 1] || ''}">
        <div class="date-jump-popup-hint">Datum wählen oder Enter</div>
      `;

      // Position below the anchor element
      const anchorRect = anchorEl.getBoundingClientRect();
      popup.style.top  = (anchorRect.bottom + 6) + 'px';
      popup.style.left = anchorRect.left + 'px';
      document.body.appendChild(popup);

      const input = popup.querySelector('#date-jump-input');
      input.focus();
      try { input.showPicker && input.showPicker(); } catch(_) {}

      function jumpToDate(dateStr) {
        if (!dateStr) return;
        const sep = listEl.querySelector('[data-jump-date="' + dateStr + '"]');
        if (sep) {
          sep.closest('.day-separator').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        popup.remove();
        removeOutsideListener();
      }

      input.addEventListener('change', () => jumpToDate(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') jumpToDate(input.value);
        if (e.key === 'Escape') { popup.remove(); removeOutsideListener(); }
      });

      function outsideClick(e) {
        if (!popup.contains(e.target) && e.target !== anchorEl) {
          popup.remove();
          removeOutsideListener();
        }
      }
      function removeOutsideListener() {
        document.removeEventListener('pointerdown', outsideClick, true);
      }
      // Delay so the current click event doesn't immediately close it
      setTimeout(() => document.addEventListener('pointerdown', outsideClick, true), 0);
    }

    // ===== MOBILE SWIPE GESTURES =====

    function createTrainEntry(train, now, isFirstTrain = false) {
      const isReadOnly = !!(train && train._readOnly);
      // Use template to create HTML
      const htmlString = Templates.trainEntry(train, now, isFirstTrain);
      
      // Create element from HTML string
      const template = document.createElement('template');
      template.innerHTML = htmlString.trim();
      const entry = template.content.firstChild;
      
      if (window.innerWidth <= 768) {
        // On mobile: header train toggles stress dashboard; list entries toggle the action bar
        entry.addEventListener('click', (e) => {
          if (isReadOnly) {
            renderFocusMode(train);
            document.querySelectorAll('.train-entry').forEach(en => en.classList.remove('selected'));
            entry.classList.add('selected');
            return;
          }
          if (e.target.closest('.mobile-info-btn, .mobile-action-btn')) return;
          const shell = entry.closest('.mobile-entry-shell');
          const bar = shell && shell.querySelector('.mobile-action-bar');
          if (!bar) {
            // No action bar (header / first-train) → toggle mobile ribbon menu
            const mobMenu = document.getElementById('mobile-ribbon-menu');
            if (mobMenu) {
              const opening = !mobMenu.classList.contains('is-open');
              mobMenu.classList.toggle('is-open', opening);
              if (opening) {
                // Close on next outside tap
                const outsideClose = (ev) => {
                  if (!mobMenu.contains(ev.target) && !entry.contains(ev.target)) {
                    mobMenu.classList.remove('is-open');
                    document.removeEventListener('pointerdown', outsideClose, true);
                  }
                };
                setTimeout(() => document.addEventListener('pointerdown', outsideClose, true), 0);
              }
            }
            document.querySelectorAll('.train-entry').forEach(en => en.classList.remove('selected'));
            entry.classList.add('selected');
            return;
          }
          // Close any sibling bars that are open
          document.querySelectorAll('.mobile-action-bar.is-open').forEach(b => {
            if (b !== bar) b.classList.remove('is-open');
          });
          const wasOpen = bar.classList.contains('is-open');
          bar.classList.toggle('is-open');
          if (!wasOpen) {
            // Bar just opened: snapshot actual time so undo knows what to restore
            const t = processedTrainData.allTrains.find(t => t._uniqueId === entry.dataset.uniqueId);
            shell.dataset.originalActual = t ? (t.actual || '') : '';
            delete shell.dataset.pendingSave;
            // Refresh cancel button
            const cancelBtn = bar.querySelector('.mobile-cancel-btn');
            if (cancelBtn && t) {
              const isCanceled = !!t.canceled;
              cancelBtn.classList.toggle('reactivate', isCanceled);
              cancelBtn.textContent = isCanceled ? '\u2713' : '\u2715';
            }
          } else {
            // Bar just closed: commit any pending delay change
            if (shell.dataset.pendingSave === 'true') {
              delete shell.dataset.pendingSave;
              const originalActual = shell.dataset.originalActual || null;
              const uid = entry.dataset.uniqueId;
              saveSchedule();
              showSwipeToast(() => {
                const t2 = processedTrainData.allTrains.find(t => t._uniqueId === uid);
                const s2 = findScheduleTrainById(uid);
                if (t2) t2.actual = originalActual || null;
                if (s2) s2.actual = originalActual || null;
                refreshUIOnly();
                saveSchedule();
              });
            }
          }
          document.querySelectorAll('.train-entry').forEach(en => en.classList.remove('selected'));
          entry.classList.add('selected');
        });
      } else {
        // On desktop: tap opens editor drawer
        entry.addEventListener('click', () => {
          renderFocusMode(train);
          document.querySelectorAll('.train-entry').forEach(e => e.classList.remove('selected'));
          entry.classList.add('selected');
        });
      }

      return entry;
    }

    // Render focus mode by cloning template and populating with train data
    // Helper function to convert ALL fields to editable inputs at once