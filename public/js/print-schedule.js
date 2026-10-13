// === PRINT SCHEDULE ===
// Exports the personal timetable for a chosen time range as a printable page
// (opened from the settings page, see _buildPrintSection in settings.js).
// The page is built in a new window with its own light, paper-friendly styles
// and the browser's print dialog is opened on it — "Als PDF speichern" there
// doubles as a PDF export.
//
// Source data is schedule.localTrains (the personal schedule, with the live
// curfew/FEX mutations from processTrainData already applied). Recurring stems
// are only materialized for the lookahead window, so dates past that window
// are filled in by projecting the stems here (in-memory only, never saved).

const PRINT_WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function _printPad(n) {
  return String(n).padStart(2, '0');
}

function _printDateStr(d) {
  return `${d.getFullYear()}-${_printPad(d.getMonth() + 1)}-${_printPad(d.getDate())}`;
}

function _printFormatDateTime(d) {
  return `${_printPad(d.getDate())}.${_printPad(d.getMonth() + 1)}.${d.getFullYear()} ${_printPad(d.getHours())}:${_printPad(d.getMinutes())}`;
}

function _printEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Departure of a timed entry as a local Date, or null for untimed ones.
function _printDeparture(train, timeField) {
  const time = train[timeField || 'plan'];
  if (!train.date || typeof time !== 'string' || !/^\d{1,2}:\d{2}$/.test(time.trim())) return null;
  const [h, m] = time.trim().split(':').map(Number);
  const d = new Date(train.date + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d;
}

// Occurrences of recurring stems inside [from, to] that aren't materialized
// yet. Past days are skipped: anything before today already exists as a real
// entry (or was deliberately deleted).
function _projectStemsForPrint(from, to, existing) {
  const covered = new Set(existing
    .filter(t => t._templateId && t.date)
    .map(t => `${t._templateId}|${t.date}`));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay = new Date(Math.max(from.getTime(), today.getTime()));
  firstDay.setHours(0, 0, 0, 0);

  const projected = [];
  for (const stem of (schedule.fixedSchedule || [])) {
    if (!stem._uniqueId || !stem.linie || !stem.linie.trim()) continue;
    const skipped = new Set(stem.skippedDates || []);
    const startDateObj = stem.startDate ? new Date(stem.startDate + 'T00:00:00') : new Date(today);
    startDateObj.setHours(0, 0, 0, 0);

    for (let d = new Date(firstDay); d <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      if (d < startDateObj || !stemMatchesDate(stem, startDateObj, d)) continue;
      const dateStr = _printDateStr(d);
      if (skipped.has(dateStr) || covered.has(`${stem._uniqueId}|${dateStr}`)) continue;
      projected.push({
        _uniqueId: `${stem._uniqueId}_${dateStr}`,
        _templateId: stem._uniqueId,
        type: stem.type,
        linie: stem.linie,
        ziel: stem.ziel || '',
        plan: stem.plan || '',
        actual: stem.plan || undefined,
        dauer: stem.dauer || 0,
        zwischenhalte: Array.isArray(stem.zwischenhalte) ? [...stem.zwischenhalte] : [],
        projectId: stem.projectId || undefined,
        canceled: false,
        date: dateStr
      });
    }
  }
  // Same live curfew rule the app applies to materialized entries.
  if (typeof applyCurfewRule === 'function') applyCurfewRule(projected);
  return projected;
}

// Timed entries whose planned departure falls in [from, to], sorted and
// grouped by day: [{ date, trains }]. Duration-only (FÜSQ) entries are left
// out of the print entirely, as are untimed ones (the list doesn't show those
// either).
function collectTrainsForPrint(from, to, includeCanceled) {
  const base = (schedule.localTrains && schedule.localTrains.length
    ? schedule.localTrains
    : schedule.spontaneousEntries || []).filter(t => t && t.type !== 'note' && t.linie);
  const all = base.concat(_projectStemsForPrint(from, to, base));

  const days = new Map();
  all.forEach(t => {
    if (t.canceled && !includeCanceled) return;
    if (isDurationOnlyTrain(t) || !hasTrainTime(t)) return;
    const dep = _printDeparture(t);
    if (!dep || dep < from || dep > to) return;
    if (!days.has(t.date)) days.set(t.date, { date: t.date, trains: [] });
    days.get(t.date).trains.push(t);
  });

  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => {
      day.trains.sort((a, b) => _printDeparture(a) - _printDeparture(b));
      return day;
    });
}

