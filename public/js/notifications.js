// === TRAIN ARRIVAL NOTIFICATIONS ===
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

    function checkTrainArrivals() {
      const now = new Date();
      const zeroMinutesFromNow = now;
      const twentyMinutesFromNow = new Date(now.getTime() + 20 * 60000);
      
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
        const previousStatus = lastTrainStatusById.get(trainId);
        lastTrainStatusById.set(trainId, statusKey);

        // Only notify when the train status changes (skip first observation)
        if (!previousStatus || previousStatus === statusKey) {
          return;
        }

        // Check if train arrives between 0 and 20 minutes from now
        if (trainTime >= zeroMinutesFromNow && trainTime < twentyMinutesFromNow) {
          if (lastNotifiedStatusById.get(trainId) !== statusKey) {
            sendTrainNotification(train, trainTime);
            lastNotifiedStatusById.set(trainId, statusKey);
          }
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
    
    function sendTrainNotification(train, trainTime) {
      if (Notification.permission !== 'granted') return;
      
      const lineLabel = train.linie || train.line || '';
      const destinationLabel = train.ziel || train.destination || '';
      const planTime = train.plan ? parseTime(train.plan, new Date(), train.date) : null;
      const planClock = planTime ? formatClock(planTime) : formatClock(trainTime);
      const delay = getDelay(train.plan, train.actual, new Date(), train.date);

      const title = `${lineLabel} nach ${destinationLabel}`.trim();
      let body = `Abfahrt ${planClock} von Gleis --.`;

      if (train.canceled) {
        body = 'Fällt heute aus. Wir bitten um Entschuldigung.';
      } else if (delay > 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${delay} Minuten später.`;
      } else if (delay < 0) {
        body = `Abfahrt ursprünglich ${planClock}, heute ${-delay} Minuten früher.`;
      }
      
      const notification = new Notification(title, {
        body: body,
        icon: train.line ? `./res/${train.line.toLowerCase()}.svg` : undefined,
        badge: train.line ? `./res/${train.line.toLowerCase()}.svg` : undefined,
        tag: `train-${train.id}`, // Prevent duplicate notifications
        requireInteraction: false,
        silent: false
      });
      
      // Auto-close after 10 seconds
      setTimeout(() => notification.close(), 10000);
      
      // Optional: focus the window when notification is clicked
      notification.onclick = function() {
        window.focus();
        notification.close();
      };
      
      console.log(`📢 Notification sent for train ${train.line} to ${train.destination} at ${timeStr}`);
    }

    // Fetch data from server API