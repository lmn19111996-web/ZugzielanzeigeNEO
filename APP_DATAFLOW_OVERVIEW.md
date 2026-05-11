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
- `checkinTime`: time a local task was checked in.
- `checkoutTime`: time a local task was checked out.
- `_checkinEpochMs`: client-side timestamp used to calculate checkout duration precisely.
- `projectId`: optional link to a project.
- `type`: special mode, commonly `note` or `duration-only`.
- `source`: origin such as local schedule or DB API data.

Important train categories:

- Fixed schedule items: recurring schedule definitions, usually weekday-based.
- Spontaneous entries: local user-created entries for concrete dates.
- Materialized trains: generated working entries derived from the schedule.
- Notes: objects with `type: note`; they behave like notes, not normal trains.
- Duration-only entries: objects with `type: duration-only`; they carry duration without a departure time.

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