// One line per stop, as entered in the editor (it splits the field on '\n');
// rendered with white-space: pre-line so the breaks survive into the print.
function _printStopsText(train) {
  const raw = train.zwischenhalte != null ? train.zwischenhalte : train.stops;
  const lines = Array.isArray(raw)
    ? raw.map(s => String(s == null ? '' : s))
    : (typeof raw === 'string' ? raw.split(/\n| • /) : []);
  return lines.join('\n').trim();
}

function _printRow(train) {
  const color = getLineColor(String(train.linie));
  const dep = _printDeparture(train);
  const actual = train.actual && train.actual !== train.plan ? _printDeparture(train, 'actual') : null;

  // A changed time shows the planned one struck through with the actual one beside it.
  let timeCell = '—';
  if (dep) {
    timeCell = actual
      ? `<span class="planned-old">${_printEscape(train.plan)}</span><span class="delay">${_printEscape(train.actual)}</span>`
      : _printEscape(train.plan);
  }

  const stops = _printStopsText(train);

  return `<tr class="${train.canceled ? 'canceled' : ''}">
    <td class="time">${timeCell}</td>
    <td class="line"><span class="badge" style="background:${color}">${_printEscape(train.linie)}</span></td>
    <td class="dest">${_printEscape(expandDestinationPrefix(train.ziel))}${stops ? `<span class="stops">${_printEscape(stops)}</span>` : ''}</td>
  </tr>`;
}

function buildPrintDocument(from, to, days) {
  const total = days.reduce((sum, d) => sum + d.trains.length, 0);
  const rangeText = `${_printFormatDateTime(from)} – ${_printFormatDateTime(to)}`;

  const body = days.length === 0
    ? '<p class="empty">Im gewählten Zeitraum sind keine Fahrten geplant.</p>'
    : days.map(day => {
      const d = new Date(day.date + 'T00:00:00');
      const heading = `${PRINT_WEEKDAYS[d.getDay()]}, ${_printPad(d.getDate())}.${_printPad(d.getMonth() + 1)}.${d.getFullYear()}`;
      const rows = day.trains.map(_printRow).join('');
      return `<section class="day">
        <h2>${heading}</h2>
        <table>
          <thead><tr><th>Zeit</th><th>Linie</th><th>Ziel</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Fahrplan ${_printEscape(rangeText)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; background: #fff; margin: 0; padding: 16px; font-size: 12pt; line-height: 1.35; }
  @media print { body { padding: 0; } }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #161B75; padding-bottom: 6px; margin-bottom: 16px; }
  h1 { font-size: 20pt; margin: 0; color: #161B75; }
  .meta { font-size: 10pt; color: #555; text-align: right; }
  .day { break-inside: auto; margin-bottom: 16px; }
  h2 { font-size: 13.5pt; margin: 0 0 5px; break-after: avoid; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 9.5pt; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #999; padding: 4px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  tr { break-inside: avoid; }
  .time { width: 11%; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .line { width: 8%; }
  .badge { display: inline-block; min-width: 3em; text-align: center; color: #fff; font-weight: 700; font-size: 10.5pt; padding: 1px 6px; border-radius: 3px; }
  .stops { display: block; margin-top: 3px; font-size: 11pt; line-height: 1.5; color: #444; white-space: pre-line; }
  .planned-old { text-decoration: line-through; color: #888; font-weight: 400; }
  .delay { margin-left: 6px; color: #c62828; font-weight: 600; }
  tr.canceled .time, tr.canceled .dest { text-decoration: line-through; color: #888; }
  .empty { color: #555; font-style: italic; }
  footer { margin-top: 10px; font-size: 10pt; color: #777; }
</style>
</head>
<body>
  <header>
    <h1>Fahrplan</h1>
    <div class="meta">${_printEscape(rangeText)}<br>Gedruckt am ${_printFormatDateTime(new Date())}</div>
  </header>
  ${body}
  <footer>${total} ${total === 1 ? 'Eintrag' : 'Einträge'}</footer>
</body>
</html>`;
}

// Returns false if the print window couldn't be opened (popup blocked).
function printScheduleRange(from, to, options) {
  options = options || {};
  const days = collectTrainsForPrint(from, to, options.includeCanceled !== false);
  const html = buildPrintDocument(from, to, days);

  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Give the new document a tick to lay out before the (blocking) dialog opens.
  setTimeout(() => {
    win.focus();
    win.print();
  }, 250);
  return true;
}

window.printScheduleRange = printScheduleRange;
