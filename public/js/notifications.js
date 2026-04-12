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

    // Called after every data change AND on the 15 s fallback interval.
    function checkTrainArrivals() {
      if (Notification.permission !== 'granted') return;
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

    // Fetch data from server API