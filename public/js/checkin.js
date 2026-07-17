// === CHECK-IN / CHECK-OUT SYSTEM ===
// Handles check-in/check-out for today's tasks.
// Check-in  → sets train.actual = now, train.checkedIn = true
// Check-out → sets train.dauer  = (checkout - train.actual) minutes, train.checkedOut = true
// train.actual is editable via the editor between check-in and check-out (e.g.
// correcting a late check-in to the real departure time) — checkedIn/checkedOut
// are plain state flags only, never a source of time data; no real-world
// check-in/check-out timestamps are recorded anywhere (log export uses only
// plan/actual/dauer).
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

function _ciApplyCheckoutState(uid, dur) {
  var lists = [schedule.spontaneousEntries || [], schedule.trains || [], schedule.localTrains || []];
  var seen = new Set();
  lists.forEach(function (list) {
    list.forEach(function (t) {
      if (!t || t._uniqueId !== uid) return;
      if (seen.has(t)) return;
      seen.add(t);
      if (isDurationOnlyTrain(t)) {
        t.dauer = (Number(t.dauer) || 0) + dur;
        t.checkedIn = false;
        t.actual = undefined;
        t._checkinEpochMs = undefined;
      } else {
        t.dauer = dur;
      }
      t.checkedOut = true;
    });
  });
}

// ── Data operations ────────────────────────────────────────────────────────

function _ciCommitCheckinClone(template, timeStr) {
  var clone = {
    linie: template.linie || '',
    ziel: template.ziel || '',
    plan: timeStr,
    actual: timeStr,
    dauer: 0,
    zwischenhalte: Array.isArray(template.zwischenhalte) ? template.zwischenhalte.slice() : [],
    canceled: false,
    date: _ciTodayStr(),
    plannedDate: _ciTodayStr(),
    source: 'local',
    _uniqueId: 'train_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    _templateUid: template._uniqueId,
    checkedIn: true,
    _checkinEpochMs: Date.now()
  };
  if (template.projectId) clone.projectId = template.projectId;

  (schedule.spontaneousEntries = schedule.spontaneousEntries || []).push(clone);

  if (typeof refreshUIOnly === 'function') {
    refreshUIOnly();
  } else {
    processTrainData(schedule);
    renderCurrentWorkspaceView();
  }
  saveSchedule();
}

function _ciCommitCheckin(uid, timeStr) {
  var train = _ciFindTrain(uid);
  if (!train || train.checkedIn) return; // Idempotent guard
  if (!isDurationOnlyTrain(train)) {
    train.actual = timeStr;
  }
  train.checkedIn = true;
  train._checkinEpochMs = Date.now();
  // Animation is finished at this point, so use the same full local refresh path
  // as editor actions before saving in the background.
  if (typeof refreshUIOnly === 'function') {
    refreshUIOnly();
  } else {
    processTrainData(schedule);
    renderCurrentWorkspaceView();
  }
  saveSchedule();
}

function _ciSaveCheckout(uid, dur, alreadyApplied) {
  if (!alreadyApplied) {
    _ciApplyCheckoutState(uid, dur);
  }

  if (typeof invalidateStressmeterCache === 'function') invalidateStressmeterCache();

  if (typeof refreshUIOnly === 'function') {
    refreshUIOnly();
  } else {
    processTrainData(schedule);
    renderCurrentWorkspaceView();
  }
  saveSchedule();
}

function _ciCommitApprove(uid) {
  var train = _ciFindTrain(uid) || (schedule.trains || []).find(function (t) { return t._uniqueId === uid; })
    || (schedule.localTrains || []).find(function (t) { return t._uniqueId === uid; });
  if (!train || train.checkedIn || train.checkedOut || isDurationOnlyTrain(train)) return;

  var planTime = train.plan || _ciNowHHMM();
  var dur = Number(train.dauer) || 0;

  train.actual = planTime;
  train.checkedIn = true;
  train.checkedOut = true;
  train.dauer = dur;

  if (typeof invalidateStressmeterCache === 'function') invalidateStressmeterCache();

  if (typeof refreshUIOnly === 'function') {
    refreshUIOnly();
  } else {
    processTrainData(schedule);
    renderCurrentWorkspaceView();
  }
  saveSchedule();
}

// Collapses any open approve overlay (tapping elsewhere or Escape dismisses it).
function _ciCollapseApprove(except) {
  document.querySelectorAll('.departure.approve-eligible.show-approve').forEach(function (el) {
    if (el !== except) el.classList.remove('show-approve');
  });
}

