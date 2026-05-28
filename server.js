// Express server to fetch DB Timetables API and feed the frontend
// Endpoints:
// - GET /api/db-departures -> { trains: [...] }
// - GET /api/db-raw        -> raw parsed XML from DB API (for debugging)
// - GET /api/schedule      -> serves fallback JSON from public/data.json
// - GET /api/health        -> health status
// - GET /events            -> Server-Sent Events (emits {event: 'update'})
// - Static files from /public

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const express = require('express');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const webPush = require('web-push');

// --- Config ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_EVA = process.env.EVA || '8000152'; // Hannover Hbf by default
const TRAIN_LOG_DIR = path.join(__dirname, 'train_logs');
const LAST_LOG_TIME_FILE = path.join(__dirname, 'train_logs', '.last_log_time');
const CUSTOM_TIMETABLE_FILE = path.join(__dirname, 'custom_timetable.json');
const LOG_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every 1 hour
const TRAIN_LOG_SCHEMA_VERSION = 3;

// In-memory accumulator for pending log records (keyed by week)
const pendingTrainData = new Map(); // Map<weekId, Map<recordId, logRecord>>

// Cache for schedule data to avoid disk reads on every request
let scheduleCache = null;
let scheduleCacheTime = 0;

// Load API keys from key.env (simple parser) if env vars are not already set
const keyEnvPath = path.join(__dirname, 'key.env');
if (!process.env.DB_CLIENT_ID || !process.env.DB_API_KEY) {
  try {
    if (fs.existsSync(keyEnvPath)) {
      const content = fs.readFileSync(keyEnvPath, 'utf8');
      content.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) {
          const [, k, v] = m;
          if (!process.env[k]) process.env[k] = v;
        }
      });
      console.log('Loaded API keys from key.env');
    }
  } catch (e) {
    console.warn('Could not read key.env:', e.message);
  }
}

// === WEB PUSH ===
const PUSH_SUBS_FILE  = path.join(__dirname, 'push_subscriptions.json');
const PUSH_EVENTS_FILE = path.join(__dirname, 'push_events.json');
// In-memory pending push timeouts: Map<eventId, { handle, event }>
const pendingPushTimeouts = new Map();

// Load VAPID keys (already in process.env from key.env loader above)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    'mailto:push@zugzielanzeige.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('🔔 VAPID keys loaded');
} else {
  console.warn('⚠️  VAPID keys not set — Web Push disabled');
}

function loadPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE))
      return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
  } catch {}
  return [];
}

function savePushSubscriptions(subs) {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(subs, null, 2), 'utf8');
}

async function sendPushToAll(title, options) {
  if (!process.env.VAPID_PUBLIC_KEY) {
    console.warn('[Push] sendPushToAll called but VAPID not configured');
    return;
  }
  const subs = loadPushSubscriptions();
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try {
      await webPush.sendNotification(sub, JSON.stringify({ title, options }));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        dead.push(sub.endpoint);
      } else {
        console.warn(`[Push] Delivery failed (${err.statusCode}): ${err.message}`);
      }
    }
  }));
  if (dead.length) {
    const cleaned = subs.filter(s => !dead.includes(s.endpoint));
    savePushSubscriptions(cleaned);
  }
}

function schedulePushEvents(events) {
  // Cancel previous timeouts
  pendingPushTimeouts.forEach(({ handle }) => clearTimeout(handle));
  pendingPushTimeouts.clear();

  const now = Date.now();
  (events || []).forEach(ev => {
    const fireAt = new Date(ev.notifyAt).getTime();
    const delay = fireAt - now;
    if (delay < -60000) return; // already more than 1 min past — skip
    const clampedDelay = Math.max(0, delay);
    const handle = setTimeout(async () => {
      await sendPushToAll(ev.title, ev.options);
      pendingPushTimeouts.delete(ev.id);
    }, clampedDelay);
    pendingPushTimeouts.set(ev.id, { handle, event: ev });
  });
}

// Restore push events that survived a server restart
(async () => {
  try {
    if (fs.existsSync(PUSH_EVENTS_FILE)) {
      const events = JSON.parse(fs.readFileSync(PUSH_EVENTS_FILE, 'utf8'));
      schedulePushEvents(events);
    }
  } catch (e) {
    console.warn('Could not restore push events:', e.message);
  }
})();

// === END WEB PUSH INIT ===

const DB_API_BASE = 'https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1';
const dbClient = axios.create({
  baseURL: DB_API_BASE,
  timeout: 15000,
  headers: {
    'DB-Client-Id': process.env.DB_CLIENT_ID || '',
    'DB-Api-Key': process.env.DB_API_KEY || '',
    Accept: 'application/xml',
  },
  // Disable decompression issues on some proxies
  decompress: true,
  validateStatus: (s) => s >= 200 && s < 500,
});

