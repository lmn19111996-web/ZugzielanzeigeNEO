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
            const trainOccEnd = getOccupancyEnd(train, now);
            
            // Is this train currently occupying AND started after current train?
            return trainStart && trainOccEnd && 
                   trainStart <= now && trainOccEnd > now &&
                   trainStart > currentTrainStart;
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
          
          // Reconstruct train object for formatCountdown
          const train = {
            plan: plan,
            actual: actual,
            dauer: dauer,
            date: trainDate,
            canceled: canceled
          };
          
          departure.innerHTML = '';
          departure.appendChild(formatCountdown(train, now));
        }
      }
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
          // Fetch schedule to check version
          const res = await fetch('/api/schedule');
          if (!res.ok) return;
          
          const serverData = await res.json();
          const serverVersion = serverData._meta?.version;
          
          // VERSION CHECK: Only update if server has newer version
          if (serverVersion && serverVersion > schedule._meta.version) {
            console.log(`🔄 Polling detected newer version: local=${schedule._meta.version}, server=${serverVersion} - Updating...`);
            
            // Update schedule and regenerate
            Object.assign(schedule, serverData);
            regenerateTrainsFromSchedule();
            processTrainData(schedule);
            
            // Re-render UI
            renderCurrentWorkspaceView();
            checkTrainArrivals();
          }
          // else: Version matches - silent success, no action needed
          
          // Also poll DB API if station selected
          if (currentEva) {
            const dbRes = await fetch(`/api/db-departures?eva=${currentEva}`);
            if (!dbRes.ok) return;
            
            const dbData = await dbRes.json();
            const dbTrains = (dbData.trains || []).map(t => ({
              ...t,
              source: 'db-api'
            }));
            
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

    // Set up Server-Sent Events for real-time updates
    const eventSource = new EventSource('/events');
    
    eventSource.addEventListener('update', async (event) => {
      console.log('📡 SSE update received at', new Date().toISOString());
      
      // Parse event data
      const eventData = JSON.parse(event.data);
      const serverVersion = eventData.version;
      
      // Complete save status indicator (if saving)
      completeSaveStatus();
      
      // VERSION CHECK: Only fetch if server has NEWER version
      // Use > instead of !== to handle out-of-order updates correctly
      if (serverVersion && serverVersion > schedule._meta.version) {
        console.log(`🔄 Server ahead: local=${schedule._meta.version}, server=${serverVersion} - Fetching...`);
        
        // Fetch and update the GLOBAL schedule object
        const freshSchedule = await fetchSchedule(true);
        Object.assign(schedule, freshSchedule);
        processTrainData(schedule);
        
        // Render current workspace view
        renderCurrentWorkspaceView();
        
        // In projects mode, also refresh open project drawer if needed
        if (currentWorkspaceMode === 'projects' && isProjectDrawerOpen && currentProjectId) {
          const updatedProject = schedule.projects.find(p => p._uniqueId === currentProjectId);
          if (updatedProject) {
            renderProjectDrawer(updatedProject);
          }
        }
        checkTrainArrivals(); // Check for trains arriving in 15 minutes
        
        // Re-render the appropriate focused train based on which one is set
        if (desktopFocusedTrainId) {
          // Desktop mode - only re-render if desktop panel has content
          const panel = document.getElementById('focus-panel');
          if (panel && panel.innerHTML.trim() !== '') {
            const updatedTrain = processedTrainData.allTrains.find(t => 
              t._uniqueId === desktopFocusedTrainId
            );
            
            if (updatedTrain) {
              renderFocusMode(updatedTrain);
            } else {
              // Train was deleted, clear the panel
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
        // Legacy SSE without version info - fallback to always fetch
        console.log('⚠️ SSE without version info - fetching anyway');
        await refreshDataAndUI();
      }
    });
    
    eventSource.addEventListener('error', (error) => {
      console.warn('SSE connection error:', error);
      // Connection will automatically reconnect
    });
    
    console.log('✅ Connected to server for real-time updates');

    // Station selection overlay functionality
    let stationOverlayBackHandler = null;
    