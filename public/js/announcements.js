// === NOTES, ANNOUNCEMENTS & PINNED TRAINS ===
    function renderNotePanel() {
      const panel = document.getElementById('note-panel');
      const template = document.getElementById('note-template');
      
      if (!template) {
        console.error('Note template not found');
        return;
      }

      const noteTrains = processedTrainData.noteTrains;

      if (noteTrains.length === 0) {
        panel.innerHTML = '<div style=\"padding: 2vh; color: rgba(255,255,255,0.6); text-align: center;\">Keine Notizen</div>';
        return;
      }

      panel.innerHTML = '';

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width: 100%; height: 100%; background: var(--color-bg-primary); position: relative;';

      const container = document.createElement('div');
      container.className = 'announcement-content-wrapper';
      container.style.cssText = 'width: 100%; height: 100%; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 8px; padding: 12px; overflow-y: auto; box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none;';

      noteTrains.forEach(note => {
        const clone = template.content.cloneNode(true);

        // Set note headline color to current accent color
        const headline = clone.querySelector('.announcement-headline.note');
        if (headline) {
          headline.style.background = currentAccentColor;
        }

        // Populate destination
        const destination = clone.querySelector('[data-note=\"destination\"]');
        destination.textContent = note.ziel || 'Unbenannte Notiz';

        // Populate date in German long form
        const dateEl = clone.querySelector('[data-note=\"date\"]');
        if (dateEl && note.date) {
          const noteDate = new Date(note.date);
          const dateStr = noteDate.toLocaleDateString('de-DE', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          dateEl.textContent = dateStr;
        } else if (dateEl) {
          dateEl.style.display = 'none';
        }

        // Populate content (zwischenhalte) - use line breaks instead of dots
        const content = clone.querySelector('[data-note=\"content\"]');
        if (note.zwischenhalte && note.zwischenhalte.length > 0) {
          // Join with line breaks and use innerHTML to preserve them
          content.innerHTML = note.zwischenhalte.map(stop => stop.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>');
        } else {
          content.textContent = '';
          content.style.display = 'none';
        }

        // Add click-to-edit functionality
        const notePanel = clone.querySelector('.note-panel');
        notePanel.style.cursor = 'pointer';
        notePanel.addEventListener('click', () => {
          renderFocusMode(note);
        });

        container.appendChild(clone);
      });

      wrapper.appendChild(container);
      panel.appendChild(wrapper);
    }


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
        if (!train.date) return true; // No date = newly created / unspecified → treat as today
        const trainDateStr = train.date.split('T')[0]; // Handle ISO format
        return trainDateStr === todayDateStr;
      };

      // 1. Ankündigung: Notes without departure time (from processed data) - persist forever, no date filter
      // NOTES ARE NOW IN SEPARATE DRAWER - excluded from announcements

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
      wrapper.style.cssText = 'width: 100%; height: 100%; background: var(--color-bg-primary); position: relative;';

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
      const focusedTrainId = desktopFocusedTrainId;
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