document.addEventListener('keydown', function _ciApproveEscape(e) {
  if (e.key === 'Escape' || e.key === 'Esc') _ciCollapseApprove(null);
});

// ── Unified click handler (document-level capture) ─────────────────────────

document.addEventListener('click', function _ciClickCapture(e) {
  // ── Approve (planned-time reveal + confirm) ─────────────────────────────
  var approveCommitBtn = e.target.closest('[data-approve-commit-uid]');
  if (approveCommitBtn) {
    e.stopPropagation();
    e.preventDefault();
    var approveShell = approveCommitBtn.closest('.approve-shell');
    if (!approveShell || approveShell.classList.contains('approve-confirmed')) return;
    var uid = approveCommitBtn.dataset.approveCommitUid;

    // Phase 0 (150 ms): crossfade the icon/text out, swap their content,
    // then crossfade back in — before the shell turns green.
    approveShell.classList.add('approve-swapping');
    setTimeout(function () {
      var icon = approveCommitBtn.querySelector('.ap-icon');
      if (icon) icon.src = 'res/eingecheckt.svg';
      var text = approveCommitBtn.querySelector('.approve-text');
      if (text) text.textContent = 'Erfolgreich bestätigt';

      // Phase 1 (immediate): pill turns green, swapped content fades back
      // in, border draws clockwise — mirrors the real check-in animation.
      approveShell.classList.remove('approve-swapping');
      approveShell.classList.add('approve-confirmed');

      // Phase 2 (1000 ms): border fades. Data commit + collapse deferred a
      // further 450 ms so the fade can play fully before the row re-renders.
      setTimeout(function () {
        approveShell.classList.add('fade-accent');
        setTimeout(function () {
          _ciCommitApprove(uid);
        }, 450);
      }, 1000);
    }, 150);
    return;
  }

  var approveField = e.target.closest('.departure.approve-eligible[data-approve-uid]');
  if (approveField) {
    e.stopPropagation();
    e.preventDefault();
    var alreadyOpen = approveField.classList.contains('show-approve');
    _ciCollapseApprove(approveField);
    approveField.classList.toggle('show-approve', !alreadyOpen);
    return;
  }

  // Any other click dismisses an open approve overlay.
  _ciCollapseApprove(null);
  // ── Check-in ────────────────────────────────────────────────────────────
  var ciBtn = e.target.closest('[data-ci-uid]');
  if (ciBtn) {
    var uid   = ciBtn.dataset.ciUid;
    var train = _ciFindTrain(uid);

    // Guard: must be today's non-cancelled train, not yet checked in.
    // Duration-only templates never carry their own checkedIn flag — instead
    // check whether an active clone session already exists for it.
    if (!train || train.date !== _ciTodayStr() || train.canceled) return;
    if (isDurationOnlyTrain(train)) {
      if (findActiveCloneForTemplate(train._uniqueId)) return;
    } else if (train.checkedIn) {
      return;
    }

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
        if (isDurationOnlyTrain(train)) {
          _ciCommitCheckinClone(train, checkinTime);
        } else {
          _ciCommitCheckin(uid, checkinTime);
        }
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
      if (!train.checkedIn) return;
    } else if (train.checkedOut) {
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
      if (!Number.isFinite(Number(startMs)) && train.actual) {
        var now = new Date();
        var parts = train.actual.split(':');
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
      // Duration is measured against the (editable) actual departure time,
      // not the moment check-in was tapped — so correcting `actual` after
      // checking in (e.g. "I forgot to check in on time, it really left at
      // 10:00") changes the computed duration on checkout.
      var baseTime = train.actual || train.plan || '00:00';
      checkoutDuration = _ciComputeDuration(baseTime, checkoutTime);
    }

    // Apply checked-out data immediately to avoid transient re-renders showing
    // the old checked-in widget during the animation window.
    _ciApplyCheckoutState(uid, checkoutDuration);

    // Stage 1 (0-1.5s): run checkout box expansion + border/background animation.
    wrap.classList.remove('show-checkout', 'fade-accent', 'checkout-fade');
    wrap.classList.add('checkout-animating');

    // Stage 2 (1.5-2.0s): fade accent + fade out to nothingness.
    setTimeout(function () {
      wrap.classList.add('fade-accent', 'checkout-fade');
      setTimeout(function () {
        _ciSaveCheckout(uid, checkoutDuration, true);
      }, 300);
    }, 1500);
    return;
  }
}, true /* capture phase — fires before bubbling entry-click listeners */);
