// === DRAWER OPEN / CLOSE HANDLERS ===
    function openAnnouncementsDrawer() {
      const drawer = document.getElementById('announcement-drawer');
      if (drawer) {
        drawer.classList.add('is-open');
        document.body.classList.add('announcements-open');
        
        // Set up event handlers for closing
        setupAnnouncementDrawerCloseHandlers();
        
        // Handle system back button (mobile)
        announcementDrawerBackHandler = (e) => {
          if (drawer.classList.contains('is-open')) {
            closeAnnouncementsDrawer();
          }
        };
        window.addEventListener('popstate', announcementDrawerBackHandler, true);
        window.history.pushState({ drawer: 'announcements' }, '');
      }
    }

    function closeAnnouncementsDrawer() {
      const drawer = document.getElementById('announcement-drawer');
      if (drawer) {
        drawer.classList.remove('is-open');
      }
      document.body.classList.remove('announcements-open');
      
      // Clean up event handlers
      if (announcementDrawerEscHandler) {
        document.removeEventListener('keydown', announcementDrawerEscHandler, true);
        announcementDrawerEscHandler = null;
      }
      if (announcementDrawerClickOutHandler) {
        document.removeEventListener('click', announcementDrawerClickOutHandler, true);
        announcementDrawerClickOutHandler = null;
      }
      if (announcementDrawerBackHandler) {
        window.removeEventListener('popstate', announcementDrawerBackHandler, true);
        announcementDrawerBackHandler = null;
      }
    }

    // Note drawer functions
    let noteDrawerEscHandler = null;
    let noteDrawerClickOutHandler = null;
    let noteDrawerBackHandler = null;

    function openNoteDrawer() {
      const drawer = document.getElementById('note-drawer');
      if (drawer) {
        drawer.classList.add('is-open');
        document.body.classList.add('notes-open');
        
        // Render notes when drawer opens
        renderNotePanel();
        
        // Set up event handlers for closing
        setupNoteDrawerCloseHandlers();
        
        // Handle system back button (mobile)
        noteDrawerBackHandler = (e) => {
          if (drawer.classList.contains('is-open')) {
            closeNoteDrawer();
          }
        };
        window.addEventListener('popstate', noteDrawerBackHandler, true);
        window.history.pushState({ drawer: 'notes' }, '');
      }
    }

    function closeNoteDrawer() {
      const drawer = document.getElementById('note-drawer');
      if (drawer) {
        drawer.classList.remove('is-open');
      }
      document.body.classList.remove('notes-open');
      
      // Clean up event handlers
      if (noteDrawerEscHandler) {
        document.removeEventListener('keydown', noteDrawerEscHandler, true);
        noteDrawerEscHandler = null;
      }
      if (noteDrawerClickOutHandler) {
        document.removeEventListener('click', noteDrawerClickOutHandler, true);
        noteDrawerClickOutHandler = null;
      }
      if (noteDrawerBackHandler) {
        window.removeEventListener('popstate', noteDrawerBackHandler, true);
        noteDrawerBackHandler = null;
      }
    }

    function setupNoteDrawerCloseHandlers() {
      const drawer = document.getElementById('note-drawer');
      
      // Remove old handlers if they exist
      if (noteDrawerEscHandler) {
        document.removeEventListener('keydown', noteDrawerEscHandler, true);
      }
      if (noteDrawerClickOutHandler) {
        document.removeEventListener('click', noteDrawerClickOutHandler, true);
      }

      // ESC key handler
      noteDrawerEscHandler = function(e) {
        if (e.key === 'Escape' && document.body.contains(drawer)) {
          // Check if editor drawer is open - if so, let it handle ESC first
          const editorDrawer = document.getElementById('focus-panel');
          if (editorDrawer && editorDrawer.classList.contains('is-open')) {
            return; // Let editor drawer handle ESC
          }
          
          // Check if we're in edit mode
          const hasInputs = drawer.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
          if (!hasInputs) {
            // Not in edit mode, close the drawer
            e.preventDefault();
            e.stopPropagation(); // Prevent other ESC handlers from running
            closeNoteDrawer();
          }
          // If we have inputs, let the normal blur behavior work, don't close drawer
        }
      };
      document.addEventListener('keydown', noteDrawerEscHandler, true);

      // Click outside handler
      noteDrawerClickOutHandler = function(e) {
        if (!drawer.contains(e.target)) {
          // Don't close if clicking the notes button itself
          const notesBtn = document.getElementById('notes-button');
          if (notesBtn && notesBtn.contains(e.target)) {
            return;
          }
          // Don't close if clicking any button (let button handlers do their thing)
          if (e.target.closest('button')) {
            return;
          }
          // Don't close if clicking inside the editor drawer
          const editorDrawer = document.getElementById('focus-panel');
          if (editorDrawer && editorDrawer.contains(e.target)) {
            return;
          }
          e.stopPropagation();
          closeNoteDrawer();
        }
      };
      document.addEventListener('click', noteDrawerClickOutHandler, true);
    }

    // Render note panel

    function setupAnnouncementDrawerCloseHandlers() {
      const drawer = document.getElementById('announcement-drawer');
      
      // Remove old handlers if they exist
      if (announcementDrawerEscHandler) {
        document.removeEventListener('keydown', announcementDrawerEscHandler, true);
      }
      if (announcementDrawerClickOutHandler) {
        document.removeEventListener('click', announcementDrawerClickOutHandler, true);
      }
      
      // Esc handler
      announcementDrawerEscHandler = (e) => {
        if (e.key === 'Escape' && document.body.contains(drawer)) {
          // Check if editor drawer is open - if so, let it handle ESC first
          const editorDrawer = document.getElementById('focus-panel');
          if (editorDrawer && editorDrawer.classList.contains('is-open')) {
            return; // Let editor drawer handle ESC
          }
          
          // Announcements are read-only, no edit mode to check
          e.preventDefault();
          e.stopPropagation(); // Prevent other ESC handlers from running
          closeAnnouncementsDrawer();
        }
      };
      document.addEventListener('keydown', announcementDrawerEscHandler, true);
      
      // Click outside handler
      announcementDrawerClickOutHandler = (e) => {
        if (drawer && drawer.classList.contains('is-open') && !drawer.contains(e.target)) {
          // Don't close if clicking the announcements button itself
          const announcementsBtn = document.getElementById('announcements-button');
          if (announcementsBtn && announcementsBtn.contains(e.target)) {
            return;
          }
          closeAnnouncementsDrawer();
        }
      };
      document.addEventListener('click', announcementDrawerClickOutHandler, true);
    }

    function openEditorDrawer(train = null) {
      const panel = document.getElementById('focus-panel');
      if (panel) {
        panel.classList.add('is-open');
        document.body.classList.add('editor-drawer-open');
        
        // Handle system back button (mobile)
        editorDrawerBackHandler = (e) => {
          if (panel.classList.contains('is-open')) {
            const hasInputs = panel.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
            if (!hasInputs) {
              desktopFocusedTrainId = null;
              panel.innerHTML = '';
              closeEditorDrawer();
              // Stop the project drawer's popstate handler from also firing,
              // so the project drawer stays open after closing the editor.
              e.stopImmediatePropagation();
            }
          }
        };
        window.addEventListener('popstate', editorDrawerBackHandler, true);
        window.history.pushState({ drawer: 'editor' }, '');
      }
      closeAnnouncementsDrawer();
      // Only close note drawer if we're not editing a note
      if (!train || train.type !== 'note') {
        closeNoteDrawer();
      }
    }

    function closeEditorDrawer() {
      const panel = document.getElementById('focus-panel');
      if (panel) {
        panel.classList.remove('is-open');
      }
      document.body.classList.remove('editor-drawer-open');
      
      // Clean up back button handler
      if (editorDrawerBackHandler) {
        window.removeEventListener('popstate', editorDrawerBackHandler, true);
        editorDrawerBackHandler = null;
      }
    }

    // ==================== PROJECT MANAGEMENT FUNCTIONS ====================
    
    let projectDrawerEscHandler = null;
    let projectDrawerClickOutHandler = null;
    
    let projectDrawerBackHandler = null;
    
    function openProjectDrawer() {
      closeAnnouncementsDrawer();
      // Keep editor drawer open so it can show to the left of project drawer
      const drawer = document.getElementById('project-drawer');
      if (drawer) {
        drawer.classList.add('is-open');
        document.body.classList.add('project-drawer-open');
        
        // Handle system back button (mobile)
        projectDrawerBackHandler = (e) => {
          if (drawer.classList.contains('is-open')) {
            closeProjectDrawer();
            restoreWorkspaceModeAfterProjectDrawer();
          }
        };
        window.addEventListener('popstate', projectDrawerBackHandler, true);
        window.history.pushState({ drawer: 'project' }, '');
      }
      isProjectDrawerOpen = true;
      setupProjectDrawerCloseHandlers();
    }

    function closeProjectDrawer() {
      const drawer = document.getElementById('project-drawer');
      if (drawer) {
        drawer.classList.remove('is-open');
      }
      document.body.classList.remove('project-drawer-open');
      currentProjectId = null;
      isProjectDrawerOpen = false;
      
      // Clean up event handlers
      if (projectDrawerEscHandler) {
        document.removeEventListener('keydown', projectDrawerEscHandler, true);
        projectDrawerEscHandler = null;
      }
      if (projectDrawerClickOutHandler) {
        document.removeEventListener('click', projectDrawerClickOutHandler, true);
        projectDrawerClickOutHandler = null;
      }
      if (projectDrawerBackHandler) {
        window.removeEventListener('popstate', projectDrawerBackHandler, true);
        projectDrawerBackHandler = null;
      }
    }
    
    function restoreWorkspaceModeAfterProjectDrawer() {
      // If we came from a specific workspace mode, restore it
      if (workspaceModeBeforeProjectDrawer) {
        if (workspaceModeBeforeProjectDrawer === 'train-editor') {
          // Opened from train editor - just close project drawer, keep train editor open
          // Do nothing, train editor is already open
        } else if (workspaceModeBeforeProjectDrawer === 'projects') {
          // If we were already in projects mode, re-render projects page
          renderProjectsPage();
        } else {
          // Otherwise, restore the previous mode (list, occupancy, etc.)
          setWorkspaceMode(workspaceModeBeforeProjectDrawer);
        }
        workspaceModeBeforeProjectDrawer = null;
      } else {
        // Fallback: if no previous mode was saved, assume projects
        renderProjectsPage();
      }
    }
    function setupProjectDrawerCloseHandlers() {
      const drawer = document.getElementById('project-drawer');
      
      // Remove old handlers if they exist
      if (projectDrawerEscHandler) {
        document.removeEventListener('keydown', projectDrawerEscHandler, true);
      }
      if (projectDrawerClickOutHandler) {
        document.removeEventListener('click', projectDrawerClickOutHandler, true);
      }
      
      // Esc handler
      projectDrawerEscHandler = (e) => {
        if (e.key === 'Escape' && document.body.contains(drawer)) {
          // Check if editor drawer is open - if so, let it handle ESC first
          const editorDrawer = document.getElementById('focus-panel');
          if (editorDrawer && editorDrawer.classList.contains('is-open')) {
            return; // Let editor drawer handle ESC
          }
          
          // Check if we're in edit mode
          const hasInputs = drawer.querySelector('[data-editable="true"] input, [data-editable="true"] textarea');
          if (!hasInputs) {
            // Not in edit mode, close the drawer
            e.preventDefault();
            e.stopPropagation(); // Prevent other ESC handlers from running
            closeProjectDrawer();
            restoreWorkspaceModeAfterProjectDrawer();
          }
          // If we have inputs, let the normal blur behavior work, don't close drawer
        }
      };
      document.addEventListener('keydown', projectDrawerEscHandler, true);
      
      // Click outside handler
      projectDrawerClickOutHandler = (e) => {
        if (drawer && drawer.classList.contains('is-open') && !drawer.contains(e.target)) {
          // Don't close if clicking inside task editor
          const taskEditor = document.getElementById('project-task-editor');
          if (taskEditor && taskEditor.contains(e.target)) {
            return;
          }
          // Don't close if clicking inside train editor drawer
          const trainEditor = document.getElementById('focus-panel');
          if (trainEditor && trainEditor.contains(e.target)) {
            return;
          }
          closeProjectDrawer();
          restoreWorkspaceModeAfterProjectDrawer();
        }
      };
      document.addEventListener('click', projectDrawerClickOutHandler, true);
    }
