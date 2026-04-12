// === TRAIN ARRIVAL NOTIFICATIONS ===

    async function requestNotificationPermission() {
      if (!('Notification' in window)) {
        console.warn('This browser does not support notifications');
        return false;
      }
      if (Notification.permission === 'granted') return true;
      if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
      }
      return false;
    }

    function getTrainNotifyId(train) {
      return train._uniqueId || `${train.linie || ''}-${train.plan || ''}-${train.date || ''}-${train.ziel || ''}`;
    }

    // ── Notification state ─────────────────────────────────────────────────────
    // One entry per train: { inWindow: bool, statusKey: string, lastFiredKey: string|null }
    // statusKey encodes the meaningful notification-relevant status.
    // lastFiredKey = `${statusKey}@in` when we last fired, null when train is outside window.
    const _notifState = new Map();

    function _trainStatusKey(train, now) {
      if (train.checkoutTime) return `departed:${train.checkoutTime}`;
      if (train.canceled) return 'canceled';
      const delay = (train.plan && train.actual)
        ? getDelay(train.plan, train.actual, now, train.date)
        : 0;
      if (delay > 0) return `late:${delay}`;
      if (delay < 0) return `early:${-delay}`;
      return 'ontime';
    }

    // Returns the computed occupation-end time for a train, or null if not applicable.
    // Priority: explicit checkoutTime > trainTime + dauer.
    function _occupationEndTime(train, trainTime, now) {
      if (train.checkoutTime) return parseTime(train.checkoutTime, now, train.date);
      if (train.dauer && train.dauer > 0 && trainTime)
        return new Date(trainTime.getTime() + train.dauer * 60000);
      return null;
    }

    // === TEMPORARY DEBUG FLAG ===
    // Set to false to re-enable in-app notifications.
    const _IN_APP_NOTIF_DISABLED = true;

    // Called after every data change AND on the 15 s fallback interval.
    function checkTrainArrivals() {
      if (_IN_APP_NOTIF_DISABLED) {
        // In-app notifications temporarily disabled for push debug.
        return;
      }
      if (!processedTrainData.localTrains) return;

      const now = new Date();
      const windowEnd = new Date(now.getTime() + 20 * 60000);
      const seenIds = new Set();

      processedTrainData.localTrains.forEach(train => {
        if (!train.plan && !train.actual) return;
        const trainId = getTrainNotifyId(train);
        if (!trainId) return;
        seenIds.add(trainId);

        const trainTime = parseTime(train.actual || train.plan, now, train.date);
        if (!trainTime) return;

        const inWindow = trainTime >= now && trainTime < windowEnd;
        const statusKey = _trainStatusKey(train, now);
        const occupationEnd = _occupationEndTime(train, trainTime, now);
        // Mark as departed when occupation end has been reached (dauer-based or explicit checkout).
        const isDeparted = train.checkoutTime
          || (occupationEnd && now >= occupationEnd);
        const effectiveStatusKey = isDeparted
          ? (train.checkoutTime ? statusKey : `departed:dauer@${train.dauer}`)
          : statusKey;
        const prev = _notifState.get(trainId);

        if (!prev) {
          _notifState.set(trainId, { inWindow, statusKey: effectiveStatusKey, lastFiredKey: null });
          return;
        }

        // Departure fires regardless of window position, once per train.
        if (effectiveStatusKey.startsWith('departed:') && prev.statusKey !== effectiveStatusKey) {
          sendTrainNotification(train, trainTime, occupationEnd);
          console.log(`🔔 Notif departure: ${train.linie} ${train.ziel}`);
          _notifState.set(trainId, { inWindow, statusKey: effectiveStatusKey, lastFiredKey: effectiveStatusKey });
          return;
        }

        if (!inWindow) {
          _notifState.set(trainId, { inWindow: false, statusKey: effectiveStatusKey, lastFiredKey: null });
          return;
        }

        // Inside window: fire on entry or status change.
        const fireKey = `${effectiveStatusKey}@in`;
        const windowEntry = !prev.inWindow;
        const statusChanged = prev.statusKey !== effectiveStatusKey;

        if (windowEntry || statusChanged) {
          if (prev.lastFiredKey !== fireKey) {
            sendTrainNotification(train, trainTime, null);
            console.log(`🔔 Notif: ${train.linie} ${train.ziel} — ${effectiveStatusKey}`);
            _notifState.set(trainId, { inWindow: true, statusKey: effectiveStatusKey, lastFiredKey: fireKey });
            return;
          }
        }

        _notifState.set(trainId, { inWindow: true, statusKey: effectiveStatusKey, lastFiredKey: prev.lastFiredKey });
      });

      // Remove trains no longer in processedTrainData.
      _notifState.forEach((_, id) => {
        if (!seenIds.has(id)) _notifState.delete(id);
      });
    }

    function sendTrainNotification(train, trainTime, occupationEnd) {
      if (Notification.permission !== 'granted') return;

      const lineLabel = train.linie || '';
      const destinationLabel = train.ziel || '';
      const now = new Date();
      const planTime = train.plan ? parseTime(train.plan, now, train.date) : null;
      const planClock = planTime ? formatClock(planTime) : formatClock(trainTime);
      const delay = getDelay(train.plan, train.actual, now, train.date);

      // Determine departure time to show: explicit checkoutTime, or computed occupation end.
      const depTime = train.checkoutTime
        ? parseTime(train.checkoutTime, now, train.date)
        : occupationEnd;
      const isDeparture = !!depTime;

      const title = `${lineLabel} nach ${destinationLabel}`.trim();
      let body;
      if (isDeparture) {
        const depClock = depTime ? formatClock(depTime) : '';
        if (delay <= 0) {
          body = `Ankunft pünktlich um ${depClock}. Vielen Dank und auf Wiedersehen.`;
        } else {
          body = `Ankunft um ${depClock}. Vielen Dank und auf Wiedersehen.`;
        }
      } else if (train.canceled) {
        body = `Abfahrt ursprünglich ${planClock}. Fällt heute aus. Wir bitten um Entschuldigung.`;
      } else if (delay > 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${delay} Minuten später um ${formatClock(trainTime)}.`;
      } else if (delay < 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${-delay} Minuten früher um ${formatClock(trainTime)}.`;
      } else {
        body = `Ihre Reise geht los. Abfahrt heute pünktlich um ${planClock}.`;
      }

      const iconPath = lineLabel ? `/res/${lineLabel.toLowerCase()}.svg` : undefined;
      const notifOptions = {
        body,
        icon: iconPath,
        // badge: SVG not supported on Android — omitted
        tag: `${train._uniqueId || getTrainNotifyId(train)}-${Date.now()}`,
        requireInteraction: false,
        silent: false,
        vibrate: [200, 100, 200],
        data: { url: window.location.href }
      };

      // Android Chrome requires showNotification() via the SW.
      // Fall back to new Notification() on desktop where SW may not be active.
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification(title, notifOptions);
        }).catch(err => console.warn('SW showNotification failed:', err));
      } else {
        try {
          const n = new Notification(title, notifOptions);
          setTimeout(() => n.close(), 12000);
          n.onclick = () => { window.focus(); n.close(); };
        } catch (e) {
          console.warn('Notification fallback failed:', e);
        }
      }
    }

    // Debug helper — open ?debug=1 for the on-screen button, or call from console.
    window.fireDebugNotification = async function() {
      const granted = await requestNotificationPermission();
      if (!granted) { alert('Notification permission not granted.'); return; }
      const now = new Date();
      const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const train = processedTrainData.currentTrain
        || (processedTrainData.localTrains && processedTrainData.localTrains[0])
        || null;
      if (train) {
        sendTrainNotification(train, now, null);
        console.log('🧪 Debug notif fired for', train.linie, train.ziel);
      } else {
        const opts = {
          body: `Benachrichtigung funktioniert. Gesendet um ${timeStr}.`,
          tag: `debug-${Date.now()}`,
          requireInteraction: false,
          silent: false,
          vibrate: [200],
          data: { url: window.location.href }
        };
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(reg => reg.showNotification('Test-Benachrichtigung', opts));
        } else {
          new Notification('Test-Benachrichtigung', opts);
        }
        console.log('🧪 Debug notif fired (no train in schedule)');
      }
    };

    // === WEB PUSH ===

    // Register this device for server-sent push notifications.
    // Safe to call multiple times — server deduplicates by endpoint.
    async function subscribeToPush() {
      console.log('[Push] subscribeToPush() called');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('[Push] ServiceWorker or PushManager not available in this browser');
        return;
      }
      if (Notification.permission !== 'granted') {
        console.warn('[Push] Notification permission not granted — skipping subscription');
        return;
      }

      try {
        console.log('[Push] Fetching VAPID public key from server...');
        const keyRes = await fetch('/api/push/vapid-public-key');
        if (!keyRes.ok) {
          console.warn('[Push] Server returned', keyRes.status, '— push not configured on server');
          return;
        }
        const { publicKey } = await keyRes.json();
        console.log('[Push] VAPID public key received:', publicKey.slice(0, 20) + '...');

        const reg = await navigator.serviceWorker.ready;
        console.log('[Push] Service worker ready, scope:', reg.scope);

        let sub = await reg.pushManager.getSubscription();
        if (sub) {
          console.log('[Push] Existing subscription found:', sub.endpoint.slice(0, 60) + '...');
        } else {
          console.log('[Push] No existing subscription — creating new one...');
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: _urlBase64ToUint8Array(publicKey)
          });
          console.log('[Push] New subscription created:', sub.endpoint.slice(0, 60) + '...');
        }

        console.log('[Push] Registering subscription with server...');
        const regRes = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON())
        });
        if (regRes.ok) {
          console.log('[Push] ✅ Subscription registered with server successfully');
        } else {
          console.warn('[Push] Server rejected subscription:', regRes.status, await regRes.text());
        }
      } catch (e) {
        console.error('[Push] subscribeToPush error:', e);
      }
    }

    function _urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }

    // Build the full list of push events for the next `days` days, based on
    // processedTrainData.localTrains. Called by saveSchedule() before POSTing.
    // Returns an array of { id, notifyAt (ISO), title, options } objects.
    //
    // Mirrors Path A behaviour exactly:
    //   win-{id}         → 20 min before departure (window entry)
    //   chg-{id}-{key}   → immediate, when train is already in window and status changed
    //   dep-{id}         → at exact departure time ("Ihre Reise geht jetzt los")
    //   end-{id}         → at occupation end (dauer / checkoutTime)
    function buildPushEvents(days = 14) {
      if (!processedTrainData || !Array.isArray(processedTrainData.localTrains)) return [];
      const now = new Date();
      const windowStart = now;
      const windowEnd = new Date(now.getTime() + 20 * 60000);
      const cutoff = new Date(now.getTime() + days * 86400000);
      const events = [];

      processedTrainData.localTrains.forEach(train => {
        if (!train.plan && !train.actual) return;
        const trainTime = parseTime(train.actual || train.plan, now, train.date);
        if (!trainTime || trainTime < now || trainTime > cutoff) return;

        const lineLabel = train.linie || '';
        const dest = train.ziel || '';
        const planTime = train.plan ? parseTime(train.plan, now, train.date) : trainTime;
        const planClock = formatClock(planTime);
        const delay = getDelay(train.plan, train.actual, now, train.date);
        const title = `${lineLabel} nach ${dest}`.trim();
        const appUrl = window.location.origin + '/';
        const trainId = train._uniqueId || getTrainNotifyId(train);

        // Compute a status key matching Path A so IDs are deterministic per status.
        const statusKey = train.canceled ? 'canceled'
          : delay > 0 ? `late:${delay}`
          : delay < 0 ? `early:${-delay}`
          : 'ontime';

        const inWindow = trainTime >= windowStart && trainTime < windowEnd;

        // ── Immediate status-change notification (train already in window) ──
        // Fires ~3s after save. ID is deterministic per status so a repeated
        // save with the same status doesn't re-queue a duplicate.
        if (inWindow) {
          let chgBody;
          if (train.canceled) {
            chgBody = `Abfahrt ursprünglich ${planClock}. Fällt heute aus. Wir bitten um Entschuldigung.`;
          } else if (delay > 0) {
            chgBody = `Abfahrt ursprünglich ${planClock}, heute ${delay} Minuten später um ${formatClock(trainTime)}.`;
          } else if (delay < 0) {
            chgBody = `Abfahrt ursprünglich ${planClock}, heute ${-delay} Minuten früher um ${formatClock(trainTime)}.`;
          } else {
            chgBody = `Abfahrt heute pünktlich um ${planClock}. Bitte bereit halten.`;
          }
          events.push({
            id: `chg-${trainId}-${statusKey}`,
            notifyAt: new Date(now.getTime() + 3000).toISOString(),
            title,
            options: {
              body: chgBody,
              icon: lineLabel ? `/res/${lineLabel.toLowerCase()}.svg` : '/res/6.png',
              vibrate: [200, 100, 200],
              data: { url: appUrl }
            }
          });
        }

        // ── Window-entry notification: 20 min before trainTime ──────────
        const windowNotifyAt = new Date(trainTime.getTime() - 20 * 60000);
        if (windowNotifyAt > now) {
          let windowBody;
          if (train.canceled) {
            windowBody = `Abfahrt ursprünglich ${planClock}. Fällt heute aus. Wir bitten um Entschuldigung.`;
          } else if (delay > 0) {
            windowBody = `Abfahrt ursprünglich ${planClock}, heute ${delay} Minuten später um ${formatClock(trainTime)}.`;
          } else if (delay < 0) {
            windowBody = `Abfahrt ursprünglich ${planClock}, heute ${-delay} Minuten früher um ${formatClock(trainTime)}.`;
          } else {
            windowBody = `Abfahrt heute pünktlich um ${planClock}. Bitte bereit halten.`;
          }
          events.push({
            id: `win-${trainId}`,
            notifyAt: windowNotifyAt.toISOString(),
            title,
            options: {
              body: windowBody,
              icon: lineLabel ? `/res/${lineLabel.toLowerCase()}.svg` : '/res/6.png',
              vibrate: [200, 100, 200],
              data: { url: appUrl }
            }
          });
        }

        // ── Departure notification: at trainTime ─────────────────────────
        if (trainTime > now && !train.canceled) {
          let depBody;
          if (delay > 0) {
            depBody = `Ihre Reise geht jetzt los. Abfahrt heute ${delay} Minuten später um ${formatClock(trainTime)}.`;
          } else if (delay < 0) {
            depBody = `Ihre Reise geht jetzt los. Abfahrt heute ${-delay} Minuten früher um ${formatClock(trainTime)}.`;
          } else {
            depBody = `Ihre Reise geht jetzt los. Abfahrt heute pünktlich um ${planClock}.`;
          }
          events.push({
            id: `dep-${trainId}`,
            notifyAt: trainTime.toISOString(),
            title,
            options: {
              body: depBody,
              icon: lineLabel ? `/res/${lineLabel.toLowerCase()}.svg` : '/res/6.png',
              vibrate: [300, 100, 300],
              data: { url: appUrl }
            }
          });
        }

        // ── Occupation-end notification ───────────────────────────────────
        const occupationEnd = train.checkoutTime
          ? parseTime(train.checkoutTime, now, train.date)
          : (train.dauer && train.dauer > 0 ? new Date(trainTime.getTime() + train.dauer * 60000) : null);

        if (occupationEnd && occupationEnd > now && occupationEnd <= cutoff) {
          const depClock = formatClock(occupationEnd);
          const endBody = delay <= 0
            ? `Ankunft pünktlich um ${depClock}. Vielen Dank und auf Wiedersehen.`
            : `Ankunft um ${depClock}. Vielen Dank und auf Wiedersehen.`;
          events.push({
            id: `end-${trainId}`,
            notifyAt: occupationEnd.toISOString(),
            title,
            options: {
              body: endBody,
              icon: lineLabel ? `/res/${lineLabel.toLowerCase()}.svg` : '/res/6.png',
              vibrate: [200],
              data: { url: appUrl }
            }
          });
        }
      });

      console.log(`📅 buildPushEvents: ${events.length} event(s) for next ${days} days`);
      if (events.length > 0) {
        console.log('[Push] First event:', events[0].id, '@', events[0].notifyAt, '—', events[0].options.body);
        console.log('[Push] Last event: ', events[events.length-1].id, '@', events[events.length-1].notifyAt);
      }
      return events;
    }

    // === END WEB PUSH CLIENT ===

    // Console debug helper — call window.debugPushStatus() at any time.
    window.debugPushStatus = async function() {
      console.group('[Push] Debug Status');
      console.log('In-app notif disabled:', _IN_APP_NOTIF_DISABLED);
      console.log('Notification.permission:', Notification.permission);
      console.log('ServiceWorker supported:', 'serviceWorker' in navigator);
      console.log('PushManager supported:', 'PushManager' in window);

      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        console.log('SW registration:', reg ? reg.scope : 'none');
        console.log('SW controller:', navigator.serviceWorker.controller ? 'active' : 'none');
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          console.log('Push subscription:', sub ? sub.endpoint.slice(0, 80) + '...' : 'none');
        }
      }

      try {
        const serverDebug = await fetch('/api/push/debug');
        if (serverDebug.ok) {
          const d = await serverDebug.json();
          console.log('Server subscriptions:', d.subscriptionCount);
          console.log('Server pending events:', d.pendingEventCount);
          console.log('Server next event:', d.nextEvent || 'none');
        }
      } catch (e) {
        console.warn('Could not reach /api/push/debug:', e.message);
      }

      console.log('_notifState entries:', _notifState.size);
      console.groupEnd();
    };

    // Fetch data from server API