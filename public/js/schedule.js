// === SCHEDULE DATA MANAGEMENT ===
    async function fetchSchedule(forceFetch = false) {
      // Mutex lock: prevent concurrent fetch operations if not forced
      if (!forceFetch && isDataOperationInProgress) {
        console.log('⏸️ fetchSchedule blocked - data operation in progress');
        return schedule; // Return current schedule without fetching
      }

      const localSnapshot = {
        fixedSchedule: (schedule.fixedSchedule || []).slice(),
        spontaneousEntries: (schedule.spontaneousEntries || []).slice(),
        projects: (schedule.projects || []).slice()
      };
      
      try {
        // Always fetch local schedule
        const fetchPromises = [
          fetch('/api/schedule').catch(() => null)
        ];
        
        // Also fetch DB API if a station is explicitly selected
        if (currentEva) {
          fetchPromises.push(fetch(`/api/db-departures?eva=${currentEva}`).catch(() => null));
        }
        
        const responses = await Promise.all(fetchPromises);
        const scheduleRes = responses[0];
        const dbRes = responses[1] || null;
        
        let localTrains = [];
        let dbTrains = [];
        
        // Always process local schedule
        if (scheduleRes && scheduleRes.ok) {
          const data = await scheduleRes.json();
          
          // Helper to assign unique IDs
          const assignId = (train) => {
            if (!train._uniqueId) {
              train._uniqueId = 'train_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
            }
            // Backward compatibility: Convert old format notes (name && !linie) to new format
            if (train.name && !train.linie && train.type !== 'note') {
              train.linie = 'NOTE';
              train.type = 'note';
              // Use name as ziel if ziel is empty
              if (!train.ziel) {
                train.ziel = train.name;
              }
              // Remove the name attribute after conversion
              delete train.name;
            }
            return train;
          };
          
          // Helper to assign project IDs
          const assignProjectId = (project) => {
            if (!project._uniqueId) {
              project._uniqueId = 'project_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
            }
            if (!project.createdAt) {
              project.createdAt = new Date().toISOString();
            }
            // Ensure tasks array exists and has IDs
            if (project.tasks) {
              project.tasks = project.tasks.map(task => {
                if (!task._uniqueId) {
                  task._uniqueId = 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
                }
                return task;
              });
            } else {
              project.tasks = [];
            }
            return project;
          };
          
          // Store global schedule object (like InputEnhanced) with unique IDs
          // Preserve metadata from server
          if (data._meta) {
            schedule._meta = {
              version: data._meta.version,
              lastSaved: data._meta.lastSaved
            };
            console.log(`📦 Loaded schedule version ${data._meta.version}`);
          } else {
            // Initialize metadata if missing
            schedule._meta = {
              version: Date.now(),
              lastSaved: new Date().toISOString()
            };
            console.log('📦 Initialized new schedule metadata');
          }
          
          schedule.fixedSchedule = (data.fixedSchedule || []).map(assignId);
          schedule.spontaneousEntries = (data.spontaneousEntries || []).map(assignId);
          schedule.trains = (data.trains || []).map(assignId);
          schedule.projects = (data.projects || []).map(assignProjectId);

          schedule.fixedSchedule = mergeClientOnlyById(schedule.fixedSchedule, localSnapshot.fixedSchedule);
          schedule.spontaneousEntries = mergeClientOnlyById(schedule.spontaneousEntries, localSnapshot.spontaneousEntries);
          schedule.projects = mergeClientOnlyById(schedule.projects, localSnapshot.projects);

          // Expand recurring stems into real entries for the rolling window
          materializeFromStems();
          regenerateTrainsFromSchedule();

          // Build localTrains from spontaneousEntries (or legacy trains array)
          localTrains = (schedule.localTrains || []).slice();
        }
        
        // Process DB API data if station selected
        if (dbRes && dbRes.ok) {
          const dbData = await dbRes.json();
          dbTrains = (dbData.trains || []).map(t => {
            // Normalize property names: use zwischenhalte consistently
            const normalized = {
              ...t,
              source: 'db-api'
            };
            // If train has 'stops' property, rename to 'zwischenhalte'
            if (t.stops && !t.zwischenhalte) {
              normalized.zwischenhalte = t.stops;
              delete normalized.stops;
            }
            return normalized;
          });
        }
        
        // If station is selected, use ONLY DB API trains for display
        // Local trains are kept separate only for the first train in top ribbon
        let trainsToDisplay = [];
        
        if (currentEva && dbTrains.length > 0) {
          // Station selected: use only DB API trains
          trainsToDisplay = dbTrains;
        } else {
          // No station: use only local schedule
          trainsToDisplay = localTrains;
        }
        
        return { trains: trainsToDisplay, localTrains };
      } catch (error) {
        console.error('Error fetching schedule:', error);
        return { trains: [], localTrains: [] };
      }
    }

    // Render headline train (first train in top ribbon)

    async function saveSchedule() {
      // If a save is already in progress, queue this save
      if (saveInProgress) {
        saveQueued = true;
        console.log('⏳ Save queued - waiting for current save to complete');
        return;
      }
      
      saveInProgress = true;
      isDataOperationInProgress = true; // Lock data operations during save
      
      try {
        // OPTIMISTIC: Version is already updated before this function is called
        // No need for save indicator with 0ms latency optimistic UI
        
        // Auto-fill any empty actual times with plan times before saving
        const autoFillActual = (train) => {
          if (train.plan && !train.actual && !isDurationOnlyTrain(train)) {
            train.actual = train.plan;
          }
          return train;
        };
        
        schedule.spontaneousEntries.forEach(autoFillActual);
        schedule.trains.forEach(autoFillActual);
        
        // CLIENT GENERATES NEW VERSION (client-authoritative)
        const oldVersion = schedule._meta.version;
        const newVersion = Date.now();
        
        // OPTIMISTICALLY update local version BEFORE sending
        // This prevents SSE race condition where broadcast arrives before response
        schedule._meta.version = newVersion;

        // CLIENT-AUTHORITATIVE: Update stressmeter immediately with current in-memory data,
        // before the network round-trip completes.
        if (typeof stressmeterOnDataChanged === 'function') stressmeterOnDataChanged();
        
        // Filter: Only save trains that have a line number
        // AND ensure proper data format: fixed schedules have weekday only, spontaneous have date only
        const dataToSave = {
          _meta: {
            oldVersion: oldVersion,  // For server validation
            newVersion: newVersion    // Client's new version
          },
          fixedSchedule: schedule.fixedSchedule
            .filter(t => t.linie && t.linie.trim() !== '')
            .map(t => {
              // Fixed schedule: remove date property, keep only weekday
              const { date, source, ...cleanTrain } = t;
              return cleanTrain;
            }),
          spontaneousEntries: schedule.spontaneousEntries
            .filter(t => t.linie && t.linie.trim() !== '')
            .map(t => {
              // Spontaneous: keep date, remove processing fields  
              // Set plannedDate during save only if user has entered a date
              // Only assume today's date if train has been configured (not just name-only)
              const { source, weekday, announcementType, ...cleanTrain } = t;
              
              // Check if train has been configured beyond just name
              const isConfigured = cleanTrain.plan || cleanTrain.actual || 
                                 (cleanTrain.dauer && cleanTrain.dauer > 0) ||
                                 (cleanTrain.zwischenhalte && cleanTrain.zwischenhalte.length > 0 && cleanTrain.zwischenhalte[0] !== '');
              
              // If no date specified and train is configured, assume today
              if (!cleanTrain.date && isConfigured) {
                const _td = new Date(); const today = `${_td.getFullYear()}-${String(_td.getMonth()+1).padStart(2,'0')}-${String(_td.getDate()).padStart(2,'0')}`;
                cleanTrain.date = today;
                cleanTrain.plannedDate = today;
              } else if (cleanTrain.date && !cleanTrain.plannedDate) {
                cleanTrain.plannedDate = cleanTrain.date;
              }
              return cleanTrain;
            }),
          projects: (schedule.projects || []).map(p => {
            const { ...cleanProject } = p;
            return cleanProject;
          })
        };
        
        console.log('💾 Saving schedule:', `${oldVersion} → ${newVersion}`, {
          fixedSchedule: dataToSave.fixedSchedule.length,
          spontaneousEntries: dataToSave.spontaneousEntries.length,
          projects: dataToSave.projects.length
        });
        
        const res = await fetch('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dataToSave)
        });

        // Handle version conflict
        if (res.status === 409) {
          const conflict = await res.json();
          console.error('⚠️ Version conflict detected:', conflict);
          // Rollback optimistic version update
          schedule._meta.version = oldVersion;
          await handleVersionConflict(conflict);
          return;
        }
        
        if (!res.ok) {
          // Rollback optimistic version update on error
          schedule._meta.version = oldVersion;
          throw new Error('Failed to save schedule');
        }
        
        // Server confirms our version - we're already updated
        const result = await res.json();
        
        // Handle out-of-order responses: only update if response is for current/newer version
        if (result.version >= schedule._meta.version) {
          schedule._meta.lastSaved = result.savedAt;
          console.log(`✅ Save confirmed: version ${result.version}`);
        } else {
          console.warn(`⚠️ Ignoring delayed response for older version ${result.version} (current: ${schedule._meta.version})`);
        }
        
        // NO fetch needed - we're already up to date!
        // Server will broadcast SSE to other clients only

      } catch (error) {
        console.error('Error saving schedule:', error);
        alert('Fehler beim Speichern: ' + error.message);
      } finally {
        saveInProgress = false;
        isDataOperationInProgress = false; // Release lock after save completes

        // If another save was queued, execute it now
        if (saveQueued) {
          saveQueued = false;
          console.log('🔄 Executing queued save');
          await saveSchedule();
        }
      }
    }

    function mergeClientOnlyById(serverItems, localItems) {
      const merged = Array.isArray(serverItems) ? serverItems.slice() : [];
      const knownIds = new Set(
        merged
          .map(item => item && item._uniqueId)
          .filter(Boolean)
      );

      (localItems || []).forEach(item => {
        if (!item || !item._uniqueId || knownIds.has(item._uniqueId)) return;
        merged.push(item);
        knownIds.add(item._uniqueId);
      });

      return merged;
    }

    // Handle version conflict - server wins strategy
    async function handleVersionConflict(conflict) {
      console.warn('⚠️ Version conflict! Server version:', conflict.serverVersion, 'Local version:', schedule._meta.version);
      
      // Simple strategy: Server wins (replace local with server data)
      const serverData = conflict.serverData;
      const localSnapshot = {
        fixedSchedule: (schedule.fixedSchedule || []).slice(),
        spontaneousEntries: (schedule.spontaneousEntries || []).slice(),
        projects: (schedule.projects || []).slice()
      };
      
      // Replace entire schedule with server data
      Object.assign(schedule, serverData);
      schedule.fixedSchedule = mergeClientOnlyById(schedule.fixedSchedule, localSnapshot.fixedSchedule);
      schedule.spontaneousEntries = mergeClientOnlyById(schedule.spontaneousEntries, localSnapshot.spontaneousEntries);
      schedule.projects = mergeClientOnlyById(schedule.projects, localSnapshot.projects);
      materializeFromStems();
      
      // Re-process and re-render everything (no fetch needed - we have server data)
      regenerateTrainsFromSchedule();
      processTrainData(schedule);
      refreshUIOnly();
      
      // Notify user
      alert('⚠️ Deine Änderungen wurden von einer anderen Sitzung überschrieben.');
    }

    // Helper function to refresh UI without fetching
    // Use this after successful saves when we already have the latest data
    function refreshUIOnly() {
      console.log('🔄 Refreshing UI (no fetch needed)...');
      
      // CRITICAL: Regenerate schedule.trains from spontaneousEntries
      // processTrainData expects schedule.trains to exist!
      regenerateTrainsFromSchedule();
      
      // Reprocess train data to rebuild computed arrays
      processTrainData(schedule);
      
      // Re-render all affected UI components
      renderCurrentWorkspaceView();
      
      // If project drawer is open, refresh it with updated data
      if (isProjectDrawerOpen && currentProjectId) {
        const updatedProject = schedule.projects.find(p => p._uniqueId === currentProjectId);
        if (updatedProject) {
          renderProjectDrawer(updatedProject);
        }
      }
      
      console.log('✅ UI refreshed');
    }
    
    // Helper to regenerate schedule.trains and schedule.localTrains from spontaneousEntries
    function regenerateTrainsFromSchedule() {
      const spontaneousAll = (schedule.spontaneousEntries || []).map(t => ({
        ...t,
        source: 'local',
        _uniqueId: t._uniqueId
      }));

      schedule.trains = [...spontaneousAll];
      schedule.localTrains = [...spontaneousAll];
    }

    // ==================== RECURRING TRAINS ====================

    // Materialize recurring stems into real spontaneousEntries for a rolling 60-day window.
    // Idempotent: skips dates whose _uniqueId already exists or is in stem.skippedDates.
    function materializeFromStems() {
      // Build local midnight Date for day offset i from a base midnight Date
      const toLocalStr = d =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const localMidnight = (baseMs, offsetDays) => {
        // Construct each day by year/month/day arithmetic to stay DST-safe
        const b = new Date(baseMs);
        return new Date(b.getFullYear(), b.getMonth(), b.getDate() + offsetDays);
      };

      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      const todayMs = todayMidnight.getTime();
      const WINDOW_DAYS = 14;

      // Normalise any legacy UTC-suffixed UIDs so they don't block new entries.
      // Legacy UIDs look like stemId_YYYY-MM-DD where the date is the UTC date
      // (which can differ from the local date in UTC+ zones).
      const existingByUid = new Map(
        (schedule.spontaneousEntries || []).map(t => [t._uniqueId, t])
      );

      const newEntries = [];

      for (const stem of (schedule.fixedSchedule || [])) {
        if (!stem._uniqueId || !stem.linie || !stem.linie.trim()) continue;

        const skipped = new Set(stem.skippedDates || []);

        // Parse startDate in LOCAL time; default to today
        const startDateObj = stem.startDate
          ? new Date(stem.startDate + 'T00:00:00')
          : new Date(todayMidnight);
        startDateObj.setHours(0, 0, 0, 0);

        // Only skip days that are strictly before startDate AND before today.
        // A future startDate correctly limits the window; a past one never limits it.
        const effectiveStartMs = Math.max(startDateObj.getTime(), todayMs);

        const { pattern = 'weekdays', days = [] } = stem.recurrence || {};
        // For weekly: anchor DOW comes from startDate (local)
        const stemDow = startDateObj.getDay(); // 0=Sun … 6=Sat

        for (let i = 0; i < WINDOW_DAYS; i++) {
          const d = localMidnight(todayMs, i);         // fresh Date each iteration
          if (d.getTime() < effectiveStartMs) continue;

          const dow = d.getDay();
          let matches = false;
          if      (pattern === 'daily')    matches = true;
          else if (pattern === 'weekdays') matches = dow >= 1 && dow <= 5;
          else if (pattern === 'weekly')   matches = dow === stemDow;
          else if (pattern === 'custom')   matches = Array.isArray(days) && days.includes(dow);

          if (!matches) continue;

          const dateStr = toLocalStr(d);
          if (skipped.has(dateStr)) continue;

          const uid = `${stem._uniqueId}_${dateStr}`;

          // Skip if an entry with the canonical UID already exists
          if (existingByUid.has(uid)) continue;

          // If a legacy UTC-suffixed entry covers the same date, skip (don't duplicate)
          // but do NOT skip just because yesterday's UTC string matches — compare by
          // stored .date field instead of by UID suffix.
          const legacyCheck = [...existingByUid.values()].find(
            t => t._templateId === stem._uniqueId && t.date === dateStr
          );
          if (legacyCheck) continue;

          const entry = {
            _uniqueId:     uid,
            _templateId:   stem._uniqueId,
            type:          stem.type,
            linie:         stem.linie,
            ziel:          stem.ziel          || '',
            plan:          stem.plan          || '',
            actual:        stem.plan          || undefined,
            dauer:         stem.dauer         || 0,
            zwischenhalte: Array.isArray(stem.zwischenhalte) ? [...stem.zwischenhalte] : [],
            projectId:     stem.projectId     || undefined,
            canceled:      false,
            date:          dateStr,
            plannedDate:   dateStr,
            source:        'local'
          };
          newEntries.push(entry);
          existingByUid.set(uid, entry); // prevent intra-run duplicates
        }
      }

      if (newEntries.length > 0) {
        schedule.spontaneousEntries.push(...newEntries);
        console.log(`🔁 Materialized ${newEntries.length} recurring train entries`);
      }
    }

    // Create a new recurring stem and open it in the stem editor
    function createNewRecurringEntry() {
      const _tn = new Date();
      const today = `${_tn.getFullYear()}-${String(_tn.getMonth()+1).padStart(2,'0')}-${String(_tn.getDate()).padStart(2,'0')}`;
      const stemId = 'stem_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();

      const newStem = {
        _uniqueId: stemId,
        type: undefined,
        linie: '',
        ziel: '',
        plan: '',
        dauer: 0,
        zwischenhalte: [],
        startDate: today,
        recurrence: { pattern: 'weekdays', days: [] },
        skippedDates: []
      };

      schedule.fixedSchedule = schedule.fixedSchedule || [];
      schedule.fixedSchedule.push(newStem);

      // Synthetic child: anchors the editor panel; not in spontaneousEntries yet
      const syntheticChild = {
        _uniqueId:    stemId + '_' + today,
        _templateId:  stemId,
        type: undefined,
        linie: '', ziel: '', plan: '', actual: undefined,
        dauer: 0, zwischenhalte: [], canceled: false,
        date: today, plannedDate: today, source: 'local'
      };

      renderFocusMode(syntheticChild, 'stem');

      // Activate all fields immediately
      setTimeout(() => {
        const panel = document.getElementById('focus-panel');
        if (panel) {
          const first = panel.querySelector('[data-editable="true"]');
          if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        }
      }, 100);
    }

    // Helper function to refresh data and update all UI panels
    // Use this when we need to fetch fresh data (version mismatch, conflicts, etc.)
    async function refreshDataAndUI() {
      console.log('🔄 Refreshing data and UI...');

      if (isDataOperationInProgress || isEditingTrain || isEditingProject) {
        console.log('⏸️ Skipping refreshDataAndUI - local edits in progress');
        return;
      }
      
      // Force fetch latest data (bypasses lock check)
      const freshSchedule = await fetchSchedule(true);
      
      // Update global schedule with fresh data
      Object.assign(schedule, freshSchedule);
      
      // Reprocess train data to rebuild computed arrays
      processTrainData(schedule);
      
      // Re-render all affected UI components
      renderCurrentWorkspaceView();
      
      console.log('✅ Data and UI refreshed');
    }

    // Delete train from schedule

    async function saveFocusPanelTrain() {
      // Save entire schedule (like InputEnhanced)
      await saveSchedule();
    }


    // Function to create a new blank train entry
    // Show line picker dropdown for selecting S-Bahn lines

    function createNewTrainEntry(options = {}) {
      // Create a blank train object pre-filled with today's date so it appears
      // immediately in the timetable (client-authoritative — no server round-trip needed).
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
      
      const newTrain = {
        type: options.type,
        linie: options.linie || '',
        ziel: options.ziel || '',
        plan: '',  // Empty - user must fill
        actual: undefined,
        dauer: 0,
        zwischenhalte: [],
        canceled: false,
        date: today,       // Default to today so the entry is immediately visible
        plannedDate: today, // Matches date; will update with user edits
        weekday: weekday,
        source: 'local',
        _uniqueId: 'train_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        ...(options.projectId && { projectId: options.projectId })
      };
      
      // For non-project trains, add to schedule and render immediately
      if (!options.projectId) {
        // Add to spontaneousEntries (like InputEnhanced does)
        schedule.spontaneousEntries.push(newTrain);
        
        // Render in focus mode (will auto-detect mobile/desktop)
        renderFocusMode(newTrain);
        
        // Activate all fields for editing immediately
        setTimeout(() => {
          const panel = document.getElementById('focus-panel');
          const container = panel;
          
          if (container) {
            // Trigger edit mode on the first editable field to convert all fields
            const firstEditable = container.querySelector('[data-editable="true"]');
            if (firstEditable) {
              // Simulate mousedown to activate ALL fields
              const mousedownEvent = new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window
              });
              firstEditable.dispatchEvent(mousedownEvent);
            }
          }
        }, 100);
      }
      
      // Return the train object (needed for project task creation)
      return newTrain;
    }

    // Show announcements view in mobile mode