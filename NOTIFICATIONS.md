# Notification System

This document describes the full notification architecture for Zugzielanzeige — covering both the in-app notification path (app open / background tab) and the Web Push path (app fully closed).

---

## Overview

Two parallel paths deliver notifications to the user:

```
┌─────────────────────────────────────────────────────────────┐
│  PATH A — In-app (app open or backgrounded in browser)      │
│                                                             │
│  15 s interval + every refreshUIOnly()                      │
│    → checkTrainArrivals()                                   │
│      → sendTrainNotification()                              │
│        → SW: reg.showNotification()   (Android)             │
│        → new Notification()           (desktop fallback)    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  PATH B — Web Push (app fully closed / Chrome killed)       │
│                                                             │
│  saveSchedule()                                             │
│    → buildPushEvents(14 days)                               │
│      → POST /api/schedule  { …, pushEvents: [...] }         │
│        → server schedules setTimeout per event              │
│          → at fire time: sendPushToAll()                    │
│            → FCM / Web Push Protocol                        │
│              → OS wakes Service Worker                      │
│                → SW push event → showNotification()         │
└─────────────────────────────────────────────────────────────┘
```

Path A gives immediate, reactive notifications while the app is running.  
Path B covers the "set and forget" case — user sets up the schedule, closes the browser, still gets notified.

---

## Files

| File | Role |
|---|---|
| `public/js/notifications.js` | All client notification logic |
| `public/service-worker.js` | SW: handles `push`, `notificationclick`, `notificationclose` |
| `public/push-settings.html` | Subscribe / unsubscribe page (see below) |
| `public/js/init.js` | Wires up `startNotifications()` and `subscribeToPush()` on first user interaction |
| `public/js/schedule.js` | `saveSchedule()` calls `buildPushEvents()` and includes result in POST body |
| `server.js` | Push endpoints, VAPID setup, `schedulePushEvents()`, `sendPushToAll()` |
| `key.env` | VAPID public + private keys (never commit to public repos) |
| `push_subscriptions.json` | All registered device push subscriptions (auto-created, never commit) |
| `push_events.json` | Persisted push schedule — restored on server restart (auto-created) |

---

## Notification Events

### 1. Train entering the 20-minute departure window
Triggered when a train's departure time (actual or planned) is between now and 20 minutes from now and was outside the window on the previous check.

**Messages:**

| Condition | Body |
|---|---|
| On time | *Ihre Reise geht los. Abfahrt heute pünktlich um HH:MM.* |
| Delayed | *Abfahrt ursprünglich HH:MM, heute N Minuten später um HH:MM.* |
| Early | *Abfahrt ursprünglich HH:MM, heute N Minuten früher um HH:MM.* |
| Canceled | *Abfahrt ursprünglich HH:MM. Fällt heute aus. Wir bitten um Entschuldigung.* |

### 2. Status change while already in the window
If a train is already within the 20-minute window and its delay, cancellation, or time changes, a new notification fires immediately reflecting the updated status.

### 3. Occupation end (departure from train)
Fires when `now >= trainTime + dauer` (computed) or when `train.checkoutTime` is set (explicit checkout). Fires regardless of the 20-minute window.

**Messages:**

| Condition | Body |
|---|---|
| On time / early | *Ankunft pünktlich um HH:MM. Vielen Dank und auf Wiedersehen.* |
| Late | *Ankunft um HH:MM. Vielen Dank und auf Wiedersehen.* |

**Title** for all notifications: `{Linie} nach {Ziel}` (e.g. *S1 nach Flughafen*).

---

## Path A: In-App Notifications

### State machine (`_notifState`)

A private `Map<trainId, state>` is owned entirely by `notifications.js`. Each entry holds:

```js
{
  inWindow: boolean,       // was the train in the 20-min window on last check?
  statusKey: string,       // last observed status (see below)
  lastFiredKey: string|null // key of the last notification fired, null = never/reset
}
```

**`statusKey` values:**

| Value | Meaning |
|---|---|
| `'ontime'` | No delay, not canceled |
| `'late:N'` | N minutes late |
| `'early:N'` | N minutes early |
| `'canceled'` | Train is canceled |
| `'departed:HH:MM'` | Explicit checkout time set |
| `'departed:dauer@N'` | Computed occupation end (N = dauer in minutes) |

### Fire conditions

```
First observation      → record state, NEVER fire (prevents startup burst)
isDeparted transitions → fire once (departure message), then lock
!inWindow              → reset lastFiredKey to null (allows re-entry fire)
inWindow + windowEntry → fire if lastFiredKey !== fireKey
inWindow + statusChanged → fire if lastFiredKey !== fireKey
inWindow + no change   → update state silently, no fire
```

### Trigger points

`checkTrainArrivals()` is called from:
- **`refreshUIOnly()`** in `schedule.js` — fires immediately on every local data change (delay edit, cancel, check-in, check-out)
- **15-second interval** — catches pure time-based window crossings (train enters the 20-min window due to clock advancing, with no data change)
- **SSE update handler** — fires after server-pushed data arrives

### Delivery

On Android Chrome, `new Notification()` is blocked. The module detects whether the SW is controlling the page and routes accordingly:

