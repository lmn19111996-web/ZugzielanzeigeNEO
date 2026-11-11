# App Dataflow Overview

This document describes the app at a product level and clarifies when to use `refreshUIOnly()` versus `renderCurrentWorkspaceView()`.

## 1. `refreshUIOnly()` vs `renderCurrentWorkspaceView()`

- `renderCurrentWorkspaceView()` is render-only. It paints the active workspace using the current `processedTrainData` and other already-prepared state.
- `refreshUIOnly()` is the local mutation refresh path. It rebuilds derived schedule data, reprocesses trains, then renders the current workspace and refreshes open dependent drawers.

Rule:

- If code mutates persisted app data in memory, especially `schedule.spontaneousEntries`, `schedule.fixedSchedule`, `schedule.trains`, or `schedule.projects`, call `refreshUIOnly()`.
- Do not call `renderCurrentWorkspaceView()` alone after a mutation unless derived data was already rebuilt manually just before it.
- `renderCurrentWorkspaceView()` is appropriate for workspace switches and other render-only situations where the underlying processed state is already current.

Short mental model:

- `refreshUIOnly()` = recompute + rerender
- `renderCurrentWorkspaceView()` = rerender only

## 2. Train Structure

The app works with a normalized train-like object shape. Not every field exists on every item.

Common fields:

- `_uniqueId`: stable client ID used for lookup, editing, save merging, and logs.
- `linie`: line label, for example `S1`.
- `ziel`: destination or note title.
- `zwischenhalte`: stop list.
- `plan`: planned time.
- `actual`: actual or shifted time.
- `dauer`: occupancy or duration in minutes.
- `date`: explicit calendar date for local/spontaneous entries.
- `weekday`: weekday-based recurrence field used by fixed schedule items.
- `canceled`: marks a canceled trip.
- `checkedIn` / `checkedOut`: booleans marking check-in/check-out UI state. `dauer` is always computed as `checkoutTime - actual` at the moment of check-out, where `actual` is user-editable in between — these flags carry no time value themselves and aren't exported to logs.
- `plannedDauer`: the planned duration, frozen once at check-out (or approve) right before `dauer` is overwritten with the measured one. Never changed afterwards; written to the train log. Absent on trains never checked out, where `dauer` still is the plan. Not set for duration-only entries.
- `_checkinEpochMs`: client-side timestamp used as the duration-only-task session start (task types without a fixed `actual` departure time).
- `projectId`: optional link to a project.
- `type`: special mode, commonly `note` or `duration-only`.
- `source`: origin such as local schedule or DB API data.

Important train categories:

- Fixed schedule items: recurring schedule definitions, usually weekday-based.
- Spontaneous entries: local user-created entries for concrete dates.
- Materialized trains: generated working entries derived from the schedule.
- Notes: objects with `type: note`; they behave like notes, not normal trains.
- Duration-only entries: objects with `type: duration-only`; they carry duration without a departure time.
- Information entries: objects with `type: information` (created with Ctrl+I). `ziel` holds the message, valid from `date` through `dateEnd` (inclusive; defaults to the start date, missing = just that day), or every day from `date` on when `openEnded` ("Kein Enddatum" tick box). No line, time or duration — identified by type, never by a placeholder line; collected into `processedTrainData.informationTrains`, shown as a bar under each covered day's separator and marked in the Belegungsplan headers. Never logged; the server prunes them only after `dateEnd` (never when `openEnded`).
  - Recurring: set via the always-visible Wiederholung field in the information editor (no separate Vorlage page; info templates are not listed in the Vorlagen workspace). The template in `fixedSchedule` repeats single-day occurrences from `startDate` through `endDate` (the editor's "Gültig bis"); `openEnded` — or no `endDate` — repeats forever. "Keine Wiederholung" ends the series: started occurrences stay as plain informations. Use `getInformationsForDay()` for per-day lists (each series at most once per day).

Important rule for duration-only entries:

- Use explicit `type: duration-only`.
- Do not infer duration-only mode from an empty `plan`.

## 3. Load / Save Pipeline

### Load pipeline

1. The app starts and loads saved station and view preferences from local storage.
2. `fetchSchedule()` loads `/api/schedule` and, when a station is selected, DB departure data.
3. Missing IDs are assigned to trains, projects, and tasks.
4. Server metadata is copied into `schedule._meta`.
5. Recurring stems are materialized into concrete entries.
6. `regenerateTrainsFromSchedule()` rebuilds the working train arrays.
7. `processTrainData()` derives the view model used by the UI.
8. The current workspace is rendered.

### Save pipeline

1. UI mutates the in-memory `schedule` object.
2. UI should immediately call `refreshUIOnly()` so derived state and visible UI stay in sync.
3. `saveSchedule()` queues if another save is already running.
4. The client updates `schedule._meta.version` optimistically before the network round-trip.
5. The payload is normalized for the server, including cleanup of transient fields.
6. The server persists the schedule and broadcasts newer versions to other sessions.

Practical rule:

- Mutation first, `refreshUIOnly()` second, `saveSchedule()` third.

## 4. Refresh / Rerender Triggers

The UI refreshes from several sources.

### Local mutation refreshes

- Editor drawer saves and action buttons.
- Swipe actions.
- Check-in and check-out after animation completion.
- Train creation, deletion, cancel/reactivate, delay changes, note creation, project edits.

These should use `refreshUIOnly()` because they change persisted local state.

### Render-only triggers

- Workspace mode switches.
- Opening a drawer or overlay that only changes presentation.
- Repainting after `processTrainData()` has already been run by another path.

These can use `renderCurrentWorkspaceView()`.

### Background refresh triggers

- Clock tick updates headline and occupancy-sensitive UI.
- SSE update events fetch newer schedule versions from the server.
- Polling refresh updates from the server and DB API.
- Station selection changes the visible departure source.

These paths usually do their own `processTrainData()` work and then render.

### Dependency refreshes

- Stressmeter refreshes when train data changes.
- Notifications re-check upcoming local trains after relevant refreshes.
- Open drawers such as the project drawer or editor drawer may rebind to the latest item after data refresh.

## 4a. Day Recorder (`day-recorder.js`, data in `day_logs/`)

Records what the weekly train logs can't: when things changed. Purely additive; it never changes what is saved or served.

- `day_logs/snapshots/YYYY-MM-DD.json`: the day's timed trains as planned, taken at 00:05 (or on the first save of the day if the server was off).
- `day_logs/events/YYYY-MM.jsonl`: after every successful `POST /api/schedule`, each changed train (plan, actual, dauer, canceled, date, check-in/out, created, deleted) with the server time. Trains dated before yesterday are ignored.
- Training use: none at the moment. `scripts/lib/real-day-levels.js` turns recorded days into levels (the snapshot is the base plan; cancellations before the day's first disruption, or on a train under no pressure, are *intentional*; after a disruption on a pushed train they are *compensating*), but it only fed the retired hurdle model (`scripts/sandbox-pretrain.js`, now runs only with `--legacy`). Real days are deliberately not fed into the cost model while it is being tested in the sandbox; the recorder keeps recording.

## 4b. Rescheduling Sandbox (`/sandbox.html`)

A separate page for playing through realistic disrupted days and training the learned cost model. Opened from Einstellungen → Prognosemodell → "Sandbox öffnen".

- The page is `mobile.html` rebuilt on request by `sandbox-server.js`, so the train list, editor drawer and all editing behaviour are the unmodified app. Injected: `public/sandbox/sandbox-shim.js` (first, before any app script), `sandbox-guards.js` (before `init.js`), then the engine (`public/sandbox/engine/candidates.js`, `patterns.js`, `cost-model.js`), `sandbox-levels.js` and `sandbox-app.js`, plus `sandbox.css`.
- Isolation (shim): `new Date()`/`Date.now()` are frozen at 00:00 of the scenario day; `/api/schedule` is routed to `/api/sandbox/*`; every other non-GET `/api/` call (settings, push, journal, bins, logs) is swallowed; `/api/db-departures` is blocked; `EventSource`, `Notification`, service-worker registration and `showNotification` are stubbed; `localStorage` keys get an `sbx:` prefix and IndexedDB names an `sbx-` prefix — the latter keeps the offline outbox (which the live app replays to `/api/schedule`) separate.
- Data lives only in `sandbox_data/` (gitignored): `state.json` (current day + scenario), `episodes.jsonl` (one record per finished level, `version: 2`), `events.jsonl` (every change you made, in order), `cost-model.json` (fitted costs + patterns, written by the server). The live `fixedSchedule` and `projects` are read when a level is created; settings for the line ranking; `train_logs` (read-only) for realistic disruptions and one-off trains. Nothing is ever written back. Levels of earlier sandbox generations are in `sandbox_data/archive/` (the hurdle-model levels in `2026-11-11_v2-hurdle-model/`).
- Reduced UI: `public/sandbox/sandbox-guards.js` blocks the workspaces/drawers Meldungen, Notizen, Projekte, Vorlagen, Logs, Rezensionen, Papierkorb and the DB station selection; the shim traps `window.openDashboardMode` so the Abfahrtstafel never opens. `sandbox.css` hides the matching nav items and the DB hover menu.
- Engine (`public/sandbox/engine/`, shared by browser and Node; `scripts/lib/candidates.js` / `patterns.js` / `cost-model.js` re-export it): candidate timetables per level (keep/cancel per train after the first disruption plus at most one special action — hold, shrink to fit (also a train disrupted by a late start, never an overrun), relocate behind a later train — built with planned gaps or full breaks), rescheduling patterns inferred from levels (break ∝ task duration, linked pairs that keep their planned gap, per-family slack with a 60-min floor, and a shortest duration = the shortest you have given the family, incl. trains that started late as the disruption — before 3 observations 50 % of the plan), and the cost model: P(timetable) ∝ exp(−cost), costs for delay / cancellation / shortening per train layered overall → tier → line → recurring template (a learned tier list), plus relocation, missing-break, overlap and end-of-day costs. Starting costs: a cancellation ≈ 1 h of delay.
- Task families: recurring templates with the same role (e.g. the 7 weekday Morning Rituals) share what the model learns — costs get a family layer (overall → tier → line → family → template, the template pulled strongly toward its family), and patterns (linked pairs, slack) and level selection work per family. Automatic family = line + name, ignoring case, punctuation and `[..]` prefixes; Einstellungen → Prognosemodell → Aufgabenfamilien merges families or splits a template off (`predictionModel.familyOverrides`: template id → family key or `solo:<id>`). Each level stores the family of every train (`baseDay[].family`); levels without it (archive) use the automatic family.
- Day-start trains (the only explicit rule): task families marked in Einstellungen → Prognosemodell → Tagesbeginn (`predictionModel.dayStartFamilies`; the older per-template `dayStartTemplates` is still honoured and converted when the page is opened), e.g. Morning Ritual. In the candidates such a train is never cancelled or relocated, and its actual start is a floor for every train planned after it (oversleeping can't be undone by skipping the ritual); it can still be shortened. Each level stores the marking (`baseDay[].dayStart`); a level created before families / the marking takes the current settings when opened (`rolesApplied`).
- Fixed appointments (second explicit rule): task families marked in Einstellungen → Prognosemodell → Feste Termine (`predictionModel.appointmentFamilies`, e.g. classes, Tennis). In the candidates the end is fixed: it never ends late and never pushes later trains; attending late means attending less (start = when you are free, end = planned end); free only after its end → it can only be skipped; never relocated, held or shortened by choice; no limit on how late — the costs learn when you'd rather skip. The generator disrupts an appointment only by a late arrival (mostly 5–20 min, sometimes 30–90, it ends as planned: `disruptions[].fixedEnd`). Prediction model only: the editor never adjusts what you enter. Stored per level as `baseDay[].appointment`.
- Fixed appointments in the costs: minutes missed of an appointment (arriving late) and skipping it have their own costs (`missed:*`, `skip:*`, layered like the others), separate from ordinary delay and cancellation, so "from how late on do I skip" is learned from appointment decisions only (starting value: skipping = missing 20 min). A disrupted appointment's given late arrival is priced as missed minutes; a disrupted ordinary train's own late start is not (tested: worse). The model dialog shows the learned threshold per appointment family. `ENGINE_VERSION` in the engine is bumped when features change; the server then refits the stored model on the next load.
- Practice mode ("Übung: Feste Termine" toggle in the bar, remembered per browser, applies from the next level): levels where a fixed appointment is at stake (10–45 min late, by arriving late or because the train before starts late), choosing the day where the model is least sure whether you'd attend or skip. Test levels stay random. Episodes carry `practice`.
- Training (`sandbox-trainer.js`, run in a worker thread by `sandbox-trainer-worker.js` so the server never blocks): after every finished, discarded or restored level the server stores the change and answers at once, then refits the costs on all kept v2 levels in the background and writes `cost-model.json`; refits requested while one runs coalesce into one follow-up. The next level uses the latest finished model (at worst one level behind — still learned from earlier levels only). Saving a level twice (reload / second "Fertig") is ignored. Patterns are refitted every 5 levels (candidate sets cached in between). Starts from zero — no levels, no patterns.
- Levels (`sandbox-levels.js`, generator v5): a date in the next four weeks, its recurring trains made conflict-free (blocks over 8 h left out, overlaps up to 60 min shifted), plus one-off trains from the logs in free gaps (never one that duplicates a recurring task). Disruptions follow the real logs (`/api/sandbox/disruption-stats`): how many per day as on real days (max 3), which train in proportion to how often its template/line really starts late unexplained, late-start size from that train's real late starts (lookup template → task family → line, so new templates inherit their family's history; capped at the pool's 90th percentile and 180 min), overruns only where the logs contain overruns (currently none). Every disruption must stand on its own (no disrupted train that an earlier disruption already pushes — it would read as knock-on), and a day must force a decision (push moves another train). Active levels are chosen among 24 candidate days by what the model is missing: uncertainty (several timetables nearly equally cheap), trains seen in few decisions, train pairs that never competed. Every 4th level is a random realistic day (**test level**, unbiased): its proposals stay hidden (no pills, empty proposal column) until "Fertig", then a reveal compares model, push and you. The bar shows why a level was chosen.
- Live prediction: the model picks the cheapest candidate timetable that agrees with what you already decided (trains moved, resized, cancelled, or confirmed by tapping their time / clearing it in the editor); its proposal for the other trains shows as yellow pills (tap = take over, "Alle Vorschläge übernehmen") and in the right occupancy column, and updates after every change. Hovering an occupancy block shows a card (plan, now, disruption, proposal, what a click does); right-clicking a yellow block = leave the train as it is.
- "Fertig": the first press highlights kept trains that still overlap an earlier one (quick actions: proposal / cancel); the next press saves anyway. The episode stores base day, final timetable, confirmed trains, the model's prediction at level start (made with earlier levels only — the score), push, and the selection reasons. Test levels end with a reveal (model vs. push vs. you); other levels with a toast on the next one. "Unrealistisch" skips a level without learning (logged with an optional reason); finished levels can be discarded / restored in the overview, which refits the model.
- Analysis: `node scripts/sandbox-eval.js` summarises the stored (prequential) scores: test vs. selected levels, model vs. push, trend per block. The archived hurdle-model levels are analysed by `scripts/replay.js [--coverage]` and `scripts/fit-cost-model.js` (legacy modules in `public/sandbox/legacy/`, loaded via `scripts/lib/sandbox-modules.js`).
- Data errors: an episode can be `discarded` (with `discardedReason`) or list `excludedTrains` (dropped when the level is rebuilt).
- The day recorder also logs recurring-template changes (`day_logs/templates/`), the trigger for resetting what was learned about a template.
- The Nachtsperre (curfew) is off in the sandbox: the shim rewrites `curfewEnabled` to false in the settings it reads, so no sandbox train is force-canceled.

## 5. User-Facing Product Areas

These are the main user-visible functions of the app.

- Train list: chronological view of local trains and tasks.
- Occupancy view: vertical time-based Belegungsplan view of train occupancy.
- Headline ribbon: shows the current or next relevant local train.
- Editor drawer: opens a train or note for editing, timing changes, cancellation, recurrence changes, and delete actions.
- Check-in / check-out: lets the user start and finish work on a train/task with animated status changes.
- Announcements drawer: shows notes, delays, conflicts, cancellations, and other announcement-style items.
- Notes drawer: dedicated place for personal notes stored in the same schedule data model.
- Projects workspace: groups trains/tasks into project cards with deadlines and progress.
- Project drawer: detailed project view and editing surface.
- Reviews workspace: displays saved journal reviews and lets the user create or filter them.
- Journal island: lightweight daily review prompt visible in train workspaces.
- Log viewer workspace: read-only historical view of saved train log entries by date range.
- Station overlay / DB departures: switches the visible departure board to live station data.
- Stressmeter dashboard: visual workload and energy view derived from train/task data.
- Notifications: browser reminders for upcoming local trains and changed statuses.

## 6. Safe Usage Rule

When in doubt:

1. If data was mutated, call `refreshUIOnly()`.
2. If the code only changed what is visible, call `renderCurrentWorkspaceView()`.
3. If a background path already ran `processTrainData()`, a direct render is usually enough.

This rule avoids stale `processedTrainData`, missing drawer updates, and partial rerenders.