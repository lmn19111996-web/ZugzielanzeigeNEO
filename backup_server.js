// Express server to fetch DB Timetables API and feed the frontend
// Endpoints:
// - GET /api/db-departures -> { trains: [...] }
// - GET /api/db-raw        -> raw parsed XML from DB API (for debugging)
// - GET /api/schedule      -> serves fallback JSON from public/data.json
// - GET /api/health        -> health status
// - GET /events            -> Server-Sent Events (emits {event: 'update'})
// - Static files from /public

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

// --- Config ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_EVA = process.env.EVA || '8000152'; // Hannover Hbf by default
const TRAIN_LOG_DIR = path.join(__dirname, 'train_logs');

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

// Get weekly log file path
function getWeeklyLogFile(date = new Date()) {
  const weekId = getWeekIdentifier(date);
  // Ensure log directory exists
  if (!fs.existsSync(TRAIN_LOG_DIR)) {
    fs.mkdirSync(TRAIN_LOG_DIR, { recursive: true });
  }
  return path.join(TRAIN_LOG_DIR, `train_history_${weekId}.log`);
}

// Comprehensive train logging - exports everything on every save
function logTrainHistory(trains, scheduleType, additionalInfo = {}) {
  try {
    const timestamp = new Date().toISOString();
    
    // Log all trains for this schedule type, regardless of changes
    // This ensures the log is always up-to-date with current state
    updateTrainStates(trains, scheduleType, timestamp);
    
  } catch (e) {
    console.error('Error logging train history:', e.message);
  }
}

// Update or add all train states in the weekly log (comprehensive export on every save)
function updateTrainStates(trains, scheduleType, timestamp) {
  // Group trains by week based on their calculated dates
  const trainsByWeek = new Map();
  
  // Process all trains and group by week
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
    
    if (!trainsByWeek.has(weekId)) {
      trainsByWeek.set(weekId, []);
    }
    trainsByWeek.get(weekId).push(currentState);
  });
  
  // Process each week separately
  trainsByWeek.forEach((weekTrains, weekId) => {
    const weekDate = parseWeekIdentifier(weekId);
    const weekLogFile = getWeeklyLogFile(weekDate);
    const existingLog = readLogAsStateMap(weekLogFile);
    
    // Add/update trains for this week
    weekTrains.forEach(trainState => {
      existingLog.set(trainState.trainKey, trainState);
    });
    
    // Rewrite the log file for this week
    rewriteLogFile(existingLog, weekLogFile);
    // Condensed logging - only show total per save operation
  });
  
  const totalTrains = Array.from(trainsByWeek.values()).reduce((sum, trains) => sum + trains.length, 0);
  const weeksList = Array.from(trainsByWeek.keys()).join(', ');
  console.log(`✅ Logged ${totalTrains} ${scheduleType} trains to ${trainsByWeek.size} week(s): ${weeksList}`);
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
function readLogAsStateMap(logFilePath = null) {
  const stateMap = new Map();
  const logFile = logFilePath || getWeeklyLogFile();
  
  try {
    if (!fs.existsSync(logFile)) {
      return stateMap;
    }
    
    const content = fs.readFileSync(logFile, 'utf8');
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
function rewriteLogFile(stateMap, logFilePath = null) {
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
    
    fs.writeFileSync(logFile, logContent, 'utf8');
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
app.get('/api/train-history', (req, res) => {
  const weekId = req.query.week || getWeekIdentifier();
  const logFile = path.join(TRAIN_LOG_DIR, `train_history_${weekId}.log`);
  
  fs.readFile(logFile, 'utf8', (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        return res.json({ 
          entries: [], 
          message: `No log file found for week ${weekId}`,
          week: weekId
        });
      }
      return res.status(500).json({ error: 'Failed to read log file' });
    }
    
    try {
      // Parse JSON lines
      const lines = content.trim().split('\n').filter(line => line.trim());
      const entries = lines.map(line => JSON.parse(line));
      
      // Optional filtering by query parameters
      const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
      const filtered = limit ? entries.slice(-limit) : entries;
      
      res.json({ 
        entries: filtered,
        total: entries.length,
        showing: filtered.length,
        week: weekId
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse log file', details: e.message });
    }
  });
});

// List available weekly log files
app.get('/api/train-history/weeks', (req, res) => {
  try {
    if (!fs.existsSync(TRAIN_LOG_DIR)) {
      return res.json({ weeks: [] });
    }
    
    const files = fs.readdirSync(TRAIN_LOG_DIR)
      .filter(file => file.startsWith('train_history_') && file.endsWith('.log'))
      .map(file => {
        const match = file.match(/train_history_(.+)\.log$/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
      .sort()
      .reverse(); // Most recent first
    
    res.json({ weeks: files, current: getWeekIdentifier() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list weekly logs', details: e.message });
  }
});

// Fallback schedule (static file)
app.get('/api/schedule', (req, res) => {
  const filePath = path.join(PUBLIC_DIR, 'data.json');
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) return res.status(500).json({ error: 'Failed to read schedule' });
    try {
      const data = JSON.parse(content);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Invalid schedule JSON' });
    }
  });
});

// Save local schedule (used by InputEnhanced.html)
app.post('/api/schedule', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    const toSave = {
      fixedSchedule: Array.isArray(body.fixedSchedule) ? body.fixedSchedule : [],
      spontaneousEntries: Array.isArray(body.spontaneousEntries) ? body.spontaneousEntries : [],
      trains: Array.isArray(body.trains) ? body.trains : [],
    };
    
    // Comprehensive logging: export all current train data on every save
    if (toSave.fixedSchedule.length > 0) {
      logTrainHistory(toSave.fixedSchedule, 'fixed');
    }
    if (toSave.spontaneousEntries.length > 0) {
      logTrainHistory(toSave.spontaneousEntries, 'spontaneous');
    }
    if (toSave.trains.length > 0) {
      logTrainHistory(toSave.trains, 'legacy');
    }
    
    // Also ensure we log empty states to reflect deletions
    if (toSave.fixedSchedule.length === 0 && toSave.spontaneousEntries.length === 0 && toSave.trains.length === 0) {
      // Silent - no need to log empty saves
    }
    
    const filePath = path.join(PUBLIC_DIR, 'data.json');
    fs.writeFile(filePath, JSON.stringify(toSave, null, 2), 'utf8', (err) => {
      if (err) return res.status(500).json({ error: 'Failed to write schedule' });
      // Notify listeners
      try { broadcastUpdate('manual-save'); } catch {}
      res.json({ ok: true, savedAt: new Date().toISOString() });
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected error' });
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
app.listen(PORT, '0.0.0.0',() => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log('📊 Weekly train logging enabled - creates separate log file for each week');
  console.log(`📁 Log directory: ${TRAIN_LOG_DIR}`);
  console.log(`📅 Current week: ${getWeekIdentifier()}`);
  
  // Create log directory if it doesn't exist
  if (!fs.existsSync(TRAIN_LOG_DIR)) {
    fs.mkdirSync(TRAIN_LOG_DIR, { recursive: true });
    console.log('📁 Created train logs directory');
  }
});