```js
if (navigator.serviceWorker && navigator.serviceWorker.controller) {
  // Android + modern desktop: use SW showNotification()
  navigator.serviceWorker.ready.then(reg => reg.showNotification(title, options));
} else {
  // Desktop fallback: direct Notification API
  new Notification(title, options);
}
```

Auto-close after 12 seconds (Path A only — SW notifications are dismissed by the user or OS).

---

## Path B: Web Push

### Push event types

Path B mirrors Path A exactly. For each train, `buildPushEvents()` generates up to four events:

| Event ID prefix | Fires at | Purpose |
|---|---|---|
| `win-{id}` | `trainTime − 20 min` | Window entry — train is 20 min away |
| `chg-{id}-{statusKey}` | `now + 3 s` (immediate) | Status changed while train is already in the window (delay update, cancellation, or window entry that happened before last save) |
| `dep-{id}` | `trainTime` (exact) | Train departs now |
| `end-{id}` | `trainTime + dauer` | Occupation ends (also fires on explicit checkout) |

The `chg-` ID is deterministic per `statusKey` (`ontime`, `late:N`, `early:N`, `canceled`). This means: if the same status is saved twice without changing, the server cancels the old timeout and re-schedules the same event — it fires at most once per distinct status. If the status changes (e.g. `late:3` → `late:5`), the old `chg-` ID is gone and the new one fires immediately on the next save.

### Subscribe / Unsubscribe page

Open **`/push-settings.html`** in the browser on any device to manage push subscriptions.

**What the page shows:**
- Browser notification permission status
- Whether this specific device has an active push subscription
- Server status: VAPID configured, total subscribed devices, number of pending scheduled notifications

**Actions:**
- **Anmelden** — requests notification permission if not yet granted, creates a `PushManager` subscription, and registers it with the server. All future push events will be delivered to this device.
- **Abmelden** — unsubscribes the device in the browser and removes it from the server's `push_subscriptions.json`. The device will no longer receive any push notifications.
- **Test-Benachrichtigung** — fires a local notification via the service worker to confirm the pipeline works on this device (does not go through the server).

Use this page to prevent test/dev server notifications from spamming a laptop: simply visit the page and click **Abmelden** on the device you want to exclude.

**URL:** `http://localhost:3000/push-settings.html` (or your deployed hostname)

### Setup (one-time per server)

VAPID keys are stored in `key.env` and loaded at server startup:

```
VAPID_PUBLIC_KEY=<base64url>
VAPID_PRIVATE_KEY=<base64url>
```

To regenerate keys (breaks all existing subscriptions — don't do this casually):
```
node scripts/gen-vapid.js
```

### Device subscription flow

1. User grants notification permission (first click on the app)
2. `subscribeToPush()` is called automatically
3. Client fetches VAPID public key from `GET /api/push/vapid-public-key`
4. Client calls `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
5. Resulting subscription object is POSTed to `POST /api/push/subscribe`
6. Server appends it to `push_subscriptions.json` (deduplicates by endpoint)

All devices that subscribe receive every push notification — there is no per-device filtering.

### Push event scheduling flow

On every `saveSchedule()` call:

1. `buildPushEvents(14)` iterates `processedTrainData.localTrains`
2. For each train with a departure time in the next 14 days, it generates:
   - A **departure event** firing 1 minute before `trainTime` with the appropriate message
   - An **occupation-end event** firing at `trainTime + dauer` (if dauer > 0)
3. The full `pushEvents[]` array is included in the `/api/schedule` POST body
4. Server receives it, writes it to `push_events.json`, calls `schedulePushEvents()`
5. `schedulePushEvents()` clears all previous `setTimeout` handles and schedules new ones
6. At fire time: `sendPushToAll(title, options)` broadcasts to every entry in `push_subscriptions.json`

### Server restart recovery

On startup, the server reads `push_events.json` and calls `schedulePushEvents()` again. Events whose `notifyAt` is more than 1 minute in the past are skipped silently.

### Dead subscription cleanup

If FCM/Web Push returns HTTP 410 (Gone) or 404 for a subscription, it is automatically removed from `push_subscriptions.json`. No manual cleanup is needed.

---

## Permissions

`requestNotificationPermission()` requests browser notification permission. On most browsers, this can only be called after a user gesture. The init code attaches a one-time `'click'` listener on `window` to defer the prompt until the user first interacts with the app.

Once permission is `'granted'`, it is persistent across sessions — the prompt only appears once.

If the user denies permission, both Path A and Path B are silently disabled (`Notification.permission === 'denied'` guards are checked at the top of `checkTrainArrivals()` and `sendTrainNotification()`).

---

## Debug

Open the app with `?debug=1` in the URL to show a test notification button.

Or call from the browser console at any time:
```js
window.fireDebugNotification()
```

This fires a notification for the first train in the schedule (or a generic test notification if no trains are loaded). It respects the same SW/fallback routing as live notifications.

---

## Security notes

- `push_subscriptions.json` contains push endpoints unique to each device. Do not commit this file to version control. Add it to `.gitignore`.
- `push_events.json` contains the pre-computed notification text for future trains. Also exclude from version control.
- `key.env` contains the VAPID private key. Already excluded from git; keep it that way.
- Push endpoints go stale when users clear browser data or uninstall the PWA. The dead-subscription cleanup handles this automatically.
