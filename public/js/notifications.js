// === TRAIN ARRIVAL NOTIFICATIONS ===
    const TRAIN_NOTIFICATION_WINDOW_MINUTES = 15;

    async function requestNotificationPermission() {
      if (!('Notification' in window)) {
        console.warn('This browser does not support notifications');
        return false;
      }
      
      if (Notification.permission === 'granted') {
        return true;
      }
      
      if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
      }
      
      return false;
    }
    
    function getTrainNotifyId(train) {
      return train.id || train._uniqueId || `${train.linie || train.line || ''}-${train.plan || ''}-${train.date || ''}-${train.ziel || train.destination || ''}`;
    }

    async function showTrainNotification(title, options) {
      if ('serviceWorker' in navigator) {
        try {
          const registration = await navigator.serviceWorker.ready;
          if (registration && typeof registration.showNotification === 'function') {
            await registration.showNotification(title, options);
            return true;
          }
        } catch (error) {
          console.warn('Service worker notification path failed, falling back to window notification:', error);
        }
      }

      try {
        const notification = new Notification(title, options);
        setTimeout(() => notification.close(), 10000);
        notification.onclick = function() {
          window.focus();
          notification.close();
        };
        return true;
      } catch (error) {
        console.error('Failed to show train notification:', error);
        return false;
      }
    }

    function checkTrainArrivals() {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;

      const now = new Date();
      const windowEnd = new Date(now.getTime() + TRAIN_NOTIFICATION_WINDOW_MINUTES * 60000);
      
      if (!processedTrainData.localTrains) return;
      
      // Check local trains for upcoming arrivals
      processedTrainData.localTrains.forEach(train => {
        const trainId = getTrainNotifyId(train);
        if (!trainId || !train.plan) {
          return;
        }
        
        const trainTime = parseTime(train.actual || train.plan, now, train.date);
        if (!trainTime) return;
        
        const statusKey = `${train.canceled ? 'canceled' : 'active'}|${train.plan || ''}|${train.actual || ''}|${train.dauer || ''}`;
        const notifyKey = `${statusKey}|${train.date || ''}|${train.actual || train.plan || ''}`;
        lastTrainStatusById.set(trainId, statusKey);

        const isUpcoming = trainTime >= now && trainTime < windowEnd;

        if (!isUpcoming) {
          if (trainTime < now) {
            lastNotifiedStatusById.delete(trainId);
          }
          return;
        }

        if (lastNotifiedStatusById.get(trainId) !== notifyKey) {
          sendTrainNotification(train, trainTime).then(function(sent) {
            if (sent) {
              lastNotifiedStatusById.set(trainId, notifyKey);
            }
          });
        }
      });
      
      // Clean up old tracking (remove trains that have passed)
      const idsToRemove = [];
      lastTrainStatusById.forEach((_, id) => {
        const train = processedTrainData.localTrains.find(t => getTrainNotifyId(t) === id);
        if (train) {
          const trainTime = parseTime(train.actual || train.plan, now, train.date);
          if (trainTime && trainTime < now) {
            idsToRemove.push(id);
          }
        } else {
          idsToRemove.push(id);
        }
      });
      idsToRemove.forEach(id => {
        lastTrainStatusById.delete(id);
        lastNotifiedStatusById.delete(id);
      });
    }
    
    async function sendTrainNotification(train, trainTime) {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      
      const lineLabel = train.linie || train.line || '';
      const destinationLabel = train.ziel || train.destination || '';
      const planTime = train.plan ? parseTime(train.plan, new Date(), train.date) : null;
      const planClock = planTime ? formatClock(planTime) : formatClock(trainTime);
      const delay = getDelay(train.plan, train.actual, new Date(), train.date);
      const iconLine = String(lineLabel || '').toLowerCase();
      const notifyId = getTrainNotifyId(train);

      const title = `${lineLabel} nach ${destinationLabel}`.trim();
      let body = `Abfahrt ${planClock} von Gleis --.`;

      if (train.canceled) {
        body = 'Fällt heute aus. Wir bitten um Entschuldigung.';
      } else if (delay > 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${delay} Minuten später.`;
      } else if (delay < 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${-delay} Minuten früher.`;
      }
      
      const sent = await showTrainNotification(title, {
        body: body,
        icon: iconLine ? `/res/${iconLine}.svg` : undefined,
        badge: iconLine ? `/res/${iconLine}.svg` : undefined,
        tag: `train-${notifyId}`,
        requireInteraction: false,
        silent: false,
        data: {
          url: '/mobile.html',
          trainId: notifyId
        }
      });

      if (!sent) return false;
      
      console.log(`📢 Notification sent for train ${lineLabel} to ${destinationLabel} at ${formatClock(trainTime)}`);
      return true;
    }

    // Fetch data from server API