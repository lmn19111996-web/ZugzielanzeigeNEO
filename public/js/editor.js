// === TRAIN EDITOR / FOCUS MODE ===
    function makeAllFieldsEditable(train, panel, focusFieldName) {
      const editableFields = panel.querySelectorAll('[data-editable="true"]');
      const inputs = {};

      const findOrRestoreScheduleTrain = (trainId, fallbackTrain) => {
        schedule.spontaneousEntries = schedule.spontaneousEntries || [];

        let scheduleTrain = schedule.spontaneousEntries.find(t => t._uniqueId === trainId);
        if (scheduleTrain) return scheduleTrain;

        const detachedTrain = [schedule.localTrains || [], schedule.trains || []]
          .flat()
          .find(t => t && t._uniqueId === trainId && t.source === 'local');

        const restoreSource = detachedTrain || fallbackTrain;
        if (!restoreSource || restoreSource.source !== 'local') return null;

        const restoredTrain = {
          ...restoreSource,
          source: 'local'
        };
        delete restoredTrain._isPastTrain;

        schedule.spontaneousEntries.push(restoredTrain);
        regenerateTrainsFromSchedule();
        console.warn('⚠️ Restored stale local train into schedule before save:', trainId);
        return restoredTrain;
      };
      
      // Define tab order: date(1) → line(2) → destination(3) → stops(4) → plan(5) → duration(6) → actual(7)
      const tabOrder = ['date', 'linie', 'ziel', 'zwischenhalte', 'plan', 'dauer', 'actual'];
      
      // Update train object from input values - MUST update the original schedule object!
      const updateValue = (field, value) => {
        // Find the actual train in the schedule using unique ID
        const trainId = panel.dataset.trainId;
        let scheduleTrain = findOrRestoreScheduleTrain(trainId, train);

        if (!scheduleTrain) {
          console.error('❌ Could not find train in schedule!', {
            trainId: trainId,
            linie: train.linie,
            plan: train.plan,
            date: train.date
          });
        }

        // Update both the display train AND the schedule source
        if (field === 'date') {
          train.date = value;
          const dateObj = new Date(train.date);
          const newWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateObj.getDay()];
          train.weekday = newWeekday;
          if (scheduleTrain) {
            scheduleTrain.date = value;
            scheduleTrain.weekday = newWeekday;
          }
        } else if (field === 'dauer') {
          train.dauer = Number(value) || 0;
          if (scheduleTrain) scheduleTrain.dauer = Number(value) || 0;
        } else if (field === 'zwischenhalte') {
          // Preserve all line breaks, including empty lines
          train.zwischenhalte = value.split('\n');
          if (scheduleTrain) scheduleTrain.zwischenhalte = value.split('\n');
        } else if (field === 'actual') {
          train.actual = value || undefined;
          if (scheduleTrain) scheduleTrain.actual = value || undefined;
        } else {
          train[field] = value;
          if (scheduleTrain) scheduleTrain[field] = value;
        }
        
        panel.dataset.currentTrain = JSON.stringify(train);
      };
      
      // Convert each field to input
      editableFields.forEach(field => {
        const fieldName = field.getAttribute('data-field');
        const inputType = field.getAttribute('data-input-type');
        const currentValue = field.getAttribute('data-value');
        const placeholder = field.getAttribute('data-placeholder') || '';
        
        // Create input element (or textarea for stops)
        const input = inputType === 'textarea' 
          ? document.createElement('textarea') 
          : document.createElement('input');
        
        if (inputType !== 'textarea') {
          input.type = inputType;
        }
        input.value = currentValue;
        if (placeholder) input.placeholder = placeholder;
        
        // Match parent field styling exactly
        input.style.background = 'rgba(255, 255, 255, 0.1)';
        input.style.border = 'none';
        input.style.outline = 'none';
        input.style.borderRadius = '2px';
        input.style.color = 'white';
        input.style.fontSize = 'inherit'; // Match parent font size exactly
        input.style.fontWeight = 'inherit';
        input.style.textAlign = field.style.textAlign || 'inherit';
        input.style.width = '100%';
        input.style.height = '100%';
        input.style.fontFamily = 'inherit';
        input.style.resize = 'none';
        input.style.padding = '0';
        input.style.margin = '0';
        input.style.boxSizing = 'border-box';
        input.style.letterSpacing = 'inherit';
        input.style.lineHeight = 'inherit';
        
        // Special styling for actual time field - black text
        if (fieldName === 'actual') {
          input.style.color = 'black';
        }
        
        // Special styling for textarea (stops)
        if (inputType === 'textarea') {
          input.style.minHeight = '8vh';
          input.style.whiteSpace = 'pre-wrap';
        }
        
        // Special styling for line field
        if (fieldName === 'linie') {
          input.style.fontWeight = 'bold';
          input.style.textAlign = 'center';
          input.style.width = 'auto';
          input.style.maxWidth = '6vw'; // Smaller width
          input.style.marginLeft = '3vh';
        }
        
        // Special styling for duration field
        if (fieldName === 'dauer') {
          input.style.fontSize = 'clamp(14px, 2vh, 24px)'; // Smaller
          const wrapper = document.createElement('div');
          wrapper.style.display = 'flex';
          wrapper.style.alignItems = 'center';
          wrapper.style.gap = '0.3vw';
          wrapper.appendChild(input);
          const minLabel = document.createElement('span');
          minLabel.textContent = 'Min';
          minLabel.style.color = 'rgba(255, 255, 255, 0.7)';
          minLabel.style.fontSize = 'clamp(12px, 1.6vh, 20px)'; // Smaller label
          wrapper.appendChild(minLabel);
          field.innerHTML = '';
          field.appendChild(wrapper);
        } else {
          field.innerHTML = '';
          field.appendChild(input);
        }
        
        // Remove the data attributes that trigger the empty box styling
        field.removeAttribute('data-editable');
        field.removeAttribute('data-value');
        
        inputs[fieldName] = input;
        
        // Pause refresh when editing
        input.addEventListener('focus', () => {
          isEditingTrain = true;
        });
        
        // Update train object on change
        input.addEventListener('change', () => updateValue(fieldName, input.value));
        input.addEventListener('input', () => updateValue(fieldName, input.value));
        
        // Handle Tab key for navigation
        input.addEventListener('keydown', (e) => {
          // For textarea (stops), allow Enter for new lines, use Ctrl+Enter to close
          if (inputType === 'textarea' && e.key === 'Enter' && !e.ctrlKey) {
            return; // Allow default behavior (new line)
          }
          
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            updateValue(fieldName, input.value); // Save current value
            
            if (e.key === 'Tab') {
              // Find next field in tab order
              const currentIndex = tabOrder.indexOf(fieldName);
              let nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
              
              // Wrap around
              if (nextIndex >= tabOrder.length) nextIndex = 0;
              if (nextIndex < 0) nextIndex = tabOrder.length - 1;
              
              const nextFieldName = tabOrder[nextIndex];
              const nextInput = inputs[nextFieldName];
              if (nextInput) {
                nextInput.focus();
                // Don't select all for better cursor control
                if (nextInput.setSelectionRange && nextInput.type === 'text') {
                  nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
                }
              }
            } else if (e.key === 'Enter') {
              // Just Enter key - close edit mode (Ctrl+Enter for textarea)
              renderFocusMode(train);
            }
          } else if (e.key === 'Escape') {
            // Cancel edit and revert
            e.preventDefault();
            e.stopPropagation();
            renderFocusMode(train);
          }
        });
      });
      
      // Global blur handler - only revert when clicking outside all inputs
      let blurTimeout;
      const handleBlur = () => {
        clearTimeout(blurTimeout);
        blurTimeout = setTimeout(async () => {
          const newFocus = document.activeElement;
          const isStillInInputs = newFocus && (
            newFocus.tagName === 'INPUT' || 
            newFocus.tagName === 'TEXTAREA'
          );
          
          // Only save and exit if focus left all input fields
          if (!isStillInInputs) {
            // SAVE SCROLL POSITION BEFORE ANY RENDERING
            const trainListEl = document.getElementById('train-list');
            const savedScroll = trainListEl ? trainListEl.scrollTop : 0;
            
            // Get train ID before any operations
            const trainId = train._uniqueId;
            
            // OPTIMISTIC UI: Render immediately, then save in background
            // 1. Refresh UI with the changes we just made
            refreshUIOnly();
            
            // 2. Re-render focus panel with fresh train reference
            const updatedTrain = processedTrainData.allTrains.find(t => 
              t._uniqueId === trainId
            );
            if (updatedTrain) {
              renderFocusMode(updatedTrain);
            }
            
            // 3. Save in background - no await, no callback needed
            //    When save succeeds, version is updated automatically, no UI refresh needed
            saveSchedule();
            
            // 4. Reset editing flag immediately (edit is done)
            isEditingTrain = false;
            
            // RESTORE SCROLL POSITION AFTER RENDERING
            setTimeout(() => {
              if (trainListEl && savedScroll > 0) {
                trainListEl.scrollTop = savedScroll;
              }
            }, 150);
          }
        }, 50);
      };
      
      Object.values(inputs).forEach(input => {
        input.addEventListener('blur', handleBlur);
      });
      
      // Don't explicitly focus - let the click event naturally focus and position cursor
      // The browser will handle cursor positioning based on where the user clicked
    }

    // Persistent timeout for delay button debouncing (survives re-renders)
    let delayButtonTimeout = null;
    
    // Global handlers for editor drawer (prevent duplicate listener registration)
    let editorDrawerEscHandler = null;
    let editorDrawerClickOutHandler = null;
    let editorDrawerBackHandler = null;
    let editorDrawerToggleHandler = null;

    // Global handlers for announcement drawer (prevent duplicate listener registration)
    let announcementDrawerEscHandler = null;
    let announcementDrawerClickOutHandler = null;
    let announcementDrawerBackHandler = null;

    function renderFocusMode(train, editMode = 'instance') {
      const now = new Date();
      
      // If suggestion panel is active for this train, don't re-render
      if (timeSuggestionState.activeTrain && timeSuggestionState.activeTrain._uniqueId === train._uniqueId) {
        return;
      }
      
      // Use the editor drawer for both mobile and desktop
      // It will be styled as fullscreen on mobile via CSS
      desktopFocusedTrainId = train._uniqueId; // Track focused train
      const panel = document.getElementById('focus-panel');
      const template = document.getElementById('focus-template');
      
      if (!panel || !template) {
        console.error('Missing panel or template!');
        return;
      }
      
      openEditorDrawer(train);
      hideWorkspacePlaceholder();
      
      // Apply line color to editor drawer border
      const lineColor = getLineColor(train.linie || 'S1');
      panel.style.borderLeft = `4px solid ${lineColor}`;
      panel.style.borderTopLeftRadius = '8px';
      panel.style.borderBottomLeftRadius = '8px';
      
      try {
        // Detect recurring train type
        const isRecurring = !!train._templateId;
        const isRecurringStem     = isRecurring && editMode === 'stem';
        const isRecurringInstance = isRecurring && editMode === 'instance';

        // In stem mode: override train fields with the stem template data so the
        // editor is populated from the source-of-truth, not the child instance.
        if (isRecurringStem) {
          const stemObj = (schedule.fixedSchedule || []).find(s => s._uniqueId === train._templateId);
          if (stemObj) {
            const { _uniqueId, _templateId } = train;
            train = {
              ...stemObj,
              _uniqueId,
              _templateId,
              date:   stemObj.startDate || '',
              source: 'local'
            };
          }
        }

        // Only allow editing for local schedule trains
        const isEditable = train.source === 'local';

        // Clear panel and clone template
        panel.innerHTML = '';
        const clone = template.content.cloneNode(true);
        
        // Populate Line
        const lineValue = clone.querySelector('[data-focus="line"]');
        lineValue.textContent = train.linie || '';
        lineValue.parentElement.setAttribute('data-value', train.linie || '');
        lineValue.parentElement.setAttribute('data-placeholder', 'S1, S2, ...');
        if (isEditable) {
          lineValue.parentElement.setAttribute('data-editable', 'true');
        }
        
        // Populate Destination
        const destinationValue = clone.querySelector('[data-focus="destination"]');
        destinationValue.textContent = train.ziel || '';
        destinationValue.parentElement.setAttribute('data-value', train.ziel || '');
        destinationValue.parentElement.setAttribute('data-placeholder', 'Ziel eingeben');
        if (isEditable) {
          destinationValue.parentElement.setAttribute('data-editable', 'true');
        }
        
        // Populate Date - long format display
        const dateValue = clone.querySelector('[data-focus="date"]');
        const trainDate = train.date ? new Date(train.date) : now;
        const dateDisplay = trainDate.toLocaleDateString('de-DE', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        dateValue.textContent = dateDisplay;
        dateValue.parentElement.setAttribute('data-value', train.date || now.toISOString().split('T')[0]);
        
        // Set data-editable for local trains only
        if (isEditable) {
          dateValue.parentElement.setAttribute('data-editable', 'true');
        }
        
        // Populate Arrival (Plan)
        const arrivalPlanValue = clone.querySelector('[data-focus="arrival-plan"]');
        const planDuration = Number(train.dauer) || 0;
        const planArrival = calculateArrivalTime(train.plan, planDuration, train.date);
        if (train.plan && planArrival) {
          arrivalPlanValue.textContent = `${train.plan} - ${planArrival}`;
        } else {
          arrivalPlanValue.textContent = train.plan || 'Keine Zeit';
        }
        arrivalPlanValue.parentElement.setAttribute('data-value', train.plan || '');
        arrivalPlanValue.parentElement.setAttribute('data-placeholder', '14:00');
        if (isEditable) {
          arrivalPlanValue.parentElement.setAttribute('data-editable', 'true');
        }
        
        // Populate Arrival (Actual)
        const arrivalActualValue = clone.querySelector('[data-focus="arrival-actual"]');
        const hasDelay = train.actual && train.actual !== train.plan;
        const actualArrival = train.actual ? calculateArrivalTime(train.actual, planDuration, train.date) : null;
        if (hasDelay) {
          if (actualArrival) {
            arrivalActualValue.textContent = `${train.actual} - ${actualArrival}`;
          } else {
            arrivalActualValue.textContent = train.actual;
          }
          arrivalActualValue.parentElement.style.color = 'rgb(255, 200, 100)';
        } else {
          if (train.actual && actualArrival) {
            arrivalActualValue.textContent = `${train.actual} - ${actualArrival}`;
          } else {
            arrivalActualValue.textContent = train.actual || 'Keine Verspätung';
          }
          arrivalActualValue.parentElement.style.opacity = '0.6';
        }
        arrivalActualValue.parentElement.setAttribute('data-value', train.actual || '');
        arrivalActualValue.parentElement.setAttribute('data-placeholder', '14:05');
        if (isEditable) {
          arrivalActualValue.parentElement.setAttribute('data-editable', 'true');
        }
        
        // Populate Duration
        const durationValue = clone.querySelector('[data-focus="duration"]');
        durationValue.textContent = train.dauer ? `${train.dauer} Min` : 'Keine Dauer';
        durationValue.parentElement.setAttribute('data-value', train.dauer || '0');
        durationValue.parentElement.setAttribute('data-placeholder', '90');
        if (isEditable) {
          durationValue.parentElement.setAttribute('data-editable', 'true');
        }

        // Populate Stops
        const stopsValue = clone.querySelector('[data-focus="stops"]');
        let stopsArray = [];
        if (train.zwischenhalte) {
          if (Array.isArray(train.zwischenhalte)) {
            stopsArray = train.zwischenhalte;
          } else if (typeof train.zwischenhalte === 'string') {
            stopsArray = train.zwischenhalte.split('\n');
          }
        }
        train.zwischenhalte = stopsArray;
        stopsValue.textContent = stopsArray.length > 0 ? stopsArray.join('\n') : 'Keine Zwischenhalte';
        if (stopsArray.length === 0) {
          stopsValue.parentElement.style.opacity = '0.6';
        }
        stopsValue.parentElement.setAttribute('data-value', stopsArray.join('\n'));
        stopsValue.parentElement.setAttribute('data-placeholder', 'Eine Station pro Zeile...');
        if (isEditable) {
          stopsValue.parentElement.setAttribute('data-editable', 'true');
        }

        // Populate Project dropdown
        const projectValue = clone.querySelector('[data-focus="project"]');
        if (projectValue) {
          const projects = schedule.projects || [];
          const currentProject = train.projectId ? projects.find(p => p._uniqueId === train.projectId) : null;

          if (currentProject) {
            projectValue.textContent = currentProject.name || 'Unbenanntes Projekt';
          } else {
            projectValue.textContent = 'Kein Projekt';
            projectValue.parentElement.style.opacity = '0.6';
          }
          projectValue.parentElement.setAttribute('data-value', train.projectId || '');
        }

        // Append to panel
        panel.appendChild(clone);

        // Setup project badge (show next to label if project assigned)
        const projectBadge = panel.querySelector('.editor-field[data-field="projectId"] .project-badge');
        if (projectBadge && train.projectId) {
          // Show badge and attach click handler
          projectBadge.style.display = 'inline';
          projectBadge.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            openProjectEditor(train.projectId);
          };
        } else if (projectBadge) {
          // Hide badge if no project
          projectBadge.style.display = 'none';
        }

        // Determine the type of object being edited and show/hide fields accordingly
        const isNote = train.type === 'note';
        const isTodo = train.type === 'todo';

        if (isNote) {
          // For notes: show only Ziel and Zwischenhalte
          const hideFields = ['linie', 'date', 'plan', 'actual', 'dauer', 'projectId'];
          hideFields.forEach(field => {
            const fieldEl = panel.querySelector(`.editor-field[data-field="${field}"]`);
            if (fieldEl) {
              fieldEl.style.display = 'none';
              // Remove from tab order
              const input = fieldEl.querySelector('input, textarea, select');
              if (input) input.setAttribute('tabindex', '-1');
            }
          });
          // Hide project badge for notes
          const noteProjectBadge = panel.querySelector('.editor-field[data-field="projectId"] .project-badge');
          if (noteProjectBadge) noteProjectBadge.style.display = 'none';

          const delayButtons = panel.querySelector('.editor-delay-buttons');
          if (delayButtons) {
            delayButtons.style.display = 'none';
            delayButtons.querySelectorAll('button').forEach(btn => btn.setAttribute('tabindex', '-1'));
          }
        } else if (isTodo) {
          // For todos: show only Ziel, Datum, and Zwischenhalte
          const hideFields = ['linie', 'plan', 'actual', 'dauer', 'projectId'];
          hideFields.forEach(field => {
            const fieldEl = panel.querySelector(`.editor-field[data-field="${field}"]`);
            if (fieldEl) {
              fieldEl.style.display = 'none';
              // Remove from tab order
              const input = fieldEl.querySelector('input, textarea, select');
              if (input) input.setAttribute('tabindex', '-1');
            }
          });
          // Hide project badge for todos
          const todoProjectBadge = panel.querySelector('.editor-field[data-field="projectId"] .project-badge');
          if (todoProjectBadge) todoProjectBadge.style.display = 'none';
          const delayButtons = panel.querySelector('.editor-delay-buttons');
          if (delayButtons) {
            delayButtons.style.display = 'none';
            delayButtons.querySelectorAll('button').forEach(btn => btn.setAttribute('tabindex', '-1'));
          }
        }
        // For trains and tasks: show all fields (default behavior, no hiding needed)

        // ---- RECURRING TRAIN: stem mode — change labels, hide irrelevant fields ----
        if (isRecurringStem) {
          // VORLAGE identification badge at the top
          const container = panel.querySelector('.editor-container');
          if (container) {
            const badge = document.createElement('div');
            badge.className = 'editor-vorlage-badge';
            badge.textContent = 'VORLAGE';
            container.prepend(badge);
          }

          const dateLabel = panel.querySelector('.editor-field[data-field="date"] .editor-field-label');
          if (dateLabel) dateLabel.textContent = 'Gültig ab';

          ['actual'].forEach(f => {
            const el = panel.querySelector(`.editor-field[data-field="${f}"]`);
            if (el) el.style.display = 'none';
          });
          const delayButtons = panel.querySelector('.editor-delay-buttons');
          if (delayButtons) delayButtons.style.display = 'none';
          const recurringCancelBtn = panel.querySelector('[data-focus-action="cancel"]');
          if (recurringCancelBtn) recurringCancelBtn.style.display = 'none';

          // Recurrence: configure the template field
          const recFieldStem = panel.querySelector('.editor-field[data-field="recurrencePattern"]');
          if (recFieldStem) {
            const stemObj = (schedule.fixedSchedule || []).find(s => s._uniqueId === train._templateId);
            const curPattern = stemObj?.recurrence?.pattern || 'weekdays';
            const patternLabels = { weekdays: 'Werktage (Mo–Fr)', daily: 'Täglich', weekly: 'Wöchentlich' };
            recFieldStem.setAttribute('data-value', curPattern);
            recFieldStem.setAttribute('data-input-type', 'recurrence-stem');
            recFieldStem.setAttribute('data-editable', 'true');
            recFieldStem.style.display = '';
            recFieldStem.querySelector('.editor-field-value').textContent = patternLabels[curPattern] || curPattern;
            const vorlageLinkStem = recFieldStem.querySelector('.vorlage-link-badge');
            if (vorlageLinkStem) vorlageLinkStem.style.display = 'none';
          }
        }

        // ---- ALL TRAINS in train editor mode: recurrence field below date, no label ----
        if (!isRecurringStem) {
          const dateFieldEl = panel.querySelector('.editor-field[data-field="date"]');
          if (dateFieldEl) {
            if (isRecurring) {
              // Recurring instance: lock date + plan
              dateFieldEl.removeAttribute('data-editable');
              dateFieldEl.style.opacity = '0.5';
              dateFieldEl.style.cursor = 'default';
              dateFieldEl.title = 'Datum wird durch Vorlage bestimmt';

              const planFieldEl = panel.querySelector('.editor-field[data-field="plan"]') ||
                panel.querySelector('[data-focus="plan"]')?.closest('.editor-field');
              if (planFieldEl) {
                planFieldEl.removeAttribute('data-editable');
                planFieldEl.style.opacity = '0.5';
                planFieldEl.style.cursor = 'default';
                planFieldEl.title = 'Abfahrtszeit wird durch Vorlage bestimmt';
              }

              const stemObj = (schedule.fixedSchedule || []).find(s => s._uniqueId === train._templateId);
              const curPattern = stemObj?.recurrence?.pattern || 'weekdays';
              const patternLabels = { weekdays: 'Werktage (Mo–Fr)', daily: 'Täglich', weekly: 'Wöchentlich' };

              // Configure the template recurrence field
              const recField = panel.querySelector('.editor-field[data-field="recurrencePattern"]');
              if (recField) {
                recField.setAttribute('data-value', curPattern);
                recField.style.display = '';
                recField.querySelector('.editor-field-value').textContent = patternLabels[curPattern] || curPattern;
                const vorlageLinkBadge = recField.querySelector('.vorlage-link-badge');
                if (vorlageLinkBadge) vorlageLinkBadge.style.display = 'inline';
              }

            } else if (isEditable) {
              // Normal train: show the 'Wiederholung konfigurieren' badge in the Datum label
              const recConfigBadge = dateFieldEl.querySelector('.recurrence-config-badge');
              if (recConfigBadge) recConfigBadge.style.display = 'inline';
              // The recurrencePattern field (from template) stays hidden until clicked
              const recField = panel.querySelector('.editor-field[data-field="recurrencePattern"]');
              if (recField) {
                recField.setAttribute('data-value', 'none');
                recField.setAttribute('data-input-type', 'recurrence');
                recField.setAttribute('data-editable', 'true');
                recField.querySelector('.editor-field-value').style.opacity = '0.6';
                recField.querySelector('.editor-field-value').textContent = 'Keine Wiederholung';
              }
            }
          }
        }
        
        // Update cancel button based on train state
        const cancelBtn = panel.querySelector('[data-focus-action="cancel"]');
        const deleteBtn = panel.querySelector('[data-focus-action="delete"]');
        if (cancelBtn) {
          if (train.canceled) {
            cancelBtn.classList.add('reactivate');
            cancelBtn.textContent = 'Reaktivieren';
          } else {
            cancelBtn.classList.remove('reactivate');
            cancelBtn.textContent = 'Durchstreichen';
          }
        }
        if (deleteBtn) {
          deleteBtn.textContent = 'Löschen';
        }
        
        // Store train reference
        panel.dataset.trainId  = train._uniqueId;
        panel.dataset.editMode = editMode;
        panel.dataset.isEditable = isEditable;
        
        // Only add editing functionality for local trains
        if (!isEditable) {
          // Make all fields non-editable
          panel.querySelectorAll('.editor-field').forEach(field => {
            field.removeAttribute('data-editable');
            field.style.cursor = 'default';
            field.style.opacity = '0.6';
          });
          // Hide action buttons for non-editable trains
          const actions = panel.querySelector('.editor-actions');
          if (actions) actions.style.display = 'none';
          return;
        }

        const findOrRestoreScheduleTrain = (trainId, fallbackTrain) => {
          schedule.spontaneousEntries = schedule.spontaneousEntries || [];

          let scheduleTrain = schedule.spontaneousEntries.find(t => t._uniqueId === trainId);
          if (scheduleTrain) return scheduleTrain;

          const detachedTrain = [schedule.localTrains || [], schedule.trains || []]
            .flat()
            .find(t => t && t._uniqueId === trainId && t.source === 'local');

          const restoreSource = detachedTrain || fallbackTrain;
          if (!restoreSource || restoreSource.source !== 'local') return null;

          const restoredTrain = {
            ...restoreSource,
            source: 'local'
          };
          delete restoredTrain._isPastTrain;

          schedule.spontaneousEntries.push(restoredTrain);
          regenerateTrainsFromSchedule();
          console.warn('⚠️ Restored stale local train into schedule before save:', trainId);
          return restoredTrain;
        };
        
      // Helper function to save all field changes and exit edit mode
      let saveAllFieldsInFlight = false;
      const saveAllFields = async () => {
        if (saveAllFieldsInFlight) {
          console.log('⏸️ saveAllFields skipped - already in progress');
          return;
        }

        saveAllFieldsInFlight = true;
        console.log('💾 saveAllFields called for train:', train._uniqueId);
        
        // Set lock to prevent concurrent operations
        isDataOperationInProgress = true;

        try {
          const editableFields = panel.querySelectorAll('.editor-field');
          let hasChanges = false;
          
          editableFields.forEach(field => {
            const input = field.querySelector('input, textarea, select');
            if (!input) return;
            
            const fieldName = field.getAttribute('data-field');
            const newValue = input.value;
            const oldValue = field.getAttribute('data-value');
            
            console.log(`  Field ${fieldName}: "${oldValue}" -> "${newValue}"`);
            
            // Only update if value changed
            if (newValue !== oldValue) {
              hasChanges = true;
              console.log(`  → Change detected in ${fieldName}`);
              
              // Update train object
              if (fieldName === 'date') {
                train.date = newValue;
                const dateObj = new Date(newValue);
                train.weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateObj.getDay()];
              } else if (fieldName === 'dauer') {
                train.dauer = Number(newValue) || 0;
              } else if (fieldName === 'zwischenhalte') {
                train.zwischenhalte = newValue.split('\n');
              } else if (fieldName === 'actual') {
                train.actual = newValue || undefined;
              } else if (fieldName === 'projectId') {
                train.projectId = newValue || undefined;
              } else if (fieldName === 'recurrencePattern') {
                // Handled by the dedicated recurrence-change block below; skip generic assignment
              } else {
                train[fieldName] = newValue;
              }
            }
          });
          
          // Find the train in schedule
          const trainId = panel.dataset.trainId;
          console.log('  Looking for train with ID:', trainId);

          // ---- STEM SAVE PATH ----
          if (panel.dataset.editMode === 'stem' && train._templateId) {
            const stemId  = train._templateId;
            const stem    = (schedule.fixedSchedule || []).find(s => s._uniqueId === stemId);
            if (stem) {
              // Write every edited field value directly onto the stem
              panel.querySelectorAll('.editor-field').forEach(field => {
                const input = field.querySelector('input, textarea, select');
                if (!input) return;
                const fieldName = field.getAttribute('data-field');
                const val = input.value;
                if      (fieldName === 'linie')             stem.linie       = val;
                else if (fieldName === 'ziel')              stem.ziel        = val;
                else if (fieldName === 'plan')            { stem.plan = val; stem.actual = val; }
                else if (fieldName === 'dauer')             stem.dauer       = Number(val) || 0;
                else if (fieldName === 'zwischenhalte')     stem.zwischenhalte = val.split('\n').filter(l => l.trim());
                else if (fieldName === 'date')              stem.startDate   = val;
                else if (fieldName === 'projectId')         stem.projectId   = val || undefined;
                else if (fieldName === 'recurrencePattern') stem.recurrence  = { ...stem.recurrence, pattern: val };
              });

              const todayStr = new Date().toISOString().split('T')[0];
              // Keep past skip records; clear future ones (they'll be re-evaluated fresh)
              stem.skippedDates = (stem.skippedDates || []).filter(d => d <= todayStr);
              // Remove future children so rematerialization regenerates them cleanly
              schedule.spontaneousEntries = schedule.spontaneousEntries.filter(
                t => t._templateId !== stemId || t.date <= todayStr
              );
              // Rebuild from updated stem
              materializeFromStems();
              regenerateTrainsFromSchedule();
              processTrainData(schedule);
              refreshUIOnly();
              saveSchedule();

              // Stay in stem editor after save (don't jump to instance)
              renderFocusMode(train, 'stem');
            }
            return;
          }
          // ---- END STEM SAVE PATH ----

          let scheduleTrain = findOrRestoreScheduleTrain(trainId, train);
          console.log('  Found in spontaneousEntries:', !!scheduleTrain);

          if (!scheduleTrain) {
            console.error('❌ Train not found in schedule!');
            return;
          }

          // ---- RECURRENCE CHANGE HANDLING (train editor only) ----
          const recSel = panel.querySelector('.editor-field[data-field="recurrencePattern"] select');
          if (recSel && panel.dataset.editMode !== 'stem') {
            const newPattern = recSel.value;
            const oldStemId  = train._templateId;
            const oldStem    = oldStemId ? (schedule.fixedSchedule || []).find(s => s._uniqueId === oldStemId) : null;
            const oldPattern = oldStem?.recurrence?.pattern || 'none';
            const _tn = new Date();
            const todayStr = `${_tn.getFullYear()}-${String(_tn.getMonth()+1).padStart(2,'0')}-${String(_tn.getDate()).padStart(2,'0')}`;

            if (newPattern !== 'none' && oldPattern === 'none') {
              // PROMOTE: normal train → recurring
              const stemId   = 'stem_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
              const entryDate = scheduleTrain.date || todayStr;
              const newStem = {
                _uniqueId:    stemId,
                linie:        scheduleTrain.linie || '',
                ziel:         scheduleTrain.ziel  || '',
                plan:         scheduleTrain.plan  || '',
                dauer:        scheduleTrain.dauer || 0,
                zwischenhalte: Array.isArray(scheduleTrain.zwischenhalte) ? [...scheduleTrain.zwischenhalte] : [],
                projectId:    scheduleTrain.projectId || undefined,
                startDate:    entryDate,
                recurrence:   { pattern: newPattern, days: [] },
                skippedDates: [entryDate] // this instance already exists, don’t re-materialise
              };
              schedule.fixedSchedule = schedule.fixedSchedule || [];
              schedule.fixedSchedule.push(newStem);
              scheduleTrain._templateId = stemId;
              train._templateId         = stemId;
              hasChanges = true;
              materializeFromStems();
              console.log('↻ Promoted train to recurring, stem:', stemId);

            } else if (newPattern === 'none' && oldPattern !== 'none') {
              // DETACH: recurring instance → standalone
              if (oldStem) {
                oldStem.skippedDates = oldStem.skippedDates || [];
                if (train.date && !oldStem.skippedDates.includes(train.date))
                  oldStem.skippedDates.push(train.date);
              }
              delete scheduleTrain._templateId;
              delete train._templateId;
              hasChanges = true;
              console.log('✂ Detached recurring instance → standalone');

            } else if (newPattern !== 'none' && oldPattern !== 'none' && newPattern !== oldPattern) {
              // PATTERN CHANGE: update stem + rematerialise future
              if (oldStem) {
                oldStem.recurrence   = { ...oldStem.recurrence, pattern: newPattern };
                oldStem.skippedDates = (oldStem.skippedDates || []).filter(d => d <= todayStr);
                schedule.spontaneousEntries = schedule.spontaneousEntries.filter(
                  t => t._templateId !== oldStemId || t.date <= todayStr
                );
                materializeFromStems();
                hasChanges = true;
                console.log('🔄 Recurrence pattern changed to', newPattern);
              }
            }
          }
          // ---- END RECURRENCE HANDLING ----
        
          // If changes were made, update schedule and save
          if (hasChanges) {
            console.log('✅ Changes detected, saving...');
            // Update the schedule train with all changes
            Object.assign(scheduleTrain, train);
            
            // OPTIMISTIC UI: Render immediately, then save in background
            refreshUIOnly();
            
            // Refresh note panel if it's open and this is a note
            const isNote = train.type === 'note';
            const noteDrawer = document.getElementById('note-drawer');
            if (isNote && noteDrawer && noteDrawer.classList.contains('is-open')) {
              console.log('  Refreshing note panel');
              renderNotePanel();
            }
            
            // Save in background - no await, no callback needed
            saveSchedule();
          } else {
            console.log('  No changes detected');
          }
          
          // Always re-render the panel to exit edit mode
          // Find the train in the freshly processed data (has all computed properties)
          const updatedTrain = processedTrainData.allTrains.find(t => 
            t._uniqueId === trainId
          );
          
          if (updatedTrain) {
            renderFocusMode(updatedTrain);
          } else {
            console.error('Could not find updated train in processedTrainData!');
          }
        } finally {
          isDataOperationInProgress = false;
          saveAllFieldsInFlight = false;
        }
      };
      
      // ============ LEGACY-STYLE EDIT MECHANISM ============
      
      // Click any field to enter edit mode for ALL fields
      const editableFields = panel.querySelectorAll('[data-editable="true"]');
      editableFields.forEach(field => {
        field.addEventListener('mousedown', function(e) {
          // Check if already in edit mode
          const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea, [data-editable="true"] select');
          if (hasInputs) {
            return; // Already in edit mode, let natural focus work
          }
          
          const fieldName = field.getAttribute('data-field');
          
          // Calculate click position for cursor placement
          const rect = field.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const fieldWidth = rect.width;
          const text = field.textContent || '';
          
          // Estimate character position based on click location
          const clickRatio = clickX / fieldWidth;
          const estimatedPosition = Math.round(text.length * clickRatio);
          
          // Convert ALL fields to inputs
          const inputs = {};
          const allEditableFields = panel.querySelectorAll('[data-editable="true"]');
          
          allEditableFields.forEach(f => {
            // Skip if already converted to an interactive input
            if (f.querySelector('input, textarea, select')) return;
            
            const fName = f.getAttribute('data-field');
            const inputType = f.getAttribute('data-input-type');
            const currentValue = f.getAttribute('data-value');
            const placeholder = f.getAttribute('data-placeholder') || '';
            const valueElement = f.querySelector('.editor-field-value');
            
            // Create input or select based on type
            let input;
            if (inputType === 'recurrence') {
              // Recurrence pattern dropdown (for normal trains → promote to recurring)
              input = document.createElement('select');
              input.style.width = '100%';
              input.style.background = 'var(--color-bg-panel)';
              input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
              input.style.borderRadius = '0';
              input.style.padding = '0.5vh';
              input.style.color = 'white';
              input.style.fontFamily = 'inherit';
              input.style.fontSize = '2vh';
              input.style.outline = 'none';
              input.style.cursor = 'pointer';
              [
                { value: 'none',     label: 'Keine Wiederholung' },
                { value: 'weekdays', label: 'Werktage (Mo\u2013Fr)' },
                { value: 'daily',    label: 'T\u00e4glich' },
                { value: 'weekly',   label: 'W\u00f6chentlich' }
              ].forEach(({ value, label }) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                input.appendChild(opt);
              });
              input.value = currentValue || 'none';
            } else if (inputType === 'recurrence-stem') {
              // Recurrence pattern dropdown for stem editor (no “Keine” option)
              input = document.createElement('select');
              input.style.width = '100%';
              input.style.background = 'var(--color-bg-panel)';
              input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
              input.style.borderRadius = '0';
              input.style.padding = '0.5vh';
              input.style.color = 'white';
              input.style.fontFamily = 'inherit';
              input.style.fontSize = '2vh';
              input.style.outline = 'none';
              input.style.cursor = 'pointer';
              [
                { value: 'weekdays', label: 'Werktage (Mo\u2013Fr)' },
                { value: 'daily',    label: 'T\u00e4glich' },
                { value: 'weekly',   label: 'W\u00f6chentlich' }
              ].forEach(({ value, label }) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                input.appendChild(opt);
              });
              input.value = currentValue || 'weekdays';
            } else if (inputType === 'select') {
              // Special handling for project dropdown
              input = document.createElement('select');
              input.style.width = '100%';
              input.style.background = 'var(--color-bg-panel)';
              input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
              input.style.borderRadius = '0';
              input.style.padding = '0.5vh';
              input.style.color = 'white';
              input.style.fontFamily = 'inherit';
              input.style.fontSize = '2vh';
              input.style.outline = 'none';
              
              // Add "No Project" option
              const noneOption = document.createElement('option');
              noneOption.value = '';
              noneOption.textContent = 'Kein Projekt';
              input.appendChild(noneOption);
              
              // Add all projects as options
              const projects = schedule.projects || [];
              projects.forEach(project => {
                const option = document.createElement('option');
                option.value = project._uniqueId;
                option.textContent = project.name || 'Unbenanntes Projekt';
                input.appendChild(option);
              });
              
              input.value = currentValue;
            } else if (inputType === 'textarea') {
              input = document.createElement('textarea');
            } else {
              input = document.createElement('input');
              input.type = inputType;
            }
            
            if (inputType !== 'select' && inputType !== 'recurrence' && inputType !== 'recurrence-stem' && inputType !== 'textarea') {
              input.type = inputType;
            }
            
            if (inputType !== 'select' && inputType !== 'recurrence' && inputType !== 'recurrence-stem') {
              input.value = currentValue;
              input.placeholder = placeholder;
              input.style.width = '100%';
              input.style.background = 'transparent';
              input.style.border = 'none';
              input.style.borderRadius = '0';
              input.style.padding = '0';
              input.style.color = 'white';
              input.style.fontFamily = 'inherit';
              input.style.fontSize = '2vh';
              input.style.outline = 'none';
            }
            
            // Style date and time inputs with white icons (dark mode)
            if (inputType === 'date' || inputType === 'time') {
              input.style.colorScheme = 'dark';
            }
            
            if (inputType === 'textarea') {
              input.style.height = '100%';
              input.style.minHeight = '8vh';
              input.style.resize = 'none';
              input.style.overflowY = 'auto';
              input.style.scrollbarWidth = 'none';
              input.style.msOverflowStyle = 'none';
            }
            
            // Replace value element
            valueElement.innerHTML = '';
            valueElement.appendChild(input);
            
            inputs[fName] = input;
            
            // Handle keyboard shortcuts
            input.addEventListener('keydown', async (keyEvent) => {
              // For textarea, allow Enter for new lines
              if (inputType === 'textarea' && keyEvent.key === 'Enter') {
                return; // Allow default
              }
              
              // For Tab key, implement custom cycling
              if (keyEvent.key === 'Tab') {
                keyEvent.preventDefault();
                
                // Define tab order based on object type
                let tabOrder;
                const isNote = train.type === 'note';
                const isTodo = train.type === 'todo';
                
                if (isNote) {
                  // Notes: Ziel → Zwischenhalte → repeat
                  tabOrder = ['ziel', 'zwischenhalte'];
                } else if (isTodo) {
                  // Todos: Ziel → Datum → Zwischenhalte → repeat
                  tabOrder = ['ziel', 'date', 'zwischenhalte'];
                } else {
                  // Trains/Tasks: Full order
                  tabOrder = ['linie', 'ziel', 'date', 'plan', 'actual', 'dauer', 'zwischenhalte', 'projectId'];
                }
                
                const currentIndex = tabOrder.indexOf(fName);
                let nextIndex = keyEvent.shiftKey ? currentIndex - 1 : currentIndex + 1;
                
                // Wrap around
                if (nextIndex >= tabOrder.length) nextIndex = 0;
                if (nextIndex < 0) nextIndex = tabOrder.length - 1;
                
                const nextFieldName = tabOrder[nextIndex];
                const nextInput = inputs[nextFieldName];
                if (nextInput) {
                  nextInput.focus();
                  // Position cursor at end for text inputs
                  if (nextInput.setSelectionRange && nextInput.type === 'text') {
                    nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
                  }
                }
                return;
              }
              
              if (keyEvent.key === 'Enter') {
                keyEvent.preventDefault();
                await saveAllFields();
              } else if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                keyEvent.stopPropagation(); // Prevent global Esc handler from closing drawer
                // Save changes and exit edit mode (don't close drawer yet)
                await saveAllFields();
              }
            });
          });
          
          // Global blur handler - saves when focus leaves ALL inputs
          let blurTimeout;
          const handleBlur = () => {
            clearTimeout(blurTimeout);
            blurTimeout = setTimeout(async () => {
              const newFocus = document.activeElement;
              const isStillInInputs = newFocus && (
                newFocus.tagName === 'INPUT'    ||
                newFocus.tagName === 'TEXTAREA' ||
                newFocus.tagName === 'SELECT'
              ) && panel.contains(newFocus);
              
              // Only save and exit if focus left all input fields
              if (!isStillInInputs) {
                await saveAllFields();
              }
            }, 100);
          };
          
          // Add blur handler to all inputs
          Object.values(inputs).forEach(input => {
            input.addEventListener('blur', handleBlur);
          });
          
          // Focus and position cursor in the clicked field
          setTimeout(() => {
            const clickedInput = inputs[fieldName];
            if (clickedInput) {
              clickedInput.focus();
              
              // Set cursor position for text inputs
              if (clickedInput.setSelectionRange && clickedInput.type === 'text') {
                try {
                  const safePosition = Math.min(estimatedPosition, clickedInput.value.length);
                  clickedInput.setSelectionRange(safePosition, safePosition);
                } catch (e) {
                  // For inputs that don't support setSelectionRange
                  if (clickedInput.select) clickedInput.select();
                }
              } else if (clickedInput.select) {
                clickedInput.select();
              }
            }
          }, 0);
          
          e.preventDefault(); // Prevent text selection during conversion
        });
      });
      
      // Global Esc handler to close drawer when not in edit mode
      // Remove old handler if exists to prevent duplicates
      if (editorDrawerEscHandler) {
        document.removeEventListener('keydown', editorDrawerEscHandler, true);
      }
      
      editorDrawerEscHandler = (e) => {
        if (e.key === 'Escape' && document.body.contains(panel)) {
          const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea, [data-editable="true"] select');
          if (!hasInputs) {
            e.preventDefault();
            e.stopPropagation();
            // If in stem mode and we came from an instance, return to that instance
            const origId = panel.dataset.originalInstanceId;
            if (panel.dataset.editMode === 'stem' && origId) {
              const origTrain = processedTrainData.allTrains.find(t => t._uniqueId === origId);
              if (origTrain) {
                renderFocusMode(origTrain, 'instance');
                return;
              }
            }
            // Otherwise close the drawer
            desktopFocusedTrainId = null;
            panel.innerHTML = '';
            closeEditorDrawer();
          }
        }
      };
      
      document.addEventListener('keydown', editorDrawerEscHandler, true);
      
      // Click-out handler to close drawer when clicking outside
      // Remove old handler if exists to prevent duplicates
      if (editorDrawerClickOutHandler) {
        document.removeEventListener('click', editorDrawerClickOutHandler, true);
      }
      
      editorDrawerClickOutHandler = async (e) => {
        // Check if panel is open and has content
        if (panel && panel.classList.contains('is-open') && panel.innerHTML.trim() !== '') {
          // Check if we're in edit mode
          const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea, [data-editable="true"] select');
          
          console.log('👆 Click detected. Inside panel:', panel.contains(e.target), 'Has inputs:', !!hasInputs);
          
          // Don't close if clicking inside the panel
          if (!panel.contains(e.target)) {
            console.log('  Click outside panel');
            // If in edit mode, save first
            if (hasInputs && typeof saveAllFields === 'function') {
              console.log('  Saving before close...');
              await saveAllFields();
              // After saving, close the drawer
              desktopFocusedTrainId = null;
              panel.innerHTML = '';
              closeEditorDrawer();
              document.querySelectorAll('.train-entry').forEach(entry => entry.classList.remove('selected'));
            } else {
              // Not in edit mode, just close
              console.log('  Just closing (no edit mode)');
              desktopFocusedTrainId = null;
              panel.innerHTML = '';
              closeEditorDrawer();
              document.querySelectorAll('.train-entry').forEach(entry => entry.classList.remove('selected'));
            }
          }
        }
      };
      
      // Use capture phase to handle click before other handlers
      document.addEventListener('click', editorDrawerClickOutHandler, true);
      
      // Add delay button event listeners - EXACTLY like legacy but with debounced save
      const delayButtonsContainer = panel.querySelector('.editor-delay-buttons');
      if (delayButtonsContainer) {
        // Use persistent timeout variable (defined outside renderFocusMode)
        // Clear any existing timeout to prevent duplicate saves
        clearTimeout(delayButtonTimeout);
        delayButtonTimeout = null;
        
        delayButtonsContainer.addEventListener('click', async (e) => {
          const button = e.target.closest('[data-delay-action]');
          if (!button) return;
          
          const action = button.dataset.delayAction;
          const trainId = panel.dataset.trainId;
          
          // Find train in schedule
          let scheduleTrain = findOrRestoreScheduleTrain(trainId, train);

          if (!scheduleTrain) {
            console.error('Train not found in schedule!');
            return;
          }

          const now = new Date();

          // COPY LEGACY LOGIC EXACTLY
          switch (action) {
            case 'minus5':
              // Subtract 5 minutes from delay (actual time) - can make train earlier than planned
              if (train.plan) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay - 5; // Allow negative (earlier than planned)
                if (newDelay === 0) {
                  train.actual = undefined; // Remove delay (on time)
                  scheduleTrain.actual = undefined;
                } else {
                  const planDate = parseTime(train.plan, now, train.date);
                  const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                  train.actual = formatClock(newActualDate);
                  scheduleTrain.actual = train.actual;
                }
              }
              renderFocusMode(train);
              break;
              
            case 'plus5':
              // Add 5 minutes to delay (actual time)
              if (train.plan) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay + 5;
                const planDate = parseTime(train.plan, now, train.date);
                const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                train.actual = formatClock(newActualDate);
                scheduleTrain.actual = train.actual;
              }
              renderFocusMode(train);
              break;
              
            case 'plus10':
              // Add 10 minutes to delay (actual time)
              if (train.plan) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay + 10;
                const planDate = parseTime(train.plan, now, train.date);
                const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                train.actual = formatClock(newActualDate);
                scheduleTrain.actual = train.actual;
              }
              renderFocusMode(train);
              break;
              
            case 'plus30':
              // Add 30 minutes to delay (actual time)
              if (train.plan) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay + 30;
                const planDate = parseTime(train.plan, now, train.date);
                const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                train.actual = formatClock(newActualDate);
                scheduleTrain.actual = train.actual;
              }
              renderFocusMode(train);
              break;
          }
          
          // Debounce to prevent multiple rapid operations
          clearTimeout(delayButtonTimeout);
          delayButtonTimeout = setTimeout(() => {
            // OPTIMISTIC UI: Render immediately, then save in background
            // 1. Refresh UI with the delay change
            refreshUIOnly();
            
            // 2. Update the editor drawer with fresh train reference
            const updatedTrainAfterDelay = processedTrainData.allTrains.find(t => 
              t._uniqueId === trainId
            );
            
            if (updatedTrainAfterDelay) {
              renderFocusMode(updatedTrainAfterDelay);
            }
            
            // 3. Save in background - no await, no callback needed
            saveSchedule();
          }, 500);
        });
      }
      
      // Add button event listeners
      const actionsContainer = panel.querySelector('.editor-actions');
      if (actionsContainer) {
        actionsContainer.addEventListener('click', async (e) => {
          const button = e.target.closest('[data-focus-action]');
          if (!button) return;
          
          const action = button.dataset.focusAction;
          const trainId = panel.dataset.trainId;
          
          // Find train in schedule
          let scheduleTrain = findOrRestoreScheduleTrain(trainId, train);
          let sourceArray = schedule.spontaneousEntries;
          
          if (!scheduleTrain) {
            console.error('Train not found in schedule!');
            return;
          }
          
          switch (action) {
            case 'cancel':
              // Toggle canceled state
              train.canceled = !train.canceled;
              scheduleTrain.canceled = train.canceled;
              
              // OPTIMISTIC UI: Render immediately, then save in background
              // 1. Refresh UI with cancel state change
              refreshUIOnly();
              
              // 2. Find the updated train and re-render focus mode
              const updatedTrainAfterCancel = processedTrainData.allTrains.find(t => 
                t._uniqueId === trainId
              );
              
              if (updatedTrainAfterCancel) {
                renderFocusMode(updatedTrainAfterCancel);
              } else {
                console.error('Could not find train after cancel/reactivate');
              }
              
              // 3. Save in background - no await, no callback needed
              saveSchedule();
              break;
              
            case 'delete':
              if (isRecurring) {
                const currentEditMode = panel.dataset.editMode || 'instance';
                const stemId = train._templateId;
                if (currentEditMode === 'stem') {
                  // Delete the entire stem + all future children
                  if (confirm(`Vorlage "${train.linie} → ${train.ziel}" und alle zukünftigen Züge löschen?`)) {
                    schedule.fixedSchedule = schedule.fixedSchedule.filter(s => s._uniqueId !== stemId);
                    const todayStr = new Date().toISOString().split('T')[0];
                    schedule.spontaneousEntries = schedule.spontaneousEntries.filter(
                      t => t._templateId !== stemId || t.date <= todayStr
                    );
                    refreshUIOnly();
                    desktopFocusedTrainId = null;
                    panel.innerHTML = '<div style="color: white; padding: 2vh; text-align: center;">Vorlage gelöscht</div>';
                    closeEditorDrawer();
                    saveSchedule();
                  }
                } else {
                  // Delete only this instance — record date as skipped
                  if (confirm(`Zug ${train.linie} nach ${train.ziel} am ${train.date} löschen?`)) {
                    schedule.spontaneousEntries = schedule.spontaneousEntries.filter(
                      t => t._uniqueId !== train._uniqueId
                    );
                    const stemObj = (schedule.fixedSchedule || []).find(s => s._uniqueId === stemId);
                    if (stemObj) {
                      stemObj.skippedDates = stemObj.skippedDates || [];
                      if (!stemObj.skippedDates.includes(train.date)) stemObj.skippedDates.push(train.date);
                    }
                    refreshUIOnly();
                    desktopFocusedTrainId = null;
                    panel.innerHTML = '<div style="color: white; padding: 2vh; text-align: center;">Zug gelöscht</div>';
                    closeEditorDrawer();
                    saveSchedule();
                  }
                }
              } else {
                // Non-recurring delete (original logic)
                if (confirm(`Zug ${train.linie} nach ${train.ziel} löschen?`)) {
                  const index = sourceArray.indexOf(scheduleTrain);
                  if (index >= 0) {
                    sourceArray.splice(index, 1);
                  }
                  
                  // OPTIMISTIC UI: Render immediately, then save in background
                  // 1. Refresh UI with train removed
                  refreshUIOnly();
                  
                  // 2. Clear focus panel
                  desktopFocusedTrainId = null;
                  panel.innerHTML = '<div style="color: white; padding: 2vh; text-align: center;">Zug gelöscht</div>';
                  closeEditorDrawer();
                  
                  // 3. Refresh note panel if this was a note
                  const isNote = train.type === 'note';
                  const noteDrawer = document.getElementById('note-drawer');
                  if (isNote && noteDrawer && noteDrawer.classList.contains('is-open')) {
                    renderNotePanel();
                  }
                  
                  // 4. Save in background - no await, no callback needed
                  saveSchedule();
                }
              }
              break;
          }
        });
      }

      // ---- Panel click handler: mode toggle + recurrence toggle ----
      if (editorDrawerToggleHandler) {
        panel.removeEventListener('click', editorDrawerToggleHandler);
        editorDrawerToggleHandler = null;
      }
      editorDrawerToggleHandler = (e) => {
        // Handle instance ↔ stem mode toggle
        const modeBtn = e.target.closest('[data-focus-action="toggle-mode"]');
        if (modeBtn && isRecurring) {
          e.stopPropagation();
          const todayStr = new Date().toISOString().split('T')[0];
          if (panel.dataset.editMode === 'instance') {
            panel.dataset.originalInstanceId = train._uniqueId;
            renderFocusMode(train, 'stem');
          } else {
            const origId = panel.dataset.originalInstanceId;
            const child = (origId && processedTrainData.allTrains.find(t => t._uniqueId === origId))
              || processedTrainData.allTrains.find(t => t._templateId === train._templateId && t.date >= todayStr)
              || processedTrainData.allTrains.find(t => t._templateId === train._templateId);
            if (child) { renderFocusMode(child, 'instance'); } else { closeEditorDrawer(); }
          }
          return;
        }
        // Handle show/hide recurrence config (normal trains)
        const recBtn = e.target.closest('[data-focus-action="toggle-recurrence"]');
        if (recBtn) {
          e.stopPropagation();
          const recConfigField = panel.querySelector('.editor-field[data-field="recurrencePattern"]');
          if (recConfigField) {
            recConfigField.style.display = recConfigField.style.display === 'none' ? '' : 'none';
          }
        }
      };
      panel.addEventListener('click', editorDrawerToggleHandler);

    } catch (error) {
      console.error('Error rendering focus mode:', error);
      panel.innerHTML = '<div style="color: white; padding: 2vh;">Error loading train details.</div>';
    }
  }


    function showLinePickerDropdown(train, popup) {
      // Check if dropdown already exists and remove it
      const existingOverlay = document.querySelector('.line-picker-overlay');
      if (existingOverlay) {
        document.body.removeChild(existingOverlay);
        return; // Don't create a new one
      }
      
      // Create overlay from template
      const template = document.createElement('template');
      template.innerHTML = Templates.linePickerOverlay().trim();
      const overlay = template.content.firstChild;
      
      const dropdown = overlay.querySelector('.line-picker-dropdown');
      
      const closeDropdown = () => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
          window.removeEventListener('popstate', handleBackButton, true);
        }
      };
      
      // Add click handlers to all option buttons
      const optionButtons = overlay.querySelectorAll('.line-picker-option');
      optionButtons.forEach(optionButton => {
        const linie = optionButton.dataset.linie;
        const beschreibung = optionButton.dataset.beschreibung;
        
        // Click handler
        optionButton.addEventListener('click', async () => {
          // Update train object
          train.linie = linie;
          train.beschreibung = beschreibung;
          
          // Find the train in schedule and update it
          const trainId = train._uniqueId;
          const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
          if (spontIndex >= 0) {
            schedule.spontaneousEntries[spontIndex].linie = linie;
            schedule.spontaneousEntries[spontIndex].beschreibung = beschreibung;
          }
          
          // Auto-save the schedule
          saveSchedule();
          
          // Close overlay
          closeDropdown();
          
          // Re-render focus drawer
          renderFocusMode(train);
        });
        
        // Hover effect
        optionButton.addEventListener('mousedown', () => {
          optionButton.style.background = 'rgba(255, 255, 255, 0.2)';
        });
        optionButton.addEventListener('mouseup', () => {
          optionButton.style.background = 'rgba(255, 255, 255, 0.1)';
        });
      });
      
      // Add cancel button
      const template2 = document.createElement('template');
      template2.innerHTML = Templates.linePickerCancelButton().trim();
      const cancelButton = template2.content.firstChild;
      
      cancelButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDropdown();
      });
      dropdown.appendChild(cancelButton);
      
      // Close on overlay click (clicking outside the dropdown)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          e.preventDefault();
          e.stopPropagation();
          closeDropdown();
        }
      });
      
      // Handle system back button (Android)
      const handleBackButton = (e) => {
        if (document.body.contains(overlay)) {
          closeDropdown();
        }
      };
      
      // Add back button listener first before pushing state
      window.addEventListener('popstate', handleBackButton, true); // Use capture phase
      
      // Push a new history state for this dropdown
      window.history.pushState({ dropdown: 'line-picker' }, '');
      
      document.body.appendChild(overlay);
    }
