// === KIOSK SHARED HELPERS ===
// Used by kiosk.html (departure board) and kiosk-control.html (station setup).
// Departures are the /api/db-departures train objects (DB or VVS).

    // Header logo per transport mode (kiosk config `icon` values)
    const KIOSK_STATION_ICONS = {
      sbahn:     { src: 'res/S-Bahn-Logo.svg',              label: 'S-Bahn' },
      stadtbahn: { src: 'res/Logo_Stadtbahn_Stuttgart.svg', label: 'Stadtbahn' },
      zacke:     { src: 'res/zacke.png',                    label: 'Zacke' },
      bus:       { src: 'res/Bus-Logo_VVS.svg',             label: 'Bus' },
      none:      { src: null,                               label: 'Kein Symbol' }
    };

    function kioskEscape(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Transport mode of one departure: 'sbahn' | 'stadtbahn' | 'zacke' | 'bus' | null
    function kioskTransportType(train) {
      const linie = String((train && train.linie) || '').trim();
      const product = String((train && train.product) || '');
      const isVvs = train && train.provider === 'vvs';
      if (/zahnrad/i.test(product) || (isVvs && linie === '10')) return 'zacke';
      if (/^S\s?\d+$/i.test(linie) || /s-bahn/i.test(product)) return 'sbahn';
      if (/stadtbahn/i.test(product) || /^U\d*$/i.test(linie)) return 'stadtbahn';
      if (train && train.bus) return 'bus';
      return null;
    }

    // Most common transport mode among the departures (header logo default)
    function kioskDetectStationIcon(trains) {
      const counts = {};
      (trains || []).forEach(t => {
        const type = kioskTransportType(t);
        if (type) counts[type] = (counts[type] || 0) + 1;
      });
      const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      return best || 'none';
    }

    function kioskPlatformOf(train) {
      return String((train && (train.platform || train.plannedPlatform)) || '').trim();
    }

    // Expected departure (actual if known, else planned) as a Date — to the
    // second when the source provides it (VVS `departureAt`), else HH:mm
    function kioskDepartureTime(train) {
      if (train && train.departureAt) {
        const exact = new Date(train.departureAt);
        if (!Number.isNaN(exact.getTime())) return exact;
      }
      const time = train && (train.actual || train.plan);
      if (!time) return null;
      const [h, m] = String(time).split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      const d = train.date ? new Date(`${train.date}T00:00:00`) : new Date();
      d.setHours(h, m, 0, 0);
      return d;
    }

    // Next `count` departures of one board side: on its platforms (none
    // selected = all), not cancelled, not yet gone — a departure drops out
    // the moment it leaves.
    // Each result carries `reachable`: the walk to the stop fits before it leaves.
    // With `skipUnreachable`, departures leaving more than
    // `unreachableGraceMinutes` before the reachable mark (now + walk) are
    // skipped, so later ones move up (0 = only reachable ones).
    function kioskNextDepartures(trains, side, now, count = 2) {
      const platforms = new Set((side && side.platforms) || []);
      const walkMs = ((side && Number(side.walkMinutes)) || 0) * 60000;
      const earliest = side && side.skipUnreachable
        ? now.getTime() + walkMs - (Number(side.unreachableGraceMinutes) || 0) * 60000
        : -Infinity;
      return (trains || [])
        .filter(t => t && !t.canceled && t.ziel !== 'Ankunft')
        .filter(t => !platforms.size || platforms.has(kioskPlatformOf(t)))
        .map(t => ({ train: t, at: kioskDepartureTime(t) }))
        .filter(x => x.at && x.at.getTime() > now.getTime() && x.at.getTime() >= earliest)
        .sort((a, b) => a.at - b.at)
        .slice(0, count)
        .map(x => ({ ...x, reachable: x.at.getTime() - now.getTime() >= walkMs }));
    }

    // Disruption = significant deviation from the timetable among one board
    // side's departures in the next `KIOSK_DISRUPTION_WINDOW_MIN`: any
    // cancellation, a live incident report, or several clearly late trips.
    // One late trip alone isn't a disruption. Departures without real-time
    // data simply don't count as late.
    const KIOSK_DISRUPTION_WINDOW_MIN = 45;
    const KIOSK_DISRUPTION_DELAY_MIN = 5;
    const KIOSK_DISRUPTION_DELAYED_COUNT = 2;

    // Delay in minutes from HH:mm plan/actual (wraps over midnight)
    function kioskDelayMinutes(train) {
      if (!train || !train.plan || !train.actual) return 0;
      const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
      const diff = toMin(train.actual) - toMin(train.plan);
      return Number.isNaN(diff) ? 0 : ((diff + 720 + 1440) % 1440) - 720;
    }

    function kioskSideDisrupted(trains, side, now) {
      const platforms = new Set((side && side.platforms) || []);
      const until = now.getTime() + KIOSK_DISRUPTION_WINDOW_MIN * 60000;
      const relevant = (trains || [])
        .filter(t => t && t.ziel !== 'Ankunft')
        .filter(t => !platforms.size || platforms.has(kioskPlatformOf(t)))
        .filter(t => {
          const at = kioskDepartureTime(t);
          return at && at.getTime() > now.getTime() && at.getTime() <= until;
        });
      if (relevant.some(t => t.canceled || t.incident)) return true;
      return relevant.filter(t => kioskDelayMinutes(t) >= KIOSK_DISRUPTION_DELAY_MIN).length
        >= KIOSK_DISRUPTION_DELAYED_COUNT;
    }

    // Last departure of the day: no further trip of the same line from the
    // same platform for `KIOSK_LAST_GAP_H` hours. Only judged in the evening
    // and at night (rural lines can have long midday gaps), and only when
    // the fetched departures reach far enough to see that gap — otherwise
    // it stays unmarked rather than guessing.
    const KIOSK_LAST_GAP_H = 3;
    const KIOSK_LAST_FROM_HOUR = 18;
    const KIOSK_LAST_UNTIL_HOUR = 5;

    // Stadtbahn depot runs are labelled just "U": one-off trips, not a line,
    // so "no further U for hours" says nothing about the service ending
    function kioskIsDepotRun(train) {
      return String((train && train.linie) || '').trim().toUpperCase() === 'U';
    }

    function kioskIsLastDeparture(train, trains) {
      const at = kioskDepartureTime(train);
      if (!at || train.canceled || kioskIsDepotRun(train)) return false;
      const hour = at.getHours();
      if (hour < KIOSK_LAST_FROM_HOUR && hour >= KIOSK_LAST_UNTIL_HOUR) return false;
      const gapMs = KIOSK_LAST_GAP_H * 3600000;
      const key = (t) => `${t.linie}|${kioskPlatformOf(t)}`;
      let horizon = 0;
      let next = Infinity;
      for (const t of trains || []) {
        const tAt = kioskDepartureTime(t);
        if (!tAt) continue;
        horizon = Math.max(horizon, tAt.getTime());
        if (t !== train && !t.canceled && key(t) === key(train) && tAt > at) next = Math.min(next, tAt.getTime());
      }
      return next === Infinity ? horizon - at.getTime() >= gapMs : next - at.getTime() >= gapMs;
    }

    // Live departures (DB/VVS board) use the kiosk icon set; the own-schedule
    // rows (Templates.lineIcon) keep the main app's res/ icons. The helpers
    // (hasLineIcon/getLineIconSrc, utils.js) are shared.
    const KIOSK_LINE_ICON_DIR = 'res/kiosk/';

    // Live line symbol: the icon from the kiosk folder (same helpers as the
    // main app, incl. the generated bus hexagon), the Zacke logo, and a text
    // badge for everything else (regional trains) or when a file is missing.
    function kioskLineIconHTML(train) {
      const linie = String((train && train.linie) || '').trim();
      const type = kioskTransportType(train);
      const badge = `<span class="kiosk-line-badge">${kioskEscape(linie)}</span>`;
      const isDigits = /^\d+$/.test(linie);

      let src = null;
      let shape = 'wide';
      if (type === 'zacke') {
        src = `${KIOSK_LINE_ICON_DIR}zacke.png`;
        shape = 'square';
      } else if (isDigits && !isBusLine(train) && train.provider === 'vvs') {
        src = null; // VVS digits are buses or Zacke; the digit SVGs are DB Stadtbahn
      } else if (hasLineIcon(train)) {
        src = getLineIconSrc(train, KIOSK_LINE_ICON_DIR);
        if (isDigits && !isBusLine(train)) shape = 'square';
      }
      if (!src) return badge;

      return `<img class="kiosk-line-icon kiosk-line-icon--${shape}" src="${src}" alt="${kioskEscape(linie)}" onerror="this.outerHTML=this.dataset.fallback" data-fallback="${kioskEscape(badge)}">`;
    }
