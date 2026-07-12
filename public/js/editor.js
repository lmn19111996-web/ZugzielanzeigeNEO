// === TRAIN EDITOR / FOCUS MODE ===
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
      // Notes render inline in the main content panel (like the projects/reviews/
      // vorlagen workspaces do) instead of the right-side editor drawer.
      const isNoteEdit = train.type === 'note';
      const panel = document.getElementById(isNoteEdit ? 'train-list' : 'focus-panel');
      const template = document.getElementById('focus-template');

      if (!panel || !template) {
        console.error('Missing panel or template!');
        return;
      }

      openEditorDrawer(train);
      hideWorkspacePlaceholder();

      if (isNoteEdit) {
        panel.style.borderLeft = '';
        panel.style.borderImage = '';
        panel.style.borderImageSlice = '';
        panel.style.borderTopLeftRadius = '';
        panel.style.borderBottomLeftRadius = '';
        delete panel.dataset.vipLine;
      } else {
      // Apply line color / VIP gradient to editor drawer border
      const lineColor = getLineColor(train.linie || 'S1');
      const vip = typeof getVipConfig === 'function' ? getVipConfig(train.linie) : null;
      if (vip) {
        panel.style.borderLeft = '4px solid transparent';
        panel.style.borderImage = `linear-gradient(to bottom, ${vip.c3}, ${vip.c2}, ${vip.c1}) 1`;
        panel.style.borderImageSlice = '1';
        panel.dataset.vipLine = (train.linie || '').toLowerCase();
      } else {
        panel.style.borderLeft = `4px solid ${lineColor}`;
        panel.style.borderImage = '';
        panel.style.borderImageSlice = '';
        delete panel.dataset.vipLine;
      }
      panel.style.borderTopLeftRadius = '8px';
      panel.style.borderBottomLeftRadius = '8px';
      }

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
        // Log entries are historical records, not live schedule trains: the
        // drawer shows every field for context but only lets you correct what
        // actually happened (actual time, duration, cancellation) or delete a
        // bad entry - see the isLogEdit branches below and in the save/action
        // handlers, which redirect to /api/train-history/entry instead of
        // schedule.spontaneousEntries + saveSchedule().
        const isLogEdit = train.source === 'log';

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

        // Populate train type
        const typeValue = clone.querySelector('[data-focus="entry-type"]');
        if (typeValue) {
          const typeLabels = {
            train: 'Fahrt mit Zeit',
            'duration-only': 'Nur Dauer'
          };
          const currentType = isDurationOnlyTrain(train) ? 'duration-only' : 'train';
          typeValue.textContent = typeLabels[currentType] || typeLabels.train;
          typeValue.parentElement.setAttribute('data-value', currentType);
          if (isEditable) {
            typeValue.parentElement.setAttribute('data-editable', 'true');
          }
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
        if (isEditable || isLogEdit) {
          arrivalActualValue.parentElement.setAttribute('data-editable', 'true');
        }

        // Populate Verspätungsgrund (delayReason) — shown when actual departure
        // differs from scheduled (hasDelay) OR the train is cancelled. Manual
        // selection always wins; if none is set, show any auto-suggestion(s) as a
        // non-persisted "(Vorschlag)" hint.
        const showDelayReason = hasDelay || !!train.canceled;
        const delayReasonValue = clone.querySelector('[data-focus="delay-reason"]');
        if (delayReasonValue) {
          const delayReasonField = delayReasonValue.parentElement;
          delayReasonField.style.display = showDelayReason ? '' : 'none';
          const autoReasons = Array.isArray(train._delayReasonAuto) ? train._delayReasonAuto : [];
          if (train.delayReason) {
            delayReasonValue.textContent = train.delayReason;
            delayReasonField.style.opacity = '';
          } else if (autoReasons.length) {
            // Space is tight in the drawer — show a compact "Auto" hint rather than
            // the full (potentially multi-reason) suggestion text; the full text is
            // still what actually renders on the notice tag in the train list.
            delayReasonValue.textContent = 'Auto';
            delayReasonValue.title = autoReasons.join(' +++ ');
            delayReasonField.style.opacity = '0.6';
          } else {
            delayReasonValue.textContent = 'Kein Grund gewählt';
            delayReasonField.style.opacity = '0.6';
          }
          // data-value stays the MANUAL value only — auto-suggestions must never be
          // persisted as if chosen (saveAllFields' change-detection compares against this).
          delayReasonField.setAttribute('data-value', train.delayReason || '');
          if (isEditable && showDelayReason) {
            delayReasonField.setAttribute('data-editable', 'true');
          }
        }

        // Populate Duration
        const durationValue = clone.querySelector('[data-focus="duration"]');
        durationValue.textContent = train.dauer ? `${train.dauer} Min` : 'Keine Dauer';
        durationValue.parentElement.setAttribute('data-value', train.dauer || '0');
        durationValue.parentElement.setAttribute('data-placeholder', '90');
        if (isEditable || isLogEdit) {
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
        const isDurationOnly = isDurationOnlyTrain(train);

        if (isNote) {
          // For notes: show only Ziel and Zwischenhalte
          const hideFields = ['linie', 'date', 'type', 'plan', 'actual', 'dauer', 'projectId'];
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

          // Inline workspace header (back button) - the note editor has no
          // surrounding drawer chrome to click outside of, so give it an explicit way back.
          // The panel is pinned to a fixed-height column here (header + action buttons
          // fixed, only the fields in between scroll) so the Speichern/Löschen buttons
          // never end up pushed below the viewport.
          panel.style.display = 'flex';
          panel.style.flexDirection = 'column';
          panel.style.overflowY = 'hidden';
          const editorContainerEl = panel.querySelector('.editor-container');
          if (editorContainerEl) {
            editorContainerEl.style.flex = '1 1 auto';
            editorContainerEl.style.minHeight = '0';
          }

          const noteHeader = document.createElement('div');
          noteHeader.className = 'note-editor-header';
          noteHeader.innerHTML = `
            <button class="note-editor-back" type="button" aria-label="Zurück zu den Notizen">← Zurück zu den Notizen</button>
          `;
          panel.insertBefore(noteHeader, panel.firstChild);
          noteHeader.querySelector('.note-editor-back').addEventListener('click', () => {
            closeEditorDrawer();
            openNoteDrawer();
          });
        } else if (isTodo) {
          // For todos: show only Ziel, Datum, and Zwischenhalte
          const hideFields = ['linie', 'type', 'plan', 'actual', 'dauer', 'projectId'];
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
        } else if (isDurationOnly) {
          const hideFields = ['plan', 'actual'];
          hideFields.forEach(field => {
            const fieldEl = panel.querySelector(`.editor-field[data-field="${field}"]`);
            if (fieldEl) fieldEl.style.display = 'none';
          });
          const durationLabel = panel.querySelector('.editor-field[data-field="dauer"] .editor-field-label');
          if (durationLabel) durationLabel.textContent = 'Gesamtdauer';
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

          ['actual', 'delayReason'].forEach(f => {
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
            const patternLabels = { weekdays: 'Werktage (Mo–Fr)', daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich', yearly: 'Jährlich' };
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

              const typeFieldEl = panel.querySelector('.editor-field[data-field="type"]');
              if (typeFieldEl) {
                typeFieldEl.removeAttribute('data-editable');
                typeFieldEl.style.opacity = '0.5';
                typeFieldEl.style.cursor = 'default';
                typeFieldEl.title = 'Eintragstyp wird durch Vorlage bestimmt';
              }

              const stemObj = (schedule.fixedSchedule || []).find(s => s._uniqueId === train._templateId);
              const curPattern = stemObj?.recurrence?.pattern || 'weekdays';
              const patternLabels = { weekdays: 'Werktage (Mo–Fr)', daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich', yearly: 'Jährlich' };

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
        if (!isEditable && !isLogEdit) {
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

        if (isLogEdit) {
          // All fields stay visible for context, but only actual/dauer/project
          // are inputs — everything else about a past event (line, destination,
          // stops, ...) is left alone. Most fields carry a hardcoded
          // data-editable="true" straight from #focus-template, so it must be
          // explicitly stripped here, not just left alone when already false.
          const LOG_EDITABLE_FIELDS = new Set(['actual', 'dauer', 'projectId']);
          panel.querySelectorAll('.editor-field').forEach(field => {
            const fieldName = field.getAttribute('data-field');
            if (LOG_EDITABLE_FIELDS.has(fieldName)) return;
            field.removeAttribute('data-editable');
            field.style.cursor = 'default';
            field.style.opacity = '0.6';
          });
          // Quick delay-adjust buttons operate on a live schedule train and
          // don't apply here.
          const delayButtons = panel.querySelector('.editor-delay-buttons');
          if (delayButtons) delayButtons.style.display = 'none';
          if (cancelBtn) cancelBtn.textContent = train.canceled ? 'Reaktivieren' : 'Ausfall melden';
          // Fall through: editableFields + actionsContainer listeners below are
          // still wired up so actual/dauer edits and cancel/delete work.
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
              } else if (fieldName === 'type') {
                train.type = newValue === 'duration-only' ? 'duration-only' : undefined;
                if (newValue === 'duration-only') {
                  train.plan = '';
                  train.actual = undefined;
                }
              } else if (fieldName === 'dauer') {
                train.dauer = Number(newValue) || 0;
              } else if (fieldName === 'zwischenhalte') {
                train.zwischenhalte = newValue.split('\n');
              } else if (fieldName === 'actual') {
                train.actual = newValue || undefined;
              } else if (fieldName === 'delayReason') {
                train.delayReason = newValue || undefined;
              } else if (fieldName === 'projectId') {
                train.projectId = newValue || undefined;
              } else if (fieldName === 'recurrencePattern') {
                // Handled by the dedicated recurrence-change block below; skip generic assignment
              } else {
                train[fieldName] = newValue;
              }
            }
          });

          // Smart project assignment: only fills in an EMPTY projectId, never
          // overwrites a manual choice — same "manual always wins" convention
          // as the delayReason auto-suggestions.
          if (!train.projectId && typeof resolveAutoProjectId === 'function') {
            const autoProjectId = resolveAutoProjectId(train.ziel);
            if (autoProjectId) {
              train.projectId = autoProjectId;
              hasChanges = true;
            }
          }

          // ---- LOG ENTRY SAVE PATH ----
          // train.actual / train.dauer were already updated above by the
          // generic field loop; persist those to the one relevant weekly log
          // file instead of schedule.spontaneousEntries + saveSchedule().
          if (isLogEdit) {
            if (hasChanges) {
              await saveLogEntryEdit(train); // re-renders the panel itself once saved
            } else {
              renderFocusMode(train); // no-op edit: still exit edit mode
            }
            return;
          }
          // ---- END LOG ENTRY SAVE PATH ----

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
                else if (fieldName === 'type')              stem.type        = val === 'duration-only' ? 'duration-only' : undefined;
                else if (fieldName === 'plan')            { stem.plan = val; stem.actual = val; }
                else if (fieldName === 'dauer')             stem.dauer       = Number(val) || 0;
                else if (fieldName === 'zwischenhalte')     stem.zwischenhalte = val.split('\n').filter(l => l.trim());
                else if (fieldName === 'date')              stem.startDate   = val;
                else if (fieldName === 'projectId')         stem.projectId   = val || undefined;
                else if (fieldName === 'recurrencePattern') stem.recurrence  = { ...stem.recurrence, pattern: val };
              });

              // Smart project assignment (see instance path above) — applies to
              // the stem too, so materialized recurring instances inherit it.
              if (!stem.projectId && typeof resolveAutoProjectId === 'function') {
                const autoProjectId = resolveAutoProjectId(stem.ziel);
                if (autoProjectId) stem.projectId = autoProjectId;
              }

              if (stem.type === 'duration-only') {
                stem.plan = '';
                stem.actual = undefined;
              }

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
              const entryDate = train.date || scheduleTrain.date || todayStr;
              const newStem = {
                _uniqueId:    stemId,
                type:         train.type,
                linie:        train.linie || '',
                ziel:         train.ziel  || '',
                plan:         train.plan  || '',
                dauer:        train.dauer || 0,
                zwischenhalte: Array.isArray(train.zwischenhalte) ? [...train.zwischenhalte] : [],
                projectId:    train.projectId || undefined,
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
            // On the first real save of a freshly-created entry, plannedDate was only a
            // today-placeholder (so the entry would render before the user picked a date).
            // Lock it to whatever date the user actually confirmed, once, here - any later
            // save (train._isNewEntry no longer set) leaves plannedDate untouched so
            // rescheduling only moves `date`/`actual`, not the original plan.
            if (train._isNewEntry) {
              train.plannedDate = train.date;
            }
            // Update the schedule train with all changes
            const { _isPastTrain, _delayReasonAuto, _hasDelay, _isNewEntry, ...persistableTrain } = train;
            Object.assign(scheduleTrain, persistableTrain);
            delete scheduleTrain._isPastTrain;
            delete scheduleTrain._isNewEntry;
            
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
              input.classList.add('editor-select-dark');
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
              input.style.colorScheme = 'dark';
              [
                { value: 'none',     label: 'Keine Wiederholung' },
                { value: 'weekdays', label: 'Werktage (Mo\u2013Fr)' },
                { value: 'daily',    label: 'T\u00e4glich' },
                { value: 'weekly',   label: 'W\u00f6chentlich' },
                { value: 'monthly',  label: 'Monatlich' },
                { value: 'yearly',   label: 'J\u00e4hrlich' }
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
              input.classList.add('editor-select-dark');
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
              input.style.colorScheme = 'dark';
              [
                { value: 'weekdays', label: 'Werktage (Mo\u2013Fr)' },
                { value: 'daily',    label: 'T\u00e4glich' },
                { value: 'weekly',   label: 'W\u00f6chentlich' },
                { value: 'monthly',  label: 'Monatlich' },
                { value: 'yearly',   label: 'J\u00e4hrlich' }
              ].forEach(({ value, label }) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                input.appendChild(opt);
              });
              input.value = currentValue || 'weekdays';
            } else if (inputType === 'train-type') {
              input = document.createElement('select');
              input.classList.add('editor-select-dark');
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
              input.style.colorScheme = 'dark';
              [
                { value: 'train', label: 'Fahrt mit Zeit' },
                { value: 'duration-only', label: 'Nur Dauer' }
              ].forEach(({ value, label }) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                input.appendChild(opt);
              });
              input.value = currentValue || 'train';
            } else if (inputType === 'delay-reason') {
              // Same formatting as the project dropdown ('select' branch below).
              input = document.createElement('select');
              input.classList.add('editor-select-dark');
              input.style.width = '100%';
              input.style.background = 'var(--color-bg-panel)';
              input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
              input.style.borderRadius = '0';
              input.style.padding = '0.5vh';
              input.style.color = 'white';
              input.style.fontFamily = 'inherit';
              input.style.fontSize = '2vh';
              input.style.outline = 'none';
              // Without this, the native options popup ignores the dark inline
              // styles above (they only affect the closed control) and renders
              // white-on-white, since it defaults to a light color scheme.
              input.style.colorScheme = 'dark';
              const noReasonOpt = document.createElement('option');
              noReasonOpt.value = '';
              noReasonOpt.textContent = 'Kein Grund';
              input.appendChild(noReasonOpt);
              (window.DelayReasons || []).forEach(reason => {
                const opt = document.createElement('option');
                opt.value = reason;
                opt.textContent = reason;
                input.appendChild(opt);
              });
              input.value = currentValue || '';
            } else if (inputType === 'select') {
              // Special handling for project dropdown
              input = document.createElement('select');
              input.classList.add('editor-select-dark');
              input.style.width = '100%';
              input.style.background = 'var(--color-bg-panel)';
              input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
              input.style.borderRadius = '0';
              input.style.padding = '0.5vh';
              input.style.color = 'white';
              input.style.fontFamily = 'inherit';
              input.style.fontSize = '2vh';
              input.style.outline = 'none';
              input.style.colorScheme = 'dark';

              // Add "No Project" option
              const noneOption = document.createElement('option');
              noneOption.value = '';
              noneOption.textContent = 'Kein Projekt';
              input.appendChild(noneOption);
              
              // Add all projects as options (exclude archived)
              const projects = (schedule.projects || []).filter(p => !p.archived);
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
            
            if (inputType !== 'select' && inputType !== 'recurrence' && inputType !== 'recurrence-stem' && inputType !== 'train-type' && inputType !== 'delay-reason' && inputType !== 'textarea') {
              input.type = inputType;
            }

            if (inputType !== 'select' && inputType !== 'recurrence' && inputType !== 'recurrence-stem' && inputType !== 'train-type' && inputType !== 'delay-reason') {
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
              // Auto-grow to fit content (clamped by the .editor-field-multiline
              // min-height in CSS) instead of stretch-filling the drawer; overall
              // scrolling is handled by the outer .editor-fields-scroll.
              input.style.minHeight = '8vh';
              input.style.resize = 'none';
              input.style.overflowY = 'hidden';
              input.style.scrollbarWidth = 'none';
              input.style.msOverflowStyle = 'none';
              const autoGrow = () => {
                input.style.height = 'auto';
                input.style.height = `${input.scrollHeight}px`;
              };
              input.addEventListener('input', autoGrow);
              requestAnimationFrame(autoGrow);
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
                } else if (isDurationOnlyTrain(train)) {
                  tabOrder = ['linie', 'ziel', 'date', 'dauer', 'zwischenhalte', 'projectId'];
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
        document.removeEventListener('pointerdown', editorDrawerClickOutHandler, true);
      }
      
      editorDrawerClickOutHandler = async (e) => {
        // Check if panel is open and has content
        if (panel && panel.classList.contains('is-open') && panel.innerHTML.trim() !== '') {
          // Clicking another train should only replace drawer content, not close/reopen.
          if (e.target.closest('.train-entry, .belegungsplan-train-block, .vorlage-row')) {
            return;
          }

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
      document.addEventListener('pointerdown', editorDrawerClickOutHandler, true);
      
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
          const isDurationOnly = isDurationOnlyTrain(train);

          const durationDeltaByAction = {
            minus5: -5,
            plus5: 5,
            plus10: 10,
            plus30: 30
          };

          if (isDurationOnly) {
            const durationDelta = durationDeltaByAction[action];
            if (durationDelta != null) {
              const currentDuration = Number(train.dauer) || 0;
              const nextDuration = Math.max(0, currentDuration + durationDelta);
              train.dauer = nextDuration;
              scheduleTrain.dauer = nextDuration;
              renderFocusMode(train);
            }

            clearTimeout(delayButtonTimeout);
            delayButtonTimeout = setTimeout(() => {
              refreshUIOnly();
              const updatedTrainAfterDelay = processedTrainData.allTrains.find(t => 
                t._uniqueId === trainId
              );
              if (updatedTrainAfterDelay) {
                renderFocusMode(updatedTrainAfterDelay);
              }
              saveSchedule();
            }, 500);
            return;
          }

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

          // ---- LOG ENTRY ACTIONS ----
          // No live scheduleTrain exists for a historical entry - handle
          // cancel/delete directly against the log file and stop here.
          if (isLogEdit) {
            if (action === 'cancel') {
              await toggleLogEntryCanceled(train);
            } else if (action === 'delete') {
              if (confirm(`Log-Eintrag ${train.linie} nach ${train.ziel} am ${train.date} endgültig löschen?`)) {
                await deleteLogEntry(train, panel);
              }
            }
            return;
          }
          // ---- END LOG ENTRY ACTIONS ----

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
              // A manual toggle always wins over the automated curfew rule from
              // here on for this specific instance (see applyCurfewRule in
              // globals.js) — otherwise a curfew-cancelled train could never be
              // reactivated since the rule re-cancels it every render cycle.
              train.curfewOverride = true;
              scheduleTrain.curfewOverride = true;
              
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
                  const isNote = train.type === 'note';
                  panel.innerHTML = isNote
                    ? '<div style="color: white; padding: 2vh; text-align: center;">Notiz gelöscht</div>'
                    : '<div style="color: white; padding: 2vh; text-align: center;">Zug gelöscht</div>';
                  closeEditorDrawer();

                  // 3. Refresh note panel if this was a note
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
