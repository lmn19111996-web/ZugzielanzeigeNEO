// === MOBILE SWIPE GESTURES ===
    function setupMobileSwipe() {
      if (window.innerWidth > 768) return;
      const trainList = document.getElementById('train-list');
      if (!trainList) return;
      trainList.querySelectorAll('.train-entry:not([data-swipe])').forEach(attachSwipeToEntry);
    }

    function findScheduleTrainById(uniqueId) {
      return schedule.spontaneousEntries.find(t => t._uniqueId === uniqueId) || null;
    }

    function attachSwipeToEntry(entry) {
      entry.dataset.swipe = '1';
      const uniqueId = entry.dataset.uniqueId;
      const isDurationOnly = entry.dataset.trainType === 'duration-only';

      // ── Outer shell: holds swipe-wrapper + collapsible action bar ──
      const shell = document.createElement('div');
      shell.className = 'mobile-entry-shell';
      entry.parentNode.insertBefore(shell, entry);
      shell.appendChild(entry);

      // ── Swipe wrapper (overflow:hidden, card sits inside) ──
      const wrapper = document.createElement('div');
      wrapper.className = 'swipe-wrapper';
      shell.insertBefore(wrapper, entry);
      wrapper.appendChild(entry);

      // Color background layer — JS controls class + opacity
      const bg = document.createElement('div');
      bg.className = 'swipe-bg';
      wrapper.insertBefore(bg, entry);

      // Floating action hint — JS positions it in the revealed strip
      const hint = document.createElement('div');
      hint.className = 'swipe-hint';
      hint.style.opacity = '0';
      wrapper.appendChild(hint);

      // ── Collapsible action bar (cancel + delay buttons only) ──
      const bar = document.createElement('div');
      bar.className = 'mobile-action-bar';
      bar.innerHTML = `
        <div class="mobile-action-btns">
          <button class="mobile-action-btn mobile-cancel-btn" data-mobile-action="cancel">✕</button>
          ${isDurationOnly ? '' : `
          <button class="mobile-action-btn mobile-delay-btn" data-mobile-action="minus5">−5</button>
          <button class="mobile-action-btn mobile-delay-btn" data-mobile-action="plus5">+5</button>
          <button class="mobile-action-btn mobile-delay-btn" data-mobile-action="plus10">+10</button>
          <button class="mobile-action-btn mobile-delay-btn" data-mobile-action="plus30">+30</button>
          `}
        </div>
      `;
      shell.appendChild(bar);

      bar.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.target.closest('[data-mobile-action]');
        if (!btn) return;
        const action = btn.dataset.mobileAction;
        if (action === 'cancel') {
          swipeToggleCancel(uniqueId);
          // Flip the button icon to reflect new state
          const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
          const isCanceled = train ? !!train.canceled : false;
          btn.classList.toggle('reactivate', isCanceled);
          btn.textContent = isCanceled ? '\u2713' : '\u2715';
          bar.classList.remove('is-open');
        } else {
          // In-place delay update — no save/re-render until bar closes
          const deltas = { minus5: -5, plus5: 5, plus10: 10, plus30: 30 };
          const delta = deltas[action];
          if (delta == null) return;
          const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
          const scheduleTrain = findScheduleTrainById(uniqueId);
          if (!train || !scheduleTrain || !train.plan) return;
          const now = new Date();
          const currentDelay = getDelay(train.plan, train.actual, now, train.date);
          const newDelay = currentDelay + delta;
          let newActual;
          if (newDelay === 0) {
            // Exactly on time — clear actual so no deviation is shown
            newActual = null;
          } else {
            // Positive = late, negative = early — both stored as an actual time
            const planTime = parseTime(train.plan, now, train.date);
            newActual = formatClock(new Date(planTime.getTime() + newDelay * 60000));
          }
          train.actual = newActual;
          scheduleTrain.actual = newActual;
          // Update departure display in the DOM without re-rendering the whole list
          // Skip past trains - they have their own CSS animation
          const depEl = entry.querySelector('.departure');
          if (depEl && !entry.classList.contains('past-train')) {
            const tempDiv = document.createElement('div');
            tempDiv.appendChild(formatDeparture(train.plan, newActual, now, newDelay, train.dauer, train.date));
            depEl.innerHTML = tempDiv.innerHTML;
            depEl.dataset.actual = newActual || '';
          }
          shell.dataset.pendingSave = 'true';
          // Bar stays open so user can tap again to add more delay
        }
      });

      // Wire the info button rendered by the template
      const infoBtn = entry.querySelector('.mobile-info-btn');
      if (infoBtn) {
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
          if (train) {
            renderFocusMode(train);
            document.querySelectorAll('.train-entry').forEach(en => en.classList.remove('selected'));
            entry.classList.add('selected');
          }
          bar.classList.remove('is-open');
        });
      }

      // ── Swipe touch handling ──
      let startX = 0, startY = 0, dx = 0;
      let isHoriz = false, isLocked = false;
      const MAX_DELAY_MIN = 30;
      const TRIGGER_PX = 90;
      const DELAY_DEAD_PX = 35;
      const maxLeftPx = () => window.innerWidth * 0.65;

      function computeDelayMins(absDx) {
        const adjusted = Math.max(0, absDx - DELAY_DEAD_PX);
        if (adjusted === 0) return 0;
        const range = maxLeftPx() - DELAY_DEAD_PX;
        return Math.max(1, Math.min(MAX_DELAY_MIN, Math.round((adjusted / range) * MAX_DELAY_MIN)));
      }

      const alpha = (v, threshold = 50) => Math.min(1, Math.abs(v) / threshold);

      function onTouchStart(e) {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dx = 0; isHoriz = false; isLocked = false;
        entry.style.transition = 'none';
        bg.style.transition = 'none';
        hint.style.transition = 'none';
      }

      function onTouchMove(e) {
        if (isLocked) return;
        const x = e.touches[0].clientX - startX;
        const y = e.touches[0].clientY - startY;
        if (!isHoriz) {
          if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
          if (Math.abs(y) >= Math.abs(x)) { isLocked = true; return; }
          isHoriz = true;
        }
        e.preventDefault();
        dx = Math.max(-maxLeftPx(), Math.min(130, x));
        entry.style.transform = `translateX(${dx}px)`;

        if (dx > 0) {
          const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
          const isCanceled = train ? !!train.canceled : false;
          bg.className = isCanceled ? 'swipe-bg swipe-bg-reactivate' : 'swipe-bg swipe-bg-right';
          bg.style.opacity = alpha(dx);
          hint.style.left = `${dx / 2}px`;
          hint.style.right = '';
          hint.style.transform = 'translateY(-50%) translateX(-50%)';
          hint.style.opacity = alpha(dx);
          hint.innerHTML = isCanceled
            ? '<span class="swipe-hint-icon">&#8634;</span><span>Reaktivieren</span>'
            : '<span class="swipe-hint-icon">&#10005;</span><span>Ausfall</span>';
        } else if (dx < 0) {
          if (isDurationOnly) {
            bg.style.opacity = 0;
            hint.style.opacity = 0;
            return;
          }
          const mins = computeDelayMins(Math.abs(dx));
          bg.className = 'swipe-bg swipe-bg-left';
          bg.style.opacity = alpha(dx);
          hint.style.right = `${Math.abs(dx) / 2}px`;
          hint.style.left = '';
          hint.style.transform = 'translateY(-50%) translateX(50%)';
          hint.style.opacity = alpha(dx);
          hint.innerHTML = mins > 0
            ? `<span class="swipe-hint-num">+${mins}</span><span class="swipe-hint-unit">min</span>`
            : '<span class="swipe-hint-icon">&#x23F1;</span>';
        } else {
          bg.style.opacity = 0;
          hint.style.opacity = 0;
        }
      }

      function snapBack(fast = false) {
        const dur = fast ? '0.22s' : '0.35s';
        const ease = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        entry.style.transition = `transform ${dur} ${ease}`;
        bg.style.transition = `opacity ${dur} ease`;
        hint.style.transition = `opacity ${dur} ease`;
        entry.style.transform = 'translateX(0)';
        bg.style.opacity = 0;
        hint.style.opacity = 0;
      }

      function onTouchEnd() {
        if (!isHoriz || isLocked) { snapBack(); return; }
        if (dx > TRIGGER_PX) {
          snapBack(true);
          swipeToggleCancel(uniqueId);
        } else if (dx < -TRIGGER_PX) {
          if (isDurationOnly) {
            snapBack();
            return;
          }
          const mins = computeDelayMins(Math.abs(dx));
          snapBack(true);
          if (mins > 0) swipeApplyDelay(uniqueId, mins);
        } else {
          snapBack();
        }
      }

      entry.addEventListener('touchstart', onTouchStart, { passive: true });
      entry.addEventListener('touchmove', onTouchMove, { passive: false });
      entry.addEventListener('touchend', onTouchEnd, { passive: true });
    }

    function mobileAdjustDelay(uniqueId, deltaMin) {
      const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
      const scheduleTrain = findScheduleTrainById(uniqueId);
      if (!train || !scheduleTrain || !train.plan) return;
      const prevActual = train.actual;
      const now = new Date();
      const currentDelay = getDelay(train.plan, train.actual, now, train.date);
      const newDelay = currentDelay + deltaMin;
      if (newDelay <= 0) {
        train.actual = undefined;
        scheduleTrain.actual = undefined;
      } else {
        const planDate = parseTime(train.plan, now, train.date);
        train.actual = formatClock(new Date(planDate.getTime() + newDelay * 60000));
        scheduleTrain.actual = train.actual;
      }
      refreshUIOnly();
      saveSchedule();
      showSwipeToast(() => {
        train.actual = prevActual;
        scheduleTrain.actual = prevActual;
        refreshUIOnly();
        saveSchedule();
      });
    }

    let swipeToastTimer = null;

    function swipeToggleCancel(uniqueId) {
      const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
      const scheduleTrain = findScheduleTrainById(uniqueId);
      if (!train || !scheduleTrain) return;

      const prevCanceled = !!train.canceled;
      const prevActual = train.actual;

      train.canceled = !train.canceled;
      scheduleTrain.canceled = train.canceled;
      refreshUIOnly();
      saveSchedule();

      showSwipeToast(() => {
        train.canceled = prevCanceled;
        scheduleTrain.canceled = prevCanceled;
        train.actual = prevActual;
        scheduleTrain.actual = prevActual;
        refreshUIOnly();
        saveSchedule();
      });
    }

    function swipeApplyDelay(uniqueId, delayMin) {
      const train = processedTrainData.allTrains.find(t => t._uniqueId === uniqueId);
      const scheduleTrain = findScheduleTrainById(uniqueId);
      if (!train || !scheduleTrain || !train.plan) return;

      const prevActual = train.actual;
      const now = new Date();
      // Stack on top of existing actual time if already delayed, otherwise use plan
      const baseTime = parseTime(train.actual || train.plan, now, train.date);
      const newActual = formatClock(new Date(baseTime.getTime() + delayMin * 60000));

      train.actual = newActual;
      scheduleTrain.actual = newActual;
      refreshUIOnly();
      saveSchedule();

      showSwipeToast(() => {
        train.actual = prevActual;
        scheduleTrain.actual = prevActual;
        refreshUIOnly();
        saveSchedule();
      });
    }

    function showSwipeToast(undoFn) {
      const toast = document.getElementById('swipe-undo-toast');
      if (!toast) return;
      if (swipeToastTimer) clearTimeout(swipeToastTimer);

      // Replace undo button to remove any stale listener
      const oldBtn = document.getElementById('swipe-undo-btn');
      const newBtn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(newBtn, oldBtn);
      newBtn.addEventListener('click', () => { undoFn(); dismissSwipeToast(); });

      toast.classList.add('is-visible');
      swipeToastTimer = setTimeout(dismissSwipeToast, 5000);
    }

    function dismissSwipeToast() {
      const toast = document.getElementById('swipe-undo-toast');
      if (toast) toast.classList.remove('is-visible');
      if (swipeToastTimer) { clearTimeout(swipeToastTimer); swipeToastTimer = null; }
    }

    // Format stops with date for display