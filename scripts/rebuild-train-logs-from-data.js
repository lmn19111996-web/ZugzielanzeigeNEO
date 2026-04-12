const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'public', 'data.json');
const LOG_DIR = path.join(ROOT, 'train_logs');
const LAST_LOG_TIME_FILE = path.join(LOG_DIR, '.last_log_time');
const SCHEMA_VERSION = 3;

function fmtYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getWeekIdentifier(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeKeyPart(v) {
  return normalizeText(v).toLowerCase() || 'unknown';
}

function normalizeStops(rawStops) {
  if (Array.isArray(rawStops)) {
    return rawStops.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof rawStops === 'string') {
    return rawStops
      .split(/\n|\u2022|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function weekdayToCurrentWeekDate(weekdayName) {
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDay = weekdays.indexOf(String(weekdayName || '').toLowerCase());
  if (targetDay === -1) return '';

  const today = new Date();
  const currentDay = today.getDay();
  let daysDiff = targetDay - currentDay;
  if (daysDiff < 0) daysDiff += 7;

  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + daysDiff);
  return fmtYYYYMMDD(targetDate);
}

function resolveServiceDate(train, sourceType) {
  if (train && typeof train.date === 'string' && train.date) return train.date;
  if (train && typeof train.plannedDate === 'string' && train.plannedDate) return train.plannedDate;
  if (sourceType === 'fixed' && train && typeof train.startDate === 'string' && train.startDate) return train.startDate;
  if (sourceType === 'fixed' && train && typeof train.weekday === 'string' && train.weekday) {
    return weekdayToCurrentWeekDate(train.weekday) || '';
  }
  return '';
}

function resolveServiceTime(train) {
  const actual = normalizeText(train && train.actual);
  const plan = normalizeText(train && train.plan);
  return actual || plan || '';
}

function buildCanonicalRecordId(train, sourceType, serviceDate, serviceTime) {
  const uid = normalizeText(train && train._uniqueId);
  if (uid) return `${sourceType}|uid|${uid}`;

  const linie = normalizeKeyPart(train && train.linie);
  const ziel = normalizeKeyPart(train && train.ziel);
  const time = normalizeKeyPart(serviceTime || 'notime');
  const date = normalizeKeyPart(serviceDate || 'unknown');
  const type = normalizeKeyPart(train && train.type);
  const project = normalizeKeyPart(train && train.projectId);
  return `${sourceType}|sig|${linie}|${ziel}|${time}|${date}|${type}|${project}`;
}

function toRecord(train, sourceType, projectNameById, nowIso) {
  const serviceDate = resolveServiceDate(train, sourceType);
  if (!serviceDate) return null;

  const serviceTime = resolveServiceTime(train);
  const recordId = buildCanonicalRecordId(train, sourceType, serviceDate, serviceTime);
  const zwischenhalte = normalizeStops(train && (train.zwischenhalte != null ? train.zwischenhalte : train.stops));
  const projectId = normalizeText(train && train.projectId) || null;

  return {
    schemaVersion: SCHEMA_VERSION,
    recordId,
    trainKey: recordId,
    scheduleType: sourceType,
    loggedAt: nowIso,
    serviceDate,
    serviceTime,
    _uniqueId: normalizeText(train && train._uniqueId) || null,
    _templateId: normalizeText(train && train._templateId) || null,
    projectId,
    projectName: projectId && projectNameById[projectId] ? projectNameById[projectId] : null,
    type: normalizeText(train && train.type) || null,
    linie: normalizeText(train && train.linie),
    ziel: normalizeText(train && train.ziel),
    plan: normalizeText(train && train.plan),
    actual: normalizeText(train && train.actual),
    dauer: Number(train && train.dauer) || 0,
    zwischenhalte,
    stops: zwischenhalte.join(' • '),
    date: serviceDate,
    plannedDate: serviceDate,
    canceled: Boolean(train && train.canceled),
    checkinTime: (train && train.checkinTime) || null,
    checkoutTime: (train && train.checkoutTime) || null,
    recurrence: (train && train.recurrence) || null,
    startDate: (train && train.startDate) || null,
    skippedDates: Array.isArray(train && train.skippedDates) ? train.skippedDates.slice() : []
  };
}

function recordTimestampMs(record) {
  const dateStr = normalizeText(record.serviceDate || record.date || record.plannedDate);
  const timeStr = normalizeText(record.serviceTime || record.actual || record.plan);
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(timeStr);
  if (dateStr && m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const dt = new Date(`${dateStr}T00:00:00`);
      if (!Number.isNaN(dt.getTime())) {
        dt.setHours(hh, mm, 0, 0);
        return dt.getTime();
      }
    }
  }
  const fallback = new Date(record.loggedAt || '').getTime();
  return Number.isFinite(fallback) ? fallback : Number.POSITIVE_INFINITY;
}

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`data.json not found: ${DATA_FILE}`);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const fixed = Array.isArray(data.fixedSchedule) ? data.fixedSchedule : [];
  const spontaneous = Array.isArray(data.spontaneousEntries) ? data.spontaneousEntries : [];
  const legacyTrains = Array.isArray(data.trains) ? data.trains : [];
  const projects = Array.isArray(data.projects) ? data.projects : [];

  const projectNameById = Object.fromEntries(
    projects
      .filter((p) => p && p._uniqueId)
      .map((p) => [String(p._uniqueId), typeof p.name === 'string' ? p.name : ''])
  );

  const nowIso = new Date().toISOString();
  const todayStr = fmtYYYYMMDD(new Date());

  const byWeek = new Map(); // Map<weekId, Map<recordId, record>>

  function addTrain(train, sourceType) {
    if (!train || typeof train !== 'object') return;
    if (sourceType === 'fixed' && train.recurrence) return; // stem template

    const serviceDate = resolveServiceDate(train, sourceType);
    if (!serviceDate) return;
    if (serviceDate > todayStr) return; // no future history

    const record = toRecord(train, sourceType, projectNameById, nowIso);
    if (!record) return;

    const weekId = getWeekIdentifier(new Date(`${serviceDate}T12:00:00`));
    if (!byWeek.has(weekId)) byWeek.set(weekId, new Map());
    byWeek.get(weekId).set(record.recordId, record);
  }

  fixed.forEach((t) => addTrain(t, 'fixed'));
  spontaneous.forEach((t) => addTrain(t, 'spontaneous'));
  legacyTrains.forEach((t) => addTrain(t, 'spontaneous'));

  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Remove all existing weekly log files first.
  const existing = fs.readdirSync(LOG_DIR).filter((f) => /^train_history_.+\.log$/.test(f));
  existing.forEach((f) => fs.unlinkSync(path.join(LOG_DIR, f)));

  // Write rebuilt files.
  let total = 0;
  const writtenWeeks = [];
  const weeks = Array.from(byWeek.keys()).sort();
  weeks.forEach((weekId) => {
    const records = Array.from(byWeek.get(weekId).values())
      .sort((a, b) => recordTimestampMs(a) - recordTimestampMs(b));
    if (!records.length) return;

    const filePath = path.join(LOG_DIR, `train_history_${weekId}.log`);
    const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
    total += records.length;
    writtenWeeks.push(`${weekId}:${records.length}`);
  });

  fs.writeFileSync(LAST_LOG_TIME_FILE, Date.now().toString(), 'utf8');

  console.log(`Rebuild complete. Weeks=${writtenWeeks.length} Records=${total}`);
  if (writtenWeeks.length) {
    console.log(`Weeks detail: ${writtenWeeks.join(', ')}`);
  }
}

main();
