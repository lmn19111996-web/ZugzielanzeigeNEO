# Data Manipulations

This document lists every place in the codebase where in-memory train/schedule objects are mutated outside of normal user-initiated save operations.  
All mutations listed here operate on the **live JavaScript objects only** — the server-side `data.json` / `push_subscriptions.json` is not written unless `saveSchedule()` is explicitly called.

---

## 1. S6 → FEX Promotion

**File:** `public/js/globals.js` — inside `processTrainData()`  
**Trigger:** Runs on every call to `processTrainData()` (i.e., on every page load and data refresh).

**Rule:**  
Any S6 train whose `ziel` starts with `[PRÜ]` has its `linie` field mutated from `S6` to `FEX` if the departure date is between today and 14 days from now (inclusive).

```js
if ((t.linie || '').toUpperCase() === 'S6' &&
    t.ziel.trimStart().toUpperCase().startsWith('[PRÜ]') &&
    daysUntil >= 0 && daysUntil <= 14) {
  t.linie = 'FEX';
}
```

**Scope:** Both `allTrains` (shared schedule) and `localTrains` (personal schedule).  
**Persisted?** No. The stored `linie` value remains `S6`. The mutation only lives for the current `processTrainData` cycle and does not survive `saveSchedule()`.

---

## 2. `_uniqueId` Assignment

**File:** `public/js/schedule.js` — `assignId()` / `assignProjectId()` inside `loadSchedule()`  
**Trigger:** Once at load time, for any train, project, or task that lacks a `_uniqueId`.

**Rule:**  
Generates a random ID of the form `train_<random>_<timestamp>` and sets it on the object.

**Persisted?** Yes — written on next `saveSchedule()`.

---

## 3. `_isPastTrain` Flag

**File:** `public/js/globals.js` — inside `processTrainData()`  
**Trigger:** Every `processTrainData()` call.

**Rule:**  
Trains from today whose occupancy end time is already in the past receive `_isPastTrain = true`. This flag drives the "past train" visual style in the list.

```js
pastTrainsFromToday.forEach(t => { t._isPastTrain = true; });
```

**Persisted?** No. The flag is not part of the schema and is deleted when the editor opens a train (`delete restoredTrain._isPastTrain` in `editor.js`).

---

## 4. `_isPreview` Flag

**File:** `public/js/time-suggestion.js` — `previewTaskAtTime()` and `renderPreviewOverlay()`  
**Trigger:** When the user hovers over a time-suggestion slot in the Belegungsplan overlay.

**Rule:**  
Temporarily sets `train._isPreview = true` on the existing train object while rendering the overlay block, then immediately deletes it:

```js
train._isPreview = true;
// ... render ...
delete train._isPreview;
```

A separate spread copy (`{ ...train, _isPreview: true }`) is also created for the overlay preview object — that copy is ephemeral and never stored.

**Persisted?** No.

---

## 5. `_readOnly` and `_showDurationColumn` Flags (Log Viewer)

**File:** `public/js/render-trains.js` — log-viewer row construction  
**Trigger:** When the log viewer renders train-log entries.

**Rule:**  
Synthetic train-like objects are constructed with `_readOnly: true` and `_showDurationColumn: true` to suppress edit controls and show the duration column. These are brand-new objects, not mutations of persisted data.

**Persisted?** No — objects exist only for the duration of the render call.
