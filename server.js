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

// --- Config ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_EVA = process.env.EVA || '8000152'; // Hannover Hbf by default
const TRAIN_LOG_DIR = path.join(__dirname, 'train_logs');
const LAST_LOG_TIME_FILE = path.join(__dirname, 'train_logs', '.last_log_time');
const LOG_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every 1 hour

// In-memory accumulator for pending train data (keyed by week)
const pendingTrainData = new Map(); // Map<weekId, Map<trainKey, trainState>>

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
  const before = spontaneousEntries.length;
  const pruned = spontaneousEntries.filter(t => {
    if (!t.date) return true;           // no date = note/undated, keep
    if (t.projectId) return true;       // project task, always keep
    return t.date >= todayStr;          // future/today, keep; past without project = drop
  });
  const removed = before - pruned.length;
  if (removed > 0) {
    console.log(`🧹 Pruned ${removed} expired entries (past, no projectId) from spontaneousEntries`);
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

// Accumulate train data in memory (no immediate write)
async function logTrainHistory(trains, scheduleType, additionalInfo = {}) {
  try {
    // Instead of writing immediately, accumulate train data in memory
    accumulateTrainData(trains, scheduleType);
  } catch (e) {
    console.error('Error accumulating train history:', e.message);
  }
}

// Accumulate train data in memory for batch writing
function accumulateTrainData(trains, scheduleType) {
  trains.forEach(train => {
    const trainKey = createTrainKey(train, scheduleType);
    
    // Convert weekday to actual date for fixed schedules
    let actualDate;
    let dateObj;
    if (scheduleType === 'fixed' && train.weekday) {
      actualDate = weekdayToCurrentWeekDate(train.weekday);
      dateObj = new Date(actualDate);
    } else {
      actualDate = train.date || '';
      dateObj = actualDate ? new Date(actualDate) : new Date();
    }
    
    const currentState = {
      trainKey,
      linie: train.linie || '',
      ziel: train.ziel || '',
      plan: train.plan || '',
      actual: train.actual || '',
      dauer: train.dauer || '',
      stops: train.stops || '',
      date: actualDate,
      canceled: train.canceled || false
    };
    
    // Determine which week this train belongs to
    const weekId = getWeekIdentifier(dateObj);
    
    // Create week map if doesn't exist
    if (!pendingTrainData.has(weekId)) {
      pendingTrainData.set(weekId, new Map());
    }
    
    // Add or update train in the week's map
    pendingTrainData.get(weekId).set(trainKey, currentState);
  });
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
        const logEntry = JSON.parse(line);
        if (logEntry.trainKey) {
          // Each line represents the current state of a train
          stateMap.set(logEntry.trainKey, logEntry);
        }
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
    const logEntries = Array.from(stateMap.values()).map(trainState => {
      return JSON.stringify({
        trainKey: trainState.trainKey,
        linie: trainState.linie,
        ziel: trainState.ziel,
        plan: trainState.plan,
        actual: trainState.actual,
        dauer: trainState.dauer,
        stops: trainState.stops,
        date: trainState.date,
        canceled: trainState.canceled
      });
    });
    
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



// Create a unique key for a train entry to detect duplicates
function createTrainKey(train, scheduleType) {
  // Always use actual date - convert weekday to current week date for fixed schedules
  let actualDate;
  if (scheduleType === 'fixed' && train.weekday) {
    actualDate = weekdayToCurrentWeekDate(train.weekday);
  } else {
    actualDate = train.date || 'unknown';
  }
  
  const keyParts = [
    train.linie || 'unknown',
    train.ziel || 'unknown', 
    train.plan || 'unknown',
    actualDate
  ];
  return keyParts.join('|').toLowerCase();
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
    const record = {
      linie: extractLine(stop),
      ziel: extractDestination(stop) || '',
      platform: extractPlatform(stop) || null,
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
    const plat = ev.changedPlatform || ev.plannedPlatform;
    if (plat) target.platform = String(plat);
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
    
    // Parse JSON lines
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    // Apply default limit of 1000 to prevent massive responses
    const DEFAULT_LIMIT = 1000;
    const requestedLimit = req.query.limit ? parseInt(req.query.limit) : DEFAULT_LIMIT;
    const limit = Math.min(requestedLimit, 10000); // Cap at 10000 for safety
    
    // Only parse the lines we need (from the end for recent entries)
    const startIdx = lines.length > limit ? lines.length - limit : 0;
    const linesToParse = lines.slice(startIdx);
    
    const entries = linesToParse.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.warn('Skipping invalid log line:', line.substring(0, 50));
        return null;
      }
    }).filter(Boolean);
    
    res.json({ 
      entries: entries,
      total: lines.length,
      showing: entries.length,
      week: weekId,
      limited: lines.length > limit
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

    // Log history BEFORE pruning so all entries are archived
    const fixedArr  = Array.isArray(body.fixedSchedule) ? body.fixedSchedule : [];
    const trainsArr = Array.isArray(body.trains) ? body.trains : [];
    if (fixedArr.length > 0)      logTrainHistory(fixedArr, 'fixed');
    if (rawSpontaneous.length > 0) logTrainHistory(rawSpontaneous, 'spontaneous');
    if (trainsArr.length > 0)     logTrainHistory(trainsArr, 'legacy');

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
      projects: Array.isArray(body.projects) ? body.projects : [],
    };

    const filePath = path.join(PUBLIC_DIR, 'data.json');
    await fsPromises.writeFile(filePath, JSON.stringify(toSave, null, 2), 'utf8');

    // Cache the pruned version so next GET doesn't re-inflate it
    scheduleCache = toSave;
    scheduleCacheTime = Date.now();

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

// DB departures API (real-time)
let cachedData = { trains: [], metadata: null };
let lastFetchOk = false;

app.get('/api/db-departures', async (req, res) => {
  try {
    const eva = (req.query.eva || DEFAULT_EVA).toString();
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

function broadcastUpdate(source = 'unknown') {
  const stack = new Error().stack.split('\n')[2].trim();
  console.log(`📡 Broadcasting SSE update to ${clients.size} client(s) - Source: ${source}`);
  console.log(`   Called from: ${stack}`);
  for (const { res } of clients) {
    try {
      res.write(`event: update\n`);
      res.write(`data: {"time":"${new Date().toISOString()}"}\n\n`);
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
