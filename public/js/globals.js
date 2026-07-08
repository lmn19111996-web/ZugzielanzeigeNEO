// === GLOBALS & processTrainData ===
// Extracted inline scripts from mobile.html

// Sentinel value for personal-timetable mode (no DB station selected)
    const PERSONAL_EVA = 'PERSONAL';
    // Returns true only when a real DB station with a usable EVA is active
    function isRealStation() {
      return !!currentEva &&
             currentEva !== PERSONAL_EVA &&
             currentEva !== '' &&
             currentEva !== '0' &&
             Number(currentEva) !== 0;
    }

// Global variables for station
    let stationsIndex = null;
    let currentEva = PERSONAL_EVA;
    let currentStationName = null;
    let currentPlatformFilter = null; // e.g. '1,2' or '1-4' or null for all
    
    // Global view mode tracking
    let currentViewMode = 'belegungsplan';

    
    // Global refresh interval tracking
    let refreshIntervalId = null;
    let isEditingTrain = false;
    let isEditingProject = false;
    
    // Critical mutex lock to prevent race conditions
    // When true, prevents SSE updates from interrupting saves/fetches
    let isDataOperationInProgress = false;
    
    // Track focused trains separately for desktop and mobile
    let desktopFocusedTrainId = null;
    
    // Track project editor state
    let currentProjectId = null;
    let isProjectDrawerOpen = false;
    let currentProjectSortMode = 'creation'; // Track project sorting preference
    let workspaceModeBeforeProjectDrawer = null; // Track workspace mode before opening project drawer
    
    // Notification tracking
    // lastTrainStatusById / lastNotifiedStatusById removed — state now owned by _notifState in notifications.js
    
    // Save queue variables
    let saveInProgress = false;
    let saveQueued = false;
    
    // Global schedule object (like InputEnhanced)
    let schedule = {
      _meta: {
        version: 0,
        lastSaved: null
      },
      fixedSchedule: [],
      spontaneousEntries: [],
      trains: [],
      projects: [] // Array of project objects
    };

    // Global accent color - matches current train line color on headline ribbon
    let currentAccentColor = 'var(--color-divider)'; // Default

    // Centralized train processing - creates categorized train lists used by all panels
    let processedTrainData = {
      allTrains: [],           // All trains from schedule
      localTrains: [],         // Local personal schedule trains only
      noteTrains: [],          // Notes (objects with type='note')
      scheduledTrains: [],     // Trains with plan time
      durationOnlyTrains: [],  // Trains without time, rendered after timed trains per day
      futureTrains: [],        // Scheduled trains in the future or currently occupying
      currentTrain: null,      // First future/occupying train from PERSONAL SCHEDULE
      remainingTrains: []      // Future trains after the current one
    };
    let lastStressDataSignature = '';

    function buildStressDataSignature(trains) {
      return (trains || []).map(t => [
        t && t._uniqueId || '',
        t && t.date || '',
        t && (t.actual || t.plan) || '',
        Number(t && t.dauer || 0),
        t && t.canceled ? 1 : 0
      ].join('|')).join('~');
    }

    // True if the clock time of `date` falls inside the [startHour, endHour) window,
    // where the window may wrap past midnight (e.g. 18 -> 6). Equal bounds means
    // no restriction at all (zero-length window).
    function isTimeInCurfewWindow(date, startHour, endHour) {
      if (!date || startHour === endHour) return false;
      const hour = date.getHours();
      if (startHour < endHour) return hour >= startHour && hour < endHour;
      return hour >= startHour || hour < endHour;
    }
    window.isTimeInCurfewWindow = isTimeInCurfewWindow;

    // Force-cancels trains on a curfewed line whose departure lands inside the
    // configured curfew window. Runs every processTrainData cycle (see call site
    // below) so it's a live rule, not a one-time/persisted edit. schedule.trains /
    // localTrains aren't necessarily rebuilt on every cycle, so a train object can
    // outlive a settings change — each pass first reverts its own previous
    // cancellation (tracked via the transient _curfewCanceled flag) before
    // re-evaluating, so disabling the rule or editing the line list self-heals
    // instead of leaving trains stuck cancelled.
    // A train with curfewOverride=true (set when the user manually toggles
    // cancel/reactivate on it — see editor.js/swipe.js) is skipped entirely so a
    // manual decision always wins and can't be immediately re-cancelled by the rule.
    function applyCurfewRule(trains) {
      const enabled = !!(window.AppSettings && window.AppSettings.get('curfewEnabled'));
      const lines = enabled ? (window.AppSettings.get('curfewLines') || []).map(l => String(l).toUpperCase()) : [];
      const startHour = window.AppSettings ? window.AppSettings.get('curfewStartHour') : 18;
      const endHour = window.AppSettings ? window.AppSettings.get('curfewEndHour') : 6;
      const now = new Date();

      trains.forEach(t => {
        if (!t) return;

        if (t._curfewCanceled) {
          t.canceled = false;
          t.delayReason = '';
          t._curfewCanceled = false;
        }

        if (t.curfewOverride) return;
        if (!enabled || t.type === 'note' || !t.linie || !t.date) return;
        if (!lines.includes(String(t.linie).toUpperCase())) return;
        if (isDurationOnlyTrain(t) || !hasTrainTime(t)) return;

        const depTime = parseTime(t.actual || t.plan, now, t.date);
        if (!depTime) return;

        if (isTimeInCurfewWindow(depTime, startHour, endHour)) {
          t.canceled = true;
          t.delayReason = `Für diese Linie ist keine Abfahrt ab ${startHour} Uhr möglich`;
          t._curfewCanceled = true;
        }
      });
    }

    function processTrainData(schedule) {
      const now = new Date();

      // Mode gate: no-EVA station selected — wipe display trains regardless of caller.
      // This is the single enforcement point so every path (clock, save, SSE, etc.) obeys.
      if (currentStationName && !isRealStation()) {
        schedule = Object.assign({}, schedule, { trains: [] });
      }

      // Reset data structure
      processedTrainData = {
        allTrains: [],
        localTrains: [],
        noteTrains: [],
        scheduledTrains: [],
        durationOnlyTrains: [],
        futureTrains: [],
        currentTrain: null,
        remainingTrains: []
      };
      
      // Get all trains (IDs already assigned at load time)
      processedTrainData.allTrains = (schedule.trains || []).slice();
      processedTrainData.localTrains = (schedule.localTrains || []).slice();

      // _isPastTrain is a transient UI flag. Recompute it every cycle so
      // edited trains (e.g. moved from past to future) never keep stale styling.
      processedTrainData.allTrains.forEach(t => { if (t) t._isPastTrain = false; });
      processedTrainData.localTrains.forEach(t => { if (t) t._isPastTrain = false; });

      // DATA MANIPULATION: S6 → FEX promotion
      // S6 trains with a destination prefixed "[PRÜ]" are promoted to FEX
      // exactly 14 days before (and including) their departure date.
      // This mutates the in-memory linie field; the stored schedule is not affected.
      const _today = new Date(); _today.setHours(0, 0, 0, 0);
      [...processedTrainData.allTrains, ...processedTrainData.localTrains].forEach(t => {
        if ((t.linie || '').toUpperCase() === 'S6' &&
            typeof t.ziel === 'string' &&
            t.ziel.trimStart().toUpperCase().startsWith('[PRÜ]') &&
            t.date) {
          const dep = new Date(t.date + 'T00:00:00');
          const daysUntil = Math.round((dep - _today) / 86400000);
          if (daysUntil >= 0 && daysUntil <= 14) {
            t.linie = 'FEX';
          }
        }
      });

      // DATA MANIPULATION: Nachtsperre (curfew) enforcement
      // Trains on a curfewed line whose departure falls inside the configured
      // window are force-cancelled every cycle — this is a hard constraint, not
      // a user-reversible edit, so it's re-applied live rather than persisted.
      // Same "in-memory only" mutation as the S6 promotion above.
      applyCurfewRule([...processedTrainData.allTrains, ...processedTrainData.localTrains]);

      // Separate notes (objects with type='note') from scheduled trains.
      // Notes can be in schedule.trains (legacy) or schedule.spontaneousEntries (new format).
      const notesFromTrains = processedTrainData.allTrains.filter(t => t.type === 'note');
      const notesFromSpontaneous = (schedule.spontaneousEntries || []).filter(t => t.type === 'note');
      // Deduplicate by _uniqueId in case both sources overlap
      const noteIds = new Set(notesFromTrains.map(t => t._uniqueId));
      processedTrainData.noteTrains = [
        ...notesFromTrains,
        ...notesFromSpontaneous.filter(t => !noteIds.has(t._uniqueId))
      ];
      
      processedTrainData.scheduledTrains = processedTrainData.allTrains
        .filter(t => t.type !== 'note' && !isDurationOnlyTrain(t) && t.linie && hasTrainTime(t))
        .sort((a, b) => {
          const ta = parseTime(a.actual || a.plan, now, a.date);
          const tb = parseTime(b.actual || b.plan, now, b.date);
          return ta - tb;
        });

      // Smart advisory: recompute delay-reason auto-suggestions every cycle so they
      // never go stale (schedule edits, overlaps, and Stressmeter tiers can all change
      // between cycles). _hasDelay/_delayReasonAuto are transient (never persisted —
      // stripped in editor.js before save).
      processedTrainData.scheduledTrains.forEach(t => {
        t._hasDelay = !!(t.actual && t.actual !== t.plan);
        t._delayReasonAuto = (typeof computeSuggestedDelayReasons === 'function')
          ? computeSuggestedDelayReasons(t, processedTrainData.scheduledTrains, now)
          : [];
      });

      // Get today's date for date-based visibility filtering
      const todayDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

      processedTrainData.durationOnlyTrains = processedTrainData.allTrains
        .filter(t => isDurationOnlyTrain(t) && t.linie && t.date && t.date >= todayDate)
        .sort((a, b) => {
          const dateCompare = String(a.date || '').localeCompare(String(b.date || ''));
          if (dateCompare !== 0) return dateCompare;
          return 0;
        });

      
      // Filter for future and currently occupying trains
      processedTrainData.futureTrains = processedTrainData.scheduledTrains.filter(t => {
        const tTime = parseTime(t.actual || t.plan, now, t.date);
        
        if (t.canceled) {
          return tTime > now;
        }
        
        const occEnd = getOccupancyEnd(t, now);
        if (t.actual && occEnd && parseTime(t.actual, now, t.date) <= now && occEnd > now) return true;
        return tTime > now;
      });
      
      // Filter for past trains from today (already departed)
      const pastTrainsFromToday = processedTrainData.scheduledTrains.filter(t => {
        // Only include trains from today
        if (t.date !== todayDate) return false;

        // Get the train's end time
        const occEnd = getOccupancyEnd(t, now);
        if (occEnd) return occEnd <= now;

        // No duration recorded (yet) — still show it once its departure time
        // has passed, so the user can check out afterwards instead of it
        // silently disappearing from the list.
        const tTime = parseTime(t.actual || t.plan, now, t.date);
        return !!tTime && tTime <= now;
      });
      
      // Mark past trains with a flag for template rendering
      pastTrainsFromToday.forEach(t => {
        t._isPastTrain = true;
      });
      
      // IMPORTANT: Current train must ALWAYS be from local personal schedule
      const localScheduledTrains = processedTrainData.localTrains
        .filter(t => !isDurationOnlyTrain(t) && hasTrainTime(t))
        .sort((a, b) => {
          const ta = parseTime(a.actual || a.plan, now, a.date);
          const tb = parseTime(b.actual || b.plan, now, b.date);
          return ta - tb;
        });
      
      const localFutureTrains = localScheduledTrains.filter(t => {
        const tTime = parseTime(t.actual || t.plan, now, t.date);
        
        if (t.canceled) {
          return tTime > now;
        }
        
        const occEnd = getOccupancyEnd(t, now);
        if (t.actual && occEnd && parseTime(t.actual, now, t.date) <= now && occEnd > now) return true;
        return tTime > now;
      });
      
      // Set current train from local schedule only
      // If there are overlaps, choose the train that starts LATEST
      if (localFutureTrains.length > 0) {
        // Find all trains that are currently occupying (overlapping with now)
        const currentlyOccupying = localFutureTrains.filter(t => {
          const tTime = parseTime(t.actual || t.plan, now, t.date);
          const occEnd = getOccupancyEnd(t, now);
          return tTime <= now && occEnd > now;
        });
        
        if (currentlyOccupying.length > 0) {
          // Multiple trains occupying - choose the one that started latest
          processedTrainData.currentTrain = currentlyOccupying.reduce((latest, train) => {
            const latestTime = parseTime(latest.actual || latest.plan, now, latest.date);
            const trainTime = parseTime(train.actual || train.plan, now, train.date);
            return trainTime > latestTime ? train : latest;
          });
        } else {
          // No overlaps, just use the first future train
          processedTrainData.currentTrain = localFutureTrains[0];
        }
      } else {
        processedTrainData.currentTrain = null;
      }
      
      // Remaining trains in main list are timed trains only.
      // Duration-only trains are rendered in a dedicated collapsed section.
      processedTrainData.remainingTrains = [...pastTrainsFromToday, ...processedTrainData.futureTrains];

      const stressSig = buildStressDataSignature(processedTrainData.allTrains);
      if (stressSig !== lastStressDataSignature) {
        lastStressDataSignature = stressSig;
        if (typeof stressmeterOnDataChanged === 'function') stressmeterOnDataChanged();
      }

      // Sync pinned trains with updated data
      syncPinnedTrains();

      return processedTrainData;
    }