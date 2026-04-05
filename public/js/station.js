// === STATION SELECTION OVERLAY ===
    function showStationOverlay() {
      const overlay = document.getElementById('station-overlay');
      const input = document.getElementById('station-input');
      const sugg = document.getElementById('station-suggestions');
      const hint = document.getElementById('overlay-hint');
      
      overlay.classList.remove('hidden');
      input.value = '';
      sugg.innerHTML = '';
      sugg.style.display = 'none';
      input.focus();
      
      // Handle system back button (mobile)
      stationOverlayBackHandler = (e) => {
        if (!overlay.classList.contains('hidden')) {
          overlay.classList.add('hidden');
        }
      };
      window.addEventListener('popstate', stationOverlayBackHandler, true);
      window.history.pushState({ overlay: 'station-chooser' }, '');

      let timer = null;
      let activeIndex = -1;
      let lastMatches = [];

      const ALLOWED_TRAIN_TAGS = new Set([
        'HIGH_SPEED_TRAIN', 'INTERCITY_TRAIN', 'INTER_REGIONAL_TRAIN', 'REGIONAL_TRAIN', 'CITY_TRAIN',
        'HIGH_SPEED', 'INTERCITY', 'INTERREGIONAL', 'REGIONAL', 'CITY', 'SUBURBAN_TRAIN', 'SUBURBAN',
        'S-BAHN', 'S_BAHN', 'SBAHN', 'S-TRAIN', 'TRAIN', 'RAIL', 'RAILWAY'
      ]);

      function getStationTags(st) {
        const fields = ['tags', 'productTags', 'product_types', 'transportTags', 'categories', 'products', 'productTypes'];
        const out = [];
        for (const f of fields) {
          const v = st && st[f];
          if (!v) continue;
          if (Array.isArray(v)) {
            v.forEach(x => { if (x != null) out.push(String(x)); });
          } else if (typeof v === 'string') {
            out.push(v);
          }
        }
        return out.map(s => s.toUpperCase().trim());
      }

      function stationHasAllowedTags(st) {
        const hasDs100 = typeof st?.ds100 === 'string' && st.ds100.trim().length > 0;
        const evaStr = st?.eva != null ? String(st.eva) : '';
        const hasEva = /^\d{6,8}$/.test(evaStr);

        const tags = getStationTags(st);
        if (tags.length) {
          const hasAllowed = tags.some(t => ALLOWED_TRAIN_TAGS.has(t));
          const isBusOnly = tags.every(t => t === 'BUS' || t === 'BUS_STOP' || t === 'BUSSTATION');
          if (isBusOnly) return false;
          if (hasAllowed) return true;
          if (hasDs100 || hasEva) return true;
          return false;
        }
        if (hasDs100 || hasEva) return true;
        return false;
      }

      function normalizeStr(s) {
        try { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
        catch { return (s || '').toLowerCase(); }
      }

      async function ensureStationsIndex() {
        if (stationsIndex) return stationsIndex;
        try {
          const res = await fetch('/stations.json');
          if (!res.ok) throw new Error('stations.json not found');
          const json = await res.json();
          stationsIndex = Array.isArray(json) ? json : (json.stations || []);
          return stationsIndex;
        } catch (e) {
          console.warn('Failed loading stations.json', e);
          stationsIndex = [];
          return stationsIndex;
        }
      }

      function updateActiveSuggestion() {
        const items = Array.from(sugg.children);
        items.forEach((el, idx) => {
          if (idx === activeIndex) {
            el.classList.add('active');
            el.style.background = 'rgba(255,255,255,0.2)';
            try { el.scrollIntoView({ block: 'nearest' }); } catch {}
          } else {
            el.classList.remove('active');
            el.style.background = '';
          }
        });
      }

      function renderSuggestions(list) {
        sugg.innerHTML = '';
        lastMatches = Array.isArray(list) ? list : [];
        activeIndex = -1;
        if (!lastMatches.length) { 
          sugg.style.display = 'none'; 
          hint.textContent = 'Keine passenden Bahnhöfe gefunden.';
          return; 
        }
        lastMatches.slice(0, 50).forEach((st) => {
          const template = document.createElement('template');
          template.innerHTML = Templates.stationSuggestion(st).trim();
          const item = template.content.firstChild;
          item.addEventListener('click', () => chooseLive(st));
          sugg.appendChild(item);
        });
        sugg.style.display = 'block';
        hint.textContent = `${lastMatches.length} Bahnhöfe gefunden:`;
        updateActiveSuggestion();
      }

      function choosePersonal() {
        currentEva = null;
        currentStationName = null;
        localStorage.removeItem('selectedEva');
        localStorage.removeItem('selectedStationName');
        overlay.classList.add('hidden');
        
        // Clean up back button handler
        if (stationOverlayBackHandler) {
          window.removeEventListener('popstate', stationOverlayBackHandler, true);
          stationOverlayBackHandler = null;
        }
        
        // Stop auto-refresh for local mode (SSE handles updates)
        updateRefreshInterval();
        
        (async () => {
          const schedule = await fetchSchedule();
          processTrainData(schedule);
          renderCurrentWorkspaceView();
          updateClock();
        })();
      }

      function chooseLive(station) {
        currentEva = station.eva;
        currentStationName = station.name;
        localStorage.setItem('selectedEva', currentEva);
        localStorage.setItem('selectedStationName', currentStationName);
        overlay.classList.add('hidden');
        
        // Clean up back button handler
        if (stationOverlayBackHandler) {
          window.removeEventListener('popstate', stationOverlayBackHandler, true);
          stationOverlayBackHandler = null;
        }
        
        // Start auto-refresh for DB API mode
        updateRefreshInterval();
        
        // Show loading animation
        showSaveStatus();
        
        (async () => {
          const schedule = await fetchSchedule();
          processTrainData(schedule);
          renderCurrentWorkspaceView();
          updateClock();
          // Complete loading animation
          completeSaveStatus();
        })();
      }

      // Input handler
      input.addEventListener('input', async () => {
        const val = input.value.trim();
        sugg.style.display = 'none';
        sugg.innerHTML = '';
        hint.textContent = 'Suche…';
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const idx = await ensureStationsIndex();
          const qn = normalizeStr(val);
          const rawMatches = idx.filter((s) => normalizeStr(s.name).includes(qn) || (s.ds100 && normalizeStr(s.ds100).includes(qn)));
          const matches = rawMatches.filter(stationHasAllowedTags);
          hint.textContent = matches.length ? 'Bitte auswählen:' : 'Keine passenden Bahnhöfe gefunden.';
          renderSuggestions(matches);
        }, 150);
      });

      // Keyboard navigation
      input.addEventListener('keydown', async (e) => {
        const itemsCount = sugg.children.length;
        if (e.key === 'ArrowDown') {
          if (!itemsCount) return;
          e.preventDefault();
          activeIndex = (activeIndex + 1) % itemsCount;
          updateActiveSuggestion();
        } else if (e.key === 'ArrowUp') {
          if (!itemsCount) return;
          e.preventDefault();
          activeIndex = activeIndex <= 0 ? itemsCount - 1 : activeIndex - 1;
          updateActiveSuggestion();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < lastMatches.length) {
            chooseLive(lastMatches[activeIndex]);
          } else if (!input.value.trim()) {
            choosePersonal();
          }
        } else if (e.key === 'Escape') {
          overlay.classList.add('hidden');
          // Clean up back button handler
          if (stationOverlayBackHandler) {
            window.removeEventListener('popstate', stationOverlayBackHandler, true);
            stationOverlayBackHandler = null;
          }
        }
      });

      // Close on background click (clicking outside the sidebar)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
          // Clean up back button handler
          if (stationOverlayBackHandler) {
            window.removeEventListener('popstate', stationOverlayBackHandler, true);
            stationOverlayBackHandler = null;
          }
        }
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape to exit focus mode
      if (e.key === 'Escape') {
        const focusPanel = document.getElementById('focus-panel');
        if (focusPanel && focusPanel.innerHTML.trim() !== '' && document.body.contains(focusPanel)) {
          // Check if we're in edit mode
          const hasInputs = focusPanel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
          if (!hasInputs) {
            // Not in edit mode, close the drawer
            e.preventDefault();
            e.stopPropagation(); // Prevent other ESC handlers from running
            desktopFocusedTrainId = null; // Clear desktop focus
            focusPanel.innerHTML = '';
            closeEditorDrawer();
            // Remove selection from all train entries
            document.querySelectorAll('.train-entry').forEach(entry => entry.classList.remove('selected'));
          }
          // If we have inputs, let the normal blur behavior work, don't close drawer
        }
      }
      
      // Left/Right arrow keys to change announcement page - but NOT when editing in any input/textarea
      const activeElement = document.activeElement;
      const isInInput = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
      
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isEditingTrain && !isInInput) {
        e.preventDefault();
        
        // Calculate total pages
        const panel = document.getElementById('announcement-panel');
        if (!panel) return;
        
        const allAnnouncements = [];
        const now = new Date();
        
        // Collect all announcements (same logic as renderComprehensiveAnnouncementPanel)
        const noteTrains = processedTrainData.noteTrains.map(t => ({ ...t, announcementType: 'note' }));
        allAnnouncements.push(...noteTrains);
        
        const todayDateStr = now.toLocaleDateString('sv-SE');
        const isToday = (train) => {
          if (!train.date) return true; // No date = newly created / unspecified → treat as today
          const trainDateStr = train.date.split('T')[0];
          return trainDateStr === todayDateStr;
        };
        
        const futureTrains = processedTrainData.futureTrains.filter(isToday);
        const cancelledTrains = futureTrains.filter(t => t.canceled).map(t => ({ ...t, announcementType: 'cancelled' }));
        allAnnouncements.push(...cancelledTrains);
        
        const delayedTrains = futureTrains.filter(t => !t.canceled && t.actual && t.actual !== t.plan)
          .filter(t => getDelay(t.plan, t.actual, now, t.date) > 0)
          .map(t => ({ ...t, announcementType: 'delayed' }));
        allAnnouncements.push(...delayedTrains);
        
        const zusatzfahrtTrains = futureTrains.filter(t => !t.canceled && t.ziel && t.ziel.trim().startsWith('[ZF]'))
          .map(t => ({ ...t, announcementType: 'zusatzfahrt' }));
        allAnnouncements.push(...zusatzfahrtTrains);
        
        const cancelledTrainsList = futureTrains.filter(t => t.canceled);
        const ersatzfahrtTrains = futureTrains.filter(activeTrain => {
          if (activeTrain.canceled) return false;
          const activeStart = parseTime(activeTrain.actual || activeTrain.plan, now, activeTrain.date);
          const activeEnd = getOccupancyEnd(activeTrain, now);
          if (!activeStart || !activeEnd) return false;
          return cancelledTrainsList.some(cancelledTrain => {
            const cancelledStart = parseTime(cancelledTrain.actual || cancelledTrain.plan, now, cancelledTrain.date);
            const cancelledEnd = getOccupancyEnd(cancelledTrain, now);
            if (!cancelledStart || !cancelledEnd) return false;
            return (activeStart < cancelledEnd && activeEnd > cancelledStart);
          });
        }).map(t => ({ ...t, announcementType: 'ersatzfahrt' }));
        allAnnouncements.push(...ersatzfahrtTrains);
        
        const allActiveTrains = processedTrainData.futureTrains.filter(t => !t.canceled);
        const konfliktTrains = [];
        for (let i = 0; i < allActiveTrains.length; i++) {
          const train1 = allActiveTrains[i];
          const start1 = parseTime(train1.actual || train1.plan, now, train1.date);
          const end1 = getOccupancyEnd(train1, now);
          if (!start1 || !end1) continue;
          for (let j = i + 1; j < allActiveTrains.length; j++) {
            const train2 = allActiveTrains[j];
            const start2 = parseTime(train2.actual || train2.plan, now, train2.date);
            const end2 = getOccupancyEnd(train2, now);
            if (!start2 || !end2) continue;
            if (start1 < end2 && end1 > start2) {
              const isComplete = start2 >= start1 && end2 <= end1;
              const conflictType = isComplete ? 'complete' : 'nested';
              konfliktTrains.push({ ...train1, announcementType: 'konflikt', conflictWith: train2, conflictType: conflictType });
            }
          }
        }
        allAnnouncements.push(...konfliktTrains);
        
        if (allAnnouncements.length === 0) return;
        
        const itemsPerPage = 3;
        const totalPages = Math.ceil(allAnnouncements.length / itemsPerPage);
        
        // Change page
        if (e.key === 'ArrowLeft') {
          comprehensiveAnnouncementCurrentPage = (comprehensiveAnnouncementCurrentPage - 1 + totalPages) % totalPages;
        } else {
          comprehensiveAnnouncementCurrentPage = (comprehensiveAnnouncementCurrentPage + 1) % totalPages;
        }
        
        // Re-render
        renderComprehensiveAnnouncementPanel();
      }
      
      // Ctrl+F to open station selection
      if (e.ctrlKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        showStationOverlay();
      }
      
      // Ctrl+G to create new train entry
      if (e.ctrlKey && (e.key === 'G' || e.key === 'g')) {
        e.preventDefault();
        createNewTrainEntry();
      }
      
      // Ctrl+S to save current train in focus panel
      if (e.ctrlKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        saveFocusPanelTrain();
      }
    });

    // Save the current train displayed in focus panel