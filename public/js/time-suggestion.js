// === TIME SLOT SUGGESTION & PREVIEW ===
    let timeSuggestionState = {
      activeTrain: null,
      selectedSlot: null,
      isPreviewActive: false
    };

    /**
     * Find available time slots within the next week for a task with given duration
     * Returns array of {date, time, dayName} objects
     * 
     * Available block = time from departure of previous train to arrival of next train
     * Only one suggestion per block (earliest possible time)
     * Respects curfew: 23:00 - 7:00
     */
    function findAvailableTimeSlots(taskDuration, maxSlots = 10) {
      const slots = [];
      const now = new Date();
      const taskDurationMs = taskDuration * 60 * 1000;
      
      // Get all scheduled trains sorted by time
      const sortedTrains = [...processedTrainData.scheduledTrains].sort((a, b) => {
        const ta = parseTime(a.actual || a.plan, now, a.date);
        const tb = parseTime(b.actual || b.plan, now, b.date);
        return ta - tb;
      });
      
      // Check time spans over the next 7 days
      const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      
      // Helper function to check if time overlaps with curfew (23:00 - 7:00)
      const overlapsCurfew = (start, end) => {
        const startHour = start.getHours();
        const endHour = end.getHours();
        const startMinute = start.getMinutes();
        const endMinute = end.getMinutes();
        
        // Check if start or end is during curfew hours
        const startInCurfew = (startHour >= 23) || (startHour < 7);
        const endInCurfew = (endHour >= 23) || (endHour < 7);
        
        // Check if task spans across midnight during curfew
        if (startHour < 7 && endHour >= 7) return true;
        if (startHour >= 23 || endHour >= 23) return true;
        if (startInCurfew || endInCurfew) return true;
        
        return false;
      };
      
      // Start from the next round hour or now, whichever is later
      let checkTime = new Date(now);
      if (checkTime.getMinutes() > 0 || checkTime.getSeconds() > 0) {
        checkTime.setHours(checkTime.getHours() + 1, 0, 0, 0);
      }
      
      // If we're in curfew, skip to 7:00
      if (checkTime.getHours() >= 23 || checkTime.getHours() < 7) {
        checkTime.setHours(7, 0, 0, 0);
        if (checkTime <= now) {
          checkTime.setDate(checkTime.getDate() + 1);
        }
      }
      
      while (checkTime < endDate && slots.length < maxSlots) {
        const slotStart = new Date(checkTime);
        const slotEnd = new Date(slotStart.getTime() + taskDurationMs);
        
        // Skip if overlaps curfew
        if (overlapsCurfew(slotStart, slotEnd)) {
          // Jump to 7:00 next day
          checkTime.setDate(checkTime.getDate() + 1);
          checkTime.setHours(7, 0, 0, 0);
          continue;
        }
        
        // Find the previous train that departs before or at this time
        // Skip cancelled trains and empty trains (they're available slots)
        let previousTrainDeparture = null;
        for (let i = sortedTrains.length - 1; i >= 0; i--) {
          const train = sortedTrains[i];
          if (timeSuggestionState.activeTrain && train._uniqueId === timeSuggestionState.activeTrain._uniqueId) {
            continue;
          }
          
          // Skip cancelled trains (they're available)
          if (train.canceled) continue;
          
          // Skip empty trains without destination (they're available)
          if (!train.ziel || train.ziel.trim() === '') continue;
          
          const trainArrival = parseTime(train.actual || train.plan, now, train.date);
          if (!trainArrival || !train.dauer) continue;
          
          const trainDeparture = new Date(trainArrival.getTime() + train.dauer * 60 * 1000);
          
          if (trainDeparture <= slotStart) {
            previousTrainDeparture = trainDeparture;
            break;
          }
        }
        
        // Find the next train that arrives after this slot ends
        // Skip cancelled trains and empty trains (they're available slots)
        let nextTrainArrival = null;
        for (let i = 0; i < sortedTrains.length; i++) {
          const train = sortedTrains[i];
          if (timeSuggestionState.activeTrain && train._uniqueId === timeSuggestionState.activeTrain._uniqueId) {
            continue;
          }
          
          // Skip cancelled trains (they're available)
          if (train.canceled) continue;
          
          // Skip empty trains without destination (they're available)
          if (!train.ziel || train.ziel.trim() === '') continue;
          
          const trainArrival = parseTime(train.actual || train.plan, now, train.date);
          if (!trainArrival) continue;
          
          if (trainArrival >= slotEnd) {
            nextTrainArrival = trainArrival;
            break;
          }
        }
        
        // Check if this slot fits in the available block
        let isAvailable = true;
        
        if (previousTrainDeparture && slotStart < previousTrainDeparture) {
          isAvailable = false;
        }
        
        if (nextTrainArrival && slotEnd > nextTrainArrival) {
          isAvailable = false;
        }
        
        // Check if any train conflicts with this slot
        // Only consider non-cancelled trains with destinations
        for (const train of sortedTrains) {
          if (timeSuggestionState.activeTrain && train._uniqueId === timeSuggestionState.activeTrain._uniqueId) {
            continue;
          }
          
          // Skip cancelled trains (they're available)
          if (train.canceled) continue;
          
          // Skip empty trains without destination (they're available)
          if (!train.ziel || train.ziel.trim() === '') continue;
          
          const trainStart = parseTime(train.actual || train.plan, now, train.date);
          if (!trainStart || !train.dauer) continue;
          
          const trainEnd = new Date(trainStart.getTime() + train.dauer * 60 * 1000);
          
          // Check for overlap
          if (slotStart < trainEnd && slotEnd > trainStart) {
            isAvailable = false;
            break;
          }
        }
        
        if (isAvailable) {
          const dayName = checkTime.toLocaleDateString('de-DE', { weekday: 'short' });
          const dateStr = checkTime.toISOString().split('T')[0];
          const timeStr = formatClock(checkTime);
          
          slots.push({
            date: dateStr,
            time: timeStr,
            dayName: dayName,
            datetime: new Date(checkTime),
            blockStart: previousTrainDeparture,
            blockEnd: nextTrainArrival
          });
          
          // Jump to the end of this block to find next block
          if (nextTrainArrival) {
            checkTime = new Date(nextTrainArrival);
            // Skip to next hour after the train
            checkTime.setHours(checkTime.getHours() + 1, 0, 0, 0);
          } else {
            // No more trains, jump ahead significantly
            checkTime = new Date(checkTime.getTime() + 24 * 60 * 60 * 1000);
            checkTime.setHours(7, 0, 0, 0);
          }
        } else {
          // Move forward by 1 hour
          checkTime = new Date(checkTime.getTime() + 60 * 60 * 1000);
        }
        
        // Skip curfew hours
        if (checkTime.getHours() >= 23 || checkTime.getHours() < 7) {
          checkTime.setDate(checkTime.getDate() + 1);
          checkTime.setHours(7, 0, 0, 0);
        }
      }
      
      return slots;
    }

    /**
     * Show the time slot suggestions inside the edit panel
     */
    function showTimeSuggestionInPanel(train, panelElement) {
      // Prevent opening if already open
      if (timeSuggestionState.activeTrain) {
        return;
      }
      
      // Store active train
      timeSuggestionState.activeTrain = train;
      timeSuggestionState.selectedSlot = null;
      timeSuggestionState.isPreviewActive = false;
      
      // Find available slots
      const slots = findAvailableTimeSlots(train.dauer || 60);
      
      // Find the focus-content-panel to replace
      const contentPanel = panelElement.querySelector('.focus-content-panel');
      if (!contentPanel) {
        console.error('Could not find focus-content-panel');
        return;
      }
      
      // Disable the suggestion button
      const suggestionButton = panelElement.querySelector('.time-suggestion-trigger-btn');
      if (suggestionButton) {
        suggestionButton.disabled = true;
      }
      
      // Save original content to restore later
      if (!contentPanel.dataset.originalContent) {
        contentPanel.dataset.originalContent = contentPanel.innerHTML;
      }
      
      // Clear and replace with suggestion UI
      contentPanel.innerHTML = '';
      contentPanel.style.display = 'flex';
      contentPanel.style.flexDirection = 'row';
      contentPanel.style.gap = '2vw';
      contentPanel.style.padding = '0 2vw';
      
      // Create main container for slots list
      const slotsContainer = document.createElement('div');
      slotsContainer.className = 'time-suggestion-slots-container';
      
      // Title
      const title = document.createElement('div');
      title.textContent = 'Verfügbare Zeitfenster';
      title.className = 'time-suggestion-title';
      slotsContainer.appendChild(title);
      
      // Slots list
      const slotsList = document.createElement('div');
      slotsList.className = 'time-suggestion-slots-list';
      
      if (slots.length === 0) {
        const noSlots = document.createElement('div');
        noSlots.textContent = 'Keine freien Zeitfenster gefunden';
        noSlots.className = 'time-suggestion-no-slots';
        slotsList.appendChild(noSlots);
      } else {
        slots.forEach(slot => {
          const slotButton = document.createElement('button');
          slotButton.className = 'time-suggestion-slot-button';
          slotButton.textContent = `${slot.dayName}, ${slot.datetime.toLocaleDateString('de-DE')} • ${slot.time}`;
          
          slotButton.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Update selected state
            timeSuggestionState.selectedSlot = slot;
            
            // Update visual state of all buttons
            slotsList.querySelectorAll('button').forEach(btn => {
              btn.classList.remove('selected');
            });
            slotButton.classList.add('selected');
            
            // Preview the task at this time
            previewTaskAtTime(train, slot);
          });
          
          slotsList.appendChild(slotButton);
        });
      }
      
      slotsContainer.appendChild(slotsList);
      
      // Create button container on the right
      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'time-suggestion-button-container';
      
      const acceptButton = document.createElement('button');
      acceptButton.textContent = 'Annehmen';
      acceptButton.className = 'time-suggestion-accept-btn';
      acceptButton.disabled = slots.length === 0;
      
      acceptButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (timeSuggestionState.selectedSlot) {
          await acceptTimeSuggestion();
        }
      });
      
      const cancelButton = document.createElement('button');
      cancelButton.textContent = 'Abbrechen';
      cancelButton.className = 'time-suggestion-cancel-btn';
      
      cancelButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const train = timeSuggestionState.activeTrain;
        hideTimeSuggestionInPanel();
        // Re-render the focus panel to restore editable state
        if (train) {
          renderFocusMode(train);
        }
      });
      
      buttonContainer.appendChild(acceptButton);
      buttonContainer.appendChild(cancelButton);
      
      // Add both sections to the content panel
      contentPanel.appendChild(slotsContainer);
      contentPanel.appendChild(buttonContainer);
      
      // Add global click handler to close overlay on any external action
      setTimeout(() => {
        document.addEventListener('click', globalOverlayClickHandler);
      }, 100);
    }
    
    /**
     * Global click handler to close overlay when clicking outside or on interactive elements
     */
    function globalOverlayClickHandler(e) {
      // Don't close if clicking inside the suggestion panel itself
      const focusPanel = document.getElementById('focus-panel');
      const overlay = document.getElementById('preview-overlay');
      
      // Don't close if clicking inside the overlay (allow interaction with preview)
      if (overlay && overlay.contains(e.target)) {
        return;
      }
      
      // Close if clicking on any button, editable field, or train entry (but not inside focus panel)
      const isButton = e.target.closest('button');
      const isEditable = e.target.closest('[data-editable="true"]');
      const isTrainEntry = e.target.closest('.train-entry, .belegungsplan-train-block');
      const isInsideFocusPanel = focusPanel && focusPanel.contains(e.target);
      
      if ((isButton || isEditable || isTrainEntry) && !isInsideFocusPanel) {
        hideTimeSuggestionInPanel();
      }
    }

    /**
     * Hide the time suggestion panel
     */
    function hideTimeSuggestionInPanel() {
      // Remove preview overlay if active
      removePreviewOverlay();
      
      // Remove global click handler
      document.removeEventListener('click', globalOverlayClickHandler);
      
      // Reset state
      timeSuggestionState = {
        activeTrain: null,
        selectedSlot: null,
        isPreviewActive: false
      };
    }

    /**
     * Preview task at selected time slot using overlay (render in gray on top of train list)
     */
    function previewTaskAtTime(train, slot) {
      if (!train || !slot) return;
      
      timeSuggestionState.isPreviewActive = true;
      timeSuggestionState.selectedSlot = slot;
      
      // Create a preview train object (don't modify the original)
      const previewTrain = {
        ...train,
        plan: slot.time,
        date: slot.date,
        _isPreview: true
      };
      
      // Render preview overlay for the specific day
      renderPreviewOverlay(previewTrain, slot.date);
    }

    /**
     * Accept the selected time suggestion and update the train
     */
    async function acceptTimeSuggestion() {
      if (!timeSuggestionState.selectedSlot || !timeSuggestionState.activeTrain) return;
      
      const train = timeSuggestionState.activeTrain;
      const slot = timeSuggestionState.selectedSlot;
      
      // Check if there's an empty train at this time slot with the same line number
      // If so, mark it as cancelled (it's being replaced)
      const now = new Date();
      const slotStartTime = parseTime(slot.time, now, slot.date);
      const trainDurationMs = (train.dauer || 0) * 60 * 1000;
      const slotEndTime = new Date(slotStartTime.getTime() + trainDurationMs);
      
      for (const existingTrain of processedTrainData.scheduledTrains) {
        // Skip the train we're placing
        if (existingTrain._uniqueId === train._uniqueId) continue;
        
        // Only check empty trains (no destination)
        if (existingTrain.ziel && existingTrain.ziel.trim() !== '') continue;
        
        // Must have same line number
        if (existingTrain.linie !== train.linie) continue;
        
        const existingStart = parseTime(existingTrain.actual || existingTrain.plan, now, existingTrain.date);
        if (!existingStart) continue;
        
        const existingDurationMs = (existingTrain.dauer || 0) * 60 * 1000;
        const existingEnd = new Date(existingStart.getTime() + existingDurationMs);
        
        // Check if times overlap (same slot)
        if (slotStartTime < existingEnd && slotEndTime > existingStart) {
          // Mark the empty train as cancelled
          existingTrain.canceled = true;
          
          // Update in schedule
          const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === existingTrain._uniqueId);
          if (spontIndex >= 0) {
            schedule.spontaneousEntries[spontIndex].canceled = true;
          }
        }
      }
      
      // Update train permanently
      train.plan = slot.time;
      train.date = slot.date;
      
      // Update in schedule
      const trainId = train._uniqueId;
      const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
      if (spontIndex >= 0) {
        schedule.spontaneousEntries[spontIndex].plan = slot.time;
        schedule.spontaneousEntries[spontIndex].date = slot.date;
      }
      
      // Save and re-render
      await saveSchedule();
      
      // Hide the suggestion panel and restore focus panel
      hideTimeSuggestionInPanel();
      
      // Re-render the focus panel with updated train
      renderFocusMode(train);
    }

    /**
     * Scroll to a specific train in the list
     */
    function scrollToTrain(trainId) {
      const trainListEl = document.getElementById('train-list');
      if (!trainListEl) return;
      
      const entries = trainListEl.querySelectorAll('.train-entry, .belegungsplan-train-block');
      for (const entry of entries) {
        const entryTrainId = entry.dataset.uniqueId;
        if (entryTrainId === trainId) {
          entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Highlight temporarily
          const originalBg = entry.style.background;
          entry.style.background = 'rgba(255, 255, 255, 0.2)';
          setTimeout(() => {
            entry.style.background = originalBg;
          }, 1500);
          
          break;
        }
      }
    }

    /**
     * Render preview overlay for the specific day
     * Creates an overlay that shows only the trains for the preview day
     */
    function renderPreviewOverlay(previewTrain, previewDate) {
      // Remove any existing overlay first
      removePreviewOverlay();
      
      const now = new Date();
      const trainListEl = document.getElementById('train-list');
      
      // Create overlay container with minimal styling - just positioning and background
      const overlay = document.createElement('div');
      overlay.id = 'preview-overlay';
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: #0d1156;
        overflow-y: auto;
        overflow-x: clip;
        z-index: 1000;
        scrollbar-width: none;
      `;
      
      // Content container doesn't need special styling for train list
      const content = document.createElement('div');
      
      // Get all trains for the preview date (including the preview train)
      const trainsForDay = processedTrainData.scheduledTrains
        .filter(t => !t.canceled && t.date === previewDate && t._uniqueId !== previewTrain._uniqueId)
        .concat([previewTrain])
        .sort((a, b) => {
          const ta = parseTime(a.actual || a.plan, now, a.date);
          const tb = parseTime(b.actual || b.plan, now, b.date);
          return ta - tb;
        });
      
      if (currentViewMode === 'belegungsplan') {
        // Render as Belegungsplan
        renderPreviewBelegungsplan(content, trainsForDay, previewTrain, now);
      } else {
        // Render as train list
        renderPreviewTrainList(content, trainsForDay, previewTrain, previewDate, now);
      }
      
      overlay.appendChild(content);
      trainListEl.style.position = 'relative';
      trainListEl.appendChild(overlay);
      
      // Position preview train in the middle of the viewport (no animation)
      requestAnimationFrame(() => {
        const previewBlock = overlay.querySelector(`[data-unique-id="${previewTrain._uniqueId}"]`);
        if (previewBlock) {
          const blockTop = previewBlock.offsetTop;
          const blockHeight = previewBlock.offsetHeight;
          const viewportHeight = overlay.clientHeight;
          
          // Center the block: scroll so block center aligns with viewport center
          const scrollPosition = blockTop - (viewportHeight / 2) + (blockHeight / 2);
          overlay.scrollTop = scrollPosition;
        }
      });
    }

    /**
     * Render preview as Belegungsplan - 1:1 clone of renderBelegungsplan() but for preview data
     */
    function renderPreviewBelegungsplan(container, trains, previewTrain, now) {
      // Create belegungsplan container
      const belegungsplan = document.createElement('div');
      belegungsplan.className = 'belegungsplan';

      // Get all scheduled trains (already filtered by caller to one day only)
      const allScheduledTrains = trains;
      
      if (allScheduledTrains.length === 0) {
        container.appendChild(belegungsplan);
        return;
      }

      // For preview, start from the beginning of the preview day (not current time)
      // Find the earliest train time to determine the day
      const firstTrainTime = parseTime(allScheduledTrains[0].actual || allScheduledTrains[0].plan, now, allScheduledTrains[0].date);
      const startHour = new Date(firstTrainTime);
      startHour.setHours(0, 0, 0, 0); // Start from midnight of the preview day
      
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

      // Note: No current time indicator line for preview (not relevant for future days)

      // Helper to calculate position and height (same as main function)
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

      // Detect overlaps and assign indent levels (same as main function)
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

      // Render train blocks (same as main function)
      trainData.forEach(({ train, pos, overlapLevel }) => {
        // Mark preview train
        const isPreview = train._uniqueId === previewTrain._uniqueId;
        if (isPreview) {
          train._isPreview = true;
        }
        
        // Use template to create HTML
        const htmlString = Templates.belegungsplanBlock(train, pos, overlapLevel, now);
        const template = document.createElement('template');
        template.innerHTML = htmlString.trim();
        const block = template.content.firstChild;
        
        // Note: No click handler for preview blocks
        
        belegungsplan.appendChild(block);
        
        // Clean up preview flag
        if (isPreview) {
          delete train._isPreview;
        }
      });

      container.appendChild(belegungsplan);
    }

    /**
     * Render preview as train list - matching official layout exactly
     */
    function renderPreviewTrainList(container, trains, previewTrain, previewDate, now) {
      // Add day separator
      const separatorHTML = Templates.daySeparator(previewDate);
      const sepTemplate = document.createElement('template');
      sepTemplate.innerHTML = separatorHTML.trim();
      container.appendChild(sepTemplate.content.firstChild);
      
      // Render each train using the same method as official train list
      trains.forEach(train => {
        const isPreview = train._uniqueId === previewTrain._uniqueId;
        const htmlString = Templates.trainEntry(train, now, false);
        const template = document.createElement('template');
        template.innerHTML = htmlString.trim();
        const entry = template.content.firstChild;
        
        entry.dataset.trainId = train._uniqueId;
        
        // Only highlight the preview train with subtle styling
        if (isPreview) {
          entry.style.border = '2px solid rgba(255, 200, 100, 0.6)';
          entry.style.boxShadow = '0 0 10px rgba(255, 200, 100, 0.3)';
        }
        
        container.appendChild(entry);
      });
    }

    /**
     * Remove preview overlay
     */
    function removePreviewOverlay() {
      const overlay = document.getElementById('preview-overlay');
      if (overlay) {
        overlay.remove();
      }
    }
    
    // ===== END OF TIME SLOT SUGGESTION =====

    // Create a single train entry