// --- Helpers ---
function toYyMmDd(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function toHour(date = new Date()) {
  return String(date.getHours()).padStart(2, '0');
}

// Parse DB Timetables 10-digit time to JS Date
// Format: YYMMddHHmm (e.g., 2510171014)
function parseDbTimeTenDigits(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [_, yy, MM, dd, HH, mm] = m;
  const year = 2000 + Number(yy);
  return new Date(year, Number(MM) - 1, Number(dd), Number(HH), Number(mm), 0, 0);
}

function fmtHHmm(d) {
  if (!d) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtYYYYMMDD(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Normalize possibly-singleton or missing arrays
function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

// Prune spontaneousEntries: remove past entries that have no projectId
// These are already archived in weekly .log files and have zero runtime value.
function pruneExpiredEntries(spontaneousEntries) {
  if (!Array.isArray(spontaneousEntries)) return [];
  const todayStr = fmtYYYYMMDD(new Date());
  const now = new Date();
  const before = spontaneousEntries.length;
  const pruned = spontaneousEntries.filter(t => {
    // Notes are intentionally persistent and must not be auto-pruned.
    if (t.type === 'note' || String(t.linie || '').toUpperCase() === 'NOTE') return true;

    // Past project train with dauer 0: treat as non-project for prune logic,
    // but do not mutate the original object in-place.
    let effectiveProjectId = t.projectId;
    if (effectiveProjectId && t.date && t.date < todayStr && (Number(t.dauer) || 0) === 0) {
      effectiveProjectId = null;
    }
    if (!t.date) return true;           // no date = note/undated, keep
    if (effectiveProjectId) return true; // project task, always keep
    if (t.date >= todayStr) return true; // today or future, always keep
    // Past date, no project: keep only if end time (plan/actual + dauer) is still in the future
    const timeStr = t.actual || t.plan;
    const m = timeStr && timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const [yy, mo, dd] = t.date.split('-').map(Number);
    const end = new Date(yy, mo - 1, dd, Number(m[1]), Number(m[2]), 0, 0);
    end.setMinutes(end.getMinutes() + (Number(t.dauer) || 0));
    return end > now;
  });
  const removed = before - pruned.length;
  if (removed > 0) {
    console.log(`🧹 Pruned ${removed} expired entries (past, no projectId, already ended) from spontaneousEntries`);
  }
  return pruned;
}

// Get weekday name from date
function getWeekdayName(date) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
}

// Convert weekday to next occurrence (0-6 days ahead, always in the future)
function weekdayToCurrentWeekDate(weekdayName) {
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDay = weekdays.indexOf(weekdayName.toLowerCase());
  
  if (targetDay === -1) return null;
  
  const today = new Date();
  const currentDay = today.getDay();
  
  // Calculate days until next occurrence (0-6 days)
  let daysDiff = targetDay - currentDay;
  
  // If the weekday already passed this week, schedule for next week
  if (daysDiff < 0) {
    daysDiff += 7;
  }
  
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + daysDiff);
  
  return fmtYYYYMMDD(targetDate);
}

// Get ISO week number (1-53) and year
function getWeekIdentifier(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Get weekly log file path (directory is created on startup, no need for sync check)
function getWeeklyLogFile(date = new Date()) {
  const weekId = getWeekIdentifier(date);
  return path.join(TRAIN_LOG_DIR, `train_history_${weekId}.log`);
}

function normalizeSourceType(scheduleType) {
  const v = String(scheduleType || '').toLowerCase();
  if (v === 'fixed' || v === 'spontaneous') return v;
  return 'spontaneous';
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeKeyPart(value) {
  return normalizeText(value).toLowerCase() || 'unknown';
}

function isRecurringStem(train, sourceType) {
  return sourceType === 'fixed' && !!(train && train.recurrence);
}

function resolveLogServiceDate(train, sourceType) {
  if (train && typeof train.date === 'string' && train.date) return train.date;
  if (train && typeof train.plannedDate === 'string' && train.plannedDate) return train.plannedDate;
  if (sourceType === 'fixed' && train && typeof train.startDate === 'string' && train.startDate) return train.startDate;
  if (sourceType === 'fixed' && train && typeof train.weekday === 'string' && train.weekday) {
    return weekdayToCurrentWeekDate(train.weekday) || '';
  }
  return '';
}

function resolveLogServiceTime(train) {
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

function buildLogRecordV3(train, sourceType, additionalInfo = {}) {
  const serviceDate = resolveLogServiceDate(train, sourceType);
  if (!serviceDate) return null;

  const serviceTime = resolveLogServiceTime(train);
  const nowIso = new Date().toISOString();
  const projectNameById = additionalInfo && typeof additionalInfo.projectNameById === 'object'
    ? additionalInfo.projectNameById
    : null;
  const zwischenhalte = normalizeStops(train && (train.zwischenhalte != null ? train.zwischenhalte : train.stops));
  const source = normalizeSourceType(sourceType);
  const recordId = buildCanonicalRecordId(train, source, serviceDate, serviceTime);

  return {
    schemaVersion: TRAIN_LOG_SCHEMA_VERSION,
    recordId,
    trainKey: recordId,
    scheduleType: source,
    loggedAt: nowIso,
    serviceDate,
    serviceTime,
    _uniqueId: normalizeText(train && train._uniqueId) || null,
    _templateId: normalizeText(train && train._templateId) || null,
    projectId: normalizeText(train && train.projectId) || null,
    projectName: train && train.projectId && projectNameById ? (projectNameById[train.projectId] || null) : null,
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

// Accumulate train data in memory (no immediate write)
async function logTrainHistory(trains, scheduleType, additionalInfo = {}) {
  try {
    // Instead of writing immediately, accumulate train data in memory
    accumulateTrainData(trains, scheduleType, additionalInfo);
  } catch (e) {
    console.error('Error accumulating train history:', e.message);
  }
}

// Accumulate train data in memory for batch writing
function accumulateTrainData(trains, scheduleType, additionalInfo = {}) {
  const sourceType = normalizeSourceType(scheduleType);
  const todayStr = fmtYYYYMMDD(new Date());

  trains.forEach(train => {
    if (isRecurringStem(train, sourceType)) return;
    const actualDate = resolveLogServiceDate(train, sourceType);

    // Skip future-dated entries. History logs should only contain past/present
    // events. Pre-materialised recurring instances for future dates would
    // flood every weekly log file on each save.
    if (actualDate && actualDate > todayStr) return;
    if (!actualDate) return;

    const currentState = buildLogRecordV3(train, sourceType, additionalInfo);
    if (!currentState) return;

    const dateObj = actualDate ? new Date(actualDate + 'T12:00:00') : new Date();

    // Determine which week this train belongs to
    const weekId = getWeekIdentifier(dateObj);
    
    // Create week map if doesn't exist
    if (!pendingTrainData.has(weekId)) {
      pendingTrainData.set(weekId, new Map());
    }
    
    // Add or update record in the week's map
    pendingTrainData.get(weekId).set(currentState.recordId, currentState);
  });
}

function resolveTrainDate(train, scheduleType) {
  return resolveLogServiceDate(train, normalizeSourceType(scheduleType));
}

function normalizeStops(rawStops) {
  if (Array.isArray(rawStops)) {
    return rawStops
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  if (typeof rawStops === 'string') {
    return rawStops
      .split(/\n|\u2022|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// Flush all pending train data to disk (called once per day)
async function flushPendingTrainData() {
  if (pendingTrainData.size === 0) {
    console.log('⏭️  No pending train data to flush');
    return;
  }
  
  try {
    const writePromises = [];
    let totalTrains = 0;
    
    // Process each week's accumulated data
    for (const [weekId, trainMap] of pendingTrainData.entries()) {
      const writePromise = (async () => {
        const weekDate = parseWeekIdentifier(weekId);
        const weekLogFile = getWeeklyLogFile(weekDate);
        
        // Read existing log and merge with pending data
        const existingLog = await readLogAsStateMap(weekLogFile);
        
        // Merge accumulated trains
        for (const [trainKey, trainState] of trainMap.entries()) {
          existingLog.set(trainKey, trainState);
        }
        
        // Write merged data to file
        await rewriteLogFile(existingLog, weekLogFile);
        
        return trainMap.size;
      })();
      
      writePromises.push(writePromise);
    }
    
    const results = await Promise.all(writePromises);
    totalTrains = results.reduce((sum, count) => sum + count, 0);
    
    const weeksList = Array.from(pendingTrainData.keys()).join(', ');
    console.log(`✅ Flushed ${totalTrains} trains to ${pendingTrainData.size} week(s): ${weeksList}`);
    
    // Clear the accumulator after successful flush
    pendingTrainData.clear();
    
    // Update last log time
    await updateLastLogTime();
    
  } catch (e) {
    console.error('❌ Error flushing pending train data:', e.message);
    // Don't clear pendingTrainData on error - will retry next time
  }
}

// Get the last logging timestamp
async function getLastLogTime() {
  try {
    const content = await fsPromises.readFile(LAST_LOG_TIME_FILE, 'utf8');
    const timestamp = parseInt(content.trim(), 10);
    return isNaN(timestamp) ? 0 : timestamp;
  } catch (e) {
    // File doesn't exist or can't be read - return 0 to trigger initial log
    return 0;
  }
}

// Update the last logging timestamp
async function updateLastLogTime() {
  try {
    await fsPromises.mkdir(TRAIN_LOG_DIR, { recursive: true });
    await fsPromises.writeFile(LAST_LOG_TIME_FILE, Date.now().toString(), 'utf8');
  } catch (e) {
    console.error('❌ Error updating last log time:', e.message);
  }
}

// Check if 24 hours have passed and flush if needed
async function checkAndFlushIfNeeded() {
  try {
    const lastLogTime = await getLastLogTime();
    const currentTime = Date.now();
    const timeSinceLastLog = currentTime - lastLogTime;
    
    if (timeSinceLastLog >= LOG_INTERVAL_MS || lastLogTime === 0) {
      const hoursSince = (timeSinceLastLog / (60 * 60 * 1000)).toFixed(1);
      console.log(`⏰ 24 hours passed since last log (${hoursSince}h ago). Flushing pending data...`);
      await flushPendingTrainData();
    } else {
      const hoursRemaining = ((LOG_INTERVAL_MS - timeSinceLastLog) / (60 * 60 * 1000)).toFixed(1);
      console.log(`⏳ Next log in ${hoursRemaining} hours. Pending data: ${pendingTrainData.size} week(s)`);
    }
  } catch (e) {
    console.error('❌ Error checking log timer:', e.message);
  }
}

// Parse week identifier back to a date (returns first day of that week)
function parseWeekIdentifier(weekId) {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return new Date();
  
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  
  // ISO week date calculation: find the Monday of the given week
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const firstMonday = new Date(year, 0, 4 - jan4Day + 1);
  const targetDate = new Date(firstMonday);
  targetDate.setDate(firstMonday.getDate() + (week - 1) * 7);
  
  return targetDate;
}

// Read weekly log file and create a map of current train states
async function readLogAsStateMap(logFilePath = null) {
  const stateMap = new Map();
  const logFile = logFilePath || getWeeklyLogFile();
  
  try {
    // Check if file exists
    try {
      await fsPromises.access(logFile);
    } catch {
      return stateMap;
    }
    
    const content = await fsPromises.readFile(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    lines.forEach(line => {
      try {
        const raw = JSON.parse(line);
        const normalized = normalizeLogRecordFromAny(raw);
        if (!normalized) return;
        stateMap.set(normalized.recordId, normalized);
      } catch (e) {
        console.warn('Skipping invalid log line:', line.substring(0, 50));
      }
    });
    
    // Only log if actually reading data (not on every call)
    if (stateMap.size > 0) {
      const weekId = getWeekIdentifier();
      // Commented out to reduce noise: console.log(`📖 Read ${stateMap.size} train states from weekly log (${weekId})`);
    }
  } catch (e) {
    console.warn('Could not read weekly log file for state mapping:', e.message);
  }
  
  return stateMap;
}

// Rewrite the entire weekly log file with current train states
async function rewriteLogFile(stateMap, logFilePath = null) {
  const logFile = logFilePath || getWeeklyLogFile();
  
  try {
    const logEntries = Array.from(stateMap.values())
      .map((entry) => normalizeLogRecordFromAny(entry))
      .filter(Boolean)
      .sort((a, b) => getLogRecordTimestampMs(a) - getLogRecordTimestampMs(b))
      .map((normalized) => JSON.stringify(normalized));
    
    const logContent = logEntries.join('\n') + '\n';
    
    // Ensure directory exists
    await fsPromises.mkdir(TRAIN_LOG_DIR, { recursive: true });
    
    await fsPromises.writeFile(logFile, logContent, 'utf8');
    // Only log errors, not every successful write
    // const weekId = getWeekIdentifier();
    // console.log(`📝 Rewrote weekly log file (${weekId}) with ${stateMap.size} train entries`);
    
  } catch (err) {
    console.error('Failed to rewrite weekly train log:', err.message);
  }
}

function normalizeLogRecordFromAny(entry) {
  if (!entry || typeof entry !== 'object') return null;

  // Already normalized v3 record
  if (Number(entry.schemaVersion) >= 3 && typeof entry.recordId === 'string' && entry.recordId) {
    const normalized = { ...entry };
    normalized.schemaVersion = TRAIN_LOG_SCHEMA_VERSION;
    normalized.scheduleType = normalizeSourceType(normalized.scheduleType);
    normalized.serviceDate = normalizeText(normalized.serviceDate || normalized.date || normalized.plannedDate);
    normalized.serviceTime = normalizeText(normalized.serviceTime || normalized.actual || normalized.plan);
    normalized.date = normalized.serviceDate;
    normalized.plannedDate = normalized.serviceDate;
    normalized.trainKey = normalized.recordId;
    if (!normalized.loggedAt) normalized.loggedAt = new Date().toISOString();
    return normalized;
  }

  // Migrate older schemas and mixed historical formats
  const sourceType = normalizeSourceType(entry.scheduleType);
  const serviceDate = normalizeText(entry.date || entry.plannedDate || resolveLogServiceDate(entry, sourceType));
  if (!serviceDate) return null;
  const serviceTime = normalizeText(entry.actual || entry.plan || entry.serviceTime);

  const uid = normalizeText(entry._uniqueId);
  let recordId = normalizeText(entry.recordId || entry.trainKey);
  if (uid) {
    recordId = `${sourceType}|uid|${uid}`;
  } else {
    const currentLooksLikeCanonical = recordId.includes('|uid|') || recordId.includes('|sig|');
    if (!currentLooksLikeCanonical) {
      recordId = buildCanonicalRecordId(entry, sourceType, serviceDate, serviceTime);
    }
  }

  const zwischenhalte = normalizeStops(entry.zwischenhalte != null ? entry.zwischenhalte : entry.stops);
  return {
    schemaVersion: TRAIN_LOG_SCHEMA_VERSION,
    recordId,
    trainKey: recordId,
    scheduleType: sourceType,
    loggedAt: normalizeText(entry.loggedAt) || new Date().toISOString(),
    serviceDate,
    serviceTime,
    _uniqueId: uid || null,
    _templateId: normalizeText(entry._templateId) || null,
    projectId: normalizeText(entry.projectId) || null,
    projectName: normalizeText(entry.projectName) || null,
    type: normalizeText(entry.type) || null,
    linie: normalizeText(entry.linie),
    ziel: normalizeText(entry.ziel),
    plan: normalizeText(entry.plan),
    actual: normalizeText(entry.actual),
    dauer: Number(entry.dauer) || 0,
    zwischenhalte,
    stops: zwischenhalte.join(' • '),
    date: serviceDate,
    plannedDate: serviceDate,
    canceled: Boolean(entry.canceled),
    checkinTime: entry.checkinTime || null,
    checkoutTime: entry.checkoutTime || null,
    recurrence: entry.recurrence || null,
    startDate: entry.startDate || null,
    skippedDates: Array.isArray(entry.skippedDates) ? entry.skippedDates.slice() : []
  };
}

function getLogRecordTimestampMs(entry) {
  if (!entry || typeof entry !== 'object') return Number.POSITIVE_INFINITY;
  const dateStr = normalizeText(entry.serviceDate || entry.date || entry.plannedDate);
  const timeStr = normalizeText(entry.serviceTime || entry.actual || entry.plan);
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(timeStr);
  if (dateStr && m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const local = new Date(`${dateStr}T00:00:00`);
      if (!Number.isNaN(local.getTime())) {
        local.setHours(hh, mm, 0, 0);
        return local.getTime();
      }
    }
  }
  const fallback = new Date(entry.loggedAt || '').getTime();
  return Number.isFinite(fallback) ? fallback : Number.POSITIVE_INFINITY;
}



// Create a unique key for a train entry to detect duplicates
function createTrainKey(train, scheduleType) {
  if (!train || typeof train !== 'object') return '';
  if (train._uniqueId) return `${scheduleType || 'unknown'}|uid|${String(train._uniqueId)}`;

  // Always use a resolved date for non-UID legacy entries
  const actualDate = resolveTrainDate(train, scheduleType) || 'unknown';
  
  const keyParts = [
    scheduleType || 'unknown',
    train.linie || 'unknown',
    train.ziel || 'unknown', 
    train.plan || train.actual || 'unknown',
    actualDate
  ];
  return keyParts.join('|').toLowerCase();
}

function parseTrainTimestampMs(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const dateStr =
    (typeof entry.date === 'string' && entry.date) ||
    (typeof entry.plannedDate === 'string' && entry.plannedDate) ||
    null;

  const timeStr =
    (typeof entry.actual === 'string' && entry.actual) ||
    (typeof entry.plan === 'string' && entry.plan) ||
    null;

  if (!dateStr || !timeStr) {
    if (typeof entry.loggedAt === 'string' && entry.loggedAt) {
      const fallback = new Date(entry.loggedAt).getTime();
      return Number.isFinite(fallback) ? fallback : null;
    }
    return null;
  }

  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(timeStr);
  if (!match) return null;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  const local = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(local.getTime())) return null;

  local.setHours(hh, mm, 0, 0);
  return local.getTime();
}

function buildHistoryDedupKey(entry) {
  if (!entry || typeof entry !== 'object') return '';

  const datePart = String(entry.date || entry.plannedDate || '').trim().toLowerCase();
  const liniePart = String(entry.linie || '').trim().toLowerCase();
  const zielPart = String(entry.ziel || '').trim().toLowerCase();
  const timePart = String(entry.actual || entry.plan || '').trim().toLowerCase();
  const typePart = String(entry.type || '').trim().toLowerCase();
  const dauerPart = String(entry.dauer != null ? entry.dauer : '').trim().toLowerCase();

  // Prefer a semantic key so legacy keys and UID-based keys for the same
  // visible train/day collapse into one row in the log viewer.
  if (datePart && liniePart && zielPart && timePart) {
    return `svc|${datePart}|${liniePart}|${zielPart}|${timePart}|${typePart}|${dauerPart}`;
  }

  const trainKey = typeof entry.trainKey === 'string' ? entry.trainKey.trim().toLowerCase() : '';
  if (trainKey) {
    // New schema keys: <scheduleType>|uid|<uniqueId>
    const uidMarker = '|uid|';
    const uidIndex = trainKey.indexOf(uidMarker);
    if (uidIndex >= 0) {
      const uid = trainKey.slice(uidIndex + uidMarker.length);
      if (uid) return `uid|${uid}`;
    }

    // Legacy schema keys: <scheduleType>|<linie>|<ziel>|<time>|<date>
    const parts = trainKey.split('|');
    if (parts.length >= 5) {
      return `legacy|${parts.slice(1).join('|')}`;
    }

    return `key|${trainKey}`;
  }

  const uid = typeof entry._uniqueId === 'string' ? entry._uniqueId.trim() : '';
  if (uid) return `uid|${uid}`;

  const planPart = String(entry.plan || '').trim().toLowerCase();
  const actualPart = String(entry.actual || '').trim().toLowerCase();

  return `sig|${datePart}|${liniePart}|${zielPart}|${planPart}|${actualPart}|${dauerPart}|${typePart}`;
}

async function listWeeklyLogFiles() {
  try {
    await fsPromises.access(TRAIN_LOG_DIR);
  } catch {
    return [];
  }

  const files = await fsPromises.readdir(TRAIN_LOG_DIR);
  return files
    .filter(file => file.startsWith('train_history_') && file.endsWith('.log'))
    .map(file => ({
      file,
      filePath: path.join(TRAIN_LOG_DIR, file)
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}



// Extract event data (arrival/dep), focusing on departures
function extractEvent(ev) {
  if (!ev) return {};
  const plannedTime = ev.pt || ev.ptime || ev.ptt || ev.ptime10 || ev.planned || null;
  const changedTime = ev.ct || ev.ctime || null;
  const plannedPlatform = ev.pp || null;
  const changedPlatform = ev.cp || null;
  const plannedDistant = ev.pde || null;
  const changedDistant = ev.cde || null;
  const plannedPath = ev.ppth || null;
  const changedPath = ev.cpth || null;
  const statusPlanned = ev.ps || null; // object in spec, may be string in XML
  const statusChanged = ev.cs || null; // object in spec, may be string in XML
  const line = ev.l || null;
  const hidden = ev.hi || 0;
  return {
    plannedTime,
    changedTime,
    plannedPlatform,
    changedPlatform,
    plannedDistant,
    changedDistant,
    plannedPath,
    changedPath,
    statusPlanned,
    statusChanged,
    line,
    hidden,
  };
}

// Extract a user-visible line string from stop data
function extractLine(stop) {
  // Prefer a user-facing line indicator over raw long train numbers where applicable
  const dp = stop.dp || null;
  const ev = extractEvent(dp);
  const tl = stop.tl || stop.ref?.tl || null;
  const tlo = Array.isArray(tl) ? tl[0] : tl;
  const rawCat = tlo?.c;
  const cat = rawCat ? String(rawCat).toUpperCase() : undefined; // e.g., 'S', 'RE', 'ICE'
  const rawNum = tlo?.n;
  const num = rawNum != null ? String(rawNum) : undefined; // may be long train number
  const evLineRaw = ev.line != null ? String(ev.line) : undefined; // e.g., '38', 'RE2', 'S1'
  const evLine = evLineRaw ? evLineRaw.toUpperCase().replace(/\s+/g, '') : undefined;

  // S-Bahn: dp.l now contains the full line (e.g., "S1"), use it directly if available
  if (cat === 'S') {
    // First check if dp.l has the full S-Bahn line designation (S1, S2, etc.)
    if (evLine && /^S\d{1,2}$/.test(evLine)) {
      return evLine;
    }
    // Otherwise try to extract digits and build it
    const digits = (evLine && /^\d+$/.test(evLine)) ? evLine : (num && /^\d{1,3}$/.test(num) ? num : undefined);
    if (digits) return `S${digits}`;
    if (num) return `S${num}`;
    return 'S';
  }

  // For most regional/private operators (e.g., RE/RB/ERX/ENO/MEX/...),
  // prefer short line indicator from dp.l or short tl.n. Exclude long-distance cats.
  const LONG_DISTANCE = new Set(['ICE', 'IC', 'FLX']);
  if (cat && cat !== 'S' && !LONG_DISTANCE.has(cat)) {
    // If dp.l already includes this category + small number (e.g., RE2, ERX3), use it
    try {
      const catEsc = cat.replace(/[-/\\^$*+?.()|[\]{}]/g, '');
      const prefixedShort = new RegExp(`^${catEsc}\\d{1,3}$`);
      if (evLine && prefixedShort.test(evLine)) return evLine;
    } catch {}
    // If dp.l is just a small number, prefix the category
    if (evLine && /^\d{1,3}$/.test(evLine)) return `${cat}${evLine}`;
    // If tl.n is short digits, construct cat+num
    if (num && /^\d{1,3}$/.test(num)) return `${cat}${num}`;
    // As a last resort, if dp.l exists, show it; otherwise fall back to cat+num
    if (evLine) return evLine;
    if (cat && num) return `${cat}${num}`;
    if (cat) return cat;
    if (num) return num;
    return 'Unknown';
  }

  // Other categories: default to cat+num when available
  if (cat && num) return `${cat}${num}`; // e.g., ICE657, IC2043
  if (cat && !num) return String(cat);
  if (num && !cat) return String(num);

  // Fall back to dp.l as-is
  if (evLine) return evLine;

  return 'Unknown';
}

function extractDestination(stop) {
  const dp = stop.dp || null;
  const ev = extractEvent(dp);
  const de = ev.changedDistant || ev.plannedDistant;
  if (de) return String(de);
  // Fallback: last station from path
  const pathStr = ev.changedPath || ev.plannedPath;
  if (pathStr) {
    const parts = String(pathStr).split('|').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return '';
}

function extractPlatform(stop) {
  const dp = stop.dp || null;
  const ev = extractEvent(dp);
  return (ev.changedPlatform || ev.plannedPlatform || '')?.toString() || null;
}

function extractTimesAndDate(stop) {
  const dp = stop.dp || null;
  const ev = extractEvent(dp);
  const planD = parseDbTimeTenDigits(ev.plannedTime);
  const actD = parseDbTimeTenDigits(ev.changedTime) || null;
  const dateRef = actD || planD;
  return {
    plan: fmtHHmm(planD),
    actual: fmtHHmm(actD),
    date: fmtYYYYMMDD(dateRef),
  };
}

function extractCanceled(stop) {
  const dp = stop.dp || null;
  const ev = extractEvent(dp);
  // In XML, cs might be a string 'c' or an object; handle both
  const cs = ev.statusChanged;
  if (!cs) return false;
  if (typeof cs === 'string') return cs.toLowerCase() === 'c';
  if (typeof cs === 'object' && cs._) return String(cs._).toLowerCase() === 'c';
  return false;
}

function extractStopsPath(stop) {
  const dp = stop.dp || null;
  const ev = extractEvent(dp);
  const pathStr = (ev.changedPath || ev.plannedPath || '').toString();
  if (!pathStr) return '';
  // Commonly uses '|' as separator; render as bullets
  return pathStr.split('|').filter(Boolean).join(' • ');
}

function normalizeTimetableStops(tt) {
  // xml2js with explicitArray:false will produce objects/arrays variably.
  const s = tt?.timetable?.s || tt?.s || [];
  const arr = Array.isArray(s) ? s : [s].filter(Boolean);
  return arr;
}

async function fetchPlannedAndChanges({ eva, dateYYMMDD, hourHH }) {
  // Fetch current hour and next hour planned data in parallel, plus full changes
  const now = new Date();
  const nextHour = new Date(now.getTime());
  nextHour.setHours(now.getHours() + 1);
  const date2 = toYyMmDd(nextHour);
  const hour2 = toHour(nextHour);

  const urls = [
    `/plan/${eva}/${dateYYMMDD}/${hourHH}`,
    `/plan/${eva}/${date2}/${hour2}`,
    `/fchg/${eva}`,
  ];

  const [plan1, plan2, changes] = await Promise.all(
    urls.map(async (u) => {
      const res = await dbClient.get(u);
      if (res.status >= 400) {
        const err = new Error(`DB API error ${res.status} for ${u}`);
        err.status = res.status;
        throw err;
      }
      return res.data; // XML string
    })
  );

  // Parse XML -> JS
  const [p1, p2, ch] = await Promise.all([
    parseStringPromise(plan1, { explicitArray: false, mergeAttrs: true }),
    parseStringPromise(plan2, { explicitArray: false, mergeAttrs: true }),
    parseStringPromise(changes, { explicitArray: false, mergeAttrs: true }),
  ]);

  return { p1, p2, ch };
}

function buildTrainsFromTimetables({ p1, p2, ch }) {
  // Build a map from stop id -> base planned record
  const plannedStops = [...normalizeTimetableStops(p1), ...normalizeTimetableStops(p2)];
  const byId = new Map();

  for (const stop of plannedStops) {
    if (!stop || !stop.dp) continue; // departures only
    // Skip hidden events
    const ev = extractEvent(stop.dp);
    if (Number(ev.hidden) === 1) continue;
    const id = stop.id || stop.i || null;
    const { plan, actual, date } = extractTimesAndDate(stop);
    const dpEv = extractEvent(stop.dp);
    const plannedPlat = dpEv.plannedPlatform ? String(dpEv.plannedPlatform) : null;
    const record = {
      linie: extractLine(stop),
      ziel: extractDestination(stop) || '',
      platform: plannedPlat,
      plannedPlatform: plannedPlat,
      plan,
      actual, // might be null if no change
      canceled: extractCanceled(stop),
      date,
      stops: extractStopsPath(stop),
      dauer: null, // unknown from API; frontend handles null
    };
    if (id) byId.set(String(id), record);
    else byId.set(`${record.linie}-${record.plan}-${record.ziel}`, record); // fallback key
  }

  // Apply changes overlay
  const changeStops = normalizeTimetableStops(ch);
  for (const stop of changeStops) {
    if (!stop || !stop.dp) continue;
    const ev = extractEvent(stop.dp);
    if (Number(ev.hidden) === 1) continue; // do not consider hidden
    const id = stop.id || stop.i || null;
    const key = id ? String(id) : null;
    const base = key ? byId.get(key) : null;
    // Only overlay onto existing planned records to avoid injecting far-future/unplanned noise
    if (!base) continue;
    const target = base;

    // Overwrite with changed data
    if (ev.changedTime) {
      const actD = parseDbTimeTenDigits(ev.changedTime);
      target.actual = fmtHHmm(actD);
      target.date = fmtYYYYMMDD(actD) || target.date;
    }
    if (ev.plannedTime && !target.plan) {
      const planD = parseDbTimeTenDigits(ev.plannedTime);
      target.plan = fmtHHmm(planD);
      target.date = fmtYYYYMMDD(planD) || target.date;
    }
    const dest = ev.changedDistant || ev.plannedDistant;
    if (dest) target.ziel = String(dest);
    if (ev.changedPlatform) {
      target.platform = String(ev.changedPlatform);
      target.platformChanged = target.plannedPlatform != null && target.platform !== target.plannedPlatform;
    } else if (ev.plannedPlatform) {
      target.platform = String(ev.plannedPlatform);
    }
    if (extractCanceled(stop)) target.canceled = true;
    const pathStr = ev.changedPath || ev.plannedPath;
    if (pathStr) target.stops = String(pathStr).split('|').filter(Boolean).join(' • ');

    // We do not add entirely new entries from changes
  }

  // Convert map to array
  return Array.from(byId.values())
    .filter((t) => t.plan || t.actual) // must have at least a time
    .map((t) => ({
      // Ensure types are strings or booleans as expected by frontend
      linie: t.linie || 'Unknown',
      ziel: t.ziel || '',
      platform: t.platform || undefined,
      platformChanged: Boolean(t.platformChanged),
      plan: t.plan || undefined,
      actual: t.actual || undefined,
      canceled: Boolean(t.canceled),
      date: t.date || undefined,
      stops: t.stops || '',
      dauer: t.dauer == null ? null : Number(t.dauer),
    }));
}

async function loadDbDepartures(eva = DEFAULT_EVA) {
  if (!process.env.DB_CLIENT_ID || !process.env.DB_API_KEY) {
    throw new Error('Missing DB API credentials (DB_CLIENT_ID/DB_API_KEY)');
  }
  const now = new Date();
  const date = toYyMmDd(now);
  const hour = toHour(now);
  const { p1, p2, ch } = await fetchPlannedAndChanges({ eva, dateYYMMDD: date, hourHH: hour });
  const trains = buildTrainsFromTimetables({ p1, p2, ch });
  // Sort by next known (actual or planned) time
  trains.sort((a, b) => {
    const aTime = a.actual || a.plan || '99:99';
    const bTime = b.actual || b.plan || '99:99';
    return aTime.localeCompare(bTime);
  });
  return { trains, metadata: { stationEva: eva, fetchedAt: new Date().toISOString() } };
}

// ─── Custom Timetable helpers ────────────────────────────────────────────────
function loadCustomTimetable() {
  try {
    if (fs.existsSync(CUSTOM_TIMETABLE_FILE))
      return JSON.parse(fs.readFileSync(CUSTOM_TIMETABLE_FILE, 'utf8'));
  } catch (e) {
    console.warn('Could not read custom_timetable.json:', e.message);
  }
  return { stops: [], lines: [] };
}

function saveCustomTimetable(data) {
  fs.writeFileSync(CUSTOM_TIMETABLE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Build a { trains, metadata } response matching /api/db-departures format
function buildCustomDepartures(evaStr) {
  const stopId = evaStr.slice('CUSTOM_'.length);
  const ct = loadCustomTimetable();
  const stop = ct.stops.find(s => s.id === stopId);
  if (!stop) return { trains: [], metadata: { stationEva: evaStr, fetchedAt: new Date().toISOString() } };

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  const trains = [];
  for (const line of (ct.lines || [])) {
    const stopIdx = line.stops.findIndex(s => s.stopId === stopId);
    if (stopIdx === -1) continue;

    // time offset from first stop to this stop
    let offsetSec = 0;
    for (let i = 0; i < stopIdx; i++) {
      offsetSec += (Number(line.stops[i].travelTime) || 0) + (Number(line.stops[i].dwellTime) || 0);
    }

    const platform = line.stops[stopIdx].platform || undefined;
    const isTerminus = stopIdx === line.stops.length - 1;

    // direction = next terminus after this stop
    const terminusEntry = isTerminus ? null : line.stops[line.stops.length - 1];
    const terminusStop  = terminusEntry ? ct.stops.find(s => s.id === terminusEntry.stopId) : null;
    const ziel = isTerminus ? 'Ankunft' : (terminusStop ? terminusStop.name : '');

    // stops path (all stops on line)
    const stopsPath = line.stops.map(s => {
      const st = ct.stops.find(x => x.id === s.stopId);
      return st ? st.name : '?';
    }).join(' • ');

    for (const dep of (line.departures || [])) {
      const parts = dep.split(':').map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) continue;
      const baseSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      const arrSec  = baseSec + offsetSec;
      if (arrSec > 86399) continue; // beyond midnight
      const arrH = Math.floor(arrSec / 3600);
      const arrM = Math.floor((arrSec % 3600) / 60);
      const planStr = `${String(arrH).padStart(2,'0')}:${String(arrM).padStart(2,'0')}`;
      trains.push({
        linie:           line.name,
        ziel,
        platform,
        plannedPlatform: platform,
        platformChanged: false,
        plan:            planStr,
        actual:          undefined,
        canceled:        false,
        date:            dateStr,
        stops:           stopsPath,
        dauer:           null,
        custom:          true,
      });
    }
  }
  trains.sort((a, b) => (a.plan || '99:99').localeCompare(b.plan || '99:99'));
  return { trains, metadata: { stationEva: evaStr, stationName: stop.name, fetchedAt: new Date().toISOString() } };
}

// --- Express app ---
const app = express();

// Serve static files
app.use(express.static(PUBLIC_DIR));
// Parse JSON bodies for local schedule save
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Read train history log (current week by default, or specified week)
app.get('/api/train-history', async (req, res) => {
  try {
    const weekId = req.query.week || getWeekIdentifier();
    const logFile = path.join(TRAIN_LOG_DIR, `train_history_${weekId}.log`);
    
    let content;
    try {
      content = await fsPromises.readFile(logFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.json({ 
          entries: [], 
          message: `No log file found for week ${weekId}`,
          week: weekId
        });
      }
      throw err;
    }
    
    // Parse JSON lines using the canonical v3 normalization path.
    const lines = content.trim().split('\n').filter(line => line.trim());
    const recordsMap = new Map();
    lines.forEach((line) => {
      try {
        const raw = JSON.parse(line);
        const record = normalizeLogRecordFromAny(raw);
        if (!record) return;
        recordsMap.set(record.recordId, record);
      } catch (e) {
        console.warn('Skipping invalid log line:', line.substring(0, 50));
      }
    });

    const rows = Array.from(recordsMap.values()).sort((a, b) => getLogRecordTimestampMs(a) - getLogRecordTimestampMs(b));

    // Apply default limit of 1000 to prevent massive responses.
    const DEFAULT_LIMIT = 1000;
    const requestedLimit = req.query.limit ? parseInt(req.query.limit, 10) : DEFAULT_LIMIT;
    const limit = Math.min(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT, 10000);
    const entries = rows.length > limit ? rows.slice(rows.length - limit) : rows;
    
    res.json({ 
      entries: entries,
      total: rows.length,
      showing: entries.length,
      week: weekId,
      limited: rows.length > limit
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse log file', details: e.message });
  }
});

// List available weekly log files
app.get('/api/train-history/weeks', async (req, res) => {
  try {
    // Check if directory exists
    try {
      await fsPromises.access(TRAIN_LOG_DIR);
    } catch {
      return res.json({ weeks: [] });
    }
    
    const files = await fsPromises.readdir(TRAIN_LOG_DIR);
    const weeks = files
      .filter(file => file.startsWith('train_history_') && file.endsWith('.log'))
      .map(file => {
        const match = file.match(/train_history_(.+)\.log$/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
      .sort()
      .reverse(); // Most recent first
    
    res.json({ weeks, current: getWeekIdentifier() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list weekly logs', details: e.message });
  }
});

// Read train history over an absolute timestamp range (inclusive), across all weekly files
app.get('/api/train-history/range', async (req, res) => {
  try {
    const fromRaw = String(req.query.from || '');
    const toRaw = String(req.query.to || '');
    const fromDateRaw = String(req.query.fromDate || '');
    const toDateRaw = String(req.query.toDate || '');

    const hasDateWindow = fromDateRaw && toDateRaw;
    if (hasDateWindow) {
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRe.test(fromDateRaw) || !dateRe.test(toDateRaw)) {
        return res.status(400).json({ error: 'Invalid fromDate/toDate format. Use YYYY-MM-DD.' });
      }
    }

    const rangeDateStart = hasDateWindow
      ? (fromDateRaw <= toDateRaw ? fromDateRaw : toDateRaw)
      : null;
    const rangeDateEnd = hasDateWindow
      ? (fromDateRaw <= toDateRaw ? toDateRaw : fromDateRaw)
      : null;

    if (!fromRaw || !toRaw) {
      return res.status(400).json({ error: 'Missing required query params: from, to' });
    }

    const fromMs = new Date(fromRaw).getTime();
    const toMs = new Date(toRaw).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return res.status(400).json({ error: 'Invalid from/to format. Use ISO datetime.' });
    }

    const rangeStart = Math.min(fromMs, toMs);
    const rangeEnd = Math.max(fromMs, toMs);
    const requestedLimit = req.query.limit ? parseInt(req.query.limit, 10) : 5000;
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 5000, 20000));

    const weeklyFiles = await listWeeklyLogFiles();
    const dedupedMap = new Map();

    for (const wf of weeklyFiles) {
      let content;
      try {
        content = await fsPromises.readFile(wf.filePath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n').filter(line => line.trim());
      lines.forEach((line) => {
        try {
          const raw = JSON.parse(line);
          const entry = normalizeLogRecordFromAny(raw);
          if (!entry) return;

          if (rangeDateStart && rangeDateEnd) {
            const entryDate = normalizeText(entry.serviceDate || entry.date || entry.plannedDate);
            // In date-window mode, only entries that carry an explicit date are valid.
            if (!entryDate) return;
            if (entryDate < rangeDateStart || entryDate > rangeDateEnd) return;
          }

          const ts = getLogRecordTimestampMs(entry);
          if (!Number.isFinite(ts)) return;
          if (ts < rangeStart || ts > rangeEnd) return;

          const existing = dedupedMap.get(entry.recordId);
          if (!existing || getLogRecordTimestampMs(existing) <= ts) {
            dedupedMap.set(entry.recordId, {
              ...entry,
              _rangeTs: ts,
              _sourceWeekFile: wf.file
            });
          }
        } catch {
          // Ignore invalid lines in range endpoint
        }
      });
    }
    const deduped = Array.from(dedupedMap.values()).sort((a, b) => a._rangeTs - b._rangeTs);
    const limited = deduped.length > limit;
    const entries = (limited ? deduped.slice(deduped.length - limit) : deduped).map((entry) => {
      const out = { ...entry };
      delete out._rangeTs;
      return out;
    });

    res.json({
      entries,
      total: deduped.length,
      showing: entries.length,
      limited,
      from: new Date(rangeStart).toISOString(),
      to: new Date(rangeEnd).toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read train history range', details: e.message });
  }
});

// Fallback schedule (static file) - cached in memory
app.get('/api/schedule', async (req, res) => {
  try {
    // Return cached data if available
    if (scheduleCache !== null) {
      return res.json(scheduleCache);
    }
    
    // Read from disk if not cached
    const filePath = path.join(PUBLIC_DIR, 'data.json');
    const content = await fsPromises.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    
    // Cache the data
    scheduleCache = data;
    scheduleCacheTime = Date.now();
    
    res.json(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Schedule file not found' });
    }
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Invalid schedule JSON' });
    }
    res.status(500).json({ error: 'Failed to read schedule' });
  }
});

// Save local schedule (used by InputEnhanced.html)
app.post('/api/schedule', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const rawSpontaneous = Array.isArray(body.spontaneousEntries) ? body.spontaneousEntries : [];
    const projectsArr = Array.isArray(body.projects) ? body.projects : [];
    const projectNameById = Object.fromEntries(
      projectsArr
        .filter(p => p && p._uniqueId)
        .map(p => [String(p._uniqueId), typeof p.name === 'string' ? p.name : ''])
    );
    const logContext = { projectNameById };

    // Log history BEFORE pruning so all entries are archived
    const fixedArr  = Array.isArray(body.fixedSchedule) ? body.fixedSchedule : [];
    const trainsArr = Array.isArray(body.trains) ? body.trains : [];
    if (fixedArr.length > 0)      logTrainHistory(fixedArr, 'fixed', logContext);
    if (rawSpontaneous.length > 0) logTrainHistory(rawSpontaneous, 'spontaneous', logContext);
    // `trains` is a legacy container from older schema versions.
    // Keep ingesting it for compatibility, but write under spontaneous
    // so no new `legacy|...` keys are produced.
    if (trainsArr.length > 0)     logTrainHistory(trainsArr, 'spontaneous', logContext);

    // Prune expired entries (past + no projectId) before persisting to disk
    const prunedSpontaneous = pruneExpiredEntries(rawSpontaneous);

    const toSave = {
      _meta: {
        version: Date.now(),
        lastSaved: new Date().toISOString()
      },
      fixedSchedule: fixedArr,
      spontaneousEntries: prunedSpontaneous,
      trains: trainsArr,
      projects: projectsArr,
    };

    const filePath = path.join(PUBLIC_DIR, 'data.json');
    await fsPromises.writeFile(filePath, JSON.stringify(toSave, null, 2), 'utf8');

    // Cache the pruned version so next GET doesn't re-inflate it
    scheduleCache = toSave;
    scheduleCacheTime = Date.now();

    // Schedule push notifications sent by the client
    if (Array.isArray(body.pushEvents)) {
      try {
        fs.writeFileSync(PUSH_EVENTS_FILE, JSON.stringify(body.pushEvents, null, 2), 'utf8');
        schedulePushEvents(body.pushEvents);
      } catch (pe) {
        console.warn('Could not schedule push events:', pe.message);
      }
    }

    // Notify listeners
    try { broadcastUpdate('manual-save'); } catch {}
    res.json({ ok: true, savedAt: toSave._meta.lastSaved, prunedCount: rawSpontaneous.length - prunedSpontaneous.length });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
});

// One-time prune endpoint: strips expired entries from the current data.json on disk
app.post('/api/prune', async (req, res) => {
  try {
    const filePath = path.join(PUBLIC_DIR, 'data.json');
    const content = await fsPromises.readFile(filePath, 'utf8');
    const data = JSON.parse(content);

    const rawSpontaneous = Array.isArray(data.spontaneousEntries) ? data.spontaneousEntries : [];
    const prunedSpontaneous = pruneExpiredEntries(rawSpontaneous);
    const removedCount = rawSpontaneous.length - prunedSpontaneous.length;

    const toSave = {
      ...data,
      _meta: {
        version: Date.now(),
        lastSaved: new Date().toISOString()
      },
      spontaneousEntries: prunedSpontaneous,
    };

    await fsPromises.writeFile(filePath, JSON.stringify(toSave, null, 2), 'utf8');

    // Invalidate cache so next GET returns the pruned data
    scheduleCache = toSave;
    scheduleCacheTime = Date.now();

    console.log(`🧹 /api/prune: removed ${removedCount} expired entries. Remaining: ${prunedSpontaneous.length}`);
    res.json({
      ok: true,
      removedCount,
      remainingCount: prunedSpontaneous.length,
      prunedAt: toSave._meta.lastSaved
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
});

// === WEB PUSH ENDPOINTS ===

// Return VAPID public key so the client can subscribe
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY)
    return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Register a push subscription (all devices stored, all receive every push)
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const subs = loadPushSubscriptions();
  if (!subs.find(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    savePushSubscriptions(subs);
  }
  res.json({ ok: true });
});

// Remove a push subscription (e.g. user revokes permission)
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  const subs = loadPushSubscriptions().filter(s => s.endpoint !== endpoint);
  savePushSubscriptions(subs);
  res.json({ ok: true });
});

// Debug: inspect current push state without triggering anything
app.get('/api/push/debug', (req, res) => {
  const subs = loadPushSubscriptions();
  const pending = [];
  pendingPushTimeouts.forEach(({ event: ev }) => {
    const inMs = new Date(ev.notifyAt) - new Date();
    pending.push({
      id: ev.id,
      title: ev.title,
      notifyAt: ev.notifyAt,
      inMinutes: Math.round(inMs / 60000),
      body: ev.options && ev.options.body ? ev.options.body : null
    });
  });
  pending.sort((a, b) => new Date(a.notifyAt) - new Date(b.notifyAt));

  res.json({
    vapidConfigured: !!process.env.VAPID_PUBLIC_KEY,
    subscriptionCount: subs.length,
    subscriptionEndpoints: subs.map(s => s.endpoint.slice(0, 60) + '...'),
    pendingEventCount: pending.length,
    scheduledEvents: pending  // sorted by notifyAt, includes title + body + inMinutes
  });
});

// === END WEB PUSH ENDPOINTS ===

// --- Journal / Review API ---
const JOURNAL_FILE = path.join(__dirname, 'journal.json');

async function readJournal() {
  try {
    const content = await fsPromises.readFile(JOURNAL_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return { reviews: [] };
    throw e;
  }
}

async function writeJournal(data) {
  await fsPromises.writeFile(JOURNAL_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// GET /api/journal - list all entries
app.get('/api/journal', async (req, res) => {
  try {
    const data = await readJournal();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/journal - create new entry
app.post('/api/journal', async (req, res) => {
  try {
    const { rating, text, date } = req.body || {};
    const r = Number(rating);
    if (!r || r < 1 || r > 5) return res.status(400).json({ error: 'rating must be 1–5' });
    const data = await readJournal();
    const now = new Date().toISOString();
    const entryDate = date || now.split('T')[0];
    const entry = { id: Date.now().toString(), date: entryDate, rating: r, text: text || '', createdAt: now, updatedAt: now };
    data.reviews.unshift(entry);
    await writeJournal(data);
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/journal/:id - update existing entry
app.put('/api/journal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, text } = req.body || {};
    const data = await readJournal();
    const idx = data.reviews.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found' });
    if (rating !== undefined) data.reviews[idx].rating = Number(rating);
    if (text !== undefined) data.reviews[idx].text = text;
    data.reviews[idx].updatedAt = new Date().toISOString();
    await writeJournal(data);
    res.json({ ok: true, entry: data.reviews[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/journal/:id - delete entry
app.delete('/api/journal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readJournal();
    const before = data.reviews.length;
    data.reviews = data.reviews.filter(r => r.id !== id);
    if (data.reviews.length === before) return res.status(404).json({ error: 'Entry not found' });
    await writeJournal(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Lovemeter data-point API ---
const LOVEMETER_FILE = path.join(__dirname, 'lovemeter_data.json');

async function readLovemeterPoints() {
  try {
    const content = await fsPromises.readFile(LOVEMETER_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeLovemeterPoints(points) {
  await fsPromises.writeFile(LOVEMETER_FILE, JSON.stringify(points, null, 2), 'utf8');
}

// GET /api/lovemeter – return all data points
app.get('/api/lovemeter', async (req, res) => {
  try {
    res.json(await readLovemeterPoints());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/lovemeter – upsert one data point { ts, M, event?, delta? }
app.post('/api/lovemeter', async (req, res) => {
  try {
    const { ts, M, event, delta } = req.body || {};
    if (typeof ts !== 'number' || typeof M !== 'number') {
      return res.status(400).json({ error: 'ts and M must be numbers' });
    }
    const point = { ts, M };
    if (event !== undefined && event !== null && event !== '') point.event = String(event).slice(0, 200);
    if (delta !== undefined && delta !== null) point.delta = Number(delta);
    const points = await readLovemeterPoints();
    const idx = points.findIndex(p => p.ts === ts);
    if (idx !== -1) points[idx] = point;
    else points.push(point);
    points.sort((a, b) => a.ts - b.ts);
    await writeLovemeterPoints(points);
    broadcastUpdate('lovemeter-change', { dataType: 'lovemeter' });
    res.json({ ok: true, points });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/lovemeter/:ts – remove a single data point by timestamp
app.delete('/api/lovemeter/:ts', async (req, res) => {
  try {
    const ts = Number(req.params.ts);
    if (!ts) return res.status(400).json({ error: 'invalid ts' });
    const points = await readLovemeterPoints();
    const before = points.length;
    const next = points.filter(p => p.ts !== ts);
    if (next.length === before) return res.status(404).json({ error: 'not found' });
    await writeLovemeterPoints(next);
    broadcastUpdate('lovemeter-change', { dataType: 'lovemeter' });
    res.json({ ok: true, points: next });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/lovemeter – replace entire array (bulk save)
app.put('/api/lovemeter', async (req, res) => {
  try {
    const points = req.body;
    if (!Array.isArray(points)) return res.status(400).json({ error: 'expected array' });
    points.sort((a, b) => a.ts - b.ts);
    await writeLovemeterPoints(points);
    broadcastUpdate('lovemeter-change', { dataType: 'lovemeter' });
    res.json({ ok: true, points });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Lovemeter presets API ---
const LOVEMETER_PRESETS_FILE = path.join(__dirname, 'lovemeter_presets.json');

async function readLovemeterPresets() {
  try {
    const content = await fsPromises.readFile(LOVEMETER_PRESETS_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeLovemeterPresets(presets) {
  await fsPromises.writeFile(LOVEMETER_PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8');
}

// GET /api/lovemeter-presets
app.get('/api/lovemeter-presets', async (req, res) => {
  try { res.json(await readLovemeterPresets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/lovemeter-presets – replace entire presets array
app.put('/api/lovemeter-presets', async (req, res) => {
  try {
    const presets = req.body;
    if (!Array.isArray(presets)) return res.status(400).json({ error: 'expected array' });
    await writeLovemeterPresets(presets);
    res.json({ ok: true, presets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


let cachedData = { trains: [], metadata: null };
let lastFetchOk = false;

// Custom timetable CRUD
app.get('/api/custom-timetable', (req, res) => {
  res.json(loadCustomTimetable());
});

app.post('/api/custom-timetable', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.stops) || !Array.isArray(data.lines))
    return res.status(400).json({ error: 'Invalid data: expected { stops[], lines[] }' });
  try {
    saveCustomTimetable(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save', details: e.message });
  }
});

// Custom stations list (for station-selection drawer)
app.get('/api/custom-stations', (req, res) => {
  const ct = loadCustomTimetable();
  const stations = (ct.stops || []).map(s => ({
    name:   s.name,
    eva:    `CUSTOM_${s.id}`,
    ds100:  null,
    tags:   ['SUBURBAN_TRAIN'],
    custom: true,
  }));
  res.json(stations);
});

app.get('/api/db-departures', async (req, res) => {
  try {
    const eva = (req.query.eva || DEFAULT_EVA).toString();
    // Intercept custom station EVAs — no DB API call needed
    if (eva.startsWith('CUSTOM_')) {
      return res.json(buildCustomDepartures(eva));
    }
    const data = await loadDbDepartures(eva);
    cachedData = data;
    lastFetchOk = true;
    res.json(data);
  } catch (e) {
    // If live fetch fails, return last cached data or fallback structure
    console.warn('DB fetch failed:', e.message);
    if (cachedData.trains?.length) return res.json(cachedData);
    res.status(503).json({ trains: [], error: 'DB API unavailable' });
  }
});

// Raw DB API data endpoint for debugging
app.get('/api/db-raw', async (req, res) => {
  try {
    const eva = (req.query.eva || DEFAULT_EVA).toString();
    const now = new Date();
    const date = toYyMmDd(now);
    const hour = toHour(now);
    const { p1, p2, ch } = await fetchPlannedAndChanges({ eva, dateYYMMDD: date, hourHH: hour });
    
    res.json({
      station: eva,
      fetchedAt: new Date().toISOString(),
      date: date,
      hour: hour,
      plan1: p1,
      plan2: p2,
      changes: ch
    });
  } catch (e) {
    res.status(503).json({ error: 'DB API unavailable', details: e.message });
  }
});

// SSE events
const clients = new Set();
app.get('/events', (req, res) => {
  console.log('🔌 New SSE client connected. Total clients:', clients.size + 1);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const client = { res };
  clients.add(client);
  // Send an initial ping (but mark it as initial so clients can ignore it)
  console.log('📤 Sending initial "connected" event to new client');
  res.write(`event: connected\n`);
  res.write(`data: {"ok":true}\n\n`);

  req.on('close', () => {
    clients.delete(client);
    console.log('🔌 SSE client disconnected. Remaining clients:', clients.size);
  });
});

function broadcastUpdate(source = 'unknown', extra = {}) {
  const stack = new Error().stack.split('\n')[2].trim();
  console.log(`📡 Broadcasting SSE update to ${clients.size} client(s) - Source: ${source}`);
  console.log(`   Called from: ${stack}`);
  const payload = JSON.stringify({ time: new Date().toISOString(), source, ...extra });
  for (const { res } of clients) {
    try {
      res.write(`event: update\n`);
      res.write(`data: ${payload}\n\n`);
    } catch {
      // connection might be closed; let close handler clean up
    }
  }
}

// Periodic background refresh and broadcast
let periodicRefreshIntervalId = null;

async function periodicRefresh() {
  try {
    const data = await loadDbDepartures(DEFAULT_EVA);
    const prev = JSON.stringify(cachedData.trains || []);
    cachedData = data;
    const curr = JSON.stringify(cachedData.trains || []);
    if (prev !== curr) {
      console.log('DB API data changed, broadcasting update');
      broadcastUpdate('db-api-change');
    }
    // Don't broadcast if nothing changed - clients handle clock updates locally
    lastFetchOk = true;
  } catch (e) {
    console.warn('Background refresh failed:', e.message);
    lastFetchOk = false;
  }
}

// Don't start periodic refresh automatically - it's wasteful if no one is using DB API mode
// The client-side auto-refresh interval in DB API mode will keep data fresh via /api/db-departures
// Only uncomment this if you want server-side caching for the default station:
// setInterval(periodicRefresh, 30000);
// setTimeout(periodicRefresh, 2000);

// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log('📊 Daily batch train logging enabled - writes once every 24 hours');
  console.log(`📁 Log directory: ${TRAIN_LOG_DIR}`);
  console.log(`📅 Current week: ${getWeekIdentifier()}`);
  console.log(`⏰ Log check interval: every ${CHECK_INTERVAL_MS / 1000 / 60} minutes`);
  
  // Create log directory if it doesn't exist
  try {
    await fsPromises.mkdir(TRAIN_LOG_DIR, { recursive: true });
    console.log('📁 Ensured train logs directory exists');
  } catch (e) {
    console.warn('Could not create train logs directory:', e.message);
  }
  
  // Check immediately on startup if we need to flush
  console.log('🔍 Checking if pending data needs to be flushed...');
  await checkAndFlushIfNeeded();
  
  // Set up periodic check (every hour)
  setInterval(checkAndFlushIfNeeded, CHECK_INTERVAL_MS);
  console.log('✅ Daily logging timer started');
});
