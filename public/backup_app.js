// Extracted inline scripts from mobile.html

// Global variables for station
    let stationsIndex = null;
    let currentEva = null;
    let currentStationName = null;
    
    // Global view mode tracking
    let currentViewMode = 'belegungsplan';
    let isAnnouncementsView = false;
    
    // Global refresh interval tracking
    let refreshIntervalId = null;
    let isEditingTrain = false;
    
    // Track focused trains separately for desktop and mobile
    let desktopFocusedTrainId = null;
    let mobileFocusedTrainId = null;
    
    // Mobile edit debounce timer
    let mobileEditDebounceTimer = null;
    let pendingMobileSave = false;
    
    // Notification tracking
    let lastTrainStatusById = new Map();
    let lastNotifiedStatusById = new Map();
    
    // Global schedule object (like InputEnhanced)
    let schedule = {
      fixedSchedule: [],
      spontaneousEntries: [],
      trains: []
    };

    // Centralized train processing - creates categorized train lists used by all panels
    let processedTrainData = {
      allTrains: [],           // All trains from schedule
      localTrains: [],         // Local personal schedule trains only
      noteTrains: [],          // Trains without plan time (announcements/notes)
      scheduledTrains: [],     // Trains with plan time
      futureTrains: [],        // Scheduled trains in the future or currently occupying
      currentTrain: null,      // First future/occupying train from PERSONAL SCHEDULE
      remainingTrains: []      // Future trains after the current one
    };

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
      
      // Separate notes from scheduled trains
      processedTrainData.noteTrains = processedTrainData.allTrains.filter(t => !t.plan || t.plan.trim() === '');
      
      processedTrainData.scheduledTrains = processedTrainData.allTrains
        .filter(t => t.plan && t.plan.trim() !== '')
        .sort((a, b) => {
          const ta = parseTime(a.actual || a.plan, now, a.date);
          const tb = parseTime(b.actual || b.plan, now, b.date);
          return ta - tb;
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
      
      // Remaining trains (all future trains)
      processedTrainData.remainingTrains = processedTrainData.futureTrains;
      
      return processedTrainData;
      
      // Sync pinned trains with updated data
      syncPinnedTrains();
      
      return processedTrainData;
    }
    // Helper functions
    //S1 to s1 weil s1.svg
    function getTrainSVG(line) {
      return `./${line.toLowerCase()}.svg`;
    }

    function getLineColor(line) {
      const lineColors = {
        's1': '#7D66AD',
        's2': '#00793B',
        's25': '#1c763b',
        's3': '#C76AA2',
        's4': '#992946',
        's41': '#aa5c3a',
        's42': '#c86722',
        's45': '#cc9d5a',
        's46': '#cc9d5a',
        's47': '#cc9d5a',
        's5': '#F08600',
        's6': '#004E9D',
        's60': '#8b8d26',
        's62': '#c17b36',
        's7': '#AEC926',
        's75': '#7f6ea3',
        's8': '#6da939',
        's85': '#6da939',
        's9': '#962d44',
        'fex': '#FF0000'
      };
      return lineColors[line.toLowerCase()] || '#161B75';
    }

    function getCarriageSVG(dauer, isFEX = false) {
      const n = Number(dauer);
      const prefix = isFEX ? 'cb' : 'c';
      if (!Number.isFinite(n) || n <= 0) return `./${prefix}3.svg`;
      if (n <= 30) return `./${prefix}1.svg`;
      if (n <= 60) return `./${prefix}2.svg`;
      if (n <= 90) return `./${prefix}3.svg`;
      return `./${prefix}4.svg`;
    }

    function formatClock(date) {
      if (!date) return '';
      const h = String(date.getHours()).padStart(2, '0');
      const m = String(date.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }

    function parseTime(str, now = new Date(), trainDate = null) {
      if (!str) return null;
      const [h, m] = String(str).split(":").map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      
      const d = trainDate ? new Date(trainDate) : new Date(now);
      d.setHours(h, m, 0, 0);
      
      if (!trainDate) {
        const diffMs = d - now;
        if (diffMs < -12 * 60 * 60 * 1000) d.setDate(d.getDate() + 1);
      }
      
      return d;
    }

    function getDelay(plan, actual, now = new Date(), trainDate = null) {
      if (!actual || !plan) return 0;
      const planDate = parseTime(plan, now, trainDate);
      const actualDate = parseTime(actual, now, trainDate);
      if (!planDate || !actualDate) return 0;
      return Math.round((actualDate - planDate) / 60000);
    }

    function getOccupancyEnd(train, now = new Date()) {
      if (!train || train.canceled) return null;
      // Use actual time if available, otherwise use plan time
      const startTime = parseTime(train.actual || train.plan, now, train.date);
      const dur = Number(train.dauer);
      if (!startTime || !dur || isNaN(dur) || dur <= 0) return null;
      return new Date(startTime.getTime() + dur * 60000);
    }

    function formatDeparture(plan, actual, now, delay, dauer, trainDate = null) {
      const planDate = parseTime(plan, now, trainDate);
      const actualDate = actual ? parseTime(actual, now, trainDate) : planDate;
      
      function addDayIndicator(frag, date, now) {
        if (!date) return;
        const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const trainDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayDiff = Math.round((trainDay - nowDay) / (24 * 60 * 60 * 1000));
        
        if (dayDiff > 0) {
          const sup = document.createElement('sup');
          sup.textContent = `+${dayDiff}`;
          sup.style.fontSize = '0.6em';
          sup.style.marginLeft = '0px';
          frag.appendChild(sup);
        }
      }
      
      // Check if train is occupying
      if (actualDate && dauer) {
        const occEnd = new Date(actualDate.getTime() + Number(dauer) * 60000);
        if (actualDate <= now && occEnd > now) {
          const frag = document.createDocumentFragment();
          frag.appendChild(document.createTextNode('bis '));
          const clock = document.createElement('span');
          clock.className = 'departure-clock';
          clock.textContent = formatClock(occEnd);
          frag.appendChild(clock);
          addDayIndicator(frag, occEnd, now);
          return frag;
        }
      }

      const diffMin = Math.round((actualDate - now) / 60000);

      if (diffMin === 0) return document.createTextNode('Zug fährt ab');

      if (diffMin > 0 && diffMin < 60) {
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(`in ${diffMin} Min`));
        addDayIndicator(frag, actualDate, now);
        return frag;
      }

      if (delay !== 0) {
        const frag = document.createDocumentFragment();
        const planSpan = document.createElement('span');
        planSpan.textContent = plan || '';
        const spacer = document.createTextNode(' ');
        const actualSpan = document.createElement('span');
        actualSpan.className = 'delayed';
        actualSpan.textContent = actual || '';
        frag.appendChild(planSpan);
        frag.appendChild(spacer);
        frag.appendChild(actualSpan);
        addDayIndicator(frag, actualDate, now);
        return frag;
      }

      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(plan || ''));
      addDayIndicator(frag, actualDate, now);
      return frag;
    }

    // Format countdown for headline train
    function formatCountdown(train, now) {
      if (train.canceled) {
        return document.createTextNode('');
      }

      const actualTime = parseTime(train.actual || train.plan, now, train.date);
      if (!actualTime) {
        return document.createTextNode('--:--:--');
      }

      // Check if currently occupying
      if (train.dauer) {
        const occEnd = getOccupancyEnd(train, now);
        if (train.actual && occEnd && parseTime(train.actual, now, train.date) <= now && occEnd > now) {
          // Currently occupying - show time until end
          const diffSec = Math.round((occEnd - now) / 1000);
          const hours = Math.floor(diffSec / 3600);
          const minutes = Math.floor((diffSec % 3600) / 60);
          const seconds = diffSec % 60;
          
          const frag = document.createDocumentFragment();
          const countdownSpan = document.createElement('span');
          countdownSpan.className = 'countdown-time';
          countdownSpan.textContent = `Abfahrt in ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
          frag.appendChild(countdownSpan);
          return frag;
        }
      }

      // Show countdown to departure
      const diffSec = Math.round((actualTime - now) / 1000);
      
      if (diffSec <= 0) {
        return document.createTextNode('Zug fährt ab');
      }

      const hours = Math.floor(diffSec / 3600);
      const minutes = Math.floor((diffSec % 3600) / 60);
      const seconds = diffSec % 60;

      const frag = document.createDocumentFragment();
      const countdownSpan = document.createElement('span');
      countdownSpan.className = 'countdown-time';
      countdownSpan.textContent = `Ankunft in ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      frag.appendChild(countdownSpan);
      return frag;
    }

    // Notification functions for train arrival alerts
    async function requestNotificationPermission() {
      if (!('Notification' in window)) {
        console.warn('This browser does not support notifications');
        return false;
      }
      
      if (Notification.permission === 'granted') {
        return true;
      }
      
      if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
      }
      
      return false;
    }
    
    function getTrainNotifyId(train) {
      return train.id || train._uniqueId || `${train.linie || train.line || ''}-${train.plan || ''}-${train.date || ''}-${train.ziel || train.destination || ''}`;
    }

    function checkTrainArrivals() {
      const now = new Date();
      const zeroMinutesFromNow = now;
      const twentyMinutesFromNow = new Date(now.getTime() + 20 * 60000);
      
      if (!processedTrainData.localTrains) return;
      
      // Check local trains for upcoming arrivals
      processedTrainData.localTrains.forEach(train => {
        const trainId = getTrainNotifyId(train);
        if (!trainId || !train.plan) {
          return;
        }
        
        const trainTime = parseTime(train.actual || train.plan, now, train.date);
        if (!trainTime) return;
        
        const statusKey = `${train.canceled ? 'canceled' : 'active'}|${train.plan || ''}|${train.actual || ''}|${train.dauer || ''}`;
        const previousStatus = lastTrainStatusById.get(trainId);
        lastTrainStatusById.set(trainId, statusKey);

        // Only notify when the train status changes (skip first observation)
        if (!previousStatus || previousStatus === statusKey) {
          return;
        }

        // Check if train arrives between 0 and 20 minutes from now
        if (trainTime >= zeroMinutesFromNow && trainTime < twentyMinutesFromNow) {
          if (lastNotifiedStatusById.get(trainId) !== statusKey) {
            sendTrainNotification(train, trainTime);
            lastNotifiedStatusById.set(trainId, statusKey);
          }
        }
      });
      
      // Clean up old tracking (remove trains that have passed)
      const idsToRemove = [];
      lastTrainStatusById.forEach((_, id) => {
        const train = processedTrainData.localTrains.find(t => getTrainNotifyId(t) === id);
        if (train) {
          const trainTime = parseTime(train.actual || train.plan, now, train.date);
          if (trainTime && trainTime < now) {
            idsToRemove.push(id);
          }
        } else {
          idsToRemove.push(id);
        }
      });
      idsToRemove.forEach(id => {
        lastTrainStatusById.delete(id);
        lastNotifiedStatusById.delete(id);
      });
    }
    
    function sendTrainNotification(train, trainTime) {
      if (Notification.permission !== 'granted') return;
      
      const lineLabel = train.linie || train.line || '';
      const destinationLabel = train.ziel || train.destination || '';
      const planTime = train.plan ? parseTime(train.plan, new Date(), train.date) : null;
      const planClock = planTime ? formatClock(planTime) : formatClock(trainTime);
      const delay = getDelay(train.plan, train.actual, new Date(), train.date);

      const title = `${lineLabel} nach ${destinationLabel}`.trim();
      let body = `Abfahrt ${planClock} von Gleis --.`;

      if (train.canceled) {
        body = 'Fällt heute aus. Wir bitten um Entschuldigung.';
      } else if (delay > 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${delay} Minuten später.`;
      } else if (delay < 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${-delay} Minuten früher.`;
      }
      
      const notification = new Notification(title, {
        body: body,
        icon: train.line ? `./${train.line.toLowerCase()}.svg` : undefined,
        badge: train.line ? `./${train.line.toLowerCase()}.svg` : undefined,
        tag: `train-${train.id}`, // Prevent duplicate notifications
        requireInteraction: false,
        silent: false
      });
      
      // Auto-close after 10 seconds
      setTimeout(() => notification.close(), 10000);
      
      // Optional: focus the window when notification is clicked
      notification.onclick = function() {
        window.focus();
        notification.close();
      };
      
      console.log(`📢 Notification sent for train ${train.line} to ${train.destination} at ${timeStr}`);
    }

    // Fetch data from server API
    async function fetchSchedule() {
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
            return train;
          };
          
          // Store global schedule object (like InputEnhanced) with unique IDs
          schedule.fixedSchedule = (data.fixedSchedule || []).map(assignId);
          schedule.spontaneousEntries = (data.spontaneousEntries || []).map(assignId);
          schedule.trains = (data.trains || []).map(assignId);
          
          // Handle both new and legacy formats
          if (data.fixedSchedule || data.spontaneousEntries) {
            const now = new Date();
            const fixedTrainsForDays = [];
            
            for (let i = 0; i < 7; i++) {
              const targetDate = new Date(now);
              targetDate.setDate(targetDate.getDate() + i);
              const dateStr = targetDate.toLocaleDateString('sv-SE');
              const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][targetDate.getDay()];
              
              const fixedForDay = (data.fixedSchedule || []).filter(t => t.weekday === weekday && t.linie);
              const fixedAsTrains = fixedForDay.map(t => {
                const normalized = {
                  ...t,
                  date: dateStr,
                  source: 'local',
                  _uniqueId: t._uniqueId // Preserve unique ID
                };
                // Normalize stops to zwischenhalte
                if (t.stops && !t.zwischenhalte) {
                  normalized.zwischenhalte = t.stops;
                  delete normalized.stops;
                }
                return normalized;
              });
              fixedTrainsForDays.push(...fixedAsTrains);
            }
            
            const spontaneousAll = (data.spontaneousEntries || []).filter(t => t.linie).map(t => {
              const normalized = {
                ...t,
                source: 'local',
                _uniqueId: t._uniqueId // Preserve unique ID
              };
              // Normalize stops to zwischenhalte
              if (t.stops && !t.zwischenhalte) {
                normalized.zwischenhalte = t.stops;
                delete normalized.stops;
              }
              return normalized;
            });
            
            localTrains = [...fixedTrainsForDays, ...spontaneousAll];
          } else {
            localTrains = (data.trains || []).map(t => {
              const normalized = {
                ...t,
                source: 'local'
              };
              // Normalize stops to zwischenhalte
              if (t.stops && !t.zwischenhalte) {
                normalized.zwischenhalte = t.stops;
                delete normalized.stops;
              }
              return normalized;
            });
          }
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
    function renderHeadlineTrain() {
      const now = new Date();
      const firstTrainContainer = document.getElementById('first-train-container');
      const currentTrain = processedTrainData.currentTrain;
      const topRibbon = document.querySelector('.top-ribbon');
      
      if (currentTrain) {
        const existingEntry = firstTrainContainer.querySelector('.train-entry');
        
        // Check if the train has changed (different linie, plan, actual, or destination)
        const existingDeparture = existingEntry ? existingEntry.querySelector('[data-departure]') : null;
        const trainChanged = !existingDeparture || 
                           !existingEntry ||
                           existingEntry.dataset.linie !== (currentTrain.linie || '') ||
                           existingDeparture.dataset.plan !== currentTrain.plan ||
                           existingDeparture.dataset.actual !== (currentTrain.actual || '') ||
                           !existingEntry.querySelector('.zugziel') ||
                           existingEntry.querySelector('.zugziel').textContent !== (currentTrain.canceled ? 'Zug fällt aus' : currentTrain.ziel);
        
        if (trainChanged) {
          // Only recreate if train changed
          const firstEntry = createTrainEntry(currentTrain, now, true);
          firstTrainContainer.innerHTML = '';
          firstTrainContainer.appendChild(firstEntry);
          
          // Apply line color to top ribbon bottom border
          if (topRibbon) {
            const lineColor = getLineColor(currentTrain.linie || 'S1');
            topRibbon.style.borderBottom = `4px solid ${lineColor}`;
          }
        }
        // If train hasn't changed, updateClock() will handle the countdown update
      } else {
        firstTrainContainer.innerHTML = '';
        // Reset to default border color when no train
        if (topRibbon) {
          topRibbon.style.borderBottom = '3px solid rgba(255, 255, 255, 0.64)';
        }
      }
    }

    let currentWorkspaceMode = 'list';

    // Toggle between Belegungsplan and legacy list view
    function toggleViewMode() {
      currentViewMode = currentViewMode === 'belegungsplan' ? 'list' : 'belegungsplan';
      localStorage.setItem('viewMode', currentViewMode);
      renderTrains();
    }

    function openAnnouncementsDrawer() {
      const drawer = document.getElementById('announcement-drawer');
      if (drawer) {
        drawer.classList.add('is-open');
        document.body.classList.add('announcements-open');
      }
    }

    function closeAnnouncementsDrawer() {
      const drawer = document.getElementById('announcement-drawer');
      if (drawer) {
        drawer.classList.remove('is-open');
      }
      document.body.classList.remove('announcements-open');
    }

    function openEditorDrawer() {
      const panel = document.getElementById('focus-panel');
      if (panel) {
        panel.classList.add('is-open');
        document.body.classList.add('editor-drawer-open');
      }
      closeAnnouncementsDrawer();
    }

    function closeEditorDrawer() {
      const panel = document.getElementById('focus-panel');
      if (panel) {
        panel.classList.remove('is-open');
      }
      document.body.classList.remove('editor-drawer-open');
    }

    function showWorkspacePlaceholder(label) {
      const placeholder = document.getElementById('mode-placeholder');
      const trainListEl = document.getElementById('train-list');
      if (placeholder) {
        placeholder.textContent = `${label} (Platzhalter)`;
        placeholder.classList.add('is-active');
      }
      if (trainListEl) {
        trainListEl.style.display = 'none';
      }
    }

    function hideWorkspacePlaceholder() {
      const placeholder = document.getElementById('mode-placeholder');
      const trainListEl = document.getElementById('train-list');
      if (placeholder) {
        placeholder.classList.remove('is-active');
      }
      if (trainListEl) {
        trainListEl.style.display = '';
      }
    }

    function setWorkspaceMode(mode) {
      const isMobile = window.innerWidth <= 768;
      currentWorkspaceMode = mode;

      if (mode === 'add') {
        createNewTrainEntry();
        return;
      }

      switch (mode) {
        case 'list':
          currentViewMode = 'list';
          isAnnouncementsView = false;
          closeAnnouncementsDrawer();
          hideWorkspacePlaceholder();
          renderTrains();
          break;
        case 'occupancy':
          currentViewMode = 'belegungsplan';
          isAnnouncementsView = false;
          closeAnnouncementsDrawer();
          hideWorkspacePlaceholder();
          renderTrains();
          break;
        case 'announcements':
          isAnnouncementsView = true;
          if (isMobile) {
            showAnnouncementsView();
          } else {
            openAnnouncementsDrawer();
            renderComprehensiveAnnouncementPanel();
          }
          break;
        case 'db-api':
          closeAnnouncementsDrawer();
          showWorkspacePlaceholder('DB API');
          showStationOverlay();
          break;
        case 'projects':
          closeAnnouncementsDrawer();
          showWorkspacePlaceholder('Projekte');
          break;
        case 'meals':
          closeAnnouncementsDrawer();
          showWorkspacePlaceholder('Mahlzeiten');
          break;
        case 'groceries':
          closeAnnouncementsDrawer();
          showWorkspacePlaceholder('Einkauf');
          break;
        case 'inventory':
          closeAnnouncementsDrawer();
          showWorkspacePlaceholder('Inventar');
          break;
        default:
          break;
      }
    }

    // Unified render function that calls the appropriate view
    function renderTrains() {
      if (currentViewMode === 'belegungsplan') {
        renderBelegungsplan();
      } else {
        renderTrainList();
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

      // Render remaining trains (skip first) with day separators
      remainingTrains.forEach((train, index) => {
        // Check if this is the first train of a new day
        const prevTrain = index === 0 ? processedTrainData.currentTrain : remainingTrains[index - 1];
        if (prevTrain && train.date !== prevTrain.date && train.date) {
          // Use template to create day separator
          const separatorHTML = Templates.daySeparator(train.date);
          const template = document.createElement('template');
          template.innerHTML = separatorHTML.trim();
          trainListEl.appendChild(template.content.firstChild);
        }
        
        const entry = createTrainEntry(train, now, false);
        trainListEl.appendChild(entry);
      });
      
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

    // Format stops with date for display
    function formatStopsWithDate(train) {
      // Format date display - always use long format for announcements
      let dateText = '';
      
      if (train.date) {
        const trainDate = new Date(train.date);
        dateText = trainDate.toLocaleDateString('de-DE', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
      }
      
      // Use zwischenhalte (standardized property name)
      let stopsText = '';
      if (train.zwischenhalte) {
        if (Array.isArray(train.zwischenhalte)) {
          stopsText = train.zwischenhalte.join('<br>');
        } else if (typeof train.zwischenhalte === 'string') {
          stopsText = train.zwischenhalte.replace(/\n/g, '<br>');
        }
      }
      
      const contentWithDate = dateText + (stopsText ? '<br><br>' + stopsText : (train.canceled ? '<br><br>Zug fällt aus' : ''));
      return contentWithDate;
    }

    // ===== AUTO SUGGESTION FOR "STELLUNG IM STUNDENPLAN" =====
    
    // Global state for time slot suggestion
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
          const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === existingTrain._uniqueId);
          if (fixedIndex >= 0) {
            schedule.fixedSchedule[fixedIndex].canceled = true;
          }
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
      const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === trainId);
      if (fixedIndex >= 0) {
        schedule.fixedSchedule[fixedIndex].plan = slot.time;
        schedule.fixedSchedule[fixedIndex].date = slot.date;
      }
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
    function createTrainEntry(train, now, isFirstTrain = false) {
      // Use template to create HTML
      const htmlString = Templates.trainEntry(train, now, isFirstTrain);
      
      // Create element from HTML string
      const template = document.createElement('template');
      template.innerHTML = htmlString.trim();
      const entry = template.content.firstChild;
      
      // Add click handler to show focus mode
      entry.addEventListener('click', () => {
        renderFocusMode(train);
        // Update selected state
        document.querySelectorAll('.train-entry').forEach(e => e.classList.remove('selected'));
        entry.classList.add('selected');
      });

      return entry;
    }

    // Render focus mode by cloning template and populating with train data
    // Helper function to convert ALL fields to editable inputs at once
    function makeAllFieldsEditable(train, panel, focusFieldName) {
      const editableFields = panel.querySelectorAll('[data-editable="true"]');
      const inputs = {};
      
      // Define tab order: date(1) → line(2) → destination(3) → stops(4) → plan(5) → duration(6) → actual(7)
      const tabOrder = ['date', 'linie', 'ziel', 'zwischenhalte', 'plan', 'dauer', 'actual'];
      
      // Update train object from input values - MUST update the original schedule object!
      const updateValue = (field, value) => {
        // Find the actual train in the schedule using unique ID
        const trainId = panel.dataset.trainId;
        let scheduleTrain = null;
        let sourceArray = null;
        
        // Try fixedSchedule first
        const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === trainId);
        
        if (fixedIndex >= 0) {
          scheduleTrain = schedule.fixedSchedule[fixedIndex];
          sourceArray = 'fixedSchedule';
        } else {
          // Try spontaneousEntries (trains with specific dates)
          const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
          
          if (spontIndex >= 0) {
            scheduleTrain = schedule.spontaneousEntries[spontIndex];
            sourceArray = 'spontaneousEntries';
          }
        }
        
        if (!scheduleTrain) {
          console.error('❌ Could not find train in schedule!', {
            trainId: trainId,
            linie: train.linie,
            plan: train.plan,
            weekday: train.weekday,
            date: train.date
          });
        }
        
        // Update both the display train AND the schedule source
        if (field === 'date') {
          // Only update date for spontaneous entries, not fixed schedules
          const isFixedSchedule = scheduleTrain && scheduleTrain.weekday && !scheduleTrain.date;
          if (!isFixedSchedule) {
            train.date = value;
            const dateObj = new Date(train.date);
            const newWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateObj.getDay()];
            train.weekday = newWeekday;
            if (scheduleTrain) {
              scheduleTrain.date = value;
              scheduleTrain.weekday = newWeekday;
            }
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
      
      // Check if this is a fixed schedule (repeating) train
      const isFixedScheduleTrain = train.isFixedSchedule === true;
      
      // Convert each field to input
      editableFields.forEach(field => {
        const fieldName = field.getAttribute('data-field');
        const inputType = field.getAttribute('data-input-type');
        const currentValue = field.getAttribute('data-value');
        const placeholder = field.getAttribute('data-placeholder') || '';
        
        // Skip date field for fixed schedule trains - keep it as display-only
        if (fieldName === 'date' && isFixedScheduleTrain) {
          return; // Don't create input element
        }
        
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
            isEditingTrain = false; // Resume refresh
            
            // SAVE SCROLL POSITION BEFORE ANY RENDERING
            const trainListEl = document.getElementById('train-list');
            const savedScroll = trainListEl ? trainListEl.scrollTop : 0;
            
            // Auto-save
            await saveSchedule();
            // Immediately re-process and re-render with the updated schedule data
            processTrainData(schedule);
            renderTrains(); // Use unified render function
            
            // Re-render focus panel and THEN restore scroll
            const trainId = train._uniqueId;
            const updatedTrain = [...schedule.fixedSchedule, ...schedule.spontaneousEntries].find(t => 
              t._uniqueId === trainId
            );
            if (updatedTrain) {
              renderFocusMode(updatedTrain);
            }
            
            // RESTORE SCROLL POSITION AFTER EVERYTHING
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

    function renderFocusMode(train) {
      const now = new Date();
      
      // If suggestion panel is active for this train, don't re-render
      if (timeSuggestionState.activeTrain && timeSuggestionState.activeTrain._uniqueId === train._uniqueId) {
        return;
      }
      
      // Check if mobile (screen width <= 768px)
      const isMobile = window.innerWidth <= 768;
      const mobilePopup = document.getElementById('mobile-focus-popup');
      
      if (isMobile && mobilePopup) {
        mobileFocusedTrainId = train._uniqueId; // Track mobile focused train
        desktopFocusedTrainId = null; // Clear desktop focus
        renderMobileFocusPopup(train);
        return;
      }
      
      // Desktop mode - simple, clean layout
      desktopFocusedTrainId = train._uniqueId; // Track desktop focused train
      mobileFocusedTrainId = null; // Clear mobile focus
      const panel = document.getElementById('focus-panel');
      const template = document.getElementById('focus-template');
      
      if (!panel || !template) {
        console.error('Missing panel or template!');
        return;
      }
      
      openEditorDrawer();
      hideWorkspacePlaceholder();
      
      // Apply line color to editor drawer border
      const lineColor = getLineColor(train.linie || 'S1');
      panel.style.borderLeft = `4px solid ${lineColor}`;
      panel.style.borderTopLeftRadius = '8px';
      panel.style.borderBottomLeftRadius = '8px';
      
      try {
        // Only allow editing for local schedule trains
        const isEditable = train.source === 'local';
        const isFixedSchedule = train.isFixedSchedule === true;
        
        // Clear panel and clone template
        panel.innerHTML = '';
        const clone = template.content.cloneNode(true);
        
        // Populate Line
        const lineValue = clone.querySelector('[data-focus="line"]');
        lineValue.textContent = train.linie || '';
        lineValue.parentElement.setAttribute('data-value', train.linie || '');
        lineValue.parentElement.setAttribute('data-placeholder', 'S1, S2, ...');
        
        // Populate Destination
        const destinationValue = clone.querySelector('[data-focus="destination"]');
        destinationValue.textContent = train.ziel || '';
        destinationValue.parentElement.setAttribute('data-value', train.ziel || '');
        destinationValue.parentElement.setAttribute('data-placeholder', 'Ziel eingeben');
        
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
        
        // Make date non-editable for fixed schedule trains
        if (isFixedSchedule) {
          dateValue.parentElement.removeAttribute('data-editable');
          dateValue.parentElement.style.cursor = 'default';
          dateValue.parentElement.style.opacity = '0.6';
        }
        
        // Populate Arrival (Plan)
        const arrivalPlanValue = clone.querySelector('[data-focus="arrival-plan"]');
        arrivalPlanValue.textContent = train.plan || 'Keine Zeit';
        arrivalPlanValue.parentElement.setAttribute('data-value', train.plan || '');
        arrivalPlanValue.parentElement.setAttribute('data-placeholder', '14:00');
        
        // Populate Arrival (Actual)
        const arrivalActualValue = clone.querySelector('[data-focus="arrival-actual"]');
        const hasDelay = train.actual && train.actual !== train.plan;
        if (hasDelay) {
          arrivalActualValue.textContent = train.actual;
          arrivalActualValue.parentElement.style.color = 'rgb(255, 200, 100)';
        } else {
          arrivalActualValue.textContent = train.actual || 'Keine Verspätung';
          arrivalActualValue.parentElement.style.opacity = '0.6';
        }
        arrivalActualValue.parentElement.setAttribute('data-value', train.actual || '');
        arrivalActualValue.parentElement.setAttribute('data-placeholder', '14:05');
        
        // Populate Duration
        const durationValue = clone.querySelector('[data-focus="duration"]');
        durationValue.textContent = train.dauer ? `${train.dauer} Min` : 'Keine Dauer';
        durationValue.parentElement.setAttribute('data-value', train.dauer || '0');
        durationValue.parentElement.setAttribute('data-placeholder', '90');
        
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
        
        // Append to panel
        panel.appendChild(clone);
        
        // Store train reference
        panel.dataset.trainId = train._uniqueId;
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
        
      // Helper function to save all field changes and exit edit mode
      const saveAllFields = async () => {
        const editableFields = panel.querySelectorAll('.editor-field');
        let hasChanges = false;
        
        editableFields.forEach(field => {
          const input = field.querySelector('input, textarea');
          if (!input) return;
          
          const fieldName = field.getAttribute('data-field');
          const newValue = input.value;
          const oldValue = field.getAttribute('data-value');
          
          // Only update if value changed
          if (newValue !== oldValue) {
            hasChanges = true;
            
            // Update train object
            if (fieldName === 'date') {
              train.date = newValue;
              const dateObj = new Date(newValue);
              train.weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateObj.getDay()];
            } else if (fieldName === 'dauer') {
              train.dauer = Number(newValue) || 0;
            } else if (fieldName === 'zwischenhalte') {
              train.zwischenhalte = newValue.split('\n').filter(s => s.trim());
            } else if (fieldName === 'actual') {
              train.actual = newValue || undefined;
            } else {
              train[fieldName] = newValue;
            }
          }
        });
        
        // Find the train in schedule
        const trainId = panel.dataset.trainId;
        let scheduleTrain = schedule.fixedSchedule.find(t => t._uniqueId === trainId);
        if (!scheduleTrain) {
          scheduleTrain = schedule.spontaneousEntries.find(t => t._uniqueId === trainId);
        }
        
        if (!scheduleTrain) {
          console.error('Train not found in schedule!');
          return;
        }
        
        // If changes were made, update schedule and save
        if (hasChanges) {
          // Update the schedule train with all changes
          Object.assign(scheduleTrain, train);
          
          // Save to server/localStorage
          await saveSchedule();
          
          // CRITICAL: Re-fetch to rebuild trains/localTrains arrays with updated data
          const freshSchedule = await fetchSchedule();
          
          // Process with the fresh schedule data
          processTrainData(freshSchedule);
          
          // Re-render the train list to show changes
          renderTrains();
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
      };
      
      // ============ LEGACY-STYLE EDIT MECHANISM ============
      
      // Click any field to enter edit mode for ALL fields
      const editableFields = panel.querySelectorAll('[data-editable="true"]');
      editableFields.forEach(field => {
        field.addEventListener('mousedown', function(e) {
          // Check if already in edit mode
          const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
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
            // Skip if already an input
            if (f.querySelector('input, textarea')) return;
            
            const fName = f.getAttribute('data-field');
            const inputType = f.getAttribute('data-input-type');
            const currentValue = f.getAttribute('data-value');
            const placeholder = f.getAttribute('data-placeholder') || '';
            const valueElement = f.querySelector('.editor-field-value');
            
            // Create input
            const input = inputType === 'textarea' 
              ? document.createElement('textarea')
              : document.createElement('input');
            
            if (inputType !== 'textarea') {
              input.type = inputType;
            }
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
                
                // Define tab order
                const tabOrder = ['linie', 'ziel', 'date', 'plan', 'actual', 'dauer', 'zwischenhalte'];
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
                newFocus.tagName === 'INPUT' || 
                newFocus.tagName === 'TEXTAREA'
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
          // Check if we're in edit mode
          const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
          if (!hasInputs) {
            // Not in edit mode, close the drawer
            e.preventDefault();
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
      
      editorDrawerClickOutHandler = (e) => {
        // Check if panel is open and has content
        if (panel && panel.classList.contains('is-open') && panel.innerHTML.trim() !== '') {
          // Check if we're in edit mode
          const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
          
          // Don't close if clicking inside the panel or if in edit mode
          if (!panel.contains(e.target) && !hasInputs) {
            desktopFocusedTrainId = null;
            panel.innerHTML = '';
            closeEditorDrawer();
            // Remove selection from all train entries
            document.querySelectorAll('.train-entry').forEach(entry => entry.classList.remove('selected'));
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
          let scheduleTrain = schedule.fixedSchedule.find(t => t._uniqueId === trainId);
          if (!scheduleTrain) {
            scheduleTrain = schedule.spontaneousEntries.find(t => t._uniqueId === trainId);
          }
          
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
          
          // Debounce only the save operation to prevent multiple rapid saves
          clearTimeout(delayButtonTimeout);
          delayButtonTimeout = setTimeout(async () => {
            await saveSchedule();
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
          let scheduleTrain = schedule.fixedSchedule.find(t => t._uniqueId === trainId);
          let sourceArray = schedule.fixedSchedule;
          if (!scheduleTrain) {
            scheduleTrain = schedule.spontaneousEntries.find(t => t._uniqueId === trainId);
            sourceArray = schedule.spontaneousEntries;
          }
          
          if (!scheduleTrain) {
            console.error('Train not found in schedule!');
            return;
          }
          
          switch (action) {
            case 'cancel':
              // Toggle canceled state
              train.canceled = !train.canceled;
              scheduleTrain.canceled = train.canceled;
              await saveSchedule();
              renderTrains();
              renderFocusMode(scheduleTrain);
              break;
              
            case 'delete':
              // Remove from schedule
              const index = sourceArray.indexOf(scheduleTrain);
              if (index >= 0) {
                sourceArray.splice(index, 1);
              }
              await saveSchedule();
              desktopFocusedTrainId = null;
              panel.innerHTML = '<div style="color: white; padding: 2vh; text-align: center;">Zug gelöscht</div>';
              closeEditorDrawer();
              renderTrains(); // Refresh list
              break;
          }
        });
      }
      
    } catch (error) {
      console.error('Error rendering focus mode:', error);
      panel.innerHTML = '<div style="color: white; padding: 2vh;">Error loading train details.</div>';
    }
  }

    // Mobile-specific focus popup rendering - using PC's exact edit mechanism
    function renderMobileFocusPopup(train) {
      try {
        const now = new Date();
        const popup = document.getElementById('mobile-focus-popup');
        
        if (!popup) {
          console.error('Mobile focus popup not found');
          return;
        }
        
        // Track this as the mobile focused train
        mobileFocusedTrainId = train._uniqueId;
        
        // Only allow editing for local schedule trains
        const isEditable = train.source === 'local';
        const isFixedSchedule = train.isFixedSchedule === true;
        
        // Apply gradient background to content layer based on line color
        const lineColor = getLineColor(train.linie || 'S1');
      const content = popup.querySelector('.mobile-focus-content');
      if (content) {
        content.style.background = `linear-gradient(180deg, ${lineColor}80 0%, ${lineColor}10 20%, #161B75 80%)`;
      }
      if (lineIcon) {
        if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
          lineIcon.src = getTrainSVG(train.linie);
          lineIcon.alt = train.linie;
          lineIcon.onerror = () => {
            const template = document.createElement('template');
            template.innerHTML = Templates.lineBadge(train.linie, isEditable, 'clamp(18px, 5vh, 40px)').trim();
            lineIcon.parentNode.replaceChild(template.content.firstChild, lineIcon);
          };
        } else {
          const template = document.createElement('template');
          template.innerHTML = Templates.lineBadge(train.linie, isEditable, 'clamp(18px, 5vh, 40px)').trim();
          lineIcon.parentNode.replaceChild(template.content.firstChild, lineIcon);
        }
      }

      // Populate destination
      const destination = clone.querySelector('[data-focus="destination"]');
      destination.textContent = train.ziel || '';
      destination.setAttribute('data-field', 'ziel');
      destination.setAttribute('data-value', train.ziel || '');
      destination.setAttribute('data-input-type', 'text');
      destination.setAttribute('data-placeholder', 'Ziel');
      if (isEditable) {
        destination.style.cursor = 'pointer';
        destination.setAttribute('data-editable', 'true');
      }
      if (train.canceled) {
        destination.style.textDecoration = 'line-through';
      }

      // Populate date field (NEW - Tab position 1) - Long format display
      const dateField = clone.querySelector('[data-focus="date"]');
      const trainDate = train.date ? new Date(train.date) : now;
      
      // Format date display
      const dateDisplay = trainDate.toLocaleDateString('de-DE', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      
      dateField.textContent = dateDisplay;
      dateField.setAttribute('data-field', 'date');
      dateField.setAttribute('data-value', train.date || now.toISOString().split('T')[0]);
      dateField.setAttribute('data-input-type', 'date');
      
      // Only make date editable for spontaneous entries
      if (isEditable && !isFixedSchedule) {
        dateField.style.cursor = 'pointer';
        dateField.setAttribute('data-editable', 'true');
      } else {
        dateField.style.cursor = 'default';
      }

      // Populate arrival time OR show "Stellung im Stundenplan" button
      const timeSlot = clone.querySelector('[data-focus="time-slot"]')
        || clone.querySelector('.focus-time-slot');
      const arrivalPlan = clone.querySelector('[data-focus="arrival-plan"]');
      
      // Check if we should show the auto-suggestion button
      const shouldShowSuggestionButton = isEditable && (!train.plan || train.plan.trim() === '') && train.dauer && train.dauer > 0;
      
      if (shouldShowSuggestionButton && timeSlot) {
        // Hide the time fields and show suggestion button
        arrivalPlan.style.display = 'none';
        
        // Create suggestion button
        const suggestionButton = document.createElement('button');
        suggestionButton.className = 'time-suggestion-trigger-btn';
        suggestionButton.textContent = 'Stellung im Stundenplan';
        
        suggestionButton.addEventListener('click', (e) => {
          e.stopPropagation();
          // Pass the actual panel element, not the clone
          const panel = document.getElementById('focus-panel');
          showTimeSuggestionInPanel(train, panel);
        });
        
        timeSlot.appendChild(suggestionButton);
      } else {
        // Normal time display
        arrivalPlan.style.display = 'block';
        arrivalPlan.textContent = train.plan || '';
        arrivalPlan.setAttribute('data-field', 'plan');
        arrivalPlan.setAttribute('data-value', train.plan || '');
        arrivalPlan.setAttribute('data-input-type', 'time');
        if (isEditable) {
          arrivalPlan.style.cursor = 'pointer';
          arrivalPlan.setAttribute('data-editable', 'true');
        }
        if (train.canceled) {
          arrivalPlan.style.textDecoration = 'line-through';
        }
      }

      const arrivalDelayed = clone.querySelector('[data-focus="arrival-delayed"]');
      // Always set up the actual time field as editable, even without delay
      arrivalDelayed.textContent = train.actual || train.plan || '';
      arrivalDelayed.setAttribute('data-field', 'actual');
      arrivalDelayed.setAttribute('data-value', train.actual || '');
      arrivalDelayed.setAttribute('data-input-type', 'time');
      
      const hasDelay = train.actual && train.actual !== train.plan;
      if (hasDelay) {
        arrivalDelayed.style.display = 'block';
        if (train.canceled) {
          arrivalDelayed.style.textDecoration = 'line-through';
        }
      } else if (isEditable) {
        // In edit mode, show it even without delay (it will become input field)
        arrivalDelayed.style.display = 'block';
        arrivalDelayed.style.opacity = '0.5'; // Show faded when no delay
      } else {
        arrivalDelayed.style.display = 'none';
      }
      
      if (isEditable) {
        arrivalDelayed.style.cursor = 'pointer';
        arrivalDelayed.setAttribute('data-editable', 'true');
      }

      // Populate carriage
      const carriage = clone.querySelector('[data-focus="carriage"]');
      carriage.src = getCarriageSVG(train.dauer, train.linie === 'FEX');

      // Populate duration
      const duration = clone.querySelector('[data-focus="duration"]');
      if (train.dauer) {
        duration.textContent = `${train.dauer} Min`;
        if (train.canceled) {
          duration.style.textDecoration = 'line-through';
        }
      } else {
        duration.textContent = '';
      }
      duration.setAttribute('data-field', 'dauer');
      duration.setAttribute('data-value', train.dauer || '0');
      duration.setAttribute('data-input-type', 'number');
      if (isEditable) {
        duration.style.cursor = 'pointer';
        duration.setAttribute('data-editable', 'true');
      }

      // Populate stops - with line breaks
      const stops = clone.querySelector('[data-focus="stops"]');
      
      // Handle both array and string formats for zwischenhalte
      let stopsArray = [];
      
      if (train.zwischenhalte) {
        if (Array.isArray(train.zwischenhalte)) {
          stopsArray = train.zwischenhalte;
        } else if (typeof train.zwischenhalte === 'string') {
          // Split by newline only, preserving empty lines
          stopsArray = train.zwischenhalte.split('\n');
        }
      }
      
      // Normalize train.zwischenhalte to always be an array
      train.zwischenhalte = stopsArray;
      
      if (stopsArray.length > 0) {
        stops.textContent = stopsArray.join('\n');
        stops.setAttribute('data-value', stopsArray.join('\n'));
        stops.style.display = 'block'; // Ensure visible
      } else {
        stops.textContent = '';
        stops.setAttribute('data-value', '');
      }
      
      stops.setAttribute('data-field', 'zwischenhalte');
      stops.setAttribute('data-input-type', 'textarea');
      stops.setAttribute('data-placeholder', 'Zwischenhalte (eine pro Zeile)...');
      if (isEditable) {
        stops.style.cursor = 'pointer';
        stops.setAttribute('data-editable', 'true');
      }

      // Populate departure time and timeline
      const timelines = clone.querySelectorAll('[data-focus="timeline"]').length > 0
        ? clone.querySelectorAll('[data-focus="timeline"]')
        : clone.querySelectorAll('.focus-timeline');
      if (train.plan && train.dauer) {
        const arrivalDate = parseTime(train.plan, now, train.date);
        const depDate = new Date(arrivalDate.getTime() + Number(train.dauer) * 60000);
        const depPlan = formatClock(depDate);

        const departurePlan = clone.querySelector('[data-focus="departure-plan"]');
        departurePlan.textContent = depPlan;
        if (train.canceled) {
          departurePlan.style.textDecoration = 'line-through';
        }

        const departureDelayed = clone.querySelector('[data-focus="departure-delayed"]');
        const hasDepDelay = train.actual && train.actual !== train.plan;
        if (hasDepDelay) {
          const actualArrivalDate = parseTime(train.actual, now, train.date);
          const actualDepDate = new Date(actualArrivalDate.getTime() + Number(train.dauer) * 60000);
          const depActual = formatClock(actualDepDate);

          departureDelayed.textContent = depActual;
          departureDelayed.style.display = 'block';
          if (train.canceled) {
            departureDelayed.style.textDecoration = 'line-through';
          }
        }
      } else {
        // Hide timelines if no departure time
        if (timelines.length > 0) {
          timelines.forEach((timeline) => {
            timeline.style.display = 'none';
          });
        }
      }

      // Append cloned template to panel
      panel.appendChild(clone);

      // Update cancel button based on train state
      const cancelBtn = panel.querySelector('[data-focus-action="cancel"]');
      const deleteBtn = panel.querySelector('[data-focus-action="delete"]');
      if (cancelBtn) {
        if (train.canceled) {
          cancelBtn.classList.add('reactivate');
          cancelBtn.textContent = '✓'; // Green checkmark for reactivate
        } else {
          cancelBtn.classList.remove('reactivate');
          cancelBtn.textContent = '✕'; // Orange X for cancel
        }
      }
      if (deleteBtn) {
        deleteBtn.textContent = 'Löschen'; // Red delete button
      }

      // Store reference to current train for editing using unique ID
      panel.dataset.trainId = train._uniqueId;
      panel.dataset.isEditable = isEditable;

      // Show badge for DB API trains (read-only)
      if (!isEditable && train.source === 'db-api') {
        const template = document.createElement('template');
        template.innerHTML = Templates.dbApiBadge().trim();
        panel.style.position = 'relative';
        panel.appendChild(template.content.firstChild);
      }
      
      // Show badge for fixed schedule trains (date not editable)
      if (isEditable && isFixedSchedule) {
        const template = document.createElement('template');
        template.innerHTML = Templates.fixedScheduleBadge().trim();
        panel.style.position = 'relative';
        panel.appendChild(template.content.firstChild);
      }

      // Only add editing functionality for local trains
      if (!isEditable) {
        return; // Don't add event listeners for non-editable trains
      }

      // Add click-to-edit functionality for editable fields
      const editableFields = panel.querySelectorAll('[data-editable="true"]');
      editableFields.forEach(field => {
        field.addEventListener('mousedown', function(e) {
          // Check if already in edit mode
          const isAlreadyInput = field.querySelector('input, textarea');
          if (isAlreadyInput) {
            return; // Already editing, let click work normally
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
          
          // Convert ALL fields to inputs at once
          makeAllFieldsEditable(train, panel, fieldName);
          
          // Focus and position cursor in the clicked field
          setTimeout(() => {
            const input = field.querySelector('input, textarea');
            if (input) {
              input.focus();
              
              // Set cursor position for text inputs
              if (input.setSelectionRange) {
                try {
                  const safePosition = Math.min(estimatedPosition, input.value.length);
                  input.setSelectionRange(safePosition, safePosition);
                } catch (e) {
                  // For date/time inputs that don't support setSelectionRange
                  if (input.select) input.select();
                }
              } else if (input.select) {
                input.select();
              }
            }
          }, 0);
          
          e.preventDefault(); // Prevent text selection during conversion
        });
      });

      // Add button event listeners
      const buttonsContainer = panel.querySelector('[data-focus="actions"]')
        || panel.querySelector('.focus-buttons');
      if (buttonsContainer) {
        buttonsContainer.addEventListener('click', async (e) => {
          const button = e.target.closest('[data-focus-action]');
          if (!button) return;

          const action = button.dataset.focusAction;
          
          // Find the actual train in schedule using unique ID
          const trainId = panel.dataset.trainId;
          let scheduleTrain = null;
          
          // Try fixedSchedule first (original trains without date property)
          const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === trainId);
          
          if (fixedIndex >= 0) {
            scheduleTrain = schedule.fixedSchedule[fixedIndex];
          } else {
            // Try spontaneousEntries (trains with specific dates)
            const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
            
            if (spontIndex >= 0) {
              scheduleTrain = schedule.spontaneousEntries[spontIndex];
            }
          }
          
          if (!scheduleTrain) {
            alert('Fehler: Zug nicht im Stundenplan gefunden');
            return;
          }
          
          switch(action) {
            case 'cancel':
              train.canceled = !train.canceled;
              scheduleTrain.canceled = train.canceled;
              renderFocusMode(train);
              await saveSchedule(); // Auto-save
              break;
              
            case 'minus5':
              // Subtract 5 minutes from delay (actual time) - can make train earlier than planned
              if (train.plan) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay - 5; // Allow negative (earlier than planned)
                const planDate = parseTime(train.plan, now, train.date);
                const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                train.actual = formatClock(newActualDate);
                scheduleTrain.actual = train.actual;
              }
              renderFocusMode(train);
              await saveSchedule(); // Auto-save
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
              await saveSchedule(); // Auto-save
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
              await saveSchedule(); // Auto-save
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
              await saveSchedule(); // Auto-save
              break;
              
            case 'delete':
              if (confirm(`Zug ${train.linie} nach ${train.ziel} löschen?`)) {
                await deleteTrainFromSchedule(train);
                desktopFocusedTrainId = null; // Clear desktop focus
                panel.innerHTML = Templates.trainDeletedMessage();
                closeEditorDrawer();
              }
              break;
          }
        });
      }

      // Store current train in panel for Shift+S save
      panel.dataset.currentTrain = JSON.stringify(train);
      
      } catch (error) {
        console.error('Error rendering focus mode:', error);
        panel.innerHTML = '<div style="color: white; padding: 2vh;">Error loading train details. Check console.</div>';
      }
    }

    // Mobile-specific focus popup rendering - using PC's exact edit mechanism
    function renderMobileFocusPopup(train) {
      const now = new Date();
      const popup = document.getElementById('mobile-focus-popup');
      
      if (!popup) {
        console.error('Mobile focus popup not found');
        return;
      }
      
      // Track this as the mobile focused train
      mobileFocusedTrainId = train._uniqueId;
      
      // Only allow editing for local schedule trains
      const isEditable = train.source === 'local';
      const isFixedSchedule = train.isFixedSchedule === true;
      
      // Apply gradient background to content layer based on line color
      const lineColor = getLineColor(train.linie || 'S1');
      const content = popup.querySelector('.mobile-focus-content');
      if (content) {
        content.style.background = `linear-gradient(180deg, ${lineColor}80 0%, ${lineColor}10 20%, #161B75 80%)`;
      }
      
      // Show popup with slide-up animation
      popup.style.display = 'flex';
      setTimeout(() => popup.classList.add('show'), 10);
      
      // Populate line icon (non-editable) and description
      const lineIcon = popup.querySelector('[data-mobile-focus="line-icon"]');
      const lineSlot = popup.querySelector('.mobile-line-description-slot');
      
      // Remove any existing description or picker
      const existingDesc = lineSlot.querySelector('.mobile-line-description');
      if (existingDesc) existingDesc.remove();
      const existingPicker = lineSlot.querySelector('.mobile-line-picker-button');
      if (existingPicker) existingPicker.remove();
      
      // Get description presets for S-Bahn lines
      const descriptionPresets = {
        'S1': ' - Pause',
        'S2': ' - Vorbereitung',
        'S3': ' - Kreativität',
        'S4': " - Girls' Night Out",
        'S45': ' - FLURUS',
        'S46': ' - Fachschaftsarbeit',
        'S5': ' - Sport',
        'S6': ' - Lehrveranstaltung',
        'S60': ' - Vortragsübung',
        'S62': ' - Tutorium',
        'S7': ' - Selbststudium',
        'S8': ' - Reise',
        'S85': ' - Reise'
      };
      
      // If no line selected, show picker button
      if (!train.linie || train.linie.trim() === '') {
        lineIcon.style.display = 'none';
        
        // Create picker button from template
        const template = document.createElement('template');
        template.innerHTML = Templates.mobileLinePickerButton().trim();
        const pickerButton = template.content.firstChild;
        
        pickerButton.addEventListener('click', () => {
          showLinePickerDropdown(train, popup);
        });
        
        lineSlot.appendChild(pickerButton);
      } else {
        // Show line icon and description
        if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
          lineIcon.src = getTrainSVG(train.linie);
          lineIcon.alt = train.linie;
          lineIcon.style.display = 'block';
          lineIcon.onerror = () => {
            lineIcon.style.display = 'none';
          };
          
          // Make line icon clickable to change line if editable
          if (isEditable) {
            lineIcon.style.cursor = 'pointer';
            // Clone to remove old event listeners
            const newLineIcon = lineIcon.cloneNode(true);
            lineIcon.parentNode.replaceChild(newLineIcon, lineIcon);
            newLineIcon.addEventListener('click', () => {
              showLinePickerDropdown(train, popup);
            });
          }
        } else {
          lineIcon.style.display = 'none';
        }
        
        // Add description field (editable route info)
        const description = document.createElement('div');
        description.className = 'mobile-line-description';
        
        const defaultDescription = descriptionPresets[train.linie] || '';
        description.textContent = train.beschreibung || defaultDescription;
        description.setAttribute('data-field', 'beschreibung');
        description.setAttribute('data-value', defaultDescription);
        description.setAttribute('data-input-type', 'text');
        description.setAttribute('data-placeholder', 'Linienbeschreibung...');
        
        lineSlot.appendChild(description);
      }
      
      // Populate destination
      const destination = popup.querySelector('[data-mobile-focus=\"destination\"]');
      if (!train.ziel || train.ziel.trim() === '') {
        destination.textContent = 'Ziel eingeben...';
        destination.style.color = 'rgba(255, 255, 255, 0.5)';
      } else {
        destination.textContent = train.ziel;
        destination.style.color = 'white';
      }
      destination.setAttribute('data-field', 'ziel');
      destination.setAttribute('data-value', train.ziel || '');
      destination.setAttribute('data-input-type', 'text');
      destination.setAttribute('data-placeholder', 'Ziel');
      if (isEditable) {
        destination.style.cursor = 'pointer';
        destination.setAttribute('data-editable', 'true');
      }
      if (train.canceled) {
        destination.style.textDecoration = 'line-through';
      } else {
        destination.style.textDecoration = 'none';
      }
      
      // Populate date
      const dateField = popup.querySelector('[data-mobile-focus=\"date\"]');
      const trainDate = train.date ? new Date(train.date) : now;
      dateField.textContent = trainDate.toLocaleDateString('de-DE', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      dateField.setAttribute('data-field', 'date');
      dateField.setAttribute('data-value', train.date || now.toISOString().split('T')[0]);
      dateField.setAttribute('data-input-type', 'date');
      if (isEditable && !isFixedSchedule) {
        dateField.style.cursor = 'pointer';
        dateField.setAttribute('data-editable', 'true');
      } else {
        dateField.style.cursor = 'default';
        dateField.removeAttribute('data-editable');
      }
      
      // Populate times OR show "Stellung im Stundenplan" button
      const arrivalSlot = popup.querySelector('.mobile-arrival-slot');
      const arrivalPlan = popup.querySelector('[data-mobile-focus=\"arrival-plan\"]');
      
      // Check if we should show the auto-suggestion button
      const shouldShowSuggestionButton = isEditable && (!train.plan || train.plan.trim() === '') && train.dauer && train.dauer > 0;
      
      if (shouldShowSuggestionButton) {
        // Clear and show suggestion button
        arrivalSlot.innerHTML = '';
        
        const suggestionButton = document.createElement('button');
        suggestionButton.className = 'time-suggestion-trigger-btn';
        suggestionButton.textContent = 'Stellung im Stundenplan';
        
        suggestionButton.addEventListener('click', (e) => {
          e.stopPropagation();
          showTimeSuggestionInPanel(train, popup);
        });
        
        arrivalSlot.appendChild(suggestionButton);
      } else {
        // Normal time display - make sure structure is correct
        if (!arrivalPlan.parentElement || arrivalPlan.parentElement !== arrivalSlot) {
          arrivalSlot.innerHTML = '';
          arrivalSlot.appendChild(arrivalPlan);
        }
        
        if (!train.plan || train.plan.trim() === '') {
          arrivalPlan.textContent = '--:--';
          arrivalPlan.style.color = 'rgba(255, 255, 255, 0.5)';
        } else {
          arrivalPlan.textContent = train.plan;
          arrivalPlan.style.color = 'white';
        }
      }
      
      arrivalPlan.setAttribute('data-field', 'plan');
      arrivalPlan.setAttribute('data-value', train.plan || '');
      arrivalPlan.setAttribute('data-input-type', 'time');
      if (isEditable) {
        arrivalPlan.style.cursor = 'pointer';
        arrivalPlan.setAttribute('data-editable', 'true');
      }
      if (train.canceled) {
        arrivalPlan.style.textDecoration = 'line-through';
      } else {
        arrivalPlan.style.textDecoration = 'none';
      }
      
      const arrivalDelayed = popup.querySelector('[data-mobile-focus=\"arrival-delayed\"]');
      const hasDelay = train.actual && train.actual !== train.plan && train.plan;
      
      // Show placeholder if no actual time
      if (!train.actual || train.actual.trim() === '') {
        arrivalDelayed.textContent = '--:--';
        arrivalDelayed.style.color = 'rgba(255, 255, 255, 0.5)';
        arrivalDelayed.style.background = 'transparent';
      } else {
        arrivalDelayed.textContent = train.actual;
        arrivalDelayed.style.color = '#161B75';
        arrivalDelayed.style.background = 'white';
        arrivalDelayed.style.padding = '0.2vh 0.5vw';
        arrivalDelayed.style.borderRadius = '2px';
      }
      
      arrivalDelayed.setAttribute('data-field', 'actual');
      arrivalDelayed.setAttribute('data-value', train.actual || '');
      arrivalDelayed.setAttribute('data-input-type', 'time');
      
      if (hasDelay) {
        arrivalDelayed.style.display = 'block';
        arrivalDelayed.style.opacity = '1';
        if (train.canceled) {
          arrivalDelayed.style.textDecoration = 'line-through';
        } else {
          arrivalDelayed.style.textDecoration = 'none';
        }
      } else if (isEditable) {
        arrivalDelayed.style.display = 'block';
        arrivalDelayed.style.opacity = '0.5';
      } else {
        arrivalDelayed.style.display = 'none';
      }
      
      if (isEditable) {
        arrivalDelayed.style.cursor = 'pointer';
        arrivalDelayed.setAttribute('data-editable', 'true');
      }
      
      // Populate carriage and duration - hide if no duration
      const carriage = popup.querySelector('[data-mobile-focus="carriage"]');
      const carriageDurationSlot = popup.querySelector('.mobile-carriage-duration-slot');
      const departureSlot = popup.querySelector('.mobile-departure-slot');
      const timelines = popup.querySelectorAll('.mobile-focus-timeline');
      
      // Always show duration slot, but handle empty/zero case
      const duration = popup.querySelector('[data-mobile-focus="duration"]');
      
      if (train.dauer && train.dauer > 0) {
        // Show carriage, duration, departure time, and timelines
        carriage.src = getCarriageSVG(train.dauer, train.linie === 'FEX');
        if (carriageDurationSlot) carriageDurationSlot.style.display = 'flex';
        if (departureSlot) departureSlot.style.display = 'flex';
        timelines.forEach(tl => tl.style.display = 'block');
        
        duration.textContent = `${train.dauer} Min`;
        duration.style.color = 'white';
        if (train.canceled) {
          duration.style.textDecoration = 'line-through';
        } else {
          duration.style.textDecoration = 'none';
        }
      } else {
        // Show placeholder for duration
        if (carriageDurationSlot) carriageDurationSlot.style.display = 'flex';
        if (departureSlot) departureSlot.style.display = 'none';
        timelines.forEach(tl => tl.style.display = 'none');
        
        duration.textContent = '0 Min';
        duration.style.color = 'rgba(255, 255, 255, 0.5)';
      }
      
      duration.setAttribute('data-field', 'dauer');
      duration.setAttribute('data-value', train.dauer || '0');
      duration.setAttribute('data-input-type', 'number');
      if (isEditable) {
        duration.style.cursor = 'pointer';
        duration.setAttribute('data-editable', 'true');
      }
      
      // Populate departure time only if we have both plan and duration
      if (train.plan && train.dauer && train.dauer > 0) {
        const arrivalDate = parseTime(train.plan, now, train.date);
        const depDate = new Date(arrivalDate.getTime() + Number(train.dauer) * 60000);
        const depPlan = formatClock(depDate);
        
        const departurePlan = popup.querySelector('[data-mobile-focus="departure-plan"]');
        departurePlan.textContent = depPlan;
        if (train.canceled) {
          departurePlan.style.textDecoration = 'line-through';
        } else {
          departurePlan.style.textDecoration = 'none';
        }
        
        const departureDelayed = popup.querySelector('[data-mobile-focus="departure-delayed"]');
        if (hasDelay) {
          const actualArrivalDate = parseTime(train.actual, now, train.date);
          const actualDepDate = new Date(actualArrivalDate.getTime() + Number(train.dauer) * 60000);
          const depActual = formatClock(actualDepDate);
          
          departureDelayed.textContent = depActual;
          departureDelayed.style.display = 'block';
          if (train.canceled) {
            departureDelayed.style.textDecoration = 'line-through';
          } else {
            departureDelayed.style.textDecoration = 'none';
          }
        } else {
          departureDelayed.style.display = 'none';
        }
      }
      
      // Populate stops
      const stops = popup.querySelector('[data-mobile-focus=\"stops\"]');
      let stopsArray = [];
      if (train.zwischenhalte) {
        if (Array.isArray(train.zwischenhalte)) {
          stopsArray = train.zwischenhalte;
        } else if (typeof train.zwischenhalte === 'string') {
          // Handle both literal \n and actual newlines
          stopsArray = train.zwischenhalte.split(/\\n|\n/).filter(s => s.trim());
        }
      }
      if (stopsArray.length === 0) {
        stops.textContent = 'Zwischenhalte eingeben...';
        stops.style.color = 'rgba(255, 255, 255, 0.5)';
      } else {
        stops.textContent = stopsArray.join('\n');
        stops.style.color = 'white';
      }
      stops.setAttribute('data-field', 'zwischenhalte');
      stops.setAttribute('data-value', stopsArray.join('\n'));
      stops.setAttribute('data-input-type', 'textarea');
      stops.setAttribute('data-placeholder', 'Zwischenhalte (eine pro Zeile)...');
      if (isEditable) {
        stops.style.cursor = 'pointer';
        stops.setAttribute('data-editable', 'true');
      }
      
      // Update cancel button
      const cancelBtn = popup.querySelector('[data-mobile-focus-action=\"cancel\"]');
      if (cancelBtn) {
        if (train.canceled) {
          cancelBtn.textContent = '✓';
        } else {
          cancelBtn.textContent = '✕';
        }
      }
      
      // Show badge for DB API trains (read-only) or fixed schedule trains
      const existingBadge = popup.querySelector('.mobile-train-badge');
      if (existingBadge) existingBadge.remove();
      
      if (!isEditable && train.source === 'db-api') {
        const template = document.createElement('template');
        template.innerHTML = Templates.mobileDbApiBadge().trim();
        popup.appendChild(template.content.firstChild);
      } else if (isEditable && isFixedSchedule) {
        const template = document.createElement('template');
        template.innerHTML = Templates.mobileFixedScheduleBadge().trim();
        popup.appendChild(template.content.firstChild);
      }
      
      // Store reference to current train for editing using unique ID
      popup.dataset.trainId = train._uniqueId;
      popup.dataset.isEditable = isEditable;
      popup.dataset.currentTrain = JSON.stringify(train);
      
      // Only add editing functionality for local trains - tap to edit individual fields
      if (isEditable) {
        const editableFields = popup.querySelectorAll('[data-editable=\"true\"]');
        editableFields.forEach(field => {
          // Remove old listeners
          const newField = field.cloneNode(true);
          field.parentNode.replaceChild(newField, field);
        });
        
        // Re-attach tap-to-edit listeners (edit one field at a time - iOS/Android style)
        popup.querySelectorAll('[data-editable=\"true\"]').forEach(field => {
          field.addEventListener('click', function(e) {
            // Check if already in edit mode
            const isAlreadyInput = field.querySelector('input, textarea');
            if (isAlreadyInput) {
              return;
            }
            
            const fieldName = field.getAttribute('data-field');
            const inputType = field.getAttribute('data-input-type');
            const currentValue = field.getAttribute('data-value');
            const placeholder = field.getAttribute('data-placeholder') || '';
            
            // Calculate click position for cursor placement (text inputs only)
            const rect = field.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const fieldWidth = rect.width;
            const text = field.textContent || '';
            const clickRatio = clickX / fieldWidth;
            const estimatedPosition = Math.round(text.length * clickRatio);
            
            // Create input for this field only
            const input = inputType === 'textarea' 
              ? document.createElement('textarea') 
              : document.createElement('input');
            
            if (inputType !== 'textarea') {
              input.type = inputType;
            }
            input.value = currentValue;
            if (placeholder) input.placeholder = placeholder;
            
            // Style the input to match the field
            input.style.background = 'rgba(255, 255, 255, 0.1)';
            input.style.border = 'none';
            input.style.outline = 'none';
            input.style.borderRadius = '2px';
            input.style.color = 'white';
            input.style.fontSize = 'inherit';
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
            
            if (fieldName === 'actual') {
              input.style.color = '#161B75';
              input.style.background = 'white';
              input.style.padding = '1px 2px';
            }
            
            if (inputType === 'textarea') {
              input.style.minHeight = '20vh';
              input.style.whiteSpace = 'pre-wrap';
              input.style.padding = '2vh 5vw';
            }
            
            if (fieldName === 'linie') {
              input.style.fontWeight = 'bold';
              input.style.textAlign = 'center';
              input.style.width = 'auto';
              input.style.maxWidth = '15vw';
            }
            
            if (fieldName === 'dauer') {
              input.style.fontSize = '2.5vh';
              const wrapper = document.createElement('div');
              wrapper.style.display = 'flex';
              wrapper.style.alignItems = 'center';
              wrapper.style.gap = '1vw';
              wrapper.appendChild(input);
              const minLabel = document.createElement('span');
              minLabel.textContent = 'Min';
              minLabel.style.color = 'rgba(255, 255, 255, 0.7)';
              minLabel.style.fontSize = '2vh';
              wrapper.appendChild(minLabel);
              field.innerHTML = '';
              field.appendChild(wrapper);
            } else {
              field.innerHTML = '';
              field.appendChild(input);
            }
            
            // Save function using PC's update logic
            const updateValue = async (value) => {
              const trainId = popup.dataset.trainId;
              let scheduleTrain = null;
              
              const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === trainId);
              if (fixedIndex >= 0) {
                scheduleTrain = schedule.fixedSchedule[fixedIndex];
              } else {
                const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
                if (spontIndex >= 0) {
                  scheduleTrain = schedule.spontaneousEntries[spontIndex];
                }
              }
              
              if (!scheduleTrain) {
                console.error('❌ Could not find train in schedule!');
                return;
              }
              
              // Update values using PC logic
              if (fieldName === 'date') {
                const isFixedSchedule = scheduleTrain.weekday && !scheduleTrain.date;
                if (!isFixedSchedule) {
                  train.date = value;
                  const dateObj = new Date(train.date);
                  const newWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateObj.getDay()];
                  train.weekday = newWeekday;
                  scheduleTrain.date = value;
                  scheduleTrain.weekday = newWeekday;
                }
              } else if (fieldName === 'dauer') {
                train.dauer = Number(value) || 0;
                scheduleTrain.dauer = Number(value) || 0;
              } else if (fieldName === 'zwischenhalte') {
                train.zwischenhalte = value.split('\n').filter(s => s.trim());
                scheduleTrain.zwischenhalte = value.split('\n').filter(s => s.trim());
              } else if (fieldName === 'actual') {
                train.actual = value || undefined;
                scheduleTrain.actual = value || undefined;
              } else {
                train[fieldName] = value;
                scheduleTrain[fieldName] = value;
              }
              
              popup.dataset.currentTrain = JSON.stringify(train);
              
              // Save and re-render with the updated train from dataset
              await saveSchedule();
              const updatedTrain = JSON.parse(popup.dataset.currentTrain);
              renderMobileFocusPopup(updatedTrain);
            };
            
            // Auto-save on blur (when input loses focus)
            let isSaving = false;
            let isRemoved = false;
            
            const saveValue = async () => {
              if (isSaving || isRemoved) return; // Prevent double-save
              isSaving = true;
              
              // Check if we're still in the same popup and the input exists
              if (!input.parentNode) {
                isRemoved = true;
                return; // Input was already removed
              }
              
              try {
                await updateValue(input.value);
                isRemoved = true;
              } catch (error) {
                console.error('Error saving field:', error);
                isSaving = false;
              }
            };
            
            input.addEventListener('blur', async () => {
              // Small timeout to allow other events to process first
              setTimeout(saveValue, 100);
            });
            
            // For time/date inputs: save immediately when user confirms selection
            if (inputType === 'time' || inputType === 'date') {
              input.addEventListener('change', async () => {
                if (!isSaving && !isRemoved) {
                  await saveValue();
                }
              });
            }
            
            // Also listen for clicks outside the input field
            const handleOutsideClick = async (e) => {
              if (!input.contains(e.target) && input.parentNode && !isSaving && !isRemoved) {
                // Clicked outside, save and remove listener
                await saveValue();
                document.removeEventListener('click', handleOutsideClick, true);
              }
            };
            
            // Add listener with slight delay to avoid triggering on the click that created the input
            setTimeout(() => {
              document.addEventListener('click', handleOutsideClick, true);
            }, 200);
            
            // Handle Enter key
            input.addEventListener('keydown', async (e) => {
              if (inputType === 'textarea' && e.key === 'Enter' && !e.ctrlKey) {
                return; // Allow newlines in textarea
              }
              
              if (e.key === 'Enter') {
                e.preventDefault();
                await updateValue(input.value);
              } else if (e.key === 'Escape') {
                renderMobileFocusPopup(train);
              }
            });
            
            // Focus and position cursor
            setTimeout(() => {
              input.focus();
              
              if (inputType === 'text' && input.setSelectionRange) {
                try {
                  const safePosition = Math.min(estimatedPosition, input.value.length);
                  input.setSelectionRange(safePosition, safePosition);
                } catch (e) {
                  if (input.select) input.select();
                }
              } else if (input.setSelectionRange) {
                try {
                  input.setSelectionRange(input.value.length, input.value.length);
                } catch (e) {
                  if (input.select) input.select();
                }
              } else if (input.select) {
                input.select();
              }
              
              // Show picker for date/time inputs
              if ((inputType === 'date' || inputType === 'time') && input.showPicker) {
                input.showPicker();
              }
            }, 0);
            
            e.preventDefault();
          });
        });
      }
      
      // Add button event listeners
      const buttons = popup.querySelectorAll('[data-mobile-focus-action]');
      buttons.forEach(button => {
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);
      });
      
      popup.querySelectorAll('[data-mobile-focus-action]').forEach(button => {
        button.addEventListener('click', async (e) => {
          const action = button.dataset.mobileFocusAction;
          
          const trainId = train._uniqueId;
          let scheduleTrain = null;
          
          const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === trainId);
          if (fixedIndex >= 0) {
            scheduleTrain = schedule.fixedSchedule[fixedIndex];
          } else {
            const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
            if (spontIndex >= 0) {
              scheduleTrain = schedule.spontaneousEntries[spontIndex];
            }
          }
          
          if (!scheduleTrain && action !== 'return' && action !== 'delete') {
            alert('Fehler: Zug nicht im Stundenplan gefunden');
            return;
          }
          
          // Helper function to schedule debounced save and rerender
          const scheduleDebouncedUpdate = (updatedTrain) => {
            // Clear existing timer
            if (mobileEditDebounceTimer) {
              clearTimeout(mobileEditDebounceTimer);
            }
            
            // Mark that we have a pending save
            pendingMobileSave = true;
            
            // Immediately update the display
            renderMobileFocusPopup(updatedTrain);
            
            // Schedule the actual save after 800ms of no input
            mobileEditDebounceTimer = setTimeout(async () => {
              if (pendingMobileSave) {
                await saveSchedule();
                pendingMobileSave = false;
                console.log('Mobile edit auto-saved');
              }
            }, 800);
          };
          
          switch(action) {
            case 'return':
              // If there's a pending save, execute it immediately before closing
              if (pendingMobileSave && mobileEditDebounceTimer) {
                clearTimeout(mobileEditDebounceTimer);
                await saveSchedule();
                pendingMobileSave = false;
              }
              mobileFocusedTrainId = null; // Clear mobile focus
              popup.classList.remove('show');
              setTimeout(() => popup.style.display = 'none', 300);
              break;
              
            case 'cancel':
              if (scheduleTrain) {
                train.canceled = !train.canceled;
                scheduleTrain.canceled = train.canceled;
                scheduleDebouncedUpdate(train);
              }
              break;
              
            case 'minus5':
              if (train.plan && scheduleTrain) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay - 5;
                const planDate = parseTime(train.plan, now, train.date);
                const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                train.actual = formatClock(newActualDate);
                scheduleTrain.actual = train.actual;
                scheduleDebouncedUpdate(train);
              }
              break;
              
            case 'plus5':
            case 'plus10':
            case 'plus30':
              if (train.plan && scheduleTrain) {
                const minutes = action === 'plus5' ? 5 : (action === 'plus10' ? 10 : 30);
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay + minutes;
                const planDate = parseTime(train.plan, now, train.date);
                const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                train.actual = formatClock(newActualDate);
                scheduleTrain.actual = train.actual;
                scheduleDebouncedUpdate(train);
              }
              break;
              
            case 'delete':
              if (confirm(`Zug ${train.linie} nach ${train.ziel} löschen?`)) {
                // Cancel any pending saves
                if (mobileEditDebounceTimer) {
                  clearTimeout(mobileEditDebounceTimer);
                  pendingMobileSave = false;
                }
                await deleteTrainFromSchedule(train);
                mobileFocusedTrainId = null; // Clear mobile focus
                popup.classList.remove('show');
                setTimeout(() => popup.style.display = 'none', 300);
              }
              break;
          }
        });
      });
      
      // Handle system back button
      const handleBackButton = (e) => {
        if (popup.classList.contains('show')) {
          e.preventDefault();
          mobileFocusedTrainId = null; // Clear mobile focus
          popup.classList.remove('show');
          setTimeout(() => popup.style.display = 'none', 300);
          window.removeEventListener('popstate', handleBackButton);
        }
      };
      
      window.history.pushState({ popup: 'mobile-focus' }, '');
      window.addEventListener('popstate', handleBackButton);
      
      // Close popup when clicking outside content
      const handleOutsideClick = (e) => {
        if (e.target === popup) {
          mobileFocusedTrainId = null; // Clear mobile focus
          popup.classList.remove('show');
          setTimeout(() => popup.style.display = 'none', 300);
          popup.removeEventListener('click', handleOutsideClick);
          window.removeEventListener('popstate', handleBackButton);
        }
      };
      popup.addEventListener('click', handleOutsideClick);
    }
    
    // Mobile version of makeAllFieldsEditable (adapted from PC version)
    function makeAllFieldsEditableMobile(train, panel, focusFieldName) {
      const editableFields = panel.querySelectorAll('[data-editable=\"true\"]');
      const inputs = {};
      
      const tabOrder = ['date', 'linie', 'ziel', 'zwischenhalte', 'plan', 'dauer', 'actual'];
      
      const updateValue = (field, value) => {
        const trainId = panel.dataset.trainId;
        let scheduleTrain = null;
        
        const fixedIndex = schedule.fixedSchedule.findIndex(t => t._uniqueId === trainId);
        if (fixedIndex >= 0) {
          scheduleTrain = schedule.fixedSchedule[fixedIndex];
        } else {
          const spontIndex = schedule.spontaneousEntries.findIndex(t => t._uniqueId === trainId);
          if (spontIndex >= 0) {
            scheduleTrain = schedule.spontaneousEntries[spontIndex];
          }
        }
        
        if (!scheduleTrain) {
          console.error('❌ Could not find train in schedule!');
        }
        
        if (field === 'date') {
          const isFixedSchedule = scheduleTrain && scheduleTrain.weekday && !scheduleTrain.date;
          if (!isFixedSchedule) {
            train.date = value;
            const dateObj = new Date(train.date);
            const newWeekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateObj.getDay()];
            train.weekday = newWeekday;
            if (scheduleTrain) {
              scheduleTrain.date = value;
              scheduleTrain.weekday = newWeekday;
            }
          }
        } else if (field === 'dauer') {
          train.dauer = Number(value) || 0;
          if (scheduleTrain) scheduleTrain.dauer = Number(value) || 0;
        } else if (field === 'zwischenhalte') {
          train.zwischenhalte = value.split('\\n');
          if (scheduleTrain) scheduleTrain.zwischenhalte = value.split('\\n');
        } else if (field === 'actual') {
          train.actual = value || undefined;
          if (scheduleTrain) scheduleTrain.actual = value || undefined;
        } else {
          train[field] = value;
          if (scheduleTrain) scheduleTrain[field] = value;
        }
        
        panel.dataset.currentTrain = JSON.stringify(train);
      };
      
      const isFixedScheduleTrain = train.isFixedSchedule === true;
      
      editableFields.forEach(field => {
        const fieldName = field.getAttribute('data-field');
        const inputType = field.getAttribute('data-input-type');
        const currentValue = field.getAttribute('data-value');
        const placeholder = field.getAttribute('data-placeholder') || '';
        
        if (fieldName === 'date' && isFixedScheduleTrain) {
          return;
        }
        
        const input = inputType === 'textarea' 
          ? document.createElement('textarea') 
          : document.createElement('input');
        
        if (inputType !== 'textarea') {
          input.type = inputType;
        }
        input.value = currentValue;
        if (placeholder) input.placeholder = placeholder;
        
        input.style.background = 'rgba(255, 255, 255, 0.1)';
        input.style.border = 'none';
        input.style.outline = 'none';
        input.style.borderRadius = '2px';
        input.style.color = 'white';
        input.style.fontSize = 'inherit';
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
        
        if (fieldName === 'actual') {
          input.style.color = '#161B75';
          input.style.background = 'white';
          input.style.padding = '1px 2px';
        }
        
        if (inputType === 'textarea') {
          input.style.minHeight = '20vh';
          input.style.whiteSpace = 'pre-wrap';
          input.style.padding = '2vh 5vw';
        }
        
        if (fieldName === 'linie') {
          input.style.fontWeight = 'bold';
          input.style.textAlign = 'center';
          input.style.width = 'auto';
          input.style.maxWidth = '15vw';
        }
        
        if (fieldName === 'dauer') {
          input.style.fontSize = '2.5vh';
          const wrapper = document.createElement('div');
          wrapper.style.display = 'flex';
          wrapper.style.alignItems = 'center';
          wrapper.style.gap = '1vw';
          wrapper.appendChild(input);
          const minLabel = document.createElement('span');
          minLabel.textContent = 'Min';
          minLabel.style.color = 'rgba(255, 255, 255, 0.7)';
          minLabel.style.fontSize = '2vh';
          wrapper.appendChild(minLabel);
          field.innerHTML = '';
          field.appendChild(wrapper);
        } else {
          field.innerHTML = '';
          field.appendChild(input);
        }
        
        field.removeAttribute('data-editable');
        field.removeAttribute('data-value');
        
        inputs[fieldName] = input;
        
        input.addEventListener('focus', () => {
          isEditingTrain = true;
        });
        
        input.addEventListener('change', () => updateValue(fieldName, input.value));
        input.addEventListener('input', () => updateValue(fieldName, input.value));
        
        input.addEventListener('keydown', (e) => {
          if (inputType === 'textarea' && e.key === 'Enter' && !e.ctrlKey) {
            return;
          }
          
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            updateValue(fieldName, input.value);
            
            if (e.key === 'Tab') {
              const currentIndex = tabOrder.indexOf(fieldName);
              let nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
              
              if (nextIndex >= tabOrder.length) nextIndex = 0;
              if (nextIndex < 0) nextIndex = tabOrder.length - 1;
              
              const nextFieldName = tabOrder[nextIndex];
              const nextInput = inputs[nextFieldName];
              if (nextInput) {
                nextInput.focus();
                if (nextInput.setSelectionRange && nextInput.type === 'text') {
                  nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
                }
              }
            } else if (e.key === 'Enter') {
              renderMobileFocusPopup(train);
            }
          } else if (e.key === 'Escape') {
            renderMobileFocusPopup(train);
          }
        });
      });
      
      let blurTimeout;
      const handleBlur = () => {
        clearTimeout(blurTimeout);
        blurTimeout = setTimeout(async () => {
          const newFocus = document.activeElement;
          const isStillInInputs = newFocus && (
            newFocus.tagName === 'INPUT' || 
            newFocus.tagName === 'TEXTAREA'
          );
          
          if (!isStillInInputs) {
            isEditingTrain = false;
            
            // Clear existing debounce timer
            if (mobileEditDebounceTimer) {
              clearTimeout(mobileEditDebounceTimer);
            }
            
            // Mark that we have a pending save
            pendingMobileSave = true;
            
            // Schedule the actual save after 800ms of no input
            mobileEditDebounceTimer = setTimeout(async () => {
              if (pendingMobileSave) {
                const trainListEl = document.getElementById('train-list');
                const savedScroll = trainListEl ? trainListEl.scrollTop : 0;
                
                await saveSchedule();
                processTrainData(schedule);
                renderTrains();
                
                const trainId = train._uniqueId;
                const updatedTrain = [...schedule.fixedSchedule, ...schedule.spontaneousEntries].find(t => 
                  t._uniqueId === trainId
                );
                if (updatedTrain) {
                  renderMobileFocusPopup(updatedTrain);
                }
                
                setTimeout(() => {
                  if (trainListEl && savedScroll > 0) {
                    trainListEl.scrollTop = savedScroll;
                  }
                }, 100);
                
                pendingMobileSave = false;
                console.log('Mobile field edit auto-saved');
              }
            }, 800);
          }
        }, 50);
      };
      
      Object.values(inputs).forEach(input => {
        input.addEventListener('blur', handleBlur);
      });
    }

    async function saveSchedule() {
      try {
        // Auto-fill any empty actual times with plan times before saving
        const autoFillActual = (train) => {
          if (train.plan && !train.actual) {
            train.actual = train.plan;
          }
          return train;
        };
        
        schedule.fixedSchedule.forEach(autoFillActual);
        schedule.spontaneousEntries.forEach(autoFillActual);
        schedule.trains.forEach(autoFillActual);
        
        // Filter: Only save trains that have a line number
        // AND ensure proper data format: fixed schedules have weekday only, spontaneous have date only
        const dataToSave = {
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
              // Spontaneous: keep date, can have weekday for reference but ensure date is primary
              const { source, ...cleanTrain } = t;
              return cleanTrain;
            }),
          trains: schedule.trains
            .filter(t => t.linie && t.linie.trim() !== '')
            .map(t => {
              const { source, ...cleanTrain } = t;
              return cleanTrain;
            })
        };
        
        console.log('💾 Saving schedule:', {
          fixedSchedule: dataToSave.fixedSchedule.length,
          spontaneousEntries: dataToSave.spontaneousEntries.length,
          trains: dataToSave.trains.length
        });
        
        const res = await fetch('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dataToSave)
        });

        if (!res.ok) throw new Error('Failed to save schedule');

        // Server will broadcast update event via SSE, which will trigger auto re-render

      } catch (error) {
        console.error('Error saving schedule:', error);
        alert('Fehler beim Speichern: ' + error.message);
      }
    }

    // Delete train from schedule
    async function deleteTrainFromSchedule(train) {
      try {
        // Fetch current schedule
        const res = await fetch('/api/schedule');
        if (!res.ok) throw new Error('Failed to fetch schedule');
        const schedule = await res.json();

        // Remove from fixed schedule
        if (schedule.fixedSchedule) {
          schedule.fixedSchedule = schedule.fixedSchedule.filter(t => 
            !(t.linie === train.linie && t.plan === train.plan && t.weekday === train.weekday)
          );
        }

        // Remove from spontaneous entries
        if (schedule.spontaneousEntries) {
          schedule.spontaneousEntries = schedule.spontaneousEntries.filter(t => 
            !(t.linie === train.linie && t.plan === train.plan && t.date === train.date)
          );
        }

        // Remove from legacy trains
        if (schedule.trains) {
          schedule.trains = schedule.trains.filter(t => 
            !(t.linie === train.linie && t.plan === train.plan && t.date === train.date)
          );
        }

        // Save back to server
        const saveRes = await fetch('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(schedule)
        });

        if (!saveRes.ok) throw new Error('Failed to save schedule');

        // Refresh the display
        const newSchedule = await fetchSchedule();
        processTrainData(newSchedule);
        renderTrains(); // Use unified render function
        renderComprehensiveAnnouncementPanel();

      } catch (error) {
        console.error('Error deleting train:', error);
        alert('Fehler beim Löschen: ' + error.message);
      }
    }

    // Comprehensive announcements panel pagination state
    let comprehensiveAnnouncementCurrentPage = 0;
    let comprehensiveAnnouncementInterval = null;
    
    // Pinned trains state (array for multiple pins)
    let pinnedTrains = [];

    // Render comprehensive announcement panel with all announcement types
    function renderComprehensiveAnnouncementPanel() {
      const now = new Date();
      const panel = document.getElementById('announcement-panel'); // MOVED to bottom panel
      const template = document.getElementById('announcement-template');
      
      if (!template) {
        console.error('Announcement template not found');
        return;
      }

      const allAnnouncements = [];
      
      // 0. PRIORITY: Pinned trains (if any exist) - sorted by time
      if (pinnedTrains && pinnedTrains.length > 0) {
        const sortedPinnedTrains = [...pinnedTrains].sort((a, b) => {
          const aTime = parseTime(a.actual || a.plan, now, a.date);
          const bTime = parseTime(b.actual || b.plan, now, b.date);
          if (!aTime && !bTime) return 0;
          if (!aTime) return 1;
          if (!bTime) return -1;
          return aTime - bTime;
        });
        
        sortedPinnedTrains.forEach(train => {
          allAnnouncements.push({ ...train, announcementType: 'pinned' });
        });
      }

      // Helper function to check if a train is today
      const todayDateStr = now.toLocaleDateString('sv-SE'); // YYYY-MM-DD format
      const isToday = (train) => {
        if (!train.date) return false;
        const trainDateStr = train.date.split('T')[0]; // Handle ISO format
        return trainDateStr === todayDateStr;
      };

      // 1. Ankündigung: Notes without departure time (from processed data) - persist forever, no date filter
      const noteTrains = processedTrainData.noteTrains
        .map(t => ({ ...t, announcementType: 'note' }));
      allAnnouncements.push(...noteTrains);

      // 2. Use processed future trains for other announcement types - filter to today only
      const futureTrains = processedTrainData.futureTrains.filter(isToday);

      // 3. Zug fällt aus: Upcoming cancelled trains
      const cancelledTrains = futureTrains
        .filter(t => t.canceled)
        .map(t => ({ ...t, announcementType: 'cancelled' }));
      allAnnouncements.push(...cancelledTrains);

      // 4. Verspätung: Upcoming trains that are late (delay > 0)
      const delayedTrains = futureTrains
        .filter(t => !t.canceled && t.actual && t.actual !== t.plan)
        .filter(t => {
          const delay = getDelay(t.plan, t.actual, now, t.date);
          return delay > 0;
        })
        .map(t => ({ ...t, announcementType: 'delayed' }));
      allAnnouncements.push(...delayedTrains);

      // 5. Zusatzfahrt: Trains with [ZF] prefix in destination
      const zusatzfahrtTrains = futureTrains
        .filter(t => !t.canceled && t.ziel && t.ziel.trim().startsWith('[ZF]'))
        .map(t => ({ ...t, announcementType: 'zusatzfahrt' }));
      allAnnouncements.push(...zusatzfahrtTrains);

      console.log('Zusatzfahrt debug:', {
        futureTrainsCount: futureTrains.length,
        trainsWithZiel: futureTrains.filter(t => t.ziel).length,
        trainsWithZF: futureTrains.filter(t => t.ziel && t.ziel.includes('[ZF]')).map(t => ({ linie: t.linie, ziel: t.ziel })),
        zusatzfahrtCount: zusatzfahrtTrains.length
      });

      // 6. Ersatzfahrt: Trains that overlap with cancelled trains
      const cancelledTrainsList = futureTrains.filter(t => t.canceled);
      
      const ersatzfahrtTrains = futureTrains.filter(activeTrain => {
        if (activeTrain.canceled) return false;
        
        const activeStart = parseTime(activeTrain.actual || activeTrain.plan, now, activeTrain.date);
        const activeEnd = getOccupancyEnd(activeTrain, now);
        if (!activeStart || !activeEnd) return false;

        // Check if this train overlaps with any cancelled train
        return cancelledTrainsList.some(cancelledTrain => {
          const cancelledStart = parseTime(cancelledTrain.plan, now, cancelledTrain.date);
          const cancelledDauer = Number(cancelledTrain.dauer);
          if (!cancelledStart || !cancelledDauer || isNaN(cancelledDauer)) return false;
          
          const cancelledEnd = new Date(cancelledStart.getTime() + cancelledDauer * 60000);
          
          // Check for overlap
          return (activeStart < cancelledEnd && activeEnd > cancelledStart);
        });
      }).map(t => ({ ...t, announcementType: 'ersatzfahrt' }));
      allAnnouncements.push(...ersatzfahrtTrains);

      console.log('Ersatzfahrt debug:', {
        cancelledCount: cancelledTrainsList.length,
        activeTrainsCount: futureTrains.filter(t => !t.canceled).length,
        ersatzfahrtCount: ersatzfahrtTrains.length,
        ersatzfahrtTrains: ersatzfahrtTrains.map(t => ({ linie: t.linie, ziel: t.ziel, plan: t.plan }))
      });

      // 7. Konflikt: Active trains that overlap with each other (not cancelled) - CHECK ALL FUTURE, NOT JUST TODAY
      const allActiveTrains = processedTrainData.futureTrains.filter(t => !t.canceled);
      const konfliktTrains = [];
      
      console.log('🔍 Konflikt check - Active trains:', allActiveTrains.map(t => ({ 
        linie: t.linie, 
        plan: t.plan, 
        date: t.date, 
        dauer: t.dauer,
        source: t.source 
      })));
      
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
            
            // Check for overlap
            if (start1 < end2 && end1 > start2) {
              // Determine conflict type:
            // - 'complete': train2 is completely within train1's duration (start2 >= start1 && end2 <= end1)
            // - 'nested': trains partially overlap
            const isComplete = start2 >= start1 && end2 <= end1;
            const conflictType = isComplete ? 'complete' : 'nested';

            // Add conflict announcement (train1 is the main train, train2 is the conflicting train)
            konfliktTrains.push({
              ...train1,
              announcementType: 'konflikt',
              conflictWith: train2,
              conflictType: conflictType
            });
          }
        }
      }
      allAnnouncements.push(...konfliktTrains);

      // Sort all announcements chronologically
      // Pinned trains ALWAYS come first (maintain their sorted order)
      // Notes without times go second, then everything else by departure time
      allAnnouncements.sort((a, b) => {
        // Pinned trains always come first
        const aIsPinned = a.announcementType === 'pinned';
        const bIsPinned = b.announcementType === 'pinned';
        
        if (aIsPinned && !bIsPinned) return -1;
        if (!aIsPinned && bIsPinned) return 1;
        if (aIsPinned && bIsPinned) {
          // Both pinned, sort by time
          const aTime = parseTime(a.actual || a.plan, now, a.date);
          const bTime = parseTime(b.actual || b.plan, now, b.date);
          if (!aTime && !bTime) return 0;
          if (!aTime) return 1;
          if (!bTime) return -1;
          return aTime - bTime;
        }
        
        // Notes without plan time come next (after pinned)
        const aHasTime = a.plan && a.plan.trim() !== '';
        const bHasTime = b.plan && b.plan.trim() !== '';
        
        if (!aHasTime && bHasTime) return -1;
        if (aHasTime && !bHasTime) return 1;
        if (!aHasTime && !bHasTime) return 0;
        
        // Both have times, sort chronologically
        const aTime = parseTime(a.actual || a.plan, now, a.date);
        const bTime = parseTime(b.actual || b.plan, now, b.date);
        return aTime - bTime;
      });

      console.log('Comprehensive announcements:', {
        notes: noteTrains.length,
        cancelled: cancelledTrains.length,
        delayed: delayedTrains.length,
        zusatzfahrt: zusatzfahrtTrains.length,
        ersatzfahrt: ersatzfahrtTrains.length,
        konflikt: konfliktTrains.length,
        total: allAnnouncements.length
      });
      console.log('All announcements sorted:', allAnnouncements.map(t => ({
        type: t.announcementType,
        linie: t.linie,
        ziel: t.ziel,
        plan: t.plan,
        actual: t.actual
      })));

      if (allAnnouncements.length === 0) {
        panel.innerHTML = Templates.noAnnouncementsMessage();
        if (comprehensiveAnnouncementInterval) {
          clearInterval(comprehensiveAnnouncementInterval);
          comprehensiveAnnouncementInterval = null;
        }
        return;
      }

      // Show all announcements in a single scroll - no pagination
      const pageAnnouncements = allAnnouncements;

      panel.innerHTML = '';

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width: 100%; height: 100%; background: #161B75; position: relative;';

      const container = document.createElement('div');
      container.className = 'announcement-content-wrapper';
      container.style.cssText = 'width: 100%; height: 100%; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 8px; padding: 12px; overflow-y: auto; box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none;';
      
      // Hide scrollbar using CSS
      const style = document.createElement('style');
      style.textContent = '.announcement-content-wrapper::-webkit-scrollbar { display: none; }';
      if (!document.querySelector('style[data-announcement-scrollbar]')) {
        style.setAttribute('data-announcement-scrollbar', 'true');
        document.head.appendChild(style);
      }

      pageAnnouncements.forEach(train => {
        // Use konflikt template for konflikt announcements
        if (train.announcementType === 'konflikt') {
          const konfliktTemplate = document.getElementById('konflikt-template');
          if (!konfliktTemplate) {
            console.error('Konflikt template not found');
            return;
          }
          const clone = konfliktTemplate.content.cloneNode(true);
          const now = new Date();
          const conflictTrain = train.conflictWith;

          // Main train icon
          const mainIcon = clone.querySelector('[data-konflikt="main-icon"]');
          if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
            mainIcon.src = getTrainSVG(train.linie);
            mainIcon.alt = train.linie;
            mainIcon.onerror = () => {
              const template = document.createElement('template');
              template.innerHTML = Templates.lineBadge(train.linie, false, 'clamp(12px, 3vh, 24px)').trim();
              if (mainIcon.parentNode) {
                mainIcon.parentNode.replaceChild(template.content.firstChild, mainIcon);
              }
            };
          } else {
            const template = document.createElement('template');
            template.innerHTML = Templates.lineBadge(train.linie, false, 'clamp(12px, 3vh, 24px)').trim();
            mainIcon.parentNode.replaceChild(template.content.firstChild, mainIcon);
          }

          // Main train destination and stops
          clone.querySelector('[data-konflikt="main-destination"]').textContent = train.ziel || '';
          clone.querySelector('[data-konflikt="main-stops"]').innerHTML = formatStopsWithDate(train);

          // Conflict train icon
          const conflictIcon = clone.querySelector('[data-konflikt="conflict-icon"]');
          if (typeof conflictTrain.linie === 'string' && (/^S\d+/i.test(conflictTrain.linie) || conflictTrain.linie === 'FEX' || /^\d+$/.test(conflictTrain.linie))) {
            conflictIcon.src = getTrainSVG(conflictTrain.linie);
            conflictIcon.alt = conflictTrain.linie;
            conflictIcon.onerror = () => {
              const template = document.createElement('template');
              template.innerHTML = Templates.lineBadge(conflictTrain.linie, false, 'clamp(12px, 3vh, 24px)').trim();
              if (conflictIcon.parentNode) {
                conflictIcon.parentNode.replaceChild(template.content.firstChild, conflictIcon);
              }
            };
          } else {
            const template = document.createElement('template');
            template.innerHTML = Templates.lineBadge(conflictTrain.linie, false, 'clamp(12px, 3vh, 24px)').trim();
            conflictIcon.parentNode.replaceChild(template.content.firstChild, conflictIcon);
          }

          // Conflict train destination and stops
          clone.querySelector('[data-konflikt="conflict-destination"]').textContent = conflictTrain.ziel || '';
          clone.querySelector('[data-konflikt="conflict-stops"]').innerHTML = formatStopsWithDate(conflictTrain);

          // Configure blocks and time slots based on conflict type
          const conflictBlock = clone.querySelector('[data-konflikt="conflict-block"]');
          const mainBlock3 = clone.querySelector('[data-konflikt="main-block-3"]');
          const time2Slot = clone.querySelector('[data-konflikt="time-2"]');
          const time3Slot = clone.querySelector('[data-konflikt="time-3"]');
          const time4Slot = clone.querySelector('[data-konflikt="time-4"]');

          if (train.conflictType === 'complete') {
            // Train in train: conflict train completely within main train
            conflictBlock.classList.add('konflikt-block-middle');
            
            // Time 2: Conflict arrival (red)
            time2Slot.classList.add('konflikt-color');
            
            // Time 3: Conflict end (red)
            time3Slot.classList.add('konflikt-color');
          } else {
            // Nested: classic overlap
            conflictBlock.classList.add('konflikt-block-nested');
            mainBlock3.classList.remove('konflikt-main-block');
            mainBlock3.classList.add('konflikt-main-half-block');
            
            // Time 2: Conflict arrival (red)
            time2Slot.classList.add('konflikt-color');
            
            // Time 4: Conflict end (red)
            time4Slot.classList.add('konflikt-color');
          }

          // Time 1: Main train departure
          clone.querySelector('[data-konflikt="time-1-plan"]').textContent = train.plan || '';
          const time1Delayed = clone.querySelector('[data-konflikt="time-1-delayed"]');
          if (train.actual && train.actual !== train.plan) {
            time1Delayed.textContent = train.actual;
            time1Delayed.style.display = 'block';
          }

          // Time 2: Conflict train arrival (always red)
          clone.querySelector('[data-konflikt="time-2-plan"]').textContent = conflictTrain.plan || '';
          const time2Delayed = clone.querySelector('[data-konflikt="time-2-delayed"]');
          if (conflictTrain.actual && conflictTrain.actual !== conflictTrain.plan) {
            time2Delayed.textContent = conflictTrain.actual;
            time2Delayed.style.display = 'block';
          }

          // Time 3 & 4 depend on conflict type
          if (train.conflictType === 'complete') {
            // Train in train:
            // Time 3: Conflict end (red)
            const conflictEndTime = getOccupancyEnd(conflictTrain, now);
            if (conflictEndTime) {
              const hours = String(conflictEndTime.getHours()).padStart(2, '0');
              const minutes = String(conflictEndTime.getMinutes()).padStart(2, '0');
              clone.querySelector('[data-konflikt="time-3-plan"]').textContent = `${hours}:${minutes}`;
            }
            const time3Delayed = clone.querySelector('[data-konflikt="time-3-delayed"]');
            if (conflictTrain.actual && conflictTrain.actual !== conflictTrain.plan && conflictTrain.dauer) {
              const actualEnd = new Date(parseTime(conflictTrain.actual, now, conflictTrain.date).getTime() + Number(conflictTrain.dauer) * 60000);
              const hours = String(actualEnd.getHours()).padStart(2, '0');
              const minutes = String(actualEnd.getMinutes()).padStart(2, '0');
              time3Delayed.textContent = `${hours}:${minutes}`;
              time3Delayed.style.display = 'block';
              time3Delayed.classList.add('delayed-konflikt');
            }
            
            // Time 4: Main train end
            const mainEndTime = getOccupancyEnd(train, now);
            if (mainEndTime) {
              const hours = String(mainEndTime.getHours()).padStart(2, '0');
              const minutes = String(mainEndTime.getMinutes()).padStart(2, '0');
              clone.querySelector('[data-konflikt="time-4-plan"]').textContent = `${hours}:${minutes}`;
            }
            const time4Delayed = clone.querySelector('[data-konflikt="time-4-delayed"]');
            if (train.actual && train.actual !== train.plan && train.dauer) {
              const actualEnd = new Date(parseTime(train.actual, now, train.date).getTime() + Number(train.dauer) * 60000);
              const hours = String(actualEnd.getHours()).padStart(2, '0');
              const minutes = String(actualEnd.getMinutes()).padStart(2, '0');
              time4Delayed.textContent = `${hours}:${minutes}`;
              time4Delayed.style.display = 'block';
              time4Delayed.classList.add('delayed-main');
            }
          } else {
            // Nested:
            // Time 3: Main train end
            const mainEndTime = getOccupancyEnd(train, now);
            if (mainEndTime) {
              const hours = String(mainEndTime.getHours()).padStart(2, '0');
              const minutes = String(mainEndTime.getMinutes()).padStart(2, '0');
              clone.querySelector('[data-konflikt="time-3-plan"]').textContent = `${hours}:${minutes}`;
            }
            const time3Delayed = clone.querySelector('[data-konflikt="time-3-delayed"]');
            if (train.actual && train.actual !== train.plan && train.dauer) {
              const actualEnd = new Date(parseTime(train.actual, now, train.date).getTime() + Number(train.dauer) * 60000);
              const hours = String(actualEnd.getHours()).padStart(2, '0');
              const minutes = String(actualEnd.getMinutes()).padStart(2, '0');
              time3Delayed.textContent = `${hours}:${minutes}`;
              time3Delayed.style.display = 'block';
              time3Delayed.classList.add('delayed-main');
            }
            
            // Time 4: Conflict end (red)
            const conflictEndTime = getOccupancyEnd(conflictTrain, now);
            if (conflictEndTime) {
              const hours = String(conflictEndTime.getHours()).padStart(2, '0');
              const minutes = String(conflictEndTime.getMinutes()).padStart(2, '0');
              clone.querySelector('[data-konflikt="time-4-plan"]').textContent = `${hours}:${minutes}`;
            }
            const time4Delayed = clone.querySelector('[data-konflikt="time-4-delayed"]');
            if (conflictTrain.actual && conflictTrain.actual !== conflictTrain.plan && conflictTrain.dauer) {
              const actualEnd = new Date(parseTime(conflictTrain.actual, now, conflictTrain.date).getTime() + Number(conflictTrain.dauer) * 60000);
              const hours = String(actualEnd.getHours()).padStart(2, '0');
              const minutes = String(actualEnd.getMinutes()).padStart(2, '0');
              time4Delayed.textContent = `${hours}:${minutes}`;
              time4Delayed.style.display = 'block';
              time4Delayed.classList.add('delayed-konflikt');
            }
          }

          // Add resolve button click handler
          const resolveButton = clone.querySelector('[data-konflikt="resolve-button"]');
          if (resolveButton) {
            resolveButton.addEventListener('click', () => {
              // 1. Bring conflicting train to focus mode
              renderFocusMode(conflictTrain);
              
              // 2. Scroll train list to the conflicting train's position
              const trainListEl = document.getElementById('train-list');
              
              // Try both list view (.train-entry) and occupancy view (.belegungsplan-train-block)
              let conflictElement = null;
              
              // Check for occupancy view blocks first
              const allBlocks = Array.from(trainListEl.querySelectorAll('.belegungsplan-train-block'));
              conflictElement = allBlocks.find(block => {
                return block.dataset.uniqueId === conflictTrain._uniqueId;
              });
              
              // If not found, check for list view entries
              if (!conflictElement) {
                const allEntries = Array.from(trainListEl.querySelectorAll('.train-entry'));
                conflictElement = allEntries.find(entry => {
                  return entry.dataset.uniqueId === conflictTrain._uniqueId;
                });
              }
              
              if (conflictElement) {
                // Scroll the train list to show this element
                const elementTop = conflictElement.offsetTop;
                const listHeight = trainListEl.clientHeight;
                const elementHeight = conflictElement.offsetHeight;
                
                // Center the element in the viewport
                const scrollTo = elementTop - (listHeight / 2) + (elementHeight / 2);
                trainListEl.scrollTo({
                  top: scrollTo,
                  behavior: 'smooth'
                });
                
                // Highlight the element briefly
                conflictElement.classList.add('selected');
                setTimeout(() => {
                  conflictElement.classList.remove('selected');
                }, 2000);
              }
            });
          }

          container.appendChild(clone);
          return;
        }

        // Regular announcement rendering
        const clone = template.content.cloneNode(true);

        // Set headline based on announcement type
        const headline = clone.querySelector('[data-announcement="headline"]');
        if (train.announcementType === 'pinned') {
          // Pinned train: classic blue background, no text, with unpin button
          headline.className = 'announcement-headline pinned';
          headline.innerHTML = '<button class="unpin-button">✕</button>';
          
          // Add unpin functionality
          const unpinButton = headline.querySelector('.unpin-button');
          unpinButton.addEventListener('click', (e) => {
            e.stopPropagation();
            unpinTrain(train._uniqueId);
          });
        } else if (train.announcementType === 'note') {
          headline.className = 'announcement-headline announce';
          headline.textContent = ' ⓘ Ankündigung ';
        } else if (train.announcementType === 'cancelled') {
          headline.className = 'announcement-headline cancelled';
          headline.textContent = ' ✕ Zug fällt aus ';
        } else if (train.announcementType === 'ersatzfahrt') {
          headline.className = 'announcement-headline ersatzfahrt';
          headline.textContent = ' ⇄ Ersatzfahrt ';
        } else if (train.announcementType === 'zusatzfahrt') {
          headline.className = 'announcement-headline announce';
          headline.textContent = ' ⓘ Zusatzfahrt ';
        } else if (train.announcementType === 'delayed') {
          headline.className = 'announcement-headline late';
          headline.textContent = ' ⚠︎ Verspätung ';
        }
        
        // Apply classic blue background to pinned train container using CSS class
        if (train.announcementType === 'pinned') {
          const announcementContainer = clone.querySelector('.announcement-container');
          announcementContainer.classList.add('pinned-train');
        }

        // Hide or show line icon and type
        const lineIconTypeGroup = clone.querySelector('.announcement-group-icon-type');
        if (train.announcementType === 'note') {
          lineIconTypeGroup.style.display = 'none';
        } else {
          const lineIcon = clone.querySelector('[data-announcement="line-icon"]');
          if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
            lineIcon.src = getTrainSVG(train.linie);
            lineIcon.alt = train.linie;
            lineIcon.onerror = () => {
              const template = document.createElement('template');
              template.innerHTML = Templates.lineBadge(train.linie, false, 'clamp(18px, 5vh, 40px)').trim();
              if (lineIcon.parentNode) {
                lineIcon.parentNode.replaceChild(template.content.firstChild, lineIcon);
              }
            };
          } else {
            const template = document.createElement('template');
            template.innerHTML = Templates.lineBadge(train.linie, false, 'clamp(18px, 5vh, 40px)').trim();
            lineIcon.parentNode.replaceChild(template.content.firstChild, lineIcon);
          }
        }

        // Populate times
        const timeSlot = clone.querySelector('.announcement-time-slot');
        if (train.announcementType === 'note') {
          timeSlot.style.display = 'none';
        } else {
          const planEl = clone.querySelector('[data-announcement="plan"]');
          if (train.canceled || train.announcementType === 'cancelled') {
            planEl.innerHTML = Templates.strikethrough(train.plan || '');
          } else {
            planEl.textContent = train.plan || '';
          }

          const delayedEl = clone.querySelector('[data-announcement="delayed"]');
          if (train.actual && train.actual !== train.plan) {
            if (train.canceled || train.announcementType === 'cancelled') {
              delayedEl.innerHTML = Templates.strikethrough(train.actual);
            } else {
              delayedEl.textContent = train.actual;
            }
            delayedEl.style.display = 'block';
          }
        }

        // Populate destination
        const destination = clone.querySelector('[data-announcement="destination"]');
        let destinationText = train.ziel || '';
        if (train.announcementType === 'zusatzfahrt' || train.announcementType === 'ersatzfahrt') {
          destinationText = destinationText.replace(/^\[ZF\]\s*/, '');
        }
        
        if (train.canceled || train.announcementType === 'cancelled') {
          destination.innerHTML = Templates.strikethrough(destinationText);
        } else {
          destination.textContent = destinationText;
        }

        // Populate content
        const content = clone.querySelector('[data-announcement="content"]');
        content.innerHTML = formatStopsWithDate(train);

        // Add click-to-edit functionality for local trains or click-to-view for pinned
        const announcementPanel = clone.querySelector('.announcement-panel');
        if (train.announcementType === 'pinned') {
          announcementPanel.style.cursor = 'pointer';
          announcementPanel.addEventListener('click', (e) => {
            // Don't trigger if clicking the unpin button
            if (!e.target.closest('.unpin-button')) {
              renderFocusMode(train);
            }
          });
        } else if (train.source === 'local' && train.announcementType === 'note') {
          announcementPanel.style.cursor = 'pointer';
          announcementPanel.addEventListener('click', () => {
            renderFocusMode(train);
          });
        }

        container.appendChild(clone);
      });

      wrapper.appendChild(container);
      
      panel.appendChild(wrapper);

      // Clear any existing interval (no pagination needed)
      if (comprehensiveAnnouncementInterval) {
        clearInterval(comprehensiveAnnouncementInterval);
        comprehensiveAnnouncementInterval = null;
      }
    }

    /**
     * Pin the currently focused train to announcements
     */
    function pinCurrentTrain() {
      // Check if there's a focused train
      const focusedTrainId = desktopFocusedTrainId || mobileFocusedTrainId;
      if (!focusedTrainId) {
        console.log('No train focused, cannot pin');
        return;
      }
      
      // Find the train in processed data
      const train = processedTrainData.scheduledTrains.find(t => t._uniqueId === focusedTrainId);
      if (!train) {
        console.log('Focused train not found');
        return;
      }
      
      // Check if focus panel is in edit mode (has input/textarea elements)
      const focusPanel = document.getElementById('focus-panel');
      if (focusPanel && (focusPanel.querySelector('input') || focusPanel.querySelector('textarea'))) {
        console.log('Focus panel is in edit mode, cannot pin');
        return;
      }
      
      // Check if already pinned
      if (pinnedTrains.some(t => t._uniqueId === train._uniqueId)) {
        console.log('Train already pinned');
        return;
      }
      
      // Pin the train (create a copy to avoid mutation)
      const pinnedCopy = { ...train };
      pinnedTrains.push(pinnedCopy);
      console.log('Train pinned:', pinnedCopy);
      
      // Save to localStorage
      savePinnedTrains();
      
      // Re-render announcement panel to show pinned train
      renderComprehensiveAnnouncementPanel();
    }
    
    /**
     * Unpin a specific train by ID
     */
    function unpinTrain(trainId) {
      pinnedTrains = pinnedTrains.filter(t => t._uniqueId !== trainId);
      console.log('Train unpinned:', trainId);
      
      // Save to localStorage
      savePinnedTrains();
      
      // Re-render announcement panel
      renderComprehensiveAnnouncementPanel();
    }
    
    /**
     * Save pinned trains to localStorage
     */
    function savePinnedTrains() {
      try {
        localStorage.setItem('pinnedTrains', JSON.stringify(pinnedTrains));
      } catch (error) {
        console.error('Error saving pinned trains:', error);
      }
    }
    
    /**
     * Load pinned trains from localStorage
     */
    function loadPinnedTrains() {
      try {
        const saved = localStorage.getItem('pinnedTrains');
        if (saved) {
          pinnedTrains = JSON.parse(saved);
          console.log('Loaded pinned trains:', pinnedTrains);
        }
      } catch (error) {
        console.error('Error loading pinned trains:', error);
        pinnedTrains = [];
      }
    }
    
    /**
     * Sync pinned trains with current schedule data
     * Updates pinned trains with latest data from processedTrainData
     */
    function syncPinnedTrains() {
      if (!pinnedTrains || pinnedTrains.length === 0) return;
      
      const updated = [];
      pinnedTrains.forEach(pinnedTrain => {
        // Find the current version of this train in processed data
        const currentTrain = processedTrainData.scheduledTrains.find(
          t => t._uniqueId === pinnedTrain._uniqueId
        );
        
        if (currentTrain) {
          // Update with current data
          updated.push({ ...currentTrain });
        } else {
          // Train no longer exists, keep the old data but mark it
          updated.push(pinnedTrain);
        }
      });
      
      pinnedTrains = updated;
      savePinnedTrains();
    }

    // Render announcement panel with cancelled trains
    // Update clock
    function updateClock() {
      const now = new Date();
      document.getElementById('clock').textContent = formatClock(now);
      const min = now.getMinutes();
      const hour = now.getHours() % 12;

      const minDeg = min *6;
      const hourDeg = hour * 30 + min*0.5;

      document.getElementById("minute").style.transform = `translateX(-50%) rotate(${minDeg}deg)`;
      document.getElementById("hour").style.transform = `translateX(-50%) rotate(${hourDeg}deg)`;

      // Update headline train countdown every second
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

    // Load saved station BEFORE initial load
    (function loadSavedStation() {
      const savedEva = localStorage.getItem('selectedEva');
      const savedName = localStorage.getItem('selectedStationName');
      if (savedEva && savedName) {
        currentEva = savedEva;
        currentStationName = savedName;
        console.log(`Loaded saved station: ${savedName} (EVA: ${savedEva})`);
      }
      
      // Load saved view mode
      const savedViewMode = localStorage.getItem('viewMode');
      if (savedViewMode === 'list' || savedViewMode === 'belegungsplan') {
        currentViewMode = savedViewMode;
      }
    })();

    // Initial load
    (async () => {
      const scheduleData = await fetchSchedule();
      processTrainData(scheduleData);
      renderTrains(); // Use unified render function
      renderComprehensiveAnnouncementPanel(); // Debug: render to upper right panel
      updateClock();

      const defaultMode = currentViewMode === 'belegungsplan' ? 'occupancy' : 'list';
      setWorkspaceMode(defaultMode);
      
      // Add train button event listener (after DOM is ready)
      const addTrainBtn = document.getElementById('add-train-button');
      if (addTrainBtn) {
        addTrainBtn.addEventListener('click', () => {
          createNewTrainEntry();
        });
      }

      // Station selection button event listener
      const stationSelectBtn = document.getElementById('station-select-button');
      if (stationSelectBtn) {
        stationSelectBtn.addEventListener('click', () => {
          showStationOverlay();
        });
      }

      // Toggle view button event listener
      const toggleViewBtn = document.getElementById('toggle-view-button');
      if (toggleViewBtn) {
        toggleViewBtn.addEventListener('click', () => {
          toggleViewMode();
        });
      }

      const listViewBtn = document.getElementById('list-view-button');
      if (listViewBtn) {
        listViewBtn.addEventListener('click', () => {
          setWorkspaceMode('list');
        });
      }

      const occupancyViewBtn = document.getElementById('occupancy-view-button');
      if (occupancyViewBtn) {
        occupancyViewBtn.addEventListener('click', () => {
          setWorkspaceMode('occupancy');
        });
      }
      
      // Pin train button event listener
      const pinTrainBtn = document.getElementById('pin-train-button');
      if (pinTrainBtn) {
        pinTrainBtn.addEventListener('click', () => {
          pinCurrentTrain();
        });
      }
      
      // Announcements button event listener
      const announcementsBtn = document.getElementById('announcements-button');
      if (announcementsBtn) {
        console.log('✅ Announcements button found, adding event listener');
        announcementsBtn.addEventListener('click', () => {
          console.log('📢 Announcements button clicked');
          const isMobile = window.innerWidth <= 768;
          if (isMobile) {
            // Toggle announcements view (mobile)
            if (isAnnouncementsView) {
              isAnnouncementsView = false;
              renderTrains(); // Go back to normal train list
            } else {
              isAnnouncementsView = true;
              showAnnouncementsView();
            }
          } else {
            setWorkspaceMode('announcements');
          }
        });
      } else {
        console.log('❌ Announcements button not found');
      }

      const navModeButtons = document.querySelectorAll('.task-icon-button.nav-only[data-mode]');
      navModeButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const mode = button.dataset.mode;
          if (mode) {
            setWorkspaceMode(mode);
          }
        });
      });

      const modeDrawer = document.getElementById('mode-drawer');
      const modeDrawerToggle = document.getElementById('mode-drawer-toggle');
      const modeDrawerClose = document.getElementById('mode-drawer-close');
      const modeDrawerScrim = document.getElementById('mode-drawer-scrim');

      const closeModeDrawer = () => {
        if (modeDrawer) {
          modeDrawer.classList.remove('is-open');
          modeDrawer.setAttribute('aria-hidden', 'true');
        }
        if (modeDrawerScrim) {
          modeDrawerScrim.classList.remove('is-active');
          modeDrawerScrim.setAttribute('aria-hidden', 'true');
        }
      };

      if (modeDrawerToggle) {
        modeDrawerToggle.addEventListener('click', () => {
          if (modeDrawer) {
            modeDrawer.classList.add('is-open');
            modeDrawer.setAttribute('aria-hidden', 'false');
          }
          if (modeDrawerScrim) {
            modeDrawerScrim.classList.add('is-active');
            modeDrawerScrim.setAttribute('aria-hidden', 'false');
          }
        });
      }

      if (modeDrawerClose) {
        modeDrawerClose.addEventListener('click', closeModeDrawer);
      }

      if (modeDrawerScrim) {
        modeDrawerScrim.addEventListener('click', closeModeDrawer);
      }

      if (modeDrawer) {
        modeDrawer.querySelectorAll('.mode-drawer-item').forEach((button) => {
          button.addEventListener('click', () => {
            const mode = button.dataset.mode;
            if (mode) {
              setWorkspaceMode(mode);
            }
            closeModeDrawer();
          });
        });
      }
      
      // Update date display based on scroll position (mobile only)
      const trainListEl = document.getElementById('train-list');
      const dateDisplay = document.getElementById('date-display');
      if (trainListEl && dateDisplay && window.innerWidth <= 768) {
        trainListEl.addEventListener('scroll', () => {
          // Find first visible train entry
          const trainEntries = trainListEl.querySelectorAll('.train-entry, .belegungsplan-train-block');
          const scrollTop = trainListEl.scrollTop;
          const listTop = trainListEl.getBoundingClientRect().top;
          
          for (const entry of trainEntries) {
            const entryTop = entry.getBoundingClientRect().top - listTop;
            if (entryTop >= 0) {
              // This is the first visible train
              const trainDate = entry.dataset.date;
              if (trainDate) {
                const date = new Date(trainDate);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                date.setHours(0, 0, 0, 0);
                
                const dayDiff = Math.round((date - today) / (24 * 60 * 60 * 1000));
                
                let dateText = 'Heute';
                if (dayDiff === 1) {
                  dateText = 'Morgen';
                } else if (dayDiff === -1) {
                  dateText = 'Gestern';
                } else if (dayDiff !== 0) {
                  dateText = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
                }
                
                dateDisplay.textContent = dateText;
              }
              break;
            }
          }
        });
      }
      
      // Date selector event listener (mobile only)
      const dateSelector = document.getElementById('date-selector');
      if (dateSelector && window.innerWidth <= 768) {
        dateSelector.addEventListener('click', () => {
          const input = document.createElement('input');
          input.type = 'date';
          input.value = new Date().toISOString().split('T')[0];
          input.style.position = 'absolute';
          input.style.opacity = '0';
          input.style.pointerEvents = 'none';
          
          input.addEventListener('change', () => {
            const selectedDate = new Date(input.value);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            selectedDate.setHours(0, 0, 0, 0);
            
            const dayDiff = Math.round((selectedDate - today) / (24 * 60 * 60 * 1000));
            
            let dateText = 'Heute';
            if (dayDiff === 1) {
              dateText = 'Morgen';
            } else if (dayDiff === -1) {
              dateText = 'Gestern';
            } else if (dayDiff !== 0) {
              dateText = selectedDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
            }
            
            document.getElementById('date-display').textContent = dateText;
            
            // Scroll to first train of selected date
            const trainListEl = document.getElementById('train-list');
            if (trainListEl) {
              const targetDateStr = input.value;
              const trainEntries = trainListEl.querySelectorAll('.train-entry');
              
              for (let i = 0; i < trainEntries.length; i++) {
                const entry = trainEntries[i];
                const trainDate = entry.dataset.trainDate;
                
                if (trainDate === targetDateStr) {
                  // Found first train of this date - scroll to it
                  const entryTop = entry.offsetTop;
                  trainListEl.scrollTop = entryTop;
                  break;
                }
              }
            }
            
            document.body.removeChild(input);
          });
          
          input.addEventListener('blur', () => {
            if (document.body.contains(input)) {
              document.body.removeChild(input);
            }
          });
          
          document.body.appendChild(input);
          input.focus();
          if (input.showPicker) input.showPicker();
        });
      }
    })();

    // Update clock every second
    setInterval(() => {
      updateClock();
    }, 1000);

    // Update departure times every 5 seconds
    setInterval(() => {
      const now = new Date();
      document.querySelectorAll('[data-departure]').forEach(el => {
        // Skip headline train - it's updated by updateClock()
        if (el.dataset.isHeadline === 'true') {
          return;
        }
        
        const plan = el.dataset.plan || null;
        const actual = el.dataset.actual || null;
        const dauer = el.dataset.dauer ? Number(el.dataset.dauer) : 0;
        const trainDate = el.dataset.date || null;
        const canceled = el.dataset.canceled === 'true';
        const delay = canceled ? 0 : getDelay(plan, actual, now, trainDate);
        el.innerHTML = '';
        el.appendChild(formatDeparture(plan, actual, now, delay, dauer, trainDate));
      });

      // Update status indicators
      document.querySelectorAll('.indicator-dot').forEach((dot) => {
        const entry = dot.closest('.train-entry');
        const departure = entry.querySelector('[data-departure]');
        const plan = departure.dataset.plan || null;
        const actual = departure.dataset.actual || null;
        const trainDate = departure.dataset.date || null;
        const canceled = departure.dataset.canceled === 'true';
        const dauer = departure.dataset.dauer ? Number(departure.dataset.dauer) : 0;
        
        // Clear all classes
        dot.classList.remove('current', 'cancelled');
        
        if (canceled) {
          // Show X for cancelled trains
          dot.classList.add('cancelled');
        } else {
          // Check if train is currently occupying
          const actualTime = parseTime(actual || plan, now, trainDate);
          if (actualTime && dauer > 0) {
            const occEnd = new Date(actualTime.getTime() + dauer * 60000);
            if (actualTime <= now && occEnd > now) {
              // Current train - show solid dot
              dot.classList.add('current');
            }
          }
        }
      });
    }, 5000);

    // Function to start/stop refresh interval based on mode
    function updateRefreshInterval() {
      // Clear existing interval
      if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
      }
      
      // Only set up interval if in DB API mode (station selected)
      if (currentEva) {
        console.log('Starting auto-refresh interval (DB API mode)');
        refreshIntervalId = setInterval(async () => {
          if (isEditingTrain) {
            console.log('Skipping refresh - train is being edited');
            return;
          }
          const schedule = await fetchSchedule();
          processTrainData(schedule);
          renderTrains();
          renderComprehensiveAnnouncementPanel();
          checkTrainArrivals(); // Check for trains arriving in 15 minutes
        }, 60000);
      } else {
        console.log('Auto-refresh interval disabled (local mode - using SSE only)');
      }
    }
    
    // Initial setup - no interval in local mode
    updateRefreshInterval();

    // Set up Server-Sent Events for real-time updates
    const eventSource = new EventSource('/events');
    
    eventSource.addEventListener('update', async (event) => {
      console.log('🔄 SSE update received at', new Date().toISOString());
      
      // Skip refresh if editing
      if (isEditingTrain) {
        console.log('Skipping SSE refresh - train is being edited');
        return;
      }
      
      // Fetch and update the GLOBAL schedule object
      const freshSchedule = await fetchSchedule();
      processTrainData(freshSchedule);
      renderTrains(); // Use unified render function
      renderComprehensiveAnnouncementPanel();
      checkTrainArrivals(); // Check for trains arriving in 15 minutes
      
      // Re-render the appropriate focused train based on which one is set
      const isMobile = window.innerWidth <= 768;
      
      if (isMobile && mobileFocusedTrainId) {
        // Mobile mode - only re-render if mobile popup is actually open
        const popup = document.getElementById('mobile-focus-popup');
        if (popup && popup.classList.contains('show')) {
          const updatedTrain = processedTrainData.allTrains.find(t => 
            t._uniqueId === mobileFocusedTrainId
          );
          
          if (updatedTrain) {
            renderMobileFocusPopup(updatedTrain);
          } else {
            // Train was deleted, close the popup
            mobileFocusedTrainId = null;
            popup.classList.remove('show');
            setTimeout(() => popup.style.display = 'none', 300);
          }
        }
      } else if (!isMobile && desktopFocusedTrainId) {
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
    });
    
    eventSource.addEventListener('error', (error) => {
      console.warn('SSE connection error:', error);
      // Connection will automatically reconnect
    });
    
    console.log('✅ Connected to server for real-time updates');

    // Station selection overlay functionality
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
        
        // Stop auto-refresh for local mode (SSE handles updates)
        updateRefreshInterval();
        
        (async () => {
          const schedule = await fetchSchedule();
          processTrainData(schedule);
          renderTrains(); // Use unified render function
          renderComprehensiveAnnouncementPanel();
          updateClock();
        })();
      }

      function chooseLive(station) {
        currentEva = station.eva;
        currentStationName = station.name;
        localStorage.setItem('selectedEva', currentEva);
        localStorage.setItem('selectedStationName', currentStationName);
        overlay.classList.add('hidden');
        
        // Start auto-refresh for DB API mode
        updateRefreshInterval();
        
        (async () => {
          const schedule = await fetchSchedule();
          processTrainData(schedule);
          renderTrains(); // Use unified render function
          renderComprehensiveAnnouncementPanel();
          updateClock();
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
        }
      });

      // Close on background click (clicking outside the sidebar)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
        }
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape to exit focus mode
      if (e.key === 'Escape') {
        const focusPanel = document.getElementById('focus-panel');
        if (focusPanel && focusPanel.innerHTML.trim() !== '') {
          e.preventDefault();
          desktopFocusedTrainId = null; // Clear desktop focus
          focusPanel.innerHTML = '';
          closeEditorDrawer();
          // Remove selection from all train entries
          document.querySelectorAll('.train-entry').forEach(entry => entry.classList.remove('selected'));
        }
      }
      
      // Left/Right arrow keys to change announcement page - but NOT when editing or in date/time input
      const activeElement = document.activeElement;
      const isInDateTimeInput = activeElement && 
        (activeElement.tagName === 'INPUT') && 
        (activeElement.type === 'date' || activeElement.type === 'time');
      
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isEditingTrain && !isInDateTimeInput) {
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
          if (!train.date) return false;
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
    async function saveFocusPanelTrain() {
      // Save entire schedule (like InputEnhanced)
      await saveSchedule();
    }


    // Function to create a new blank train entry
    // Show line picker dropdown for selecting S-Bahn lines
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
          
          // Re-render popup
          renderMobileFocusPopup(train);
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

    function createNewTrainEntry() {
      // Create a blank train object with current date but NO auto-filled time
      const now = new Date();
      const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD format
      const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
      
      const newTrain = {
        linie: '',
        ziel: '',
        plan: '',  // Empty - user must fill
        actual: undefined,
        dauer: 0,
        zwischenhalte: [],
        canceled: false,
        date: currentDate,
        weekday: weekday,
        source: 'local',
        _uniqueId: 'train_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now()
      };
      
      // Add to spontaneousEntries (like InputEnhanced does)
      schedule.spontaneousEntries.push(newTrain);
      
      // Render in focus mode (will auto-detect mobile/desktop)
      renderFocusMode(newTrain);
      
      // Auto-open line picker for mobile, auto-click for desktop
      setTimeout(() => {
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
          const popup = document.getElementById('mobile-focus-popup');
          if (popup) {
            showLinePickerDropdown(newTrain, popup);
          }
        } else {
          const lineField = document.querySelector('[data-field="linie"]');
          if (lineField) lineField.click();
        }
      }, 100);
    }

    // Show announcements view in mobile mode
    function showAnnouncementsView() {
      console.log('🎯 showAnnouncementsView called');
      const now = new Date();
      
      // Get all announcements using the same logic as renderComprehensiveAnnouncementPanel
      const allAnnouncements = [];
      
      console.log('📊 processedTrainData:', processedTrainData);
      
      const todayDateStr = now.toLocaleDateString('sv-SE');
      const isToday = (train) => {
        if (!train.date) return false;
        const trainDateStr = train.date.split('T')[0];
        return trainDateStr === todayDateStr;
      };
      
      // 0. PRIORITY: Pinned trains (if any exist) - sorted by time
      if (pinnedTrains && pinnedTrains.length > 0) {
        const sortedPinnedTrains = [...pinnedTrains].sort((a, b) => {
          const aTime = parseTime(a.actual || a.plan, now, a.date);
          const bTime = parseTime(b.actual || b.plan, now, b.date);
          if (!aTime && !bTime) return 0;
          if (!aTime) return 1;
          if (!bTime) return -1;
          return aTime - bTime;
        });
        
        sortedPinnedTrains.forEach(train => {
          allAnnouncements.push({ ...train, announcementType: 'pinned' });
        });
      }
      
      // 1. Notes without departure time - ALWAYS FIRST, sorted by their own order
      const noteTrains = processedTrainData.noteTrains
        .map(t => ({ ...t, announcementType: 'note' }));
      
      // 2. Future trains for other types
      const futureTrains = processedTrainData.futureTrains.filter(isToday);
      
      // 3. Cancelled trains
      const cancelledTrains = futureTrains
        .filter(t => t.canceled)
        .map(t => ({ ...t, announcementType: 'cancelled' }));
      
      // 4. Delayed trains
      const delayedTrains = futureTrains
        .filter(t => !t.canceled && t.actual && t.actual !== t.plan)
        .filter(t => {
          const delay = getDelay(t.plan, t.actual, now, t.date);
          return delay > 0;
        })
        .map(t => ({ ...t, announcementType: 'delayed' }));
      
      // 5. Zusatzfahrt
      const zusatzfahrtTrains = futureTrains
        .filter(t => !t.canceled && t.ziel && t.ziel.trim().startsWith('[ZF]'))
        .map(t => ({ ...t, announcementType: 'zusatzfahrt' }));
      
      // 6. Ersatzfahrt
      const cancelledTrainsList = futureTrains.filter(t => t.canceled);
      const ersatzfahrtTrains = futureTrains.filter(activeTrain => {
        if (activeTrain.canceled) return false;
        const activeStart = parseTime(activeTrain.actual || activeTrain.plan, now, activeTrain.date);
        const activeDur = Number(activeTrain.dauer) || 0;
        if (!activeStart || activeDur <= 0) return false;
        const activeEnd = new Date(activeStart.getTime() + activeDur * 60000);
        
        return cancelledTrainsList.some(cancelledTrain => {
          const cancelledStart = parseTime(cancelledTrain.plan, now, cancelledTrain.date);
          const cancelledDur = Number(cancelledTrain.dauer) || 0;
          if (!cancelledStart || cancelledDur <= 0) return false;
          const cancelledEnd = new Date(cancelledStart.getTime() + cancelledDur * 60000);
          return activeStart < cancelledEnd && activeEnd > cancelledStart;
        });
      }).map(t => ({ ...t, announcementType: 'ersatzfahrt' }));
      
      // 7. Konflikt
      const allActiveTrains = processedTrainData.futureTrains.filter(t => !t.canceled);
      const konfliktTrains = [];
      for (let i = 0; i < allActiveTrains.length; i++) {
        for (let j = i + 1; j < allActiveTrains.length; j++) {
          const t1 = allActiveTrains[i];
          const t2 = allActiveTrains[j];
          const t1Start = parseTime(t1.actual || t1.plan, now, t1.date);
          const t2Start = parseTime(t2.actual || t2.plan, now, t2.date);
          const t1Dur = Number(t1.dauer) || 0;
          const t2Dur = Number(t2.dauer) || 0;
          if (!t1Start || !t2Start || t1Dur <= 0 || t2Dur <= 0) continue;
          const t1End = new Date(t1Start.getTime() + t1Dur * 60000);
          const t2End = new Date(t2Start.getTime() + t2Dur * 60000);
          if (t1Start < t2End && t1End > t2Start) {
            konfliktTrains.push({
              ...t1,
              announcementType: 'konflikt',
              conflictWith: t2,
              _uniqueId: t1._uniqueId + '_konflikt_' + t2._uniqueId
            });
            break;
          }
        }
      }
      
      // Sort each category by time
      const sortByTime = (arr) => {
        return arr.sort((a, b) => {
          const aTime = parseTime(a.plan, now, a.date);
          const bTime = parseTime(b.plan, now, b.date);
          if (!aTime && !bTime) return 0;
          if (!aTime) return 1;
          if (!bTime) return -1;
          return aTime - bTime;
        });
      };
      
      // Add announcements in priority order (notes always first)
      allAnnouncements.push(...noteTrains);
      allAnnouncements.push(...sortByTime(cancelledTrains));
      allAnnouncements.push(...sortByTime(delayedTrains));
      allAnnouncements.push(...sortByTime(zusatzfahrtTrains));
      allAnnouncements.push(...sortByTime(ersatzfahrtTrains));
      allAnnouncements.push(...sortByTime(konfliktTrains));
      
      console.log('📢 Total announcements:', allAnnouncements.length);
      console.log('📋 Announcements:', allAnnouncements);
      
      // Render announcements in the main train list panel
      const trainListEl = document.getElementById('train-list');
      trainListEl.innerHTML = '';
      trainListEl.style.opacity = '0';
      
      if (allAnnouncements.length === 0) {
        const template = document.createElement('template');
        template.innerHTML = Templates.mobileNoAnnouncements().trim();
        trainListEl.appendChild(template.content.firstChild);
      } else {
        allAnnouncements.forEach(announcement => {
          const template = document.createElement('template');
          template.innerHTML = Templates.mobileAnnouncementCard(announcement).trim();
          const card = template.content.firstChild;
          
          card.addEventListener('click', () => {
            renderFocusMode(announcement);
          });
          
          trainListEl.appendChild(card);
        });
      }
      
      // Show the list with fade-in
      setTimeout(() => {
        trainListEl.style.opacity = '1';
      }, 50);
      
      console.log('✅ Announcements rendered in train list panel');
    }

if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('/public/service-worker.js');
      });
    }
    
    // Load pinned trains from localStorage on startup
    loadPinnedTrains();

    // Initialize notifications for train arrivals
    (function initializeNotifications() {
      let notificationIntervalId = null;

      async function startNotifications() {
        const granted = await requestNotificationPermission();
        if (!granted) {
          console.log('Notification permission not granted - arrival alerts disabled');
          return;
        }

        console.log('Notification permission granted - will alert for trains arriving in 15 minutes');

        if (!notificationIntervalId) {
          notificationIntervalId = setInterval(() => {
            checkTrainArrivals();
          }, 60000);
        }

        // Initial check
        checkTrainArrivals();
      }

      // Some browsers only allow permission prompts after user interaction
      if ('Notification' in window && Notification.permission === 'default') {
        window.addEventListener('click', startNotifications, { once: true });
      } else if ('Notification' in window) {
        startNotifications();
      }
    })();