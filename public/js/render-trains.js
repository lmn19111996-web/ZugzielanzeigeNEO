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

    /**
     * Unified decision helper function that checks the current workspace mode
     * and calls the correct rendering functions.
     * 
     * WORKSPACE MODES (main panel content):
     * - 'list' or 'occupancy': Train workspace (list or belegungsplan view)
     * - 'projects': Projects workspace
     * - 'reviews': Rezensionen workspace
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

    // Legacy render function for reference
    function renderTrainList() {
      const now = new Date();
      const trainListEl = document.getElementById('train-list');
      
      // Save scroll position BEFORE any DOM manipulation
      const savedScrollPosition = trainListEl.scrollTop;
      const oldScrollHeight = trainListEl.scrollHeight;
      
      trainListEl.innerHTML = '';

      // Update headline train
      renderHeadlineTrain();

      // Use processed data
      const remainingTrains = processedTrainData.remainingTrains;

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

      // Render remaining trains (skip first) with day separators
      remainingTrains.forEach((train, index) => {
        // Check if this is the first train of a new day
        const prevTrain = index === 0 ? processedTrainData.currentTrain : remainingTrains[index - 1];
        if (prevTrain && train.date !== prevTrain.date && train.date) {
          // Use template to create day separator with stacked bar
          const separatorHTML = Templates.daySeparator(train.date, trainsByDate[train.date] || []);
          const template = document.createElement('template');
          template.innerHTML = separatorHTML.trim();
          trainListEl.appendChild(template.content.firstChild);
        }
        
        const entry = createTrainEntry(train, now, false);
        trainListEl.appendChild(entry);
      });
      
      // Attach swipe gestures on mobile after list is populated
      setupMobileSwipe();

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

    // ===== MOBILE SWIPE GESTURES =====


    function createTrainEntry(train, now, isFirstTrain = false) {
      // Use template to create HTML
      const htmlString = Templates.trainEntry(train, now, isFirstTrain);
      
      // Create element from HTML string
      const template = document.createElement('template');
      template.innerHTML = htmlString.trim();
      const entry = template.content.firstChild;
      
      if (window.innerWidth <= 768) {
        // On mobile: header train opens editor directly; list entries toggle the action bar
        entry.addEventListener('click', (e) => {
          if (e.target.closest('.mobile-info-btn, .mobile-action-btn')) return;
          const shell = entry.closest('.mobile-entry-shell');
          const bar = shell && shell.querySelector('.mobile-action-bar');
          if (!bar) {
            // No action bar (header / first-train) → open editor drawer directly
            renderFocusMode(train);
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