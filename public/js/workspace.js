// === WORKSPACE MODE MANAGEMENT ===
    let currentWorkspaceMode = 'list';
    let _reviewsFilterRating = 0; // 0 = all, 1-5 = specific star filter
    // Guards against closeNoteEditorWorkspace() recursing back into setWorkspaceMode()
    // when setWorkspaceMode() itself is what triggered the note editor to close.
    let settingWorkspaceMode = false;

    // Toggle between Belegungsplan and legacy list view
    function toggleViewMode() {
      currentViewMode = currentViewMode === 'belegungsplan' ? 'list' : 'belegungsplan';
      localStorage.setItem('viewMode', currentViewMode);
      renderTrains();
    }


    function showWorkspacePlaceholder(label) {
      const placeholder = document.getElementById('mode-placeholder');
      const trainListEl = document.getElementById('train-list');
      if (placeholder) {
        placeholder.textContent = `${label} (Platzhalter)`;
        placeholder.classList.add('is-active');
      }
      if (trainListEl) {
        trainListEl.style.display = 'none';
      }
    }

    function hideWorkspacePlaceholder() {
      const placeholder = document.getElementById('mode-placeholder');
      const trainListEl = document.getElementById('train-list');
      if (placeholder) {
        placeholder.classList.remove('is-active');
      }
      if (trainListEl) {
        trainListEl.style.display = '';
      }
    }


    /**
     * Mirror the current workspace onto the nav rail: the matching item gets
     * .is-active (lighter surface + accent bar). The two drawer-backed items
     * (Meldungen / Notizen) are driven from body.announcements-open /
     * body.notes-open in CSS instead, since drawers toggle independently.
     */
    function syncTaskbarActiveState() {
      document.querySelectorAll('.task-icon-button[data-nav]').forEach((btn) => {
        const nav = btn.dataset.nav;
        // Drawer items are handled in CSS — leave them alone here.
        if (nav === 'announcements' || nav === 'notes') return;
        btn.classList.toggle('is-active', nav === currentWorkspaceMode);
      });
    }
    window.syncTaskbarActiveState = syncTaskbarActiveState;

    function setWorkspaceMode(mode) {
      const isMobile = window.innerWidth <= 768;
      // Note: currentWorkspaceMode is only set for actual workspaces (list, occupancy, projects, reviews, log-viewer)
      // Non-workspace modes (drawers/overlays) don't change it

      if (mode === 'add') {
        createNewTrainEntry();
        return;
      }

      settingWorkspaceMode = true;
      try {
      switch (mode) {
        case 'list':
          currentViewMode = 'list';
          currentWorkspaceMode = 'list';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          // The inline note editor occupies the same panel as the train list, so
          // (unlike the right-side train editor drawer) it must close when switching here.
          if (editingNoteInline) closeEditorDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'occupancy':
          currentViewMode = 'belegungsplan';
          currentWorkspaceMode = 'occupancy';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          if (editingNoteInline) closeEditorDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'announcements':
          // Announcements is a drawer, not a workspace - don't change currentWorkspaceMode
          // Toggle announcements drawer (both desktop and mobile)
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          const drawer = document.getElementById('announcement-drawer');
          if (drawer && drawer.classList.contains('is-open')) {
            closeAnnouncementsDrawer();
          } else {
            openAnnouncementsDrawer();
            renderComprehensiveAnnouncementPanel();
          }
          break;
        case 'db-api':
          // db-api is an overlay, not a workspace - don't change currentWorkspaceMode
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          showWorkspacePlaceholder('DB API');
          showStationOverlay();
          break;
        case 'projects':
          currentWorkspaceMode = 'projects';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          closeEditorDrawer();
          closeProjectDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'reviews':
          currentWorkspaceMode = 'reviews';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          closeEditorDrawer();
          closeProjectDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'log-viewer':
          currentWorkspaceMode = 'log-viewer';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          closeEditorDrawer();
          closeProjectDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'vorlagen':
          currentWorkspaceMode = 'vorlagen';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          closeEditorDrawer();
          closeProjectDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'settings':
          if (currentWorkspaceMode !== 'settings') {
            // Remember where we came from so Apply/Discard can return here
            window._preSettingsWorkspaceMode = currentWorkspaceMode;
          }
          currentWorkspaceMode = 'settings';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          closeEditorDrawer();
          closeProjectDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        default:
          break;
      }
      } finally {
        settingWorkspaceMode = false;
      }

      syncTaskbarActiveState();
    }

    /**
     * Unified render function that calls the appropriate view
     */