// === UTILITY FUNCTIONS ===
// Pure helper functions with no side effects.
    function getTrainSVG(line) {
      return `./res/${line.toLowerCase()}.svg`;
    }

    // Parse a platform filter string like "1,2,3" or "3-5" or "1,3-5,7"
    // Returns a predicate function (platform => bool), or null if filter is empty/invalid.
    function parsePlatformFilter(filterStr) {
      if (!filterStr || !filterStr.trim()) return null;
      const norm = p => String(p || '').trim().toLowerCase();
      const allowed = new Set();
      const ranges = [];
      filterStr.split(',').forEach(part => {
        part = part.trim();
        const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
          const lo = parseInt(range[1], 10), hi = parseInt(range[2], 10);
          for (let i = lo; i <= hi; i++) allowed.add(String(i));
          ranges.push([lo, hi]);
        } else if (part) {
          allowed.add(norm(part));
        }
      });
      if (!allowed.size) return null;
      return (platform) => allowed.has(norm(platform));
    }

    function getLineColor(line) {
      const lineColors = {
        's1': '#7D66AD',
        's11': '#62AC4E',
        's17': '#478dbb',
        's2': '#00793B',
        's21': '#00793B',
        's25': '#1c763b',
        's26': '#1c763b',
        's28': '#95b026',
        's3': '#C76AA2',
        's4': '#992946',
        's41': '#aa5c3a',
        's42': '#c86722',
        's45': '#cc9d5a',
        's46': '#cc9d5a',
        's47': '#39bb78',
        's49': '#750787',
        's5': '#F08600',
        's51': '#F08600',
        's57': '#ebb400',
        's6': '#004E9D',
        's60': '#8b8d26',
        's62': '#c17b36',
        's7': '#AEC926',
        's74': '#8c3232',
        's75': '#7f6ea3',
        's8': '#6da939',
        's85': '#6da939',
        's9': '#962d44',
        's91': '#03377a',
        's92': '#7a0707',
        's93': '#e4592b',
        's94': '#41238d',
        's95': '#207910',
        's96': '#196489',
        's97': '#074d70',
        's98': '#ffd737',
        's99': '#ff76c4',
        'fex': '#FF0000',
        'sev': '#f5c400',
        '1': '#ed1846',
        '2': '#ed1846',
        '8': '#ed1846',
        '3': '#0071bb',
        '7': '#0071bb',
        '9': '#0071bb',
        '13': '#0071bb',
        '4': '#ffaf19',
        '5': '#ffaf19',
        '6': '#ffaf19',
        '11': '#ffaf19',
        '10': '#72bf43',
        '12': '#72bf43',
        '17': '#72bf43'

      };
      return lineColors[line.toLowerCase()] || '#8c8c8c';
    }

    function adjustHexColor(hex, amount) {
      const match = String(hex || '').trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
      if (!match) return hex;
      let h = match[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const target = amount >= 0 ? 255 : 0;
      const mix = (v) => Math.round(v + (target - v) * Math.abs(amount));
      const toHex = (v) => mix(v).toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    // A multi-step "shine" gradient built from a line's own base color:
    // muted -> dark -> base -> light -> dark, never touching pure black/white.
    function shineGradientStops(base) {
      return [
        adjustHexColor(base, -0.2),
        adjustHexColor(base, -0.4),
        base,
        adjustHexColor(base, 0.35),
        adjustHexColor(base, -0.3)
      ];
    }

    // Special multi-stop border gradients per line, keyed by lowercase line id.
    // Colors for s91-s99 are taken from their pill SVGs (./res/<line>.svg).
    const SPECIAL_LINE_GRADIENTS = {
      s49: ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787'], // pride flag
      s91: shineGradientStops('#03377a'),
      s92: shineGradientStops('#7a0707'),
      s93: shineGradientStops('#e4592b'),
      s94: shineGradientStops('#41238d'),
      s95: shineGradientStops('#e4592b'),
      s96: shineGradientStops('#196489'),
      s97: shineGradientStops('#074d70'),
      s98: shineGradientStops('#ffd737'), // gold text accent, dark pill
      s99: shineGradientStops('#ff76c4')  // pink text accent, dark pill
    };

    function hasSpecialLineGradient(line) {
      return Object.prototype.hasOwnProperty.call(SPECIAL_LINE_GRADIENTS, String(line || '').toLowerCase());
    }

    function getLineGradient(line, direction = 'to right') {
      const stops = SPECIAL_LINE_GRADIENTS[String(line || '').toLowerCase()] || SPECIAL_LINE_GRADIENTS.s49;
      return `linear-gradient(${direction}, ${stops.join(', ')})`;
    }

    // Builds a `background` shorthand that paints the special-line gradient only
    // as a thin stripe on one edge (border-box), leaving the rest of the box's
    // background as the normal panel color. This keeps any existing translucent
    // border on the other edges from picking up a tint from the gradient behind it,
    // while still respecting border-radius (unlike border-image).
    function getLineStripeBackground(line, { edge = 'bottom', thickness = '4px', panelBgVar = '--color-bg-panel' } = {}) {
      const direction = (edge === 'left' || edge === 'right') ? 'to bottom' : 'to right';
      const size = (edge === 'left' || edge === 'right') ? `${thickness} 100%` : `100% ${thickness}`;
      const gradient = getLineGradient(line, direction);
      return `${gradient} ${edge} / ${size} no-repeat border-box, linear-gradient(var(${panelBgVar}), var(${panelBgVar})) padding-box`;
    }

    function getCarriageSVG(dauer, isFEX = false, line = '') {
      function brightenHexColor(hex, amount = 0.22) {
        const raw = String(hex || '').trim();
        const match = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
        if (!match) return '#5e7fb8';
        let h = match[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const lift = (v) => Math.round(v + (255 - v) * amount);
        const toHex = (v) => lift(v).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      }

      const n = Number(dauer);
      let level = 3;
      if (Number.isFinite(n) && n >= 0) {
        if (n === 0) level = 0;
        else if (n <= 30) level = 1;
        else if (n <= 60) level = 2;
        else if (n <= 90) level = 3;
        else level = 4;
      }

      if (isFEX) {
        return `./res/cb${level}.svg`;
      }

      const baseColor = getLineColor(line || 's1');
      const fillColor = brightenHexColor(baseColor, 0.7);
      const polygonPoints = [
        '69,274 69,243 215,78 702,78 702,274',
        '724,274 724,243 870,78 1257,78 1257,274',
        '1283,274 1283,243 1429,78 1716,78 1716,274',
        '1740,274 1740,243 1889,78 2073,78 2073,274'
      ];
      const rects = [
        { x: 69, width: 633 },
        { x: 724, width: 533 },
        { x: 1283, width: 433 },
        { x: 1740, width: 333 }
      ];

      const polygons = level > 0
        ? polygonPoints
            .slice(polygonPoints.length - level)
            .map((points) => `<polygon points="${points}" fill="${fillColor}"/>`)
            .join('')
        : '';

      const rectMarkup = rects
        .map((r) => `<rect x="${r.x}" y="284" width="${r.width}" height="31" fill="${fillColor}"/>`)
        .join('');

      const svg = `<svg viewBox="0 0 2140 383" xmlns="http://www.w3.org/2000/svg">${polygons}${rectMarkup}</svg>`;
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
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

    // Shared JS-driven marquee (no CSS @keyframes): scrolls `span` left by
    // `scrollDist` px, pausing at each end, looping until cancelled via
    // span._marqueeCancel(). Originally lived in dashboard.js (via-stops ticker);
    // extracted here so other tickers (e.g. cancel-notice-tag) can reuse it.
    function startMarquee(span, scrollDist) {
      const SPEED = 40; // px per second (slow scroll)
      const PAUSE = 3000; // ms pause at start and end
      const scrollDuration = Math.round((scrollDist / SPEED) * 1000);
      let cancelled = false;
      let timers = [];

      span._marqueeCancel = function() {
        cancelled = true;
        timers.forEach(clearTimeout);
        span.style.transition = 'none';
        span.style.transform = '';
      };

      function cycle() {
        if (cancelled || !span.isConnected) return;
        span.style.transition = 'none';
        span.style.transform = 'translateX(0)';
        timers.push(setTimeout(() => {
          if (cancelled || !span.isConnected) return;
          span.style.transition = `transform ${scrollDuration}ms linear`;
          span.style.transform = `translateX(-${scrollDist}px)`;
          timers.push(setTimeout(() => {
            if (cancelled || !span.isConnected) return;
            timers.push(setTimeout(cycle, PAUSE));
          }, scrollDuration));
        }, PAUSE));
      }

      cycle();
    }

    // Seamless infinite ticker: `span` must already contain a repeating segment
    // duplicated back-to-back (segment + segment), and `segmentWidth` is the pixel
    // width of one segment. Scrolls continuously left by exactly `segmentWidth`
    // then snaps back to translateX(0) with no visible seam, since the second
    // copy is identical to the first and now sits exactly where it started —
    // unlike startMarquee, there is no pause/reverse, it just keeps going.
    function startInfiniteMarquee(span, segmentWidth) {
      const SPEED = 40; // px per second, consistent with startMarquee
      const duration = Math.round((segmentWidth / SPEED) * 1000);
      let cancelled = false;

      function onTransitionEnd(e) {
        if (e.propertyName !== 'transform') return;
        if (cancelled || !span.isConnected) return;
        step();
      }

      span._marqueeCancel = function() {
        cancelled = true;
        span.removeEventListener('transitionend', onTransitionEnd);
        span.style.transition = 'none';
        span.style.transform = '';
      };

      function step() {
        if (cancelled || !span.isConnected) return;
        span.style.transition = 'none';
        span.style.transform = 'translateX(0)';
        // Force reflow so the browser registers the reset before the next
        // transition starts (otherwise it can be coalesced away).
        void span.offsetWidth;
        span.style.transition = `transform ${duration}ms linear`;
        span.style.transform = `translateX(-${segmentWidth}px)`;
      }

      span.addEventListener('transitionend', onTransitionEnd);
      step();
    }

    function isDurationOnlyTrain(train) {
      return !!train && train.type === 'duration-only';
    }

    // A train with an open check-in session and no recorded duration yet
    // ("laufend") is effectively occupying right now even though
    // getOccupancyEnd() can't compute an end time for it (dauer is 0/unset).
    // Used so these trains count as "currently occupying" for headline/list
    // purposes until they're checked out (at which point dauer becomes real)
    // or superseded by a later-starting train.
    function isOpenCheckinOccupying(train, now) {
      if (!train || !train.checkedIn || train.checkedOut) return false;
      if (Number(train.dauer) > 0) return false;
      const tTime = parseTime(train.actual || train.plan, now, train.date);
      return !!tTime && tTime <= now;
    }

    // A duration-only entry acts as a template: checking it in spawns a normal
    // timed clone (see checkin.js `_ciCommitCheckinClone`) rather than mutating
    // the template. This finds that clone's open session, if any.
    function findActiveCloneForTemplate(templateUid) {
      const lists = [schedule.spontaneousEntries || [], schedule.trains || [], schedule.localTrains || []];
      for (const list of lists) {
        const found = list.find(t => t && t._templateUid === templateUid && t.checkedIn && !t.checkedOut);
        if (found) return found;
      }
      return null;
    }

    function hasTrainTime(train) {
      return !!(train && typeof train.plan === 'string' && train.plan.trim() !== '');
    }

    function expandDestinationPrefix(ziel) {
      if (typeof ziel !== 'string' || !ziel) return ziel || '';
      return ziel.replace(/^\s*\[(ZF|PRÜ|PRUE|EF)\]/i, (match, code) => {
        const key = String(code).toUpperCase();
        if (key === 'ZF') return '[Zusatzfahrt]';
        if (key === 'PRÜ' || key === 'PRUE') return '[Prüfung]';
        if (key === 'EF') return '[Ersatzfahrt]';
        return match;
      });
    }

    function formatDurationOnlyText(dauer) {
      const minutes = Math.max(0, Math.round(Number(dauer) || 0));
      if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
        return `${minutes} Min`;
      }
      return `gesamte Dauer: ${minutes} Minuten`;
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
    function formatPastTrainTime(plan, actual, dauer, trainDate, now, isCheckedIn = false, canceled = false) {
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
        const isOngoing = isCheckedIn && !(actualTime && dauer);

        // Planned time (strikethrough) is shown only when actual differs from plan.
        if (hasDelay && !isOngoing) {
          const plannedSpan = document.createElement('span');
          plannedSpan.className = 'past-train-planned-time';
          plannedSpan.textContent = planHHMM;
          timeDisplay.appendChild(plannedSpan);
        }

        // Show interval only when a valid duration exists; while still
        // ongoing (checked in, no duration yet) show "von HH:MM" instead.
        const actualSpan = document.createElement('span');
        actualSpan.className = 'past-train-actual-time';
        actualSpan.textContent = isOngoing
          ? `von ${actualHHMM}`
          : (departureHHMM !== '--:--' ? `${actualHHMM} - ${departureHHMM}` : actualHHMM);
        timeDisplay.appendChild(actualSpan);

        animContainer.appendChild(timeDisplay);

        // Departure status display (hidden initially)
        // Always show only "abgefahren"; icon/color indicate check-in status.
        const statusDisplay = document.createElement('div');
        statusDisplay.className = 'past-train-departed-display';

        const statusText = document.createElement('span');
        statusText.className = 'past-status-text';
        statusText.textContent = canceled ? 'Zug fällt aus' : (isOngoing ? 'laufend' : 'abgefahren');
        if (canceled) statusText.classList.add('past-status-text--canceled');
        statusDisplay.appendChild(statusText);

        if (isCheckedIn && !canceled) {
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

      // Checked in, no duration recorded yet ("laufend") — there's no known
      // end time to count down to, so alternate between a "laufend" label
      // and a count-UP of elapsed time instead, sized like the other ribbon
      // labels ("Abfahrt in" / "Ankunft in").
      if (isOpenCheckinOccupying(train, now)) {
        const frag = document.createDocumentFragment();

        const toggle = document.createElement('span');
        toggle.className = 'countdown-laufend-toggle';

        const labelLayer = document.createElement('span');
        labelLayer.className = 'countdown-laufend-label-layer';
        const label = document.createElement('span');
        label.className = 'countdown-label countdown-laufend-label';
        label.textContent = 'laufend';
        labelLayer.appendChild(label);

        const elapsedLayer = document.createElement('span');
        elapsedLayer.className = 'countdown-laufend-elapsed-layer';
        const elapsedTime = document.createElement('span');
        elapsedTime.className = 'countdown-time departing countdown-elapsed-time';
        const elapsedSec = Math.max(0, Math.round((now - actualTime) / 1000));
        elapsedTime.textContent = hms(elapsedSec);
        elapsedLayer.appendChild(elapsedTime);

        toggle.appendChild(labelLayer);
        toggle.appendChild(elapsedLayer);
        frag.appendChild(toggle);

        // No day-boundary superscript needed: the elapsed counter isn't
        // capped at 24h, so hours just keep climbing (e.g. "27:42:10") to
        // represent multi-day sessions on its own.
        return frag;
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
