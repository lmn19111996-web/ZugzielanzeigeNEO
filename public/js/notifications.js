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

    // Tracks the statusKey last included in a chg- push event per train.
    // buildPushEvents() only emits chg- when the current status differs from this.
    const _lastPushedStatusByTrain = new Map();

    // Called after every data change AND on the 15 s fallback interval.
    // Path A (in-app) has been removed � Web Push (Path B) is the active notification channel.
    function checkTrainArrivals() {
      // no-op: in-app notifications retired in favour of Web Push
    }



    // Debug helper � open ?debug=1 for the on-screen button, or call from console.
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
        console.log('?? Debug notif fired for', train.linie, train.ziel);
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
        console.log('?? Debug notif fired (no train in schedule)');
      }
    };

    // === WEB PUSH ===

    // Register this device for server-sent push notifications.
    // Safe to call multiple times � server deduplicates by endpoint.
    async function subscribeToPush() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if (Notification.permission !== 'granted') return;

      try {
        const keyRes = await fetch('/api/push/vapid-public-key');
        if (!keyRes.ok) return;
        const { publicKey } = await keyRes.json();

        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: _urlBase64ToUint8Array(publicKey)
          });
        }

        const regRes = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON())
        });
        if (!regRes.ok) {
          console.warn('[Push] Server rejected subscription:', regRes.status);
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
    //   win-{id}         ? 20 min before departure (window entry)
    //   chg-{id}-{key}   ? immediate, when train is already in window and status changed
    //   dep-{id}         ? at exact departure time ("Ihre Reise geht jetzt los")
    //   end-{id}         ? at occupation end (dauer / checkoutTime)
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

        // Build zwischenhalte suffix (max 100 chars) and extract cancel reason from [brackets]
        const _zhRaw = Array.isArray(train.zwischenhalte) ? train.zwischenhalte.filter(s => s && s.trim()) : [];
        // Strip [reason] from each entry for the "von" text; grab first reason found
        let _cancelReason = '';
        const _zhClean = _zhRaw.map(s => {
          const m = s.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
          if (m) {
            if (!_cancelReason) _cancelReason = m[2].trim();
            return m[1].trim();
          }
          return s.trim();
        }).filter(Boolean);
        const _zh = _zhClean.join(', ');
        const zhSuffix = _zh ? (' von ' + (_zh.length > 100 ? _zh.slice(0, 100) + '\u2026' : _zh)) : '';
        // Canceled message parts
        const _cancelVon = _zh ? ` von ${_zh.length > 100 ? _zh.slice(0, 100) + '\u2026' : _zh}` : '';
        const _cancelGrund = _cancelReason ? ` Grund dafür ist ${_cancelReason}.` : '';

        // -- Immediate status-change notification (train already in window) --
        // Only fires when the status is different from what was last pushed for this train.
        if (inWindow) {
          const lastPushed = _lastPushedStatusByTrain.get(trainId);
          const statusChanged = lastPushed !== statusKey;
          if (statusChanged) {
            let chgBody;
            if (train.canceled) {
              chgBody = `Abfahrt ursprünglich ${planClock}${_cancelVon}. Fällt heute aus.${_cancelGrund} Wir bitten um Entschuldigung.`;
            } else if (delay > 0) {
              chgBody = `Abfahrt ursprünglich ${planClock}${zhSuffix}, heute ${delay} Minuten später um ${formatClock(trainTime)}.`;
            } else if (delay < 0) {
              chgBody = `Abfahrt ursprünglich ${planClock}${zhSuffix}, heute ${-delay} Minuten früher um ${formatClock(trainTime)}.`;
            } else {
              chgBody = `Ihre Reise geht los. Abfahrt heute pünktlich um ${planClock}${zhSuffix}.`;
            }
            events.push({
              id: `chg-${trainId}-${statusKey}`,
              notifyAt: new Date(now.getTime() + 3000).toISOString(),
              title,
              options: {
                body: chgBody,
                icon: lineLabel ? `/res/png/square/${lineLabel.toLowerCase()}.png` : '/res/announcement.png',
                vibrate: [200, 100, 200],
                data: { url: appUrl }
              }
            });
            _lastPushedStatusByTrain.set(trainId, statusKey);
          }
        } else {
          // Train left the window � clear so re-entry fires again
          _lastPushedStatusByTrain.delete(trainId);
        }

        // -- Window-entry notification: 20 min before trainTime ----------
        const windowNotifyAt = new Date(trainTime.getTime() - 20 * 60000);
        if (windowNotifyAt > now) {
          let windowBody;
          if (train.canceled) {
            windowBody = `Abfahrt ursprünglich ${planClock}${_cancelVon}. Fällt heute aus.${_cancelGrund} Wir bitten um Entschuldigung.`;
          } else if (delay > 0) {
            windowBody = `Abfahrt ursprünglich ${planClock}${zhSuffix}, heute ${delay} Minuten später um ${formatClock(trainTime)}.`;
          } else if (delay < 0) {
            windowBody = `Abfahrt ursprünglich ${planClock}${zhSuffix}, heute ${-delay} Minuten früher um ${formatClock(trainTime)}.`;
          } else {
            windowBody = `Ihre Reise geht los. Abfahrt heute pünktlich um ${planClock}${zhSuffix}.`;
          }
          events.push({
            id: `win-${trainId}`,
            notifyAt: windowNotifyAt.toISOString(),
            title,
            options: {
              body: windowBody,
              icon: lineLabel ? `/res/png/square/${lineLabel.toLowerCase()}.png` : '/res/announcement.png',
              vibrate: [200, 100, 200],
              data: { url: appUrl }
            }
          });
        }

        // -- Departure notification: at trainTime -------------------------
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
              icon: lineLabel ? `/res/png/square/${lineLabel.toLowerCase()}.png` : '/res/announcement.png',
              vibrate: [300, 100, 300],
              data: { url: appUrl }
            }
          });
        }

        // -- Occupation-end notification -----------------------------------
        const occupationEnd = train.checkoutTime
          ? parseTime(train.checkoutTime, now, train.date)
          : (train.dauer && train.dauer > 0 ? new Date(trainTime.getTime() + train.dauer * 60000) : null);

        if (!train.canceled && occupationEnd && occupationEnd > now && occupationEnd <= cutoff) {
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
              icon: lineLabel ? `/res/png/square/${lineLabel.toLowerCase()}.png` : '/res/announcement.png',
              vibrate: [200],
              data: { url: appUrl }
            }
          });
        }
      });

      return events;
    }

    // === END WEB PUSH CLIENT ===

    // Console debug helper � call window.debugPushStatus() at any time.
    window.debugPushStatus = async function() {
      console.group('[Push] Debug Status');
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

      console.groupEnd();
    };

    // Fetch data from server API
