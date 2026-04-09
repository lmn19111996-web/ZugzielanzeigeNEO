// === TRAIN LIST & BELEGUNGSPLAN RENDERING ===
    function renderHeadlineTrain() {
      const now = new Date();
      const firstTrainContainer = document.getElementById('first-train-container');
      const currentTrain = processedTrainData.currentTrain;
      const topRibbon = document.querySelector('.top-ribbon');
      
      if (currentTrain) {
        const existingEntry = firstTrainContainer.querySelector('.train-entry');
        
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
                           existingEntry.querySelector('.zugziel').textContent !== (currentTrain.canceled ? 'Zug fällt aus' : currentTrain.ziel);
        
        if (trainChanged) {
          // Only recreate if train changed
          const firstEntry = createTrainEntry(currentTrain, now, true);
          firstTrainContainer.innerHTML = '';
          firstTrainContainer.appendChild(firstEntry);
          
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
      loading: false,
      loadedOnce: false,
      error: '',
      preset: ''
    };

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
        zwischenhalte: stopsArr,
        canceled: !!(entry && entry.canceled),
        _readOnly: true,
        _showDurationColumn: true,
        _isPastTrain: isPast,
        checkinTime: entry && entry.checkinTime ? entry.checkinTime : null,
        checkoutTime: entry && entry.checkoutTime ? entry.checkoutTime : null,
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
        const url = `/api/train-history/range?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=10000`;
        const res = await fetch(url);
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        logViewerState.rows = entries.map(normalizeLogEntryToTrain).filter(t => t.plan || t.actual);
        logViewerState.loadedOnce = true;
      } catch (err) {
        console.error('Failed to load log viewer range:', err);
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

      if (!logViewerState.loading && logViewerState.rows.length > 0) {
        renderTrainListWithEntries(logViewerState.rows, {
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
        empty.textContent = 'Keine Einträge im gewählten Zeitraum.';
        results.appendChild(empty);
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
     * - 'announcements', 'db-api', 'meals', 'groceries', 'inventory' are NOT workspaces
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
          
        default:
          // Should not happen - defensive fallback
          console.warn('Unknown workspace mode:', currentWorkspaceMode);
          break;
      }
    }

    // Render Belegungsplan (Occupancy Plan) - vertical timeline view
    function renderBelegungsplan() {
      const now = new Date();
      const trainListEl = document.getElementById('train-list');
      trainListEl.classList.remove('log-viewer-mode');
      
      // Save scroll position BEFORE any DOM manipulation
      const savedScrollPosition = trainListEl.scrollTop;
      const oldScrollHeight = trainListEl.scrollHeight;
      
      trainListEl.innerHTML = '';

      // Update headline train
      renderHeadlineTrain();

      // Create belegungsplan container
      const belegungsplan = document.createElement('div');
      belegungsplan.className = 'belegungsplan';

      // Get all scheduled trains and FILTER OUT CANCELLED TRAINS
      const allScheduledTrains = processedTrainData.scheduledTrains.filter(t => !t.canceled);
      
      if (allScheduledTrains.length === 0) {
        trainListEl.appendChild(belegungsplan);
        return;
      }

      // Find time range: start from the earlier of (current hour OR current train's hour)
      const currentHour = new Date(now);
      currentHour.setMinutes(0, 0, 0);
      
      let startHour = currentHour;
      
      // Check if there's a current train
      const currentTrain = processedTrainData.currentTrain;
      if (currentTrain) {
        const currentTrainTime = parseTime(currentTrain.actual || currentTrain.plan, now, currentTrain.date);
        if (currentTrainTime) {
          const currentTrainHour = new Date(currentTrainTime);
          currentTrainHour.setMinutes(0, 0, 0);
          // Use whichever is earlier
          if (currentTrainHour < startHour) {
            startHour = currentTrainHour;
          }
        }
      }
      
      // Find the latest train end time
      let latestTime = startHour;
      allScheduledTrains.forEach(train => {
        const trainStart = parseTime(train.actual || train.plan, now, train.date);
        const trainEnd = getOccupancyEnd(train, now);
        if (trainEnd && trainEnd > latestTime) {
          latestTime = trainEnd;
        }
      });
      
      // Add 2 hours buffer
      const endTime = new Date(latestTime.getTime() + 2 * 60 * 60 * 1000);
      
      // Calculate total hours and height (1 hour = 7vh)
      const totalHours = Math.ceil((endTime - startHour) / (60 * 60 * 1000));
      const totalHeight = totalHours * 7; // vh units
      belegungsplan.style.minHeight = `${totalHeight}vh`;

      // Track dates for separators
      let lastDate = null;

      // Add hour markers, lines, and date separators
      for (let i = 0; i <= totalHours; i++) {
        const markerTime = new Date(startHour.getTime() + i * 60 * 60 * 1000);
        const markerY = i * 7; // vh
        
        // Check if this is midnight (00:00) for a new day
        const isNewDay = markerTime.getHours() === 0;
        const currentDate = markerTime.toLocaleDateString('sv-SE');
        
        if (isNewDay && currentDate !== lastDate) {
          // Use template for date separator
          const dateSeparatorHTML = Templates.belegungsplanDateSeparator(markerTime, markerY);
          const template = document.createElement('template');
          template.innerHTML = dateSeparatorHTML.trim();
          belegungsplan.appendChild(template.content.firstChild);
          lastDate = currentDate;
        }
        
        // Use template for hour line and marker
        const hourLineHTML = Templates.belegungsplanHourLine(markerTime, markerY, isNewDay);
        const template = document.createElement('template');
        template.innerHTML = hourLineHTML.trim();
        // Append all children (both line and marker)
        while (template.content.firstChild) {
          belegungsplan.appendChild(template.content.firstChild);
        }
      }

      // Add current time indicator line
      const currentTimeOffsetMs = now - startHour;
      const currentTimeOffsetHours = currentTimeOffsetMs / (60 * 60 * 1000);
      const currentTimeY = currentTimeOffsetHours * 7;
      
      if (currentTimeY >= 0 && currentTimeY <= totalHeight) {
        const currentTimeLineHTML = Templates.belegungsplanCurrentTimeLine(currentTimeY);
        const template = document.createElement('template');
        template.innerHTML = currentTimeLineHTML.trim();
        belegungsplan.appendChild(template.content.firstChild);
      }

      // Helper to calculate position and height
      const getBlockPosition = (train) => {
        const trainStart = parseTime(train.actual || train.plan, now, train.date);
        if (!trainStart) return null;
        
        const duration = Number(train.dauer) || 0;
        if (duration <= 0) return null;
        
        // Calculate offset from start in hours
        const offsetMs = trainStart - startHour;
        const offsetHours = offsetMs / (60 * 60 * 1000);
        const topVh = offsetHours * 7; // 1 hour = 7vh
        
        // Calculate height
        const durationHours = duration / 60;
        const heightVh = durationHours * 7;
        
        return { top: topVh, height: heightVh, start: trainStart, end: new Date(trainStart.getTime() + duration * 60000) };
      };

      // Calculate positions for all trains
      const trainData = allScheduledTrains.map(train => {
        const pos = getBlockPosition(train);
        return { train, pos };
      }).filter(item => item.pos && item.pos.top + item.pos.height >= 0);

      // Detect overlaps and assign indent levels
      trainData.forEach((item, index) => {
        let overlapLevel = 0;
        
        // Check against all previous trains to find overlaps
        for (let i = 0; i < index; i++) {
          const other = trainData[i];
          
          // Check if time ranges overlap
          if (item.pos.start < other.pos.end && item.pos.end > other.pos.start) {
            // This train overlaps with the other, check the other's level
            const otherLevel = other.overlapLevel || 0;
            if (otherLevel >= overlapLevel) {
              overlapLevel = otherLevel + 1;
            }
          }
        }
        
        item.overlapLevel = Math.min(overlapLevel, 3); // Max 4 levels (0-3)
      });

      // Render train blocks
      trainData.forEach(({ train, pos, overlapLevel }) => {
        // Use template to create HTML
        const htmlString = Templates.belegungsplanBlock(train, pos, overlapLevel, now);
        const template = document.createElement('template');
        template.innerHTML = htmlString.trim();
        const block = template.content.firstChild;
        
        // Add click handler
        block.addEventListener('click', () => {
          renderFocusMode(train);
          document.querySelectorAll('.belegungsplan-train-block').forEach(b => b.classList.remove('selected'));
          block.classList.add('selected');
        });
        
        belegungsplan.appendChild(block);
      });

      trainListEl.appendChild(belegungsplan);
      
      // Wait for DOM to fully render, then restore scroll and show
      requestAnimationFrame(() => {
        setTimeout(() => {
          // Set scroll position
          if (savedScrollPosition > 0) {
            trainListEl.scrollTop = savedScrollPosition;
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
        targetEl = null
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

      // Pre-group ALL trains (current + remaining) by date for the stacked bars
      const trainsByDate = {};
      const allForGrouping = processedTrainData.currentTrain
        ? [processedTrainData.currentTrain, ...remainingTrains]
        : [...remainingTrains];
      allForGrouping.forEach(t => {
        if (t.date) {
          if (!trainsByDate[t.date]) trainsByDate[t.date] = [];
          trainsByDate[t.date].push(t);
        }
      });

      // Render separator for the FIRST day at the top of the list
      // Always use the actual first train's date, not necessarily today
      const firstDate = remainingTrains[0] && remainingTrains[0].date;
      if (firstDate) {
        const firstSepHTML = Templates.daySeparator(firstDate, trainsByDate[firstDate] || []);
        const firstSepTemplate = document.createElement('template');
        firstSepTemplate.innerHTML = firstSepHTML.trim();
        listRoot.appendChild(firstSepTemplate.content.firstChild);
      }

      // Render remaining trains with day separators on date change
      let lastRenderedDate = firstDate;
      remainingTrains.forEach((train) => {
        // Check if this is the first train of a new day
        if (train.date && train.date !== lastRenderedDate) {
          // Use template to create day separator with stacked bar
          const separatorHTML = Templates.daySeparator(train.date, trainsByDate[train.date] || []);
          const template = document.createElement('template');
          template.innerHTML = separatorHTML.trim();
          listRoot.appendChild(template.content.firstChild);
          lastRenderedDate = train.date;
        }
        
        const entry = createTrainEntry(train, now, false);
        listRoot.appendChild(entry);
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
        append: false
      });
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
            // No action bar (header / first-train) → open stress dashboard on mobile
            const badge = document.getElementById('stressmeter-badge');
            if (badge) badge.click();
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
          if (isReadOnly) {
            renderFocusMode(train);
            document.querySelectorAll('.train-entry').forEach(e => e.classList.remove('selected'));
            entry.classList.add('selected');
            return;
          }
          renderFocusMode(train);
          document.querySelectorAll('.train-entry').forEach(e => e.classList.remove('selected'));
          entry.classList.add('selected');
        });
      }

      return entry;
    }

    // Render focus mode by cloning template and populating with train data
    // Helper function to convert ALL fields to editable inputs at once