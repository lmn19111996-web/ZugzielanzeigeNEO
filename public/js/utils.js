// === UTILITY FUNCTIONS ===
// Pure helper functions with no side effects.
    // Folder the line icons (s1.svg, u13.svg, fex.svg, …) are loaded from.
    // The main app uses res/; a page can point it at its own icon set, and
    // getLineIconSrc can take a folder per call (the kiosk's live board uses
    // res/kiosk/ while its own-schedule rows keep res/).
    let lineIconDir = './res/';

    function setLineIconDir(dir) {
      lineIconDir = String(dir || './res/').replace(/\/?$/, '/');
    }

    function getLineIconDir() {
      return lineIconDir;
    }

    function getTrainSVG(line) {
      if (isBusLine(line)) return getBusSVG(line);
      return `${lineIconDir}${line.toLowerCase()}.svg`;
    }

    // === BUS LINES ===
    // Bus numbers ("42", "10") collide with rail line names, so the API's `bus`
    // flag is the source of truth. Line names seen as buses are remembered so
    // call sites that only have the name (e.g. projects, stressmeter) match too.
    const BUS_COLOR = '#e2001a';
    // Replacement buses (API `sev` flag, e.g. S1E) keep the bus hexagon in the
    // SEV colors of sev.svg
    const SEV_BUS_FILL = '#1e1e1e';
    const SEV_BUS_TEXT = '#eab308';
    const knownBusLines = new Set();
    const knownSevBusLines = new Set();

    function registerBusLines(trains) {
      (trains || []).forEach(t => {
        if (!t || !t.linie) return;
        const l = String(t.linie).toLowerCase();
        if (t.bus) knownBusLines.add(l);
        if (t.sev) knownSevBusLines.add(l);
      });
    }

    // Any replacement service: the plain "SEV" line or a replacement bus (S1E, …)
    function isErsatzverkehr(lineOrTrain) {
      const linie = lineOrTrain && typeof lineOrTrain === 'object' ? lineOrTrain.linie : lineOrTrain;
      return String(linie || '').trim().toUpperCase() === 'SEV' || isSevBus(lineOrTrain);
    }

    // Replacement bus with its own label (not the plain "SEV" line)
    function isSevBus(lineOrTrain) {
      if (lineOrTrain && typeof lineOrTrain === 'object') {
        if (typeof lineOrTrain.sev === 'boolean') return lineOrTrain.sev && isBusLine(lineOrTrain);
        lineOrTrain = lineOrTrain.linie;
      }
      return typeof lineOrTrain === 'string' && knownSevBusLines.has(lineOrTrain.toLowerCase());
    }

    // Accepts a train object or a bare line name. Night (N…) and express (X…)
    // lines are buses even without API data. SEV keeps its own icon.
    function isBusLine(lineOrTrain) {
      if (lineOrTrain && typeof lineOrTrain === 'object') {
        if (typeof lineOrTrain.bus === 'boolean' && String(lineOrTrain.linie || '').toUpperCase() !== 'SEV') {
          return lineOrTrain.bus;
        }
        lineOrTrain = lineOrTrain.linie;
      }
      if (typeof lineOrTrain !== 'string' || !lineOrTrain) return false;
      const l = lineOrTrain.toLowerCase();
      if (l === 'sev') return false;
      return knownBusLines.has(l) || /^[nx]\d+$/.test(l);
    }

    // Whether a line has an image icon (rail SVG file or generated bus hexagon)
    function hasLineIcon(lineOrTrain) {
      if (isBusLine(lineOrTrain)) return true;
      const linie = lineOrTrain && typeof lineOrTrain === 'object' ? lineOrTrain.linie : lineOrTrain;
      if (typeof linie !== 'string') return false;
      const u = linie.toUpperCase();
      return /^[SU]\d+/.test(u) || u === 'U' || u === 'FEX' || u === 'SEV' || /^\d+$/.test(u);
    }

    // Icon src for a train object: respects its own bus flag over the name.
    // `dir` overrides the page's icon folder for this one call.
    function getLineIconSrc(lineOrTrain, dir = lineIconDir) {
      const linie = lineOrTrain && typeof lineOrTrain === 'object' ? lineOrTrain.linie : lineOrTrain;
      if (isBusLine(lineOrTrain)) return getBusSVG(linie, isSevBus(lineOrTrain));
      return `${dir}${String(linie || '').toLowerCase()}.svg`;
    }

    // Red hexagon with white label (SEV: dark with yellow label), same 3:2 box
    // as the U-line icons
    const busSvgCache = new Map();
    function getBusSVG(line, sev = isSevBus(line)) {
      const label = String(line || '').toUpperCase();
      const key = (sev ? 'sev:' : '') + label;
      if (busSvgCache.has(key)) return busSvgCache.get(key);
      const esc = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Same text scale as the U-line icons (90) for every label; long labels
      // widen the hexagon instead of squeezing the text. Width estimate:
      // ~0.56em per Bahnschrift glyph + room for the slanted ends.
      const size = 90;
      const y = Math.round(50 + size * 0.067);
      const w = Math.max(150, Math.ceil(label.length * size * 0.56 + 38));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="100" viewBox="0 0 ${w} 100">`
        + `<polygon points="24,0 ${w - 24},0 ${w},50 ${w - 24},100 24,100 0,50" fill="${sev ? SEV_BUS_FILL : BUS_COLOR}"/>`
        + `<text x="${w / 2}" y="${y}" font-size="${size}" text-anchor="middle" dominant-baseline="middle" fill="${sev ? SEV_BUS_TEXT : '#ffffff'}" font-family="Bahnschrift, sans-serif">${esc}</text>`
        + '</svg>';
      const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      busSvgCache.set(key, uri);
      return uri;
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
        's91': '#3d3db8',
        's92': '#00727a',
        's93': '#f07167',
        's94': '#5e2750',
        's95': '#5f7385',
        's96': '#1b2a5c',
        's97': '#5c3b23',
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
        '17': '#72bf43',
        'u': '#0068b4',
        'u1': '#d09a72',
        'u2': '#ec7a32',
        'u3': '#9a6034',
        'u4': '#7b5fa8',
        'u5': '#1fb1e6',
        'u6': '#e3157f',
        'u7': '#1aa486',
        'u8': '#c4b68a',
        'u9': '#fdd31e',
        'u12': '#8bb8e2',
        'u13': '#f49fb0',
        'u14': '#6cb33f',
        'u15': '#0d5aa7',
        'u16': '#c6cc3c',
        'u19': '#fbb535'

      };
      if (isSevBus(line)) return lineColors.sev;
      if (isBusLine(line)) return BUS_COLOR;
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
      s91: shineGradientStops('#3d3db8'), // indigo
      s92: shineGradientStops('#00727a'), // petrol
      s93: shineGradientStops('#f07167'), // coral
      s94: shineGradientStops('#5e2750'), // aubergine
      s95: shineGradientStops('#5f7385'), // slate
      s96: shineGradientStops('#1b2a5c'), // navy
      s97: shineGradientStops('#5c3b23'), // chocolate
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

    // True when a (non-cancelled) train departs/arrives within the next
    // `windowMin` minutes — drives the blinking indicator dot. Defaults to the
    // notification lead time (Einstellungen → Vorlaufzeit).
    function isArrivingSoon(train, now = new Date(), windowMin) {
      if (!train || train.canceled) return false;
      if (windowMin == null) {
        const lead = window.AppSettings ? Number(window.AppSettings.get('notificationLeadMin')) : NaN;
        windowMin = lead > 0 ? lead : 20;
      }
      const t = parseTime(train.actual || train.plan, now, train.date);
      if (!t) return false;
      const diff = t - now;
      return diff > 0 && diff <= windowMin * 60000;
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

    // ===== MARQUEES =====
    // Two JS-driven tickers (no CSS @keyframes), both self-measuring: callers
    // only pass the span (an inline-block inside its clipping container) and
    // the text. Each decides by itself whether the text overflows, and refits
    // whenever the container's width changes - even without a re-render (e.g.
    // a drawer closing): it starts when the text starts overflowing and stops
    // (plain text) as soon as it fits again. Cancel with span._marqueeCancel().
    //
    // Performance: a drawer opening resizes every marquee in the list at once.
    // So refits are (a) collected by ONE shared ResizeObserver and flushed
    // together once the widths have been stable for MARQUEE_SETTLE_MS, (b) fed
    // the width from the observer entry (no layout read), and (c) write-only:
    // text widths are measured once when a marquee starts, never on a refit -
    // otherwise each refit would force a full layout of the list.
    //
    // Scroll speed in px/s. 40 suits the app's small text; a page with much
    // larger text (kiosk.html) can set window.marqueeSpeedFor(span) to scale it.
    function marqueeSpeed(span) {
      const custom = typeof window.marqueeSpeedFor === 'function' ? Number(window.marqueeSpeedFor(span)) : NaN;
      return custom > 0 ? custom : 40;
    }

    // Visible width = content box of the container (its padding is not part
    // of the clipped text area). Only read when a marquee starts.
    // Everything here is measured with fractional precision: clientWidth /
    // scrollWidth are rounded to whole pixels, so a text 48.7px wide in a
    // 48.7px field read as 49 > 48.7 - "overflowing" - and in a field sized by
    // its content (week slide-out) that toggled the ticker on and off forever.
    function marqueeAvailableWidth(container) {
      const cs = getComputedStyle(container);
      return container.getBoundingClientRect().width
        - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
        - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    }

    function marqueeTextWidth(span) {
      return span.getBoundingClientRect().width;
    }

    // Sub-pixel slack so layout rounding never counts as overflow.
    function marqueeFits(textWidth, width) {
      return textWidth <= width + 0.5;
    }

    const MARQUEE_SETTLE_MS = 150;
    const marqueeWatchers = new Map();      // container -> Set of watchers
    const marqueePendingWidths = new Map(); // container -> latest content width
    let marqueeFlushTimer = null;
    let marqueeSweepTimer = null;

    const marqueeResizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(entries => {
          entries.forEach(entry => marqueePendingWidths.set(entry.target, entry.contentRect.width));
          clearTimeout(marqueeFlushTimer);
          marqueeFlushTimer = setTimeout(flushMarqueeWidths, MARQUEE_SETTLE_MS);
        })
      : null;

    function flushMarqueeWidths() {
      marqueeFlushTimer = null;
      const pending = [...marqueePendingWidths];
      marqueePendingWidths.clear();
      pending.forEach(([container, width]) => {
        const watchers = marqueeWatchers.get(container);
        if (watchers) [...watchers].forEach(w => w.resize(width));
      });
    }

    // Re-renders replace spans without cancelling them; drop watchers whose
    // span left the DOM so their containers aren't observed forever.
    function sweepMarqueeWatchers() {
      marqueeSweepTimer = null;
      marqueeWatchers.forEach(watchers => watchers.forEach(w => {
        if (!w.span.isConnected) w.cancel();
      }));
    }

    function unwatchMarquee(watcher) {
      const watchers = marqueeWatchers.get(watcher.container);
      if (!watchers) return;
      watchers.delete(watcher);
      if (!watchers.size) {
        marqueeWatchers.delete(watcher.container);
        marqueePendingWidths.delete(watcher.container);
        if (marqueeResizeObserver) marqueeResizeObserver.unobserve(watcher.container);
      }
    }

    // Shared lifecycle: fit(width) runs now and after every settled width
    // change (changes under 1px are ignored), and span._marqueeCancel stops
    // watching + runs cleanup().
    function watchMarqueeWidth(span, container, fit, cleanup) {
      let lastWidth = marqueeAvailableWidth(container);
      const watcher = {
        span,
        container,
        resize(width) {
          if (!span.isConnected) { watcher.cancel(); return; }
          if (Math.abs(width - lastWidth) < 1) return;
          lastWidth = width;
          fit(width);
        },
        cancel() {
          unwatchMarquee(watcher);
          if (span._marqueeCancel === watcher.cancel) span._marqueeCancel = null;
          cleanup();
        }
      };
      span._marqueeCancel = watcher.cancel;

      fit(lastWidth);

      if (!marqueeWatchers.has(container)) {
        marqueeWatchers.set(container, new Set());
        // Observing fires once right away; resize() ignores it (same width).
        if (marqueeResizeObserver) marqueeResizeObserver.observe(container);
      }
      marqueeWatchers.get(container).add(watcher);
      if (!marqueeSweepTimer) marqueeSweepTimer = setTimeout(sweepMarqueeWatchers, 1000);
    }

    // Bounce ticker: scrolls from the start to the end, pauses, jumps back,
    // pauses, repeats. `scrollText` (default: `text`) is what's shown while
    // scrolling, e.g. the dashboard's "+++ via +++" markers. Any width change
    // restarts from the start with a fresh distance - the old one would leave
    // a gap at the end (field grew) or cut the end off (field shrank).
    function startMarquee(span, text, scrollText = text) {
      if (typeof span._marqueeCancel === 'function') span._marqueeCancel();
      const container = span.parentElement;
      if (!container || !text) return;

      const SPEED = marqueeSpeed(span); // px per second (slow scroll)
      const PAUSE = 3000; // ms pause at start and end
      let timers = [];
      let stopped = false;
      const isStopped = () => stopped || !span.isConnected;

      function showPlain() {
        timers.forEach(clearTimeout);
        timers = [];
        span.style.transition = 'none';
        span.style.transform = '';
        span.textContent = text;
      }

      // Measured once; refits only compare against the new width.
      showPlain();
      const textWidth = marqueeTextWidth(span);
      span.textContent = scrollText;
      const scrollTextWidth = marqueeTextWidth(span);

      function cycle(scrollDist) {
        if (isStopped()) return;
        const scrollDuration = Math.round((scrollDist / SPEED) * 1000);
        span.style.transition = 'none';
        span.style.transform = 'translateX(0)';
        timers.push(setTimeout(() => {
          if (isStopped()) return;
          span.style.transition = `transform ${scrollDuration}ms linear`;
          span.style.transform = `translateX(-${scrollDist}px)`;
          timers.push(setTimeout(() => {
            if (isStopped()) return;
            timers.push(setTimeout(() => cycle(scrollDist), PAUSE));
          }, scrollDuration));
        }, PAUSE));
      }

      function fit(width) {
        showPlain();
        if (marqueeFits(textWidth, width)) return; // fits - no ticker
        const scrollDist = scrollTextWidth - width;
        if (scrollDist <= 0) return;
        span.textContent = scrollText;
        cycle(scrollDist);
      }

      watchMarqueeWidth(span, container, fit, () => { stopped = true; showPlain(); });
    }

    // Seamless infinite ticker (cancel notices, headline, information bars):
    // while `text` overflows, the span holds back-to-back copies of
    // `text + separator` and scrolls left by exactly one copy, then snaps
    // back to translateX(0) - invisible, since the next copy now sits where
    // the first one started. No pause/reverse, unlike startMarquee.
    //
    // Copy count: at the end of a loop the span is shifted by one copy, so
    // the copies must still cover one copy + the whole visible width, i.e.
    // ceil(width / copy) + 1 (never fewer than 2). On a width change while
    // scrolling, only the copy count moves - the loop length is the same, so
    // the animation keeps running from where it is.
    function startInfiniteMarquee(span, text, separator = '   +++   ') {
      if (typeof span._marqueeCancel === 'function') span._marqueeCancel();
      const container = span.parentElement;
      if (!container || !text) return;

      const SPEED = marqueeSpeed(span); // px per second, consistent with startMarquee
      let stopped = false;
      let running = false;
      const isStopped = () => stopped || !span.isConnected;

      function onTransitionEnd(e) {
        if (e.propertyName !== 'transform' || isStopped()) return;
        step();
      }

      function showPlain() {
        running = false;
        span.removeEventListener('transitionend', onTransitionEnd);
        span.style.transition = 'none';
        span.style.transform = '';
        span.textContent = text;
      }

      // Measured once; refits only compare against the new width.
      showPlain();
      // The copy width is measured as width(2 copies) - width(1 copy): with
      // nowrap, a trailing space at the end of a line isn't counted, but the
      // same space between two copies is - measuring one copy alone would make
      // every loop wrap a space short.
      const textWidth = marqueeTextWidth(span);
      span.textContent = text + separator;
      const oneCopyWidth = marqueeTextWidth(span);
      span.textContent = text + separator + text + separator;
      const segmentWidth = marqueeTextWidth(span) - oneCopyWidth;
      span.textContent = text;

      function step() {
        if (isStopped()) return;
        span.style.transition = 'none';
        span.style.transform = 'translateX(0)';
        // Force reflow so the browser registers the reset before the next
        // transition starts (otherwise it can be coalesced away).
        void span.offsetWidth;
        span.style.transition = `transform ${Math.round((segmentWidth / SPEED) * 1000)}ms linear`;
        span.style.transform = `translateX(-${segmentWidth}px)`;
      }

      function fillCopies(width) {
        const copies = Math.max(2, Math.ceil(width / segmentWidth) + 1);
        span.textContent = (text + separator).repeat(copies);
      }

      function fit(width) {
        if (marqueeFits(textWidth, width)) { showPlain(); return; } // fits - no ticker
        fillCopies(width);
        if (running) return; // keeps running from where it is
        running = true;
        span.addEventListener('transitionend', onTransitionEnd);
        step();
      }

      watchMarqueeWidth(span, container, fit, () => { stopped = true; showPlain(); });
    }

    function isDurationOnlyTrain(train) {
      return !!train && train.type === 'duration-only';
    }

    // Information entries (type: 'information') are plain announcement texts
    // stored in `ziel`, valid from `date` through `dateEnd` (inclusive,
    // YYYY-MM-DD; missing = just that day) or every day from `date` on when
    // `openEnded` ("Kein Enddatum"). No time, line or duration - they never
    // act like a trip. A recurring information's template (fixedSchedule)
    // repeats single-day occurrences from startDate through endDate (or
    // forever when openEnded / without endDate).
    function isInformationTrain(train) {
      return !!train && train.type === 'information';
    }

    // Symbols an information can show (`icon` field; missing = 'information').
    // Order = editor dropdown order. Glyphs live in res/ (see .info-glyph--*).
    const INFORMATION_ICONS = [
      { value: 'information',   label: 'Information' },
      { value: 'stoerung',      label: 'Störung' },
      { value: 'ersatzverkehr', label: 'Ersatzverkehr' }
    ];

    function getInformationIcon(train) {
      const icon = train && train.icon;
      return INFORMATION_ICONS.some(i => i.value === icon) ? icon : 'information';
    }

    // Far-future stand-in for "no end": keeps every YYYY-MM-DD comparison
    // (still valid?, covers this day?, prune) working unchanged.
    const INFORMATION_OPEN_END = '9999-12-31';

    // Last day an information shows. `openEnded` ("Kein Enddatum" in the
    // editor) = every day from its start, forever. Without it, a missing or
    // earlier dateEnd means just the start day.
    function getInformationEndDate(train) {
      if (!train || !train.date) return '';
      if (train.openEnded) return INFORMATION_OPEN_END;
      return train.dateEnd && train.dateEnd > train.date ? train.dateEnd : train.date;
    }

    function informationCoversDate(train, dateStr) {
      return !!train && !!train.date && train.date <= dateStr && getInformationEndDate(train) >= dateStr;
    }

    // The informations to show on one day, each series at most once (guards
    // against a series occurrence and a leftover entry of the same template
    // on one day; the one that started most recently wins).
    function getInformationsForDay(infos, dateStr) {
      const byTemplate = new Map();
      (infos || []).forEach(info => {
        if (!informationCoversDate(info, dateStr)) return;
        const key = info._templateId || info._uniqueId;
        const shown = byTemplate.get(key);
        if (!shown || info.date > shown.date) byTemplate.set(key, info);
      });
      return [...byTemplate.values()];
    }

    // YYYY-MM-DD in local time. Use this instead of toISOString(), which is
    // UTC and still reports the previous day for the first hours after midnight.
    function toLocalDateStr(date = new Date()) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    // Message as shown in the list/Belegungsplan: multi-day entries get a
    // "Von DD.MM bis DD.MM:" prefix, unless hideDateRange is set in the editor.
    function formatInformationText(train) {
      const text = (train && train.ziel || '').trim();
      const endDate = getInformationEndDate(train);
      if (!endDate || endDate === train.date || train.hideDateRange) return text;
      const ddmm = (s) => { const [, m, d] = s.split('-'); return `${d}.${m}`; };
      if (train.openEnded) return `Ab ${ddmm(train.date)}: ${text}`;
      return `Von ${ddmm(train.date)} bis ${ddmm(endDate)}: ${text}`;
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
