// === GLOBALS & processTrainData ===
// Extracted inline scripts from mobile.html

// Global variables for station
    let stationsIndex = null;
    let currentEva = null;
    let currentStationName = null;
    
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
    let lastTrainStatusById = new Map();
    let lastNotifiedStatusById = new Map();
    
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

    function processTrainData(schedule) {
      const now = new Date();
      
      // Reset data structure
      processedTrainData = {
        allTrains: [],
        localTrains: [],
        noteTrains: [],
        scheduledTrains: [],
        futureTrains: [],
        currentTrain: null,
        remainingTrains: []
      };
      
      // Get all trains (IDs already assigned at load time)
      processedTrainData.allTrains = (schedule.trains || []).slice();
      processedTrainData.localTrains = (schedule.localTrains || []).slice();
      
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
        .filter(t => t.type !== 'note' && t.linie && t.plan && t.plan.trim() !== '')
        .sort((a, b) => {
          const ta = parseTime(a.actual || a.plan, now, a.date);
          const tb = parseTime(b.actual || b.plan, now, b.date);
          return ta - tb;
        });
      
      // Get today's date for filtering past trains from today
      const todayDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      
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
        if (!occEnd) return false;
        
        // Include only trains that have already ended
        return occEnd <= now;
      });
      
      // Mark past trains with a flag for template rendering
      pastTrainsFromToday.forEach(t => {
        t._isPastTrain = true;
      });
      
      // IMPORTANT: Current train must ALWAYS be from local personal schedule
      const localScheduledTrains = processedTrainData.localTrains
        .filter(t => t.plan && t.plan.trim() !== '')
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
      
      // Remaining trains: past trains (from today) + future trains
      // Display order: oldest past train first, then future trains
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