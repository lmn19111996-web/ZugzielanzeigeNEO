// === CLOCK, SAVE STATUS & SSE REFRESH ===
    function updateClock() {
      const now = new Date();
      document.getElementById('clock').textContent = formatClock(now);
      const min = now.getMinutes();
      const hour = now.getHours() % 12;

      const minDeg = min *6;
      const hourDeg = hour * 30 + min*0.5;

      document.getElementById("minute").style.transform = `translateX(-50%) rotate(${minDeg}deg)`;
      document.getElementById("hour").style.transform = `translateX(-50%) rotate(${hourDeg}deg)`;

      // Check if current headline train has expired or if a newer train has started
      let needsHeadlineUpdate = false;
      
      if (processedTrainData.currentTrain) {
        // Check 1: Has current train expired?
        const currentOccEnd = getOccupancyEnd(processedTrainData.currentTrain, now);
        if (currentOccEnd && now > currentOccEnd) {
          needsHeadlineUpdate = true;
        }
        
        // Check 2: Has a newer train started? (Edge case: overlapping trains)
        if (!needsHeadlineUpdate && processedTrainData.localTrains) {
          const currentTrainStart = parseTime(
            processedTrainData.currentTrain.actual || processedTrainData.currentTrain.plan,
            now,
            processedTrainData.currentTrain.date
          );
          
          // Check if any local train started more recently and is currently occupying
          const newerOccupyingTrain = processedTrainData.localTrains.find(train => {
            if (!train.plan || train.plan.trim() === '') return false;
            const trainStart = parseTime(train.actual || train.plan, now, train.date);
            if (!trainStart || trainStart <= currentTrainStart) return false;

            // Checked in, no duration yet ("laufend") — occupying indefinitely.
            if (isOpenCheckinOccupying(train, now)) return true;

            const trainOccEnd = getOccupancyEnd(train, now);
            // Is this train currently occupying AND started after current train?
            return !!trainOccEnd && trainStart <= now && trainOccEnd > now;
          });
          
          if (newerOccupyingTrain) {
            needsHeadlineUpdate = true;
          }
        }
      } else {
        // No current train - check if one has become available
        if (processedTrainData.localTrains && processedTrainData.localTrains.length > 0) {
          needsHeadlineUpdate = true;
        }
      }
      
      // If headline needs update, reprocess data and re-render
      if (needsHeadlineUpdate) {
        processTrainData(schedule);
        renderHeadlineTrain();
        
        // If train list workspace is open, re-render it
        if (currentWorkspaceMode === 'list' || currentWorkspaceMode === 'occupancy') {
          renderTrains();
        }
        
        return; // Skip countdown update since we just re-rendered
      }

      // Update headline train countdown every second (if no reprocess needed)
      const firstTrainContainer = document.getElementById('first-train-container');
      const existingEntry = firstTrainContainer.querySelector('.train-entry');
      if (existingEntry) {
        const departure = existingEntry.querySelector('[data-departure]');
        if (departure && departure.dataset.isHeadline === 'true') {
          // For headline train, show countdown
          const plan = departure.dataset.plan || null;
          const actual = departure.dataset.actual || null;
          const dauer = departure.dataset.dauer ? Number(departure.dataset.dauer) : 0;
          const trainDate = departure.dataset.date || null;
          const canceled = departure.dataset.canceled === 'true';
          const checkinTime = departure.dataset.checkinTime || undefined;
          const checkoutTime = departure.dataset.checkoutTime || undefined;

          // Reconstruct train object for formatCountdown
          const train = {
            plan: plan,
            actual: actual,
            dauer: dauer,
            date: trainDate,
            canceled: canceled,
            checkinTime: checkinTime,
            checkoutTime: checkoutTime
          };

          const elapsedEl = departure.querySelector('.countdown-elapsed-time');
          if (elapsedEl && isOpenCheckinOccupying(train, now)) {
            // Already showing the laufend/elapsed-time toggle — update the
            // elapsed digits in place instead of rebuilding the DOM, so the
            // CSS cross-fade animation keeps running instead of restarting
            // every second.
            const actualTime = parseTime(actual, now, trainDate);
            if (actualTime) {
              const sec = Math.max(0, Math.round((now - actualTime) / 1000));
              const h = Math.floor(sec / 3600);
              const m = Math.floor((sec % 3600) / 60);
              const s = sec % 60;
              elapsedEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            }
          } else {
            departure.innerHTML = '';
            departure.appendChild(formatCountdown(train, now));
          }
        }
      }

      // Refresh stressmeter badge (debounced internally to once per minute)
      if (typeof updateStressBadge === 'function') updateStressBadge();
    }


    function showSaveStatus() {
      const indicator = document.getElementById('save-status-indicator');
      if (indicator) {
        // Remove all classes and inline styles
        indicator.className = '';
        indicator.style.cssText = '';
        // Trigger reflow
        void indicator.offsetWidth;
        // Start animation
        indicator.classList.add('saving');
      }
    }

    function completeSaveStatus() {
      const indicator = document.getElementById('save-status-indicator');
      if (indicator) {
        indicator.classList.remove('saving');
        indicator.classList.add('saved');
        setTimeout(() => {
          indicator.classList.add('hide');
          setTimeout(() => {
            indicator.className = '';
            indicator.style.cssText = '';
          }, 500);
        }, 300);
      }
    }

    // Function to start/stop refresh interval based on mode
    function updateRefreshInterval() {
      // Clear existing interval
      if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
      }
      
      // Set up routine version check polling (30s interval)
      // Verifies we're in sync with server, only updates UI if version mismatch
      console.log('Starting routine version check polling (30s interval)');
      refreshIntervalId = setInterval(async () => {
        try {
          if (isDataOperationInProgress || isEditingTrain || isEditingProject) {
            console.log('⏸️ Polling deferred - local edits in progress');
            return;
          }

          // Skip all server calls when offline
          if (typeof window.isAppOnline === 'function' && !window.isAppOnline()) {
            console.log('⏸️ Polling skipped — app is offline');
            return;
          }

          // Fetch schedule to check version
          const res = await fetch('/api/schedule');
          if (!res.ok) return;
          
          const serverData = await res.json();
          const serverVersion = serverData._meta?.version;
          
          // VERSION CHECK: Only update if server has newer version
          if (serverVersion && serverVersion > schedule._meta.version) {
            console.log(`🔄 Polling detected newer version: local=${schedule._meta.version}, server=${serverVersion} - Updating...`);
            const localSnapshot = {
              fixedSchedule: (schedule.fixedSchedule || []).slice(),
              spontaneousEntries: (schedule.spontaneousEntries || []).slice(),
              projects: (schedule.projects || []).slice()
            };

            // Update schedule and regenerate
            Object.assign(schedule, serverData);
            schedule.fixedSchedule = mergeClientOnlyById(schedule.fixedSchedule, localSnapshot.fixedSchedule);
            schedule.spontaneousEntries = mergeClientOnlyById(schedule.spontaneousEntries, localSnapshot.spontaneousEntries);
            schedule.projects = mergeClientOnlyById(schedule.projects, localSnapshot.projects);
            materializeFromStems();
            regenerateTrainsFromSchedule();
            processTrainData(schedule);

            // Re-render UI
            renderCurrentWorkspaceView();
            checkTrainArrivals();
          }
          // else: Version matches - silent success, no action needed

          // Also poll DB API if station selected
          if (isRealStation()) {
            const dbRes = await fetch(`/api/db-departures?eva=${currentEva}`);
            if (!dbRes.ok) {
              // API failed — wipe trains and render empty (never show stale/personal data)
              schedule.trains = [];
              processTrainData(schedule);
              renderCurrentWorkspaceView();
              checkTrainArrivals();
              return;
            }

            const dbData = await dbRes.json();
            let dbTrains = (dbData.trains || []).map(t => {
              const normalized = { ...t, source: 'db-api' };
              if (t.stops && !t.zwischenhalte) {
                normalized.zwischenhalte = t.stops;
                delete normalized.stops;
              }
              return normalized;
            });

            // Hide terminus arrivals (same as real DB API behaviour)
            dbTrains = dbTrains.filter(t => t.ziel !== 'Ankunft');

            // Filter by platform if set
            if (currentPlatformFilter) {
              const allowedPlatforms = parsePlatformFilter(currentPlatformFilter);
              if (allowedPlatforms) dbTrains = dbTrains.filter(t => allowedPlatforms(t.platform || t.plannedPlatform));
            }

            // For custom trains, trim zwischenhalte to only show stops AFTER
            // the selected station (the selected stop is already the departure point)
            if (String(currentEva).startsWith('CUSTOM_')) {
              const selectedStopName = (dbData.metadata && dbData.metadata.stationName) || null;
              if (selectedStopName) {
                dbTrains = dbTrains.map(t => {
                  if (!t.zwischenhalte || !t.custom) return t;
                  const parts = t.zwischenhalte.split(' • ');
                  const idx = parts.findIndex(p => p.trim() === selectedStopName.trim());
                  if (idx !== -1 && idx < parts.length - 1) {
                    return { ...t, zwischenhalte: parts.slice(idx + 1, parts.length - 1).join(' • ') };
                  }
                  return t;
                });
              }
            }

            // Update display with DB trains
            schedule.trains = dbTrains;
            processTrainData(schedule);
            renderCurrentWorkspaceView();
            checkTrainArrivals();
          }
        } catch (error) {
          console.error('❌ Polling error:', error);
        }
      }, 30000); // 30 seconds
    }
    
    // Initial setup
    updateRefreshInterval();

    // Set up Server-Sent Events for real-time updates.
    // The connection is managed based on server reachability so the browser
    // never shows reconnect errors in the console while offline.
    let eventSource = null;

    function _connectSSE() {
      if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
      eventSource = new EventSource('/events');

      eventSource.addEventListener('update', async (event) => {
        if (typeof window.isAppOnline === 'function' && !window.isAppOnline()) return;

        console.log('📡 SSE update received at', new Date().toISOString());
      
        // Parse event data
        const eventData = JSON.parse(event.data);
        const serverVersion = eventData.version;

        // Lovemeter-only update — refresh lovemeter data without touching schedule
        if (eventData.dataType === 'lovemeter') {
          if (typeof window.lovemeterOnDataChanged === 'function') window.lovemeterOnDataChanged();
          return;
        }
      
        // Complete save status indicator (if saving)
        completeSaveStatus();
      
        // VERSION CHECK: Only fetch if server has NEWER version
        if (serverVersion && serverVersion > schedule._meta.version) {
          if (isDataOperationInProgress || isEditingTrain || isEditingProject) {
            console.log('⏸️ SSE refresh deferred - local edits in progress');
            return;
          }

          console.log(`🔄 Server ahead: local=${schedule._meta.version}, server=${serverVersion} - Fetching...`);
        
          const freshSchedule = await fetchSchedule(true);
          Object.assign(schedule, freshSchedule);
          processTrainData(schedule);
          renderCurrentWorkspaceView();
        
          if (currentWorkspaceMode === 'projects' && isProjectDrawerOpen && currentProjectId) {
            const updatedProject = schedule.projects.find(p => p._uniqueId === currentProjectId);
            if (updatedProject) renderProjectDrawer(updatedProject);
          }
          checkTrainArrivals();
        
          if (desktopFocusedTrainId) {
            const panel = document.getElementById('focus-panel');
            if (panel && panel.innerHTML.trim() !== '') {
              const updatedTrain = processedTrainData.allTrains.find(t => t._uniqueId === desktopFocusedTrainId);
              if (updatedTrain) {
                renderFocusMode(updatedTrain);
              } else {
                desktopFocusedTrainId = null;
                panel.innerHTML = '';
                closeEditorDrawer();
              }
            }
          }
        } else if (serverVersion && serverVersion < schedule._meta.version) {
          console.warn(`⚠️ Ignoring SSE with older version ${serverVersion} (current: ${schedule._meta.version})`);
        } else if (serverVersion && serverVersion === schedule._meta.version) {
          console.log(`✅ Version in sync: ${schedule._meta.version} - No fetch needed`);
        } else if (!serverVersion) {
          console.log('⚠️ SSE without version info - fetching anyway');
          await refreshDataAndUI();
        }
      });

      eventSource.addEventListener('error', () => {
        // Only log if we're supposed to be online — if offline.js already switched us
        // to offline mode this is expected and should be silent.
        if (typeof window.isAppOnline === 'function' && !window.isAppOnline()) return;
        console.warn('SSE connection error — will reconnect automatically');
      });

      console.log('✅ SSE connected');
    }

    function _disconnectSSE() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
        console.log('[SSE] Disconnected (offline mode)');
      }
    }

    // Expose so offline.js can manage the connection lifecycle
    window._sseConnect    = _connectSSE;
    window._sseDisconnect = _disconnectSSE;

    // Start connected if online
    if (typeof window.isAppOnline !== 'function' || window.isAppOnline()) {
      _connectSSE();
    }

    // Station selection overlay functionality
    let stationOverlayBackHandler = null;
    