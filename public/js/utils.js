// === UTILITY FUNCTIONS ===
// Pure helper functions with no side effects.
    function getTrainSVG(line) {
      return `./res/${line.toLowerCase()}.svg`;
    }

    function getLineColor(line) {
      const lineColors = {
        's1': '#7D66AD',
        's2': '#00793B',
        's25': '#1c763b',
        's26': '#1c763b',
        's3': '#C76AA2',
        's4': '#992946',
        's41': '#aa5c3a',
        's42': '#c86722',
        's45': '#cc9d5a',
        's46': '#cc9d5a',
        's47': '#cc9d5a',
        's5': '#F08600',
        's51': '#c17b36',
        's6': '#004E9D',
        's60': '#8b8d26',
        's62': '#c17b36',
        's7': '#AEC926',
        's75': '#7f6ea3',
        's8': '#6da939',
        's85': '#6da939',
        's9': '#962d44',
        's95': '#91247D',
        'fex': '#FF0000'
      };
      return lineColors[line.toLowerCase()] || '#7D66AD';
    }

    function getCarriageSVG(dauer, isFEX = false) {
      const n = Number(dauer);
      const prefix = isFEX ? 'cb' : 'c';
      if (!Number.isFinite(n) || n <= 0) return `./res/${prefix}3.svg`;
      if (n <= 30) return `./res/${prefix}1.svg`;
      if (n <= 60) return `./res/${prefix}2.svg`;
      if (n <= 90) return `./res/${prefix}3.svg`;
      return `./res/${prefix}4.svg`;
    }

    function formatClock(date) {
      if (!date) return '';
      const h = String(date.getHours()).padStart(2, '0');
      const m = String(date.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }

    // Alias for formatClock for semantic clarity in different contexts

    function escapeHTML(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function calculateArrivalTime(departureTime, durationMinutes, trainDate = null) {
      if (!departureTime || !durationMinutes) return null;
      const now = new Date();
      const depDate = parseTime(departureTime, now, trainDate);
      if (!depDate) return null;
      const arrDate = new Date(depDate.getTime() + durationMinutes * 60000);
      return formatClock(arrDate);
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

    // Format time display for past trains (departed)
    function formatPastTrainTime(plan, actual, dauer, trainDate, now, isCheckedIn = false) {
      try {
        // Parse times to get HH:MM format
        const planTime = parseTime(plan, now, trainDate);
        const actualTime = parseTime(actual || plan, now, trainDate);
        
        const planHHMM = planTime ? formatClock(planTime).substring(0, 5) : '--:--';
        const actualHHMM = actualTime ? formatClock(actualTime).substring(0, 5) : '--:--';
        
        // Calculate departure time (actual arrival + duration)
        let departureHHMM = '--:--';
        if (actualTime && dauer) {
          const occEnd = new Date(actualTime.getTime() + Number(dauer) * 60000);
          departureHHMM = formatClock(occEnd).substring(0, 5);
        }
        
        const frag = document.createDocumentFragment();
        
        // Create animation container for toggling time/departure status
        const animContainer = document.createElement('div');
        animContainer.className = 'past-train-time-toggle';
        animContainer.setAttribute('data-plan', planHHMM);
        animContainer.setAttribute('data-actual', actualHHMM);
        animContainer.setAttribute('data-departure', departureHHMM);
        
        // Time display content
        const timeDisplay = document.createElement('div');
        timeDisplay.className = 'past-train-time-display active';
        
        const hasDelay = planHHMM !== actualHHMM;

        // Planned time (strikethrough) is shown only when actual differs from plan.
        if (hasDelay) {
          const plannedSpan = document.createElement('span');
          plannedSpan.className = 'past-train-planned-time';
          plannedSpan.textContent = planHHMM;
          timeDisplay.appendChild(plannedSpan);
        }

        // Always show actual arrival - departure interval.
        const actualSpan = document.createElement('span');
        actualSpan.className = 'past-train-actual-time';
        actualSpan.textContent = `${actualHHMM}–${departureHHMM}`;
        timeDisplay.appendChild(actualSpan);
        
        animContainer.appendChild(timeDisplay);
        
        // Departure status display (hidden initially)
        // Always show only "abgefahren"; icon/color indicate check-in status.
        const statusDisplay = document.createElement('div');
        statusDisplay.className = 'past-train-departed-display';

        const statusText = document.createElement('span');
        statusText.className = 'past-status-text';
        statusText.textContent = 'abgefahren';
        statusDisplay.appendChild(statusText);

        if (isCheckedIn) {
          statusDisplay.classList.add('is-checked');
          const icon = document.createElement('img');
          icon.className = 'past-status-icon';
          icon.src = 'res/eingecheckt.svg';
          icon.alt = '';
          statusDisplay.appendChild(icon);
        }
        
        animContainer.appendChild(statusDisplay);
        frag.appendChild(animContainer);
        return frag;
      } catch (e) {
        console.error('Error formatting past train time:', e);
        return document.createTextNode('--:--');
      }
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

      const hms = (sec) => {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      };

      // Check if currently occupying
      if (train.dauer) {
        const occEnd = getOccupancyEnd(train, now);
        if (train.actual && occEnd && parseTime(train.actual, now, train.date) <= now && occEnd > now) {
          // Occupying — white countdown to departure
          const diffSec = Math.round((occEnd - now) / 1000);
          const frag = document.createDocumentFragment();
          const label = document.createElement('span');
          label.className = 'countdown-label';
          label.textContent = 'Abfahrt in ';
          const time = document.createElement('span');
          time.className = 'countdown-time departing';
          time.textContent = hms(diffSec);
          frag.appendChild(label);
          frag.appendChild(time);
          return frag;
        }
      }

      // Countdown to arrival (pre-departure) — gray
      const diffSec = Math.max(0, Math.round((actualTime - now) / 1000));
      const frag = document.createDocumentFragment();
      const label = document.createElement('span');
      label.className = 'countdown-label';
      label.textContent = 'Ankunft in ';
      const prefix = document.createElement('span');
      prefix.className = 'countdown-prefix';
      prefix.textContent = 'in ';
      const time = document.createElement('span');
      time.className = 'countdown-time arriving';
      time.textContent = hms(diffSec);
      frag.appendChild(label);
      frag.appendChild(prefix);
      frag.appendChild(time);
      return frag;
    }

    // Notification functions for train arrival alerts

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
