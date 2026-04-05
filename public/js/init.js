// === INITIALIZATION & STARTUP ===
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

      // Sidebar add button event listener (desktop)
      const sidebarAddBtn = document.getElementById('sidebar-add-button');
      if (sidebarAddBtn) {
        sidebarAddBtn.addEventListener('click', () => {
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
          const drawer = document.getElementById('announcement-drawer');
          if (drawer && drawer.classList.contains('is-open')) {
            // If announcement drawer is open, close it
            closeAnnouncementsDrawer();
          } else {
            // If announcement drawer is closed, open it and close notes
            closeNoteDrawer();
            openAnnouncementsDrawer();
          }
        });
      } else {
        console.log('❌ Announcements button not found');
      }

      // Announcement drawer close button event listener
      const announcementDrawerCloseBtn = document.getElementById('announcement-drawer-close');
      if (announcementDrawerCloseBtn) {
        announcementDrawerCloseBtn.addEventListener('click', () => {
          closeAnnouncementsDrawer();
        });
      }

      // Note drawer event listeners
      const noteDrawerCloseBtn = document.getElementById('note-drawer-close');
      if (noteDrawerCloseBtn) {
        noteDrawerCloseBtn.addEventListener('click', () => {
          closeNoteDrawer();
        });
      }

      const noteAddBtn = document.getElementById('note-add-button');
      if (noteAddBtn) {
        noteAddBtn.addEventListener('click', async () => {
          // Create a new note object
          const newNote = {
            linie: 'NOTE',
            type: 'note',
            ziel: 'Neue Notiz',
            zwischenhalte: [],
            date: new Date().toISOString().split('T')[0],
            source: 'local',
            _uniqueId: 'note_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now()
          };
          
          // Add to spontaneousEntries
          schedule.spontaneousEntries = schedule.spontaneousEntries || [];
          schedule.spontaneousEntries.push(newNote);
          
          // Save and refresh
          await saveSchedule();
          const freshSchedule = await fetchSchedule();
          Object.assign(schedule, freshSchedule);
          processTrainData(schedule);
          
          // Open editor for the new note
          renderFocusMode(newNote);
          
          // Refresh note panel
          renderNotePanel();
        });
      }

      // Notes button event listener
      const notesBtn = document.getElementById('notes-button');
      if (notesBtn) {
        notesBtn.addEventListener('click', () => {
          const drawer = document.getElementById('note-drawer');
          if (drawer && drawer.classList.contains('is-open')) {
            // If note drawer is open, close it
            closeNoteDrawer();
          } else {
            // If note drawer is closed, open it and close announcements
            closeAnnouncementsDrawer();
            openNoteDrawer();
          }
        });
      }

      const navModeButtons = document.querySelectorAll('.task-icon-button[data-mode]');
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

    // Save status indicator functions



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
// ══════════════════════════════════════════════════════════════