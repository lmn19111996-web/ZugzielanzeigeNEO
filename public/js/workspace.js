// === WORKSPACE MODE MANAGEMENT ===
    let currentWorkspaceMode = 'list';
    let _reviewsFilterRating = 0; // 0 = all, 1-5 = specific star filter

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

    function setWorkspaceMode(mode) {
      const isMobile = window.innerWidth <= 768;
      // Note: currentWorkspaceMode is only set for actual workspaces (list, occupancy, projects, reviews)
      // Non-workspace modes (drawers/overlays) don't change it

      if (mode === 'add') {
        createNewTrainEntry();
        return;
      }

      switch (mode) {
        case 'list':
          currentViewMode = 'list';
          currentWorkspaceMode = 'list';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          hideWorkspacePlaceholder();
          renderCurrentWorkspaceView();
          break;
        case 'occupancy':
          currentViewMode = 'belegungsplan';
          currentWorkspaceMode = 'occupancy';
          closeAnnouncementsDrawer();
          closeNoteDrawer();
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
        case 'meals':
          // Placeholder modes - not workspaces, don't change currentWorkspaceMode
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          showWorkspacePlaceholder('Mahlzeiten');
          break;
        case 'groceries':
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          showWorkspacePlaceholder('Einkauf');
          break;
        case 'inventory':
          closeAnnouncementsDrawer();
          closeNoteDrawer();
          if (typeof window.closeReviewWriteDrawer === 'function') window.closeReviewWriteDrawer();
          showWorkspacePlaceholder('Inventar');
          break;
        default:
          break;
      }

      // Sync island visibility whenever workspace mode changes
      if (typeof window.updateJournalIslandVisibility === 'function') {
        window.updateJournalIslandVisibility(currentWorkspaceMode);
      }
    }

    /**
     * Unified render function that calls the appropriate view
     */