// Extracted inline scripts from mobile.html

// Global variables for station
    let stationsIndex = null;
    let currentEva = null;
    let currentStationName = null;
    
    // View mode: 'belegungsplan' or 'list'
    let currentViewMode = 'belegungsplan';
    
    // Global refresh interval tracking
    let refreshIntervalId = null;
    let isEditingTrain = false;
    
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
    }
    // Helper functions
    //S1 to s1 weil s1.svg
    function getTrainSVG(line) {
      return `./${line.toLowerCase()}.svg`;
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
      
      if (currentTrain) {
        const existingEntry = firstTrainContainer.querySelector('.train-entry');
        
        // Check if the train has changed (different linie or plan)
        const existingDeparture = existingEntry ? existingEntry.querySelector('[data-departure]') : null;
        const trainChanged = !existingDeparture || 
                           existingDeparture.dataset.plan !== currentTrain.plan ||
                           existingDeparture.dataset.actual !== (currentTrain.actual || '') ||
                           !existingEntry.querySelector('.zugziel') ||
                           existingEntry.querySelector('.zugziel').textContent !== (currentTrain.canceled ? 'Zug fällt aus' : currentTrain.ziel);
        
        if (trainChanged || !existingEntry) {
          // Only recreate if train changed or doesn't exist
          const firstEntry = createTrainEntry(currentTrain, now, true);
          firstTrainContainer.innerHTML = '';
          firstTrainContainer.appendChild(firstEntry);
        }
        // If train hasn't changed, updateClock() will handle the countdown update
      } else {
        firstTrainContainer.innerHTML = '';
      }
    }

    // Toggle between Belegungsplan and legacy list view
    function toggleViewMode() {
      currentViewMode = currentViewMode === 'belegungsplan' ? 'list' : 'belegungsplan';
      localStorage.setItem('viewMode', currentViewMode);
      renderTrains();
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
      
      // Hide to prevent flashing during render
      trainListEl.style.opacity = '0';
      
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
          // Add date separator
          const dateSeparator = document.createElement('div');
          dateSeparator.className = 'belegungsplan-date-separator';
          dateSeparator.style.top = `${markerY}vh`;
          const dateObj = new Date(markerTime);
          dateSeparator.textContent = dateObj.toLocaleDateString('de-DE', {
            weekday: 'long',
            day: '2-digit',
            month: '2-digit',
          });
          belegungsplan.appendChild(dateSeparator);
          lastDate = currentDate;
        }
        
        // Hour line
        const hourLine = document.createElement('div');
        hourLine.className = 'belegungsplan-hour-line';
        if (isNewDay) {
          hourLine.classList.add('midnight');
        }
        hourLine.style.top = `${markerY}vh`;
        belegungsplan.appendChild(hourLine);
        
        // Time marker
        const marker = document.createElement('div');
        marker.className = 'belegungsplan-time-marker';
        marker.style.top = `${markerY}vh`;
        marker.textContent = formatClock(markerTime);
        belegungsplan.appendChild(marker);
      }

      // Add current time indicator line
      const currentTimeOffsetMs = now - startHour;
      const currentTimeOffsetHours = currentTimeOffsetMs / (60 * 60 * 1000);
      const currentTimeY = currentTimeOffsetHours * 7;
      
      if (currentTimeY >= 0 && currentTimeY <= totalHeight) {
        const currentTimeLine = document.createElement('div');
        currentTimeLine.className = 'belegungsplan-current-time-line';
        currentTimeLine.style.top = `${currentTimeY}vh`;
        belegungsplan.appendChild(currentTimeLine);
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
        const block = document.createElement('div');
        block.className = 'belegungsplan-train-block';
        block.style.top = `${pos.top}vh`;
        block.style.height = `${pos.height}vh`;
        
        // Add overlap class for indentation
        block.classList.add(`overlap-${overlapLevel}`);
        
        // Add data attributes
        block.dataset.uniqueId = train._uniqueId || '';
        block.dataset.linie = train.linie || '';
        block.dataset.plan = train.plan || '';
        
        // Add state classes
        if (train.linie === 'FEX') {
          block.classList.add('fex-entry');
        } else if (typeof train.linie === 'string' && /^S\d+/i.test(train.linie)) {
          // Add S-Bahn color class
          const lineClass = `s-bahn-${train.linie.toLowerCase()}`;
          block.classList.add(lineClass);
        }
        
        // Check if currently occupying
        const trainStart = parseTime(train.actual || train.plan, now, train.date);
        const trainEnd = getOccupancyEnd(train, now);
        if (trainStart && trainEnd && trainStart <= now && trainEnd > now) {
          block.classList.add('current');
        }
        
        // Only show header content for blocks 30 minutes or longer
        const duration = Number(train.dauer) || 0;
        if (duration >= 30) {
          // Header: icon + destination
          const header = document.createElement('div');
          header.className = 'belegungsplan-header';
          
          // Line icon
          if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
            const img = document.createElement('img');
            img.className = 'belegungsplan-line-icon';
            img.src = getTrainSVG(train.linie);
            img.alt = train.linie;
            img.onerror = () => {
              const badge = document.createElement('div');
              badge.className = 'line-badge';
              badge.style.fontSize = '2.5vh';
              badge.textContent = train.linie || '';
              img.parentNode.replaceChild(badge, img);
            };
            header.appendChild(img);
          } else {
            const badge = document.createElement('div');
            badge.className = 'line-badge';
            badge.style.fontSize = '2.5vh';
            badge.textContent = train.linie || '';
            header.appendChild(badge);
          }
          
          // Destination
          const dest = document.createElement('div');
          dest.className = 'belegungsplan-destination';
          dest.textContent = train.ziel || '';
          header.appendChild(dest);
          
          block.appendChild(header);
        }
        // For blocks under 30 minutes, just leave it as a colored block with no content
        
        // Click handler
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
          
          // Show content immediately after setting scroll
          trainListEl.style.opacity = '1';
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
      
      // Hide to prevent flashing during render
      trainListEl.style.opacity = '0';
      
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
          // Create day separator element
          const separator = document.createElement('div');
          separator.className = 'day-separator';
          
          const dateSpan = document.createElement('span');
          dateSpan.className = 'day-separator-date';
          const trainDate = new Date(train.date);
          dateSpan.textContent = trainDate.toLocaleDateString('de-DE', {
            weekday: 'long',
            day: '2-digit',
            month: '2-digit'
          });
          
          const line = document.createElement('div');
          line.className = 'day-separator-line';
          
          separator.appendChild(dateSpan);
          separator.appendChild(line);
          trainListEl.appendChild(separator);
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
          
          // Show content immediately after setting scroll
          trainListEl.style.opacity = '1';
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

    // Create a single train entry
    function createTrainEntry(train, now, isFirstTrain = false) {
      const entry = document.createElement('div');
      entry.className = 'train-entry';
      if (isFirstTrain) entry.classList.add('first-train');
      
      // Add data attributes for identification
      entry.dataset.linie = train.linie || '';
      entry.dataset.plan = train.plan || '';
      entry.dataset.date = train.date || '';
      entry.dataset.uniqueId = train._uniqueId || '';
      
      if (train.linie === 'FEX') {
        entry.classList.add('fex-entry');
      }

      // Add click handler to show focus mode
      entry.addEventListener('click', () => {
        renderFocusMode(train);
        // Update selected state
        document.querySelectorAll('.train-entry').forEach(e => e.classList.remove('selected'));
        entry.classList.add('selected');
      });

      // Status indicator
      const indicator = document.createElement('div');
      indicator.className = 'indicator-dot';
      
      if (train.canceled) {
        // Show X for cancelled trains
        indicator.classList.add('cancelled');
      } else {
        // Check if train is currently occupying (arrived but not departed)
        const tTime = parseTime(train.actual || train.plan, now, train.date);
        const occEnd = getOccupancyEnd(train, now);
        if (train.actual && occEnd && parseTime(train.actual, now, train.date) <= now && occEnd > now) {
          // Current train - show solid dot
          indicator.classList.add('current');
        }
      }

      // Train info container
      const trainInfo = document.createElement('div');
      trainInfo.className = 'train-info';

      // Symbol slot
      const symbolSlot = document.createElement('div');
      symbolSlot.className = 'symbol-slot';

      let trainSymbol;
      if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
        const img = document.createElement('img');
        img.className = 'train-symbol';
        img.src = getTrainSVG(train.linie);
        img.alt = train.linie;
        img.onerror = () => {
          const badge = document.createElement('div');
          badge.className = 'line-badge';
          badge.textContent = train.linie || '';
          if (img.parentNode) img.parentNode.replaceChild(badge, img);
        };
        trainSymbol = img;
      } else {
        trainSymbol = document.createElement('div');
        trainSymbol.className = 'line-badge';
        trainSymbol.textContent = train.linie || '';
      }

      symbolSlot.appendChild(trainSymbol);

      // Destination
      const zugziel = document.createElement('div');
      zugziel.className = 'zugziel';
      
      if (train.canceled) {
        zugziel.textContent = 'Zug fällt aus';
      } else {
        zugziel.textContent = train.ziel || '';
      }

      trainInfo.appendChild(indicator);
      trainInfo.appendChild(symbolSlot);
      trainInfo.appendChild(zugziel);

      // Right block
      const rightBlock = document.createElement('div');
      rightBlock.className = 'right-block';

      // Departure time (no carriage symbol)
      const departureSlot = document.createElement('div');
      departureSlot.className = 'departure-slot';
      const departure = document.createElement('div');
      departure.className = 'departure';
      departure.dataset.departure = '1';
      if (train.plan) departure.dataset.plan = train.plan;
      if (train.actual) departure.dataset.actual = train.actual;
      if (train.dauer != null) departure.dataset.dauer = String(train.dauer);
      if (train.date) departure.dataset.date = train.date;
      departure.dataset.canceled = train.canceled ? 'true' : 'false';
      
      // For headline train, show countdown; for others, show formatted time
      if (isFirstTrain) {
        departure.dataset.isHeadline = 'true';
        const depNode = formatCountdown(train, now);
        departure.appendChild(depNode);
      } else {
        const delay = train.canceled ? 0 : getDelay(train.plan, train.actual, now, train.date);
        const depNode = formatDeparture(train.plan, train.actual, now, delay, train.dauer, train.date);
        departure.appendChild(depNode);
      }
      
      departureSlot.appendChild(departure);
      rightBlock.appendChild(departureSlot);

      entry.appendChild(trainInfo);
      entry.appendChild(rightBlock);

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
      const isFixedScheduleTrain = train.weekday && !train.date;
      
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

    function renderFocusMode(train) {
      const now = new Date();
      
      // Check if mobile (screen width <= 768px)
      const isMobile = window.innerWidth <= 768;
      
      if (isMobile) {
        renderMobileFocusPopup(train);
        return;
      }
      
      // Desktop mode
      const panel = document.getElementById('focus-panel');
      const template = document.getElementById('focus-template');
      
      // Only allow editing for local schedule trains
      const isEditable = train.source === 'local';
      
      // Check if this is a fixed schedule train (has weekday but no date in original schedule)
      const isFixedSchedule = train.weekday && !train.date;
      
      // Clear panel and clone template
      panel.innerHTML = '';
      const clone = template.content.cloneNode(true);

      const lineIcon = clone.querySelector('[data-focus="line-icon"]');
      const lineIconParent = lineIcon.parentNode;
      
      if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
        lineIcon.src = getTrainSVG(train.linie);
        lineIcon.alt = train.linie;        
        lineIcon.onerror = () => {
          const badge = document.createElement('div');
          badge.className = 'line-badge';
          badge.style.fontSize = 'clamp(18px, 5vh, 40px)';
          badge.textContent = train.linie || '';
          badge.setAttribute('data-field', 'linie');
          badge.setAttribute('data-value', train.linie || '');
          badge.setAttribute('data-input-type', 'text');
          badge.setAttribute('data-placeholder', 'Linie');
          if (isEditable) {
            badge.style.cursor = 'pointer';
            badge.setAttribute('data-editable', 'true');
          }
          lineIcon.parentNode.replaceChild(badge, lineIcon);
        };
      } else {
        const badge = document.createElement('div');
        badge.className = 'line-badge';
        badge.style.fontSize = 'clamp(18px, 5vh, 40px)';
        badge.textContent = train.linie || '';
        badge.setAttribute('data-field', 'linie');
        badge.setAttribute('data-value', train.linie || '');
        badge.setAttribute('data-input-type', 'text');
        badge.setAttribute('data-placeholder', 'Linie');
        if (isEditable) {
          badge.style.cursor = 'pointer';
          badge.setAttribute('data-editable', 'true');
        }
        lineIcon.parentNode.replaceChild(badge, lineIcon);
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

      // Populate arrival time
      const arrivalPlan = clone.querySelector('[data-focus="arrival-plan"]');
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
      const timeline = clone.querySelector('.focus-timeline');
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
        // Hide timeline if no departure time
        if (timeline) {
          timeline.style.display = 'none';
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
        const indicator = document.createElement('div');
        indicator.style.cssText = 'position: absolute; top: 1vh; right: 1vw; font-size: 1.5vh; color: rgba(255,255,255,0.5); background: rgba(0,0,0,0.3); padding: 0.5vh 1vw; border-radius: 2px;';
        indicator.textContent = 'DB API - Nur Lesen';
        panel.style.position = 'relative';
        panel.appendChild(indicator);
      }
      
      // Show badge for fixed schedule trains (date not editable)
      if (isEditable && isFixedSchedule) {
        const fixedIndicator = document.createElement('div');
        fixedIndicator.style.cssText = 'position: absolute; top: 1vh; right: 1vw; font-size: 1.5vh; color: rgba(255,200,100,0.8); background: rgba(100,60,0,0.4); padding: 0.5vh 1vw; border-radius: 2px; border: 1px solid rgba(255,200,100,0.3);';
        fixedIndicator.textContent = '🔒 Wiederholender Termin';
        fixedIndicator.title = 'Datum kann nicht bearbeitet werden - dieser Termin wiederholt sich wöchentlich';
        panel.style.position = 'relative';
        panel.appendChild(fixedIndicator);
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
      const buttonsContainer = panel.querySelector('.focus-buttons');
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
                panel.innerHTML = '<div style="font-size: 2vw; color: rgba(255,255,255,0.5); text-align: center; padding: 2vh;">Zug gelöscht</div>';
              }
              break;
          }
        });
      }

      // Store current train in panel for Shift+S save
      panel.dataset.currentTrain = JSON.stringify(train);
    }

    // Mobile-specific focus popup rendering - using PC's exact edit mechanism
    function renderMobileFocusPopup(train) {
      const now = new Date();
      const popup = document.getElementById('mobile-focus-popup');
      
      if (!popup) {
        console.error('Mobile focus popup not found');
        return;
      }
      
      // Only allow editing for local schedule trains
      const isEditable = train.source === 'local';
      const isFixedSchedule = train.weekday && !train.date;
      
      // Show popup with slide-up animation
      popup.style.display = 'flex';
      setTimeout(() => popup.classList.add('show'), 10);
      
      // Populate line icon (non-editable) and description
      const lineIcon = popup.querySelector('[data-mobile-focus="line-icon"]');
      const lineSlot = popup.querySelector('.mobile-line-description-slot');
      
      // Remove any existing description
      const existingDesc = lineSlot.querySelector('.mobile-line-description');
      if (existingDesc) existingDesc.remove();
      
      if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
        lineIcon.src = getTrainSVG(train.linie);
        lineIcon.alt = train.linie;
        lineIcon.style.display = 'block';
        lineIcon.onerror = () => {
          lineIcon.style.display = 'none';
        };
      } else {
        lineIcon.style.display = 'none';
      }
      
      // Add description field (editable route info)
      const description = document.createElement('div');
      description.className = 'mobile-line-description';
      
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
      
      const defaultDescription = descriptionPresets[train.linie] || '';
      description.textContent = train.beschreibung || defaultDescription;
      description.setAttribute('data-field', 'beschreibung');
      description.setAttribute('data-value', defaultDescription);
      description.setAttribute('data-input-type', 'text');
      description.setAttribute('data-placeholder', 'Linienbeschreibung...');

      
      lineSlot.appendChild(description);
      
      // Populate destination
      const destination = popup.querySelector('[data-mobile-focus=\"destination\"]');
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
      
      // Populate times
      const arrivalPlan = popup.querySelector('[data-mobile-focus=\"arrival-plan\"]');
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
      } else {
        arrivalPlan.style.textDecoration = 'none';
      }
      
      const arrivalDelayed = popup.querySelector('[data-mobile-focus=\"arrival-delayed\"]');
      arrivalDelayed.textContent = train.actual || train.plan || '';
      arrivalDelayed.setAttribute('data-field', 'actual');
      arrivalDelayed.setAttribute('data-value', train.actual || '');
      arrivalDelayed.setAttribute('data-input-type', 'time');
      
      const hasDelay = train.actual && train.actual !== train.plan;
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
      
      if (train.dauer) {
        // Show carriage, duration, departure time, and timelines
        carriage.src = getCarriageSVG(train.dauer, train.linie === 'FEX');
        if (carriageDurationSlot) carriageDurationSlot.style.display = 'flex';
        if (departureSlot) departureSlot.style.display = 'flex';
        timelines.forEach(tl => tl.style.display = 'block');
        
        const duration = popup.querySelector('[data-mobile-focus="duration"]');
        duration.textContent = `${train.dauer} Min`;
        if (train.canceled) {
          duration.style.textDecoration = 'line-through';
        } else {
          duration.style.textDecoration = 'none';
        }
        duration.setAttribute('data-field', 'dauer');
        duration.setAttribute('data-value', train.dauer || '0');
        duration.setAttribute('data-input-type', 'number');
        if (isEditable) {
          duration.style.cursor = 'pointer';
          duration.setAttribute('data-editable', 'true');
        }
        
        // Populate departure time
        if (train.plan) {
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
      } else {
        // No duration - hide carriage, duration, departure time, and timelines
        if (carriageDurationSlot) carriageDurationSlot.style.display = 'none';
        if (departureSlot) departureSlot.style.display = 'none';
        timelines.forEach(tl => tl.style.display = 'none');
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
      stops.textContent = stopsArray.length > 0 ? stopsArray.join('\n') : '';
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
        const badge = document.createElement('div');
        badge.className = 'mobile-train-badge';
        badge.style.cssText = 'position: fixed; top: 6vh; right: 2vw; font-size: 1.8vh; color: rgba(255,255,255,0.6); background: rgba(0,0,0,0.4); padding: 0.5vh 2vw; border-radius: 4px; z-index: 5001;';
        badge.textContent = 'DB API - Nur Lesen';
        popup.appendChild(badge);
      } else if (isEditable && isFixedSchedule) {
        const badge = document.createElement('div');
        badge.className = 'mobile-train-badge';
        badge.style.cssText = 'position: fixed; top: 6vh; right: 2vw; font-size: 1.8vh; color: rgba(255,200,100,0.9); background: rgba(100,60,0,0.5); padding: 0.5vh 2vw; border-radius: 4px; border: 1px solid rgba(255,200,100,0.4); z-index: 5001;';
        badge.textContent = '🔒 Wiederholender Termin';
        popup.appendChild(badge);
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
              
              // Save and re-render
              await saveSchedule();
              renderMobileFocusPopup(train);
            };
            
            // Auto-save on blur
            input.addEventListener('blur', async () => {
              await updateValue(input.value);
            });
            
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
          
          switch(action) {
            case 'return':
              popup.classList.remove('show');
              setTimeout(() => popup.style.display = 'none', 300);
              break;
              
            case 'cancel':
              if (scheduleTrain) {
                train.canceled = !train.canceled;
                scheduleTrain.canceled = train.canceled;
                renderMobileFocusPopup(train);
                await saveSchedule();
              }
              break;
              
            case 'minus5':
              if (train.plan && scheduleTrain) {
                const currentDelay = getDelay(train.plan, train.actual, now, train.date);
                const newDelay = currentDelay - 5;
                if (newDelay === 0) {
                  train.actual = undefined;
                  scheduleTrain.actual = undefined;
                } else {
                  const planDate = parseTime(train.plan, now, train.date);
                  const newActualDate = new Date(planDate.getTime() + newDelay * 60000);
                  train.actual = formatClock(newActualDate);
                  scheduleTrain.actual = train.actual;
                }
                renderMobileFocusPopup(train);
                await saveSchedule();
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
                renderMobileFocusPopup(train);
                await saveSchedule();
              }
              break;
              
            case 'delete':
              if (confirm(`Zug ${train.linie} nach ${train.ziel} löschen?`)) {
                await deleteTrainFromSchedule(train);
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
      
      const isFixedScheduleTrain = train.weekday && !train.date;
      
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
            }, 150);
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
      // Notes without times go first, then everything else by departure time
      allAnnouncements.sort((a, b) => {
        // Notes without plan time come first
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
        panel.innerHTML = '<div style="font-size: 2vw; color: rgba(255,255,255,0.5); text-align: center;">Keine Ankündigungen</div>';
        if (comprehensiveAnnouncementInterval) {
          clearInterval(comprehensiveAnnouncementInterval);
          comprehensiveAnnouncementInterval = null;
        }
        return;
      }

      // Calculate pagination
      const itemsPerPage = 3;
      const totalPages = Math.ceil(allAnnouncements.length / itemsPerPage);
      
      if (comprehensiveAnnouncementCurrentPage >= totalPages) {
        comprehensiveAnnouncementCurrentPage = 0;
      }

      const startIndex = comprehensiveAnnouncementCurrentPage * itemsPerPage;
      const endIndex = Math.min(startIndex + itemsPerPage, allAnnouncements.length);
      const pageAnnouncements = allAnnouncements.slice(startIndex, endIndex);

      panel.innerHTML = '';

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width: 100%; height: 100%; background: white; position: relative;';

      const container = document.createElement('div');
      container.className = 'announcement-content-wrapper';
      container.style.cssText = 'width: 100%; height: 100%; display: flex; flex-direction: row; align-items: flex-start; justify-content: space-evenly; opacity: 0; transition: opacity 1s ease-in-out;';

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
              const badge = document.createElement('div');
              badge.className = 'line-badge';
              badge.style.fontSize = 'clamp(12px, 3vh, 24px)';
              badge.textContent = train.linie || '';
              if (mainIcon.parentNode) {
                mainIcon.parentNode.replaceChild(badge, mainIcon);
              }
            };
          } else {
            const badge = document.createElement('div');
            badge.className = 'line-badge';
            badge.style.fontSize = 'clamp(12px, 3vh, 24px)';
            badge.textContent = train.linie || '';
            mainIcon.parentNode.replaceChild(badge, mainIcon);
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
              const badge = document.createElement('div');
              badge.className = 'line-badge';
              badge.style.fontSize = 'clamp(12px, 3vh, 24px)';
              badge.textContent = conflictTrain.linie || '';
              if (conflictIcon.parentNode) {
                conflictIcon.parentNode.replaceChild(badge, conflictIcon);
              }
            };
          } else {
            const badge = document.createElement('div');
            badge.className = 'line-badge';
            badge.style.fontSize = 'clamp(12px, 3vh, 24px)';
            badge.textContent = conflictTrain.linie || '';
            conflictIcon.parentNode.replaceChild(badge, conflictIcon);
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
        if (train.announcementType === 'note') {
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
              const badge = document.createElement('div');
              badge.className = 'line-badge';
              badge.style.fontSize = 'clamp(18px, 5vh, 40px)';
              badge.textContent = train.linie || '';
              if (lineIcon.parentNode) {
                lineIcon.parentNode.replaceChild(badge, lineIcon);
              }
            };
          } else {
            const badge = document.createElement('div');
            badge.className = 'line-badge';
            badge.style.fontSize = 'clamp(18px, 5vh, 40px)';
            badge.textContent = train.linie || '';
            lineIcon.parentNode.replaceChild(badge, lineIcon);
          }
        }

        // Populate times
        const timeSlot = clone.querySelector('.announcement-time-slot');
        if (train.announcementType === 'note') {
          timeSlot.style.display = 'none';
        } else {
          const planEl = clone.querySelector('[data-announcement="plan"]');
          if (train.canceled || train.announcementType === 'cancelled') {
            planEl.innerHTML = `<s>${train.plan || ''}</s>`;
          } else {
            planEl.textContent = train.plan || '';
          }

          const delayedEl = clone.querySelector('[data-announcement="delayed"]');
          if (train.actual && train.actual !== train.plan) {
            if (train.canceled || train.announcementType === 'cancelled') {
              delayedEl.innerHTML = `<s>${train.actual}</s>`;
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
          destination.innerHTML = `<s>${destinationText}</s>`;
        } else {
          destination.textContent = destinationText;
        }

        // Populate content
        const content = clone.querySelector('[data-announcement="content"]');
        content.innerHTML = formatStopsWithDate(train);

        // Add click-to-edit functionality for local trains
        const announcementPanel = clone.querySelector('.announcement-panel');
        if (train.source === 'local' && train.announcementType === 'note') {
          announcementPanel.style.cursor = 'pointer';
          announcementPanel.addEventListener('click', () => {
            renderFocusMode(train);
          });
        }

        container.appendChild(clone);
      });

      wrapper.appendChild(container);
      
      // Add pagination dots if there are multiple pages
      if (totalPages > 1) {
        const paginationDots = document.createElement('div');
        paginationDots.className = 'pagination-dots';
        
        for (let i = 0; i < totalPages; i++) {
          const dot = document.createElement('div');
          dot.className = 'pagination-dot';
          if (i === comprehensiveAnnouncementCurrentPage) {
            dot.classList.add('active');
          }
          paginationDots.appendChild(dot);
        }
        
        wrapper.appendChild(paginationDots);
      }
      
      panel.appendChild(wrapper);

      setTimeout(() => {
        container.style.opacity = '1';
      }, 50);

      // ALWAYS clear existing interval first
      if (comprehensiveAnnouncementInterval) {
        clearInterval(comprehensiveAnnouncementInterval);
        comprehensiveAnnouncementInterval = null;
      }

      // Set up NEW pagination interval if needed
      if (allAnnouncements.length > itemsPerPage) {
        comprehensiveAnnouncementInterval = setInterval(() => {
          const contentWrapper = panel.querySelector('.announcement-content-wrapper');
          if (!contentWrapper) return;
          
          // Fade out current content
          contentWrapper.style.opacity = '0';
          
          // Wait for fade out, then render new content
          setTimeout(() => {
            comprehensiveAnnouncementCurrentPage = (comprehensiveAnnouncementCurrentPage + 1) % totalPages;
            renderComprehensiveAnnouncementPanel();
          }, 1000); // Match the CSS transition time
        }, 16000); // 15 seconds visible + 1 second transition
      }
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
      const schedule = await fetchSchedule();
      processTrainData(schedule);
      renderTrains(); // Use unified render function
      renderComprehensiveAnnouncementPanel(); // Debug: render to upper right panel
      updateClock();
      
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

    // Refresh full schedule every minute (unless editing)
    refreshIntervalId = setInterval(async () => {
      if (isEditingTrain) {
        console.log('Skipping refresh - train is being edited');
        return;
      }
      const schedule = await fetchSchedule();
      processTrainData(schedule);
      renderTrains(); // Use unified render function
      renderComprehensiveAnnouncementPanel(); // Debug: render to upper right panel
    }, 60000);

    // Set up Server-Sent Events for real-time updates
    const eventSource = new EventSource('/events');
    
    eventSource.addEventListener('update', async (event) => {
      console.log('Received server update event, refreshing data...');
      
      // Skip refresh if editing
      if (isEditingTrain) {
        console.log('Skipping SSE refresh - train is being edited');
        return;
      }
      
      // Store currently focused train unique ID before refresh
      const panel = document.getElementById('focus-panel');
      let focusedTrainId = null;
      if (panel && panel.dataset.trainId) {
        focusedTrainId = panel.dataset.trainId;
      }
      
      // Fetch and update the GLOBAL schedule object
      const freshSchedule = await fetchSchedule();
      processTrainData(freshSchedule);
      renderTrains(); // Use unified render function
      renderComprehensiveAnnouncementPanel();
      
      // Re-render focus panel if a train was focused
      if (focusedTrainId && processedTrainData.allTrains) {
        // Find the updated train in the refreshed data using unique ID
        const updatedTrain = processedTrainData.allTrains.find(t => 
          t._uniqueId === focusedTrainId
        );
        
        if (updatedTrain) {
          renderFocusMode(updatedTrain);
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
          const item = document.createElement('div');
          item.className = 'suggestion-item';
          const label = st.ds100 ? `${st.name} (${st.ds100})` : st.name;
          item.textContent = label;
          item.title = label;
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
          focusPanel.innerHTML = '';
          // Remove selection from all train entries
          document.querySelectorAll('.train-entry').forEach(entry => entry.classList.remove('selected'));
        }
      }
      
      // Left/Right arrow keys to change announcement page - but NOT when editing
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isEditingTrain) {
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
      
      // Auto-click on the line field to enter edit mode
      setTimeout(() => {
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
          const lineDescription = document.querySelector('[data-mobile-focus="line-description"]');
          if (lineDescription) lineDescription.click();
        } else {
          const lineField = document.querySelector('[data-field="linie"]');
          if (lineField) lineField.click();
        }
      }, 100);
    }

if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('/public/service-worker.js');
      });
    }