// === CHECK-IN / CHECK-OUT SYSTEM ===
// Handles check-in/check-out for today's tasks.
// Check-in  → sets train.actual = now, train.checkinTime = now
// Check-out → sets train.dauer  = (checkout - checkin) minutes, train.checkoutTime = now
//
// DATA MUTATION IS INTENTIONALLY DEFERRED UNTIL AFTER ANIMATION COMPLETES.
// Reason: clock.js ticks every second and checks processedTrainData.localTrains by
// reference. Setting train.actual immediately would mark the train as "currently
// occupying", triggering needsHeadlineUpdate → renderTrains() mid-animation.
// By deferring mutation + save to the 1.5 s animation callback, the DOM is safe.

// ── Helpers ────────────────────────────────────────────────────────────────

function _ciNowHHMM() {
  var d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function _ciTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _ciFindTrain(uid) {
  return (schedule.spontaneousEntries || []).find(function (t) { return t._uniqueId === uid; });
}

function _ciComputeDuration(baseTime, outTime) {
  var baseH = parseInt(baseTime.split(':')[0], 10);
  var baseM = parseInt(baseTime.split(':')[1], 10);
  var outH  = parseInt(outTime.split(':')[0], 10);
  var outM  = parseInt(outTime.split(':')[1], 10);
  var dur   = (outH * 60 + outM) - (baseH * 60 + baseM);
  if (dur < 1) dur = 1;
  return dur;
}

function _ciComputeDurationFromMs(startMs, endMs) {
  var safeStart = Number(startMs);
  var safeEnd = Number(endMs);
  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd) || safeEnd <= safeStart) return 0;
  return Math.max(0, Math.round((safeEnd - safeStart) / 60000));
}

function _ciApplyCheckoutState(uid, timeStr, dur) {
  var lists = [schedule.spontaneousEntries || [], schedule.trains || [], schedule.localTrains || []];
  var seen = new Set();
  lists.forEach(function (list) {
    list.forEach(function (t) {
      if (!t || t._uniqueId !== uid) return;
      if (seen.has(t)) return;
      seen.add(t);
      if (isDurationOnlyTrain(t)) {
        t.dauer = (Number(t.dauer) || 0) + dur;
        t.checkinTime = undefined;
        t.actual = undefined;
        t._checkinEpochMs = undefined;
      } else {
        t.dauer = dur;
      }
      t.checkoutTime = timeStr;
    });
  });
}

// ── Data operations ────────────────────────────────────────────────────────

function _ciCommitCheckin(uid, timeStr) {
  var train = _ciFindTrain(uid);
  if (!train || train.checkinTime) return; // Idempotent guard
  if (!isDurationOnlyTrain(train)) {
    train.actual = timeStr;
  }
  train.checkinTime = timeStr;
  train._checkinEpochMs = Date.now();
  // Refresh processed data so clock.js sees the correct state on the next tick.
  // We intentionally skip renderCurrentWorkspaceView() here — the animated DOM
  // already shows the correct post-stage-2 state, and a forced re-render would
  // cause a visible blink. The next natural clock tick will re-render cleanly.
  processTrainData(schedule);
  saveSchedule();
}

function _ciSaveCheckout(uid, timeStr, dur, alreadyApplied) {
  if (!alreadyApplied) {
    _ciApplyCheckoutState(uid, timeStr, dur);
  }

  if (typeof invalidateStressmeterCache === 'function') invalidateStressmeterCache();

  processTrainData(schedule);
  renderCurrentWorkspaceView({ includeAnnouncements: false });
  saveSchedule();
}

// ── Unified click handler (document-level capture) ─────────────────────────

document.addEventListener('click', function _ciClickCapture(e) {
  // ── Check-in ────────────────────────────────────────────────────────────
  var ciBtn = e.target.closest('[data-ci-uid]');
  if (ciBtn) {
    var uid   = ciBtn.dataset.ciUid;
    var train = _ciFindTrain(uid);

    // Guard: must be today's non-cancelled train, not yet checked in
    if (!train || train.checkinTime || train.date !== _ciTodayStr() || train.canceled) return;

    e.stopPropagation();
    e.preventDefault();

    var shell = ciBtn.closest('.checkin-shell');
    var wrap  = ciBtn.closest('.checkin-wrap');
    if (!shell || !wrap) return;

    // Capture click time NOW (before any async delay)
    var checkinTime = _ciNowHHMM();

    // Swap icon to eingecheckt.svg
    var icon = ciBtn.querySelector('.ci-icon');
    if (icon) {
      icon.src = 'res/eingecheckt.svg';
      icon.classList.add('ci-icon--checked');
    }

    // Phase 1 (immediate): shell expands, border draws clockwise (0.3 s animations)
    shell.classList.add('checked-in');

    // Phase 2 (1000 ms): CSS already finished — apply fade-out classes.
    // Data commit is deferred a further 450 ms so the fade-out transitions
    // (0.4 s) can play fully on the existing DOM before renderTrains() replaces it.
    setTimeout(function () {
      shell.classList.add('fade-accent');
      wrap.classList.add('show-checkout');
      setTimeout(function () {
        _ciCommitCheckin(uid, checkinTime);
      }, 450);
    }, 1000);

    return;
  }

  // ── Check-out ───────────────────────────────────────────────────────────
  var coBtn = e.target.closest('[data-co-uid]');
  if (coBtn) {
    var uid   = coBtn.dataset.coUid;
    var train = _ciFindTrain(uid);
    if (!train) return;

    if (isDurationOnlyTrain(train)) {
      if (!train.checkinTime) return;
    } else if (train.checkoutTime) {
      return;
    }

    e.stopPropagation();
    e.preventDefault();

    var wrap  = coBtn.closest('.checkin-wrap');
    if (!wrap) return;

    coBtn.disabled = true;
    var checkoutTime = _ciNowHHMM();
    var checkoutDuration;
    if (isDurationOnlyTrain(train)) {
      var checkoutMs = Date.now();
      var startMs = train._checkinEpochMs;
      if (!Number.isFinite(Number(startMs)) && train.checkinTime) {
        var now = new Date();
        var parts = train.checkinTime.split(':');
        if (parts.length === 2) {
          var hh = parseInt(parts[0], 10);
          var mm = parseInt(parts[1], 10);
          if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
            var fallbackStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
            startMs = fallbackStart.getTime();
          }
        }
      }
      checkoutDuration = _ciComputeDurationFromMs(startMs, checkoutMs);
    } else {
      var baseTime = train.checkinTime || train.actual || '00:00';
      checkoutDuration = _ciComputeDuration(baseTime, checkoutTime);
    }

    // Apply checked-out data immediately to avoid transient re-renders showing
    // the old checked-in widget during the animation window.
    _ciApplyCheckoutState(uid, checkoutTime, checkoutDuration);

    // Stage 1 (0-1.5s): run checkout box expansion + border/background animation.
    wrap.classList.remove('show-checkout', 'fade-accent', 'checkout-fade');
    wrap.classList.add('checkout-animating');

    // Stage 2 (1.5-2.0s): fade accent + fade out to nothingness.
    setTimeout(function () {
      wrap.classList.add('fade-accent', 'checkout-fade');
      setTimeout(function () {
        _ciSaveCheckout(uid, checkoutTime, checkoutDuration, true);
      }, 300);
    }, 1500);
    return;
  }
}, true /* capture phase — fires before bubbling entry-click listeners */);

