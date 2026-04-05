// === PROJECT MANAGEMENT ===
    function renderProjectsPage() {
      const trainListEl = document.getElementById('train-list');
      if (!trainListEl) return;

      const projects = schedule.projects || [];
      
      // Clone the projects page template
      const pageTemplate = document.getElementById('projects-page-template');
      if (!pageTemplate) return;
      
      const pageClone = pageTemplate.content.cloneNode(true);
      const projectsList = pageClone.querySelector('[data-projects="list"]');
      
      // Apply sorting based on currentProjectSortMode
      const sortedProjects = [...projects].sort((a, b) => {
        switch (currentProjectSortMode) {
          case 'name':
            const nameA = (a.name || 'Unbenanntes Projekt').toLowerCase();
            const nameB = (b.name || 'Unbenanntes Projekt').toLowerCase();
            return nameA.localeCompare(nameB);
          
          case 'line':
            const lineA = (a.linie || 's1').toLowerCase();
            const lineB = (b.linie || 's1').toLowerCase();
            return lineA.localeCompare(lineB);
          
          case 'deadline':
            // Projects without deadline go to end
            if (!a.deadline && !b.deadline) return 0;
            if (!a.deadline) return 1;
            if (!b.deadline) return -1;
            return new Date(a.deadline) - new Date(b.deadline);
          
          case 'tasks':
            const tasksA = schedule.spontaneousEntries.filter(t => t.projectId === a._uniqueId).length;
            const tasksB = schedule.spontaneousEntries.filter(t => t.projectId === b._uniqueId).length;
            return tasksB - tasksA; // Descending order (more tasks first)
          
          case 'creation':
          default:
            // Sort by creation date (oldest first, which is write order)
            const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
            const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
            return dateA - dateB;
        }
      });
      
      if (sortedProjects.length === 0) {
        // Show empty state
        const emptyTemplate = document.getElementById('projects-empty-template');
        if (emptyTemplate) {
          projectsList.appendChild(emptyTemplate.content.cloneNode(true));
        }
      } else {
        // Add project cards
        const cardTemplate = document.getElementById('project-card-template');
        if (!cardTemplate) return;
        
        sortedProjects.forEach(project => {
          const lineColor = getLineColor(project.linie || 's1');
          const deadlineDate = project.deadline ? new Date(project.deadline) : null;
          const deadlineStr = deadlineDate ? deadlineDate.toLocaleDateString('de-DE', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
          }) : 'Open-Ended';
          
          // Get tasks for this project from spontaneousEntries
          const projectTasks = schedule.spontaneousEntries.filter(t => t.projectId === project._uniqueId);
          const today = new Date().toISOString().split('T')[0];
          
          const taskCount = projectTasks.length;
          const completedTasks = projectTasks.filter(t => t.date && t.date <= today).length;
          
          // Clone card template and populate
          const cardClone = cardTemplate.content.cloneNode(true);
          const card = cardClone.querySelector('[data-projects="card"]');
          
          card.setAttribute('data-project-id', project._uniqueId);
          card.style.borderLeft = `4px solid ${lineColor}`;
          
          const icon = cardClone.querySelector('[data-projects="icon"]');
          const iconFallback = cardClone.querySelector('[data-projects="icon-fallback"]');
          const lineName = (project.linie || 'S1').toUpperCase();
          
          icon.src = getTrainSVG(project.linie || 'S1');
          iconFallback.textContent = lineName;
          
          // Adjust font size based on text length for project card fallback
          const adjustCardFallbackFontSize = () => {
            const textLength = lineName.length;
            let fontSize;
            
            if (textLength <= 2) {
              fontSize = '2.2vh';
            } else if (textLength === 3) {
              fontSize = '1.9vh';
            } else if (textLength === 4) {
              fontSize = '1.7vh';
            } else if (textLength <= 6) {
              fontSize = '1.5vh';
            } else {
              fontSize = '1.2vh';
            }
            
            iconFallback.style.fontSize = fontSize;
          };
          
          // Show fallback if image fails to load
          icon.onerror = function() {
            icon.style.display = 'none';
            iconFallback.style.display = 'flex';
            adjustCardFallbackFontSize();
          };
          
          icon.onload = function() {
            icon.style.display = 'block';
            iconFallback.style.display = 'none';
          };
          
          cardClone.querySelector('[data-projects="name"]').textContent = project.name || 'Unbenanntes Projekt';
          cardClone.querySelector('[data-projects="deadline"]').textContent = deadlineStr;
          cardClone.querySelector('[data-projects="progress"]').textContent = `${completedTasks} / ${taskCount} Aufgaben abgeschlossen`;
          
          projectsList.appendChild(cardClone);
        });
      }
      
      trainListEl.innerHTML = '';
      trainListEl.appendChild(pageClone);
      
      // Add event listeners
      const createBtn = document.getElementById('create-project-btn');
      if (createBtn) {
        createBtn.addEventListener('click', createNewProject);
      }
      
      // Add sort selector event listener
      const sortSelector = document.getElementById('project-sort-selector');
      if (sortSelector) {
        sortSelector.value = currentProjectSortMode; // Set current value
        sortSelector.addEventListener('change', () => {
          currentProjectSortMode = sortSelector.value;
          renderProjectsPage(); // Re-render with new sort order
        });
      }
      
      // Add click handlers for project cards
      trainListEl.querySelectorAll('.project-card').forEach(card => {
        card.addEventListener('click', function() {
          const projectId = this.getAttribute('data-project-id');
          openProjectEditor(projectId);
        });
      });
    }

    // ── Rezensionen workspace ────────────────────────────────────────

    async function createNewProject() {
      const newProject = {
        _uniqueId: 'project_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        name: '',
        linie: 's1',
        deadline: null,
        createdAt: new Date().toISOString()
      };
      
      schedule.projects = schedule.projects || [];
      schedule.projects.push(newProject);
      
      await saveSchedule();
      const freshSchedule = await fetchSchedule();
      Object.assign(schedule, freshSchedule);
      openProjectEditor(newProject._uniqueId);
    }

    function openProjectEditor(projectId) {
      const project = schedule.projects.find(p => p._uniqueId === projectId);
      if (!project) {
        console.error('Project not found:', projectId);
        return;
      }
      
      // Save the current workspace mode before opening project drawer
      // Also track if we're opening from train editor (don't change workspace mode in that case)
      const openedFromTrainEditor = !!desktopFocusedTrainId;
      workspaceModeBeforeProjectDrawer = openedFromTrainEditor ? 'train-editor' : currentWorkspaceMode;
      
      currentProjectId = projectId;
      renderProjectDrawer(project);
      openProjectDrawer();
    }

    function renderProjectStatistics(trains, project) {
      const now = new Date();
      
      // Get Monday and Sunday of current week
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dayOfWeek = today.getDay();
      const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust when day is Sunday
      const monday = new Date(today);
      monday.setDate(diff);
      monday.setHours(0, 0, 0, 0);
      
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);
      
      // Calculate statistics
      let totalHours = 0;
      let weekHours = 0;
      let weekTasks = 0;
      let weekCancelledTasks = 0;
      let weekDelays = [];
      
      trains.forEach(train => {
        const duration = Number(train.dauer) || 0;
        
        // Only count hours for tasks that have occurred up to today
        if (train.date) {
          const taskDate = new Date(train.date);
          taskDate.setHours(0, 0, 0, 0);
          
          if (taskDate <= today) {
            totalHours += duration / 60; // Convert minutes to hours
          }
        }
        
        // Check if task is in current week
        if (train.date) {
          const taskDate = new Date(train.date);
          if (taskDate >= monday && taskDate <= sunday) {
            weekTasks++;
            weekHours += duration / 60;
            
            // Check for cancellation
            if (train.canceled) {
              weekCancelledTasks++;
            }
            
            // Calculate delay (only for completed/past tasks)
            if (train.plan && train.actual && !train.canceled) {
              // Use parseTime to properly combine date and time for both planned and actual
              const plannedDateTime = parseTime(train.plan, now, train.plannedDate || train.date);
              const actualDateTime = parseTime(train.actual, now, train.date);
              
              if (plannedDateTime && actualDateTime) {
                // Calculate delay in minutes (including both date and time difference)
                const delayMinutes = (actualDateTime - plannedDateTime) / (1000 * 60);
                
                // Count all tasks, treating early completions as 0 delay for true average
                weekDelays.push(Math.max(0, delayMinutes));
              }
            }
          }
        }
      });
      
      // Calculate averages and rates
      const cancellationRate = weekTasks > 0 ? (weekCancelledTasks / weekTasks * 100).toFixed(1) : 0;
      const avgDelay = weekDelays.length > 0 
        ? (weekDelays.reduce((sum, d) => sum + d, 0) / weekDelays.length).toFixed(0)
        : 0;
      
      // Use yellow (warning) for high values, green (highlight) otherwise
      const cancellationClass = cancellationRate > 20 ? 'warning' : 'highlight';
      const delayClass = avgDelay > 60 ? 'warning' : 'highlight';
      
      // Create statistics board HTML
      const isExpanded = project.statisticsExpanded || false;
      const expandedClass = isExpanded ? 'expanded' : '';
      const arrowChar = '▶';
      
      const statisticsHTML = `
        <div class="project-statistics-board">
          <div class="project-statistics-toggle" data-action="toggle-statistics">
            <div class="project-statistics-toggle-text">
              <span class="project-statistics-toggle-arrow ${expandedClass}">${arrowChar}</span>
              <span>Statistik</span>
            </div>
          </div>
          <div class="project-statistics-content ${expandedClass}">
            <div class="project-stat-item">
              <div class="project-stat-label">Gesamtstunden</div>
              <div class="project-stat-value">${totalHours.toFixed(1)} h</div>
            </div>
            <div class="project-stat-item">
              <div class="project-stat-label">Diese Woche</div>
              <div class="project-stat-value">${weekHours.toFixed(1)} h</div>
            </div>
            <div class="project-stat-item">
              <div class="project-stat-label">Abbruchrate (Woche)</div>
              <div class="project-stat-value ${cancellationClass}">${cancellationRate}%</div>
            </div>
            <div class="project-stat-item">
              <div class="project-stat-label">Ø Verspätung (Woche)</div>
              <div class="project-stat-value ${delayClass}">${avgDelay} min</div>
            </div>
          </div>
        </div>
      `;
      
      const template = document.createElement('template');
      template.innerHTML = statisticsHTML.trim();
      return template.content.firstChild;
    }

    function renderProjectDrawer(project) {
      const drawer = document.getElementById('project-drawer');
      const template = document.getElementById('project-drawer-template');
      
      if (!drawer || !template) return;

      const lineColor = getLineColor(project.linie || 's1');
      const deadlineDate = project.deadline ? new Date(project.deadline) : null;
      const createdDate = project.createdAt ? new Date(project.createdAt) : new Date();
      
      // Clear drawer and clone template
      drawer.innerHTML = '';
      const clone = template.content.cloneNode(true);
      
      // Populate header with line color border
      const header = clone.querySelector('[data-project="header"]');
      header.style.borderBottom = `1.2vh solid ${lineColor}`;
      
      // Populate symbol image
      const symbol = clone.querySelector('[data-project="symbol"]');
      const symbolFallback = clone.querySelector('[data-project="symbol-fallback"]');
      const lineName = (project.linie || 's1').toUpperCase();
      
      symbol.src = getTrainSVG(project.linie || 's1');
      symbolFallback.textContent = lineName;
      
      // Adjust font size based on text length for fallback badge
      const adjustFallbackFontSize = () => {
        const textLength = lineName.length;
        let fontSize;
        
        // Dynamic font sizing based on text length (scaled for smaller badge)
        if (textLength <= 2) {
          fontSize = '3.2vh';
        } else if (textLength === 3) {
          fontSize = '2.8vh';
        } else if (textLength === 4) {
          fontSize = '2.5vh';
        } else if (textLength <= 6) {
          fontSize = '2.2vh';
        } else {
          fontSize = '1.8vh';
        }
        
        symbolFallback.style.fontSize = fontSize;
      };
      
      // Show fallback if image fails to load
      symbol.onerror = function() {
        symbol.style.display = 'none';
        symbolFallback.style.display = 'flex';
        adjustFallbackFontSize();
      };
      
      symbol.onload = function() {
        symbol.style.display = 'block';
        symbolFallback.style.display = 'none';
      };
      
      // Populate project name
      const nameField = clone.querySelector('[data-project="name"]');
      nameField.textContent = project.name || 'Unbenanntes Projekt';
      nameField.setAttribute('data-field', 'name');
      nameField.setAttribute('data-value', project.name || '');
      
      // Populate close button
      const closeBtn = clone.querySelector('[data-project="close-btn"]');
      closeBtn.id = 'project-drawer-close-btn';
      
      // Populate deadline field
      const deadlineField = clone.querySelector('[data-project="deadline"]');
      deadlineField.textContent = deadlineDate 
        ? deadlineDate.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Open-Ended';
      deadlineField.setAttribute('data-field', 'deadline');
      deadlineField.setAttribute('data-value', project.deadline || '');
      
      // Set up view selector
      const viewSelector = clone.querySelector('[data-project="view-selector"]');
      viewSelector.value = project.currentView || 'aufgabe';
      
      // Get headers and tasks list
      const tasksHeader = clone.querySelector('[data-project="tasks-header"]');
      const todosHeader = clone.querySelector('[data-project="todos-header"]');
      const tasksList = clone.querySelector('[data-project="tasks-list"]');
      
      // Populate tasks or todos based on current view
      schedule.spontaneousEntries = schedule.spontaneousEntries || [];
      
      if (viewSelector.value === 'todo') {
        // Hide both headers in todo mode
        tasksHeader.style.display = 'none';
        todosHeader.style.display = 'none';
        
        // Hide spacer in todo mode (we need all the height)
        const spacer = clone.querySelector('.spacer');
        if (spacer) spacer.style.display = 'none';
        
        // Get todos (trains with type='todo') for this project
        // Don't sort - keep natural creation order (data write order)
        const allTodos = schedule.spontaneousEntries
          .filter(t => t.projectId === project._uniqueId && t.type === 'todo');
        
        // Split into active (unchecked) and completed (checked)
        const activeTodos = allTodos.filter(t => !t.todoChecked);
        const completedTodos = allTodos.filter(t => t.todoChecked);
        
        // Render active todos
        activeTodos.forEach((todo, index) => {
          const todoHTML = renderProjectTodo(todo, index, lineColor, project._uniqueId);
          const todoTemplate = document.createElement('template');
          todoTemplate.innerHTML = todoHTML.trim();
          tasksList.appendChild(todoTemplate.content.firstChild);
        });
        
        // Add todo creation row (no spacer for todo list)
        const addRowHTML = `
          <div class="project-todo-row project-todo-add-row">
            <span class="project-todo-due-date"></span>
            <span class="project-todo-checkbox"></span>
            <span class="project-todo-name project-todo-add-input" contenteditable="true" data-placeholder="+ To-Do hinzufügen"></span>
          </div>
        `;
        const addRowTemplate = document.createElement('template');
        addRowTemplate.innerHTML = addRowHTML.trim();
        tasksList.appendChild(addRowTemplate.content.firstChild);
      } else {
        // Show tasks header, hide todos header
        tasksHeader.style.display = 'flex';
        todosHeader.style.display = 'none';
        
        // Show spacer in task mode
        const spacer = clone.querySelector('.spacer');
        if (spacer) spacer.style.display = '';
        
        // Get tasks for this project (excluding todos) and sort by actual date
        const trains = schedule.spontaneousEntries
          .filter(t => t.projectId === project._uniqueId && t.type !== 'todo')
          .sort((a, b) => {
            const dateA = a.date || '9999-12-31'; // Tasks without dates go to end
            const dateB = b.date || '9999-12-31';
            return dateA.localeCompare(dateB);
          });
        
        const today = new Date().toISOString().split('T')[0];
        
        trains.forEach((train, index) => {
          const taskHTML = renderProjectTask(train, index, trains.length, lineColor, project._uniqueId, today);
          const taskTemplate = document.createElement('template');
          taskTemplate.innerHTML = taskHTML.trim();
          tasksList.appendChild(taskTemplate.content.firstChild);
        });
        
        // Add task creation row
        const addRowHTML = `
          <div class="project-task-row project-task-add-row">
            <span class="project-task-plan"></span>
            <span style="width: 8%; display: flex; justify-content: center; flex-shrink: 0;"></span>
            <span class="project-task-actual"></span>
            <span class="project-task-name project-task-add-input" contenteditable="true" data-placeholder="+ Aufgabe hinzufügen"></span>
            <span class="spacer"></span>
          </div>
        `;
        const addRowTemplate = document.createElement('template');
        addRowTemplate.innerHTML = addRowHTML.trim();
        tasksList.appendChild(addRowTemplate.content.firstChild);
        
        // Add progress line visualization - after the tasks list
        const completedTasks = trains.filter(t => t.date && t.date <= today).length;
        const totalTasks = trains.length;
        const progressPercent = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
        
        const progressLineHTML = `
          <div class="project-progress-line">
            <div class="project-progress-track">
              <div class="project-progress-fill" style="width: ${progressPercent}%; background-color: ${lineColor};"></div>
            </div>
            <div class="project-progress-text">${completedTasks}/${totalTasks} bis heute</div>
          </div>
        `;
        
        const progressTemplate = document.createElement('template');
        progressTemplate.innerHTML = progressLineHTML.trim();
        
        // Insert progress line after the tasks list but before the spacer
        const progressLine = progressTemplate.content.firstChild;
        tasksList.parentNode.insertBefore(progressLine, tasksList.nextElementSibling);
        
        // Add statistics board after progress line
        const statisticsBoard = renderProjectStatistics(trains, project);
        tasksList.parentNode.insertBefore(statisticsBoard, tasksList.nextElementSibling.nextElementSibling);
        
        // Auto-scroll to focus on current progress point (where colored tasks end)
        if (trains.length > 0) {
          const currentTaskIndex = trains.findIndex(t => !t.date || t.date > today);
          if (currentTaskIndex > 0) {
            // Scroll to show the transition point between colored and gray tasks
            const taskRows = tasksList.querySelectorAll('.project-task-row:not(.project-task-add-row)');
            if (taskRows[currentTaskIndex - 1]) {
              setTimeout(() => {
                taskRows[currentTaskIndex - 1].scrollIntoView({
                  behavior: 'smooth',
                  block: 'center'
                });
              }, 100);
            }
          }
        }
      }
      
      // Populate created date
      const createdDateField = clone.querySelector('[data-project="created-date"]');
      createdDateField.textContent = 'Erstellt am ' + createdDate.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      
      // Populate delete button
      const deleteBtn = clone.querySelector('[data-project="delete-btn"]');
      deleteBtn.id = 'project-delete-btn';
      
      // Append to drawer
      drawer.appendChild(clone);
      
      // If in todo mode, add completed section as a sibling to tasks-list
      if (viewSelector.value === 'todo') {
        const activeTodos = schedule.spontaneousEntries
          .filter(t => t.projectId === project._uniqueId && t.type === 'todo' && !t.todoChecked);
        const completedTodos = schedule.spontaneousEntries
          .filter(t => t.projectId === project._uniqueId && t.type === 'todo' && t.todoChecked);
        
        if (completedTodos.length > 0) {
          const isOpen = project.completedSectionOpen || false;
          const arrowChar = isOpen ? '▼' : '▶';
          const displayStyle = isOpen ? 'block' : 'none';
          
          const completedSectionHTML = `
            <div class="project-completed-section">
              <div class="project-completed-header" data-action="toggle-completed">
                <span class="project-completed-arrow">${arrowChar}</span>
                <span class="project-completed-title">Abgeschlossen (${completedTodos.length})</span>
              </div>
              <div class="project-completed-list" style="display: ${displayStyle};" data-section="completed-list">
              </div>
            </div>
          `;
          
          // Insert completed section after tasks-list
          const tasksListInDrawer = drawer.querySelector('[data-project="tasks-list"]');
          const spacer = drawer.querySelector('.spacer');
          const completedTemplate = document.createElement('template');
          completedTemplate.innerHTML = completedSectionHTML.trim();
          tasksListInDrawer.parentNode.insertBefore(completedTemplate.content.firstChild, spacer);
          
          // Render completed todos
          const completedList = drawer.querySelector('[data-section="completed-list"]');
          completedTodos.forEach((todo, index) => {
            const todoHTML = renderProjectTodo(todo, index, lineColor, project._uniqueId);
            const todoTemplate = document.createElement('template');
            todoTemplate.innerHTML = todoHTML.trim();
            completedList.appendChild(todoTemplate.content.firstChild);
          });
        }
      }
      
      // Set up event listeners
      setupProjectDrawerListeners(project);
    }

    function renderProjectTodo(todo, index, lineColor, projectId) {
      const rowClass = index % 2 === 0 ? 'project-todo-row-bright' : 'project-todo-row-dark';
      const checked = todo.todoChecked ? 'checked' : '';
      
      // Format due date as DD.MM if it exists
      let dueDateStr = '';
      if (todo.date) {
        const dueDate = new Date(todo.date);
        dueDateStr = dueDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      }
      
      return `
        <div class="project-todo-row ${rowClass}" data-task-id="${todo._uniqueId}" style="--line-color: ${lineColor};">
          <span class="project-todo-due-date">${dueDateStr}</span>
          <span class="project-todo-checkbox">
            <input type="checkbox" ${checked} data-todo-action="toggle">
          </span>
          <span class="project-todo-name">${todo.ziel || 'Unbenanntes To-Do'}</span>
          <img src="res/remove.svg" class="project-task-remove-icon" data-task-action="remove">
        </div>
      `;
    }

    function renderProjectTask(train, index, totalTasks, lineColor, projectId, today) {
      const rowClass = index % 2 === 0 ? 'project-task-row-bright' : 'project-task-row-dark';
      // Use plannedDate (original date) and date (current date) instead of plan/actual which are times
      const planDate = train.plannedDate ? new Date(train.plannedDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '';
      const actualDate = train.date ? new Date(train.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : planDate;
      
      // Progress based on date: everything until today is colored, rest is gray
      const isBeforeOrToday = train.date && train.date <= today;
      
      // Status dot styling - tasks until today are colored, future tasks are gray
      let statusDotClass = 'project-task-status-dot';
      if (isBeforeOrToday) {
        statusDotClass += ' project-task-status-active';
      }
      
      const dotColor = isBeforeOrToday ? lineColor : '#666';
      
      return `
        <div class="project-task-row ${rowClass}" data-task-id="${train._uniqueId}" data-task-active="${isBeforeOrToday}">
          <span class="project-task-plan">${planDate}</span>
          <span style="width: 8%; display: flex; justify-content: center; flex-shrink: 0;">
            <span class="${statusDotClass}" style="background-color: ${dotColor}; --line-color: ${dotColor};"></span>
          </span>
          <span class="project-task-actual">${actualDate}</span>
          <span class="project-task-name">${train.ziel || 'Unbenannte Aufgabe'}</span>
          <span class="spacer"></span>
          <img src="res/remove.svg" class="project-task-remove-icon" data-task-action="remove">
        </div>
      `;
    }

    function setupProjectDrawerListeners(project) {
      // View selector change
      const viewSelector = document.querySelector('[data-project="view-selector"]');
      if (viewSelector) {
        viewSelector.addEventListener('change', async () => {
          // Preserve completed section state before re-rendering
          const wasOpen = project.completedSectionOpen;
          
          // OPTIMISTIC UI: Update immediately, save in background
          project.currentView = viewSelector.value;
          
          // Re-render immediately with updated view
          const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
          if (freshProject) {
            freshProject.completedSectionOpen = wasOpen;
            renderProjectDrawer(freshProject);
          }
          
          // Save in background
          saveSchedule();
        });
      }
      
      // Close button
      const closeBtn = document.getElementById('project-drawer-close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          closeProjectDrawer();
          restoreWorkspaceModeAfterProjectDrawer();
        });
      }
      
      // Delete button
      const deleteBtn = document.getElementById('project-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          if (confirm('Möchten Sie dieses Projekt wirklich löschen?')) {
            // Remove project
            schedule.projects = schedule.projects.filter(p => p._uniqueId !== project._uniqueId);
            // Make trains projectless (orphaned) instead of deleting them
            schedule.spontaneousEntries.forEach(train => {
              if (train.projectId === project._uniqueId) {
                train.projectId = null;
              }
            });
            
            // CRITICAL: Regenerate derived data after orphaning trains
            regenerateTrainsFromSchedule();
            processTrainData(schedule);
            
            // Re-render immediately
            closeProjectDrawer();
            restoreWorkspaceModeAfterProjectDrawer();
            
            // Save in background
            saveSchedule();
          }
        });
      }
      
      // Editable fields - convert ALL to inputs when ANY is clicked (like train editor)
      const editableFields = document.querySelectorAll('#project-drawer [data-editable="true"]');
      editableFields.forEach(field => {
        field.addEventListener('mousedown', function(e) {
          // Check if already in edit mode
          const hasInputs = document.querySelector('#project-drawer [data-editable="true"] input, #project-drawer [data-editable="true"] textarea');
          if (hasInputs) {
            return; // Already in edit mode
          }
          
          const clickedFieldName = field.getAttribute('data-field');
          
          // Convert ALL editable fields to inputs
          editableFields.forEach(f => {
            const fieldName = f.getAttribute('data-field');
            const inputType = f.getAttribute('data-input-type') || 'text';
            const currentValue = f.getAttribute('data-value');
            
            const input = document.createElement('input');
            input.type = inputType;
            input.value = currentValue;
            input.style.width = '100%';
            input.style.background = 'transparent';
            input.style.border = 'none';
            input.style.color = 'inherit';
            input.style.fontFamily = 'inherit';
            input.style.fontSize = 'inherit';
            input.style.fontWeight = 'inherit';
            input.style.letterSpacing = 'inherit';
            input.style.outline = 'none';
            
            if (inputType === 'datetime-local' || inputType === 'date') {
              input.style.colorScheme = 'dark';
            }
            
            const save = () => {
              // Preserve completed section state before re-rendering
              const wasOpen = project.completedSectionOpen;
              
              // OPTIMISTIC UI: Update immediately, save in background
              // Save all fields
              const allInputs = document.querySelectorAll('#project-drawer [data-editable="true"] input');
              allInputs.forEach(inp => {
                const fn = inp.parentElement.getAttribute('data-field');
                if (fn) {
                  project[fn] = inp.value;
                }
              });
              
              // Re-render immediately
              const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
              if (freshProject) {
                freshProject.completedSectionOpen = wasOpen;
                renderProjectDrawer(freshProject);
              }
              renderProjectsPage();
              
              // Save in background
              saveSchedule();
            };
            
            input.addEventListener('blur', save);
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                save();
              }
            });
            
            f.innerHTML = '';
            f.appendChild(input);
          });
          
          // Focus the clicked field's input
          setTimeout(() => {
            const thisInput = field.querySelector('input');
            if (thisInput) {
              thisInput.focus();
            }
          }, 0);
        });
      });
      
      // Symbol image/fallback opens prompt dialog to change line
      const symbol = document.querySelector('[data-project="symbol"]');
      const symbolFallback = document.querySelector('[data-project="symbol-fallback"]');
      
      const handleSymbolClick = function(e) {
        e.stopPropagation();
        
        const currentLine = project.linie || 's1';
        const newLine = prompt('Linie ändern:', currentLine.toUpperCase());
        
        if (newLine && newLine.trim() !== '') {
          // Preserve completed section state before re-rendering
          const wasOpen = project.completedSectionOpen;
          
          project.linie = newLine.trim().toLowerCase();
          
          // Re-render immediately
          const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
          if (freshProject) {
            // Restore the completed section state
            freshProject.completedSectionOpen = wasOpen;
            renderProjectDrawer(freshProject);
          }
          renderProjectsPage();
          
          // Save in background
          saveSchedule();
        }
      };
      
      if (symbol) {
        symbol.addEventListener('click', handleSymbolClick);
      }
      
      if (symbolFallback) {
        symbolFallback.addEventListener('click', handleSymbolClick);
      }
      
      // Task add input
      const addInput = document.querySelector('.project-task-add-input');
      if (addInput) {
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const taskName = addInput.textContent.trim();
            if (taskName) {
              // OPTIMISTIC UI: Update immediately, save in background
              // Preserve completed section state
              const wasOpen = project.completedSectionOpen;
              
              // Use unified createNewTrainEntry with project-specific options
              schedule.spontaneousEntries = schedule.spontaneousEntries || [];
              const newTrain = createNewTrainEntry({
                linie: (project.linie || 's1').toUpperCase(),
                ziel: taskName,
                projectId: project._uniqueId
              });
              // Add to schedule
              schedule.spontaneousEntries.push(newTrain);
              
              // CRITICAL: Regenerate derived data so click handlers can find the new train
              regenerateTrainsFromSchedule();
              processTrainData(schedule);
              
              // Re-render immediately
              const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
              if (freshProject) {
                freshProject.completedSectionOpen = wasOpen;
                renderProjectDrawer(freshProject);
              }
              renderProjectsPage(); // Update main projects panel
              
              // Focus the next add input
              setTimeout(() => {
                const nextAddInput = document.querySelector('.project-task-add-input');
                if (nextAddInput) nextAddInput.focus();
              }, 100);
              
              // Save in background
              saveSchedule();
            }
          }
        });
        
        // Placeholder handling
        addInput.addEventListener('focus', function() {
          if (this.textContent === this.getAttribute('data-placeholder')) {
            this.textContent = '';
          }
        });
        addInput.addEventListener('blur', function() {
          if (this.textContent.trim() === '') {
            this.textContent = '';
          }
        });
      }
      
      // Todo add input
      const todoAddInput = document.querySelector('.project-todo-add-input');
      if (todoAddInput) {
        todoAddInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const todoName = todoAddInput.textContent.trim();
            if (todoName) {
              // OPTIMISTIC UI: Update immediately, save in background
              // Preserve completed section state
              const wasOpen = project.completedSectionOpen;
              
              schedule.spontaneousEntries = schedule.spontaneousEntries || [];
              const newTodo = createNewTrainEntry({
                linie: (project.linie || 's1').toUpperCase(),
                ziel: todoName,
                projectId: project._uniqueId
              });
              // Mark as todo
              newTodo.type = 'todo';
              newTodo.todoChecked = false;
              
              // Add to schedule
              schedule.spontaneousEntries.push(newTodo);
              
              // CRITICAL: Regenerate derived data so click handlers can find the new todo
              regenerateTrainsFromSchedule();
              processTrainData(schedule);
              
              // Re-render immediately
              const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
              if (freshProject) {
                freshProject.completedSectionOpen = wasOpen;
                renderProjectDrawer(freshProject);
              }
              renderProjectsPage(); // Update main projects panel
              
              // Focus the next add input
              setTimeout(() => {
                const nextTodoInput = document.querySelector('.project-todo-add-input');
                if (nextTodoInput) nextTodoInput.focus();
              }, 100);
              
              // Save in background
              saveSchedule();
            }
          }
        });
        
        // Placeholder handling
        todoAddInput.addEventListener('focus', function() {
          if (this.textContent === this.getAttribute('data-placeholder')) {
            this.textContent = '';
          }
        });
        todoAddInput.addEventListener('blur', function() {
          if (this.textContent.trim() === '') {
            this.textContent = '';
          }
        });
      }
      
      // Task row clicks
      const drawer = document.getElementById('project-drawer');
      const taskRows = drawer.querySelectorAll('.project-task-row:not(.project-task-add-row)');
      taskRows.forEach(row => {
        const taskId = row.getAttribute('data-task-id');
        
        // Remove button
        const removeBtn = row.querySelector('[data-task-action="remove"]');
        if (removeBtn) {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const taskToDelete = schedule.spontaneousEntries.find(t => t._uniqueId === taskId);
            const taskName = taskToDelete ? taskToDelete.ziel : 'Aufgabe';
            if (confirm(`Aufgabe "${taskName}" löschen?`)) {
              // Preserve completed section state before re-rendering
              const wasOpen = project.completedSectionOpen;
              
              schedule.spontaneousEntries = schedule.spontaneousEntries.filter(t => t._uniqueId !== taskId);
              
              // CRITICAL: Regenerate derived data after removing train
              regenerateTrainsFromSchedule();
              processTrainData(schedule);
              
              // Re-render immediately
              const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
              if (freshProject) {
                // Restore the completed section state
                freshProject.completedSectionOpen = wasOpen;
                renderProjectDrawer(freshProject);
              }
              renderProjectsPage(); // Update main projects panel
              
              // Save in background
              saveSchedule();
            }
          });
        }
        
        // Click on task row to open editor drawer
        row.addEventListener('click', function(e) {
          console.log('Task row clicked:', taskId);
          if (e.target.closest('[data-task-action]')) {
            console.log('Clicked on action button, returning');
            return;
          }
          openTaskEditor(project._uniqueId, taskId);
        });
        
        // Double-click on task row to edit name inline
        row.addEventListener('dblclick', function(e) {
          e.stopPropagation();
          e.preventDefault();
          
          // Don't allow inline edit if clicking on action buttons
          if (e.target.closest('[data-task-action]')) {
            return;
          }
          
          const nameSpan = row.querySelector('.project-task-name');
          if (!nameSpan || nameSpan.querySelector('input')) return; // Already editing
          
          const currentName = nameSpan.textContent;
          const input = document.createElement('input');
          input.type = 'text';
          input.value = currentName;
          input.className = 'project-task-name-input';
          input.style.width = '100%';
          input.style.background = 'rgba(255, 255, 255, 0.1)';
          input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
          input.style.borderRadius = '0.3vh';
          input.style.padding = '0.5vh 1vh';
          input.style.color = 'inherit';
          input.style.fontSize = 'inherit';
          input.style.fontFamily = 'inherit';
          
          const saveName = () => {
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
              const task = schedule.spontaneousEntries.find(t => t._uniqueId === taskId);
              if (task) {
                // Preserve completed section state
                const wasOpen = project.completedSectionOpen;
                
                // OPTIMISTIC UI: Update immediately
                task.ziel = newName;
                regenerateTrainsFromSchedule();
                processTrainData(schedule);
                
                // Re-render both views
                const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
                if (freshProject) {
                  freshProject.completedSectionOpen = wasOpen;
                  renderProjectDrawer(freshProject);
                }
                renderProjectsPage();
                
                // Save in background
                saveSchedule();
              }
            } else {
              nameSpan.textContent = currentName;
            }
          };
          
          input.addEventListener('blur', saveName);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              input.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              nameSpan.textContent = currentName;
              input.blur();
            }
          });
          
          nameSpan.textContent = '';
          nameSpan.appendChild(input);
          input.focus();
          input.select();
        });
      });
      
      // Todo row clicks and checkbox handling
      const todoRows = drawer.querySelectorAll('.project-todo-row:not(.project-todo-add-row)');
      todoRows.forEach(row => {
        const todoId = row.getAttribute('data-task-id');
        
        // Checkbox toggle
        const checkbox = row.querySelector('[data-todo-action="toggle"]');
        if (checkbox) {
          checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            const todo = schedule.spontaneousEntries.find(t => t._uniqueId === todoId);
            if (todo) {
              // OPTIMISTIC UI: Update immediately, save in background
              // Preserve completed section state
              const wasOpen = project.completedSectionOpen;
              
              todo.todoChecked = checkbox.checked;
              
              // CRITICAL: Regenerate derived data after modifying train
              regenerateTrainsFromSchedule();
              processTrainData(schedule);
              
              // Re-render immediately
              const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
              if (freshProject) {
                freshProject.completedSectionOpen = wasOpen;
                renderProjectDrawer(freshProject);
              }
              renderProjectsPage(); // Update main projects panel
              
              // Save in background
              saveSchedule();
            }
          });
        }
        
        // Remove button (no confirmation for todos)
        const removeBtn = row.querySelector('[data-task-action="remove"]');
        if (removeBtn) {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // OPTIMISTIC UI: Update immediately, save in background
            // Preserve completed section state
            const wasOpen = project.completedSectionOpen;
            
            schedule.spontaneousEntries = schedule.spontaneousEntries.filter(t => t._uniqueId !== todoId);
            
            // CRITICAL: Regenerate derived data after removing train
            regenerateTrainsFromSchedule();
            processTrainData(schedule);
            
            // Re-render immediately
            const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
            if (freshProject) {
              freshProject.completedSectionOpen = wasOpen;
              renderProjectDrawer(freshProject);
            }
            renderProjectsPage(); // Update main projects panel
            
            // Save in background
            saveSchedule();
          });
        }
        
        // Click on todo row to open editor drawer
        row.addEventListener('click', function(e) {
          if (e.target.tagName === 'INPUT' || e.target.closest('[data-task-action]')) {
            return;
          }
          openTaskEditor(project._uniqueId, todoId);
        });
        
        // Double-click on todo row to edit name inline (same as tasks)
        row.addEventListener('dblclick', function(e) {
          e.stopPropagation();
          e.preventDefault();
          
          // Don't allow inline edit if clicking on action buttons or checkbox
          if (e.target.tagName === 'INPUT' || e.target.closest('[data-task-action]')) {
            return;
          }
          
          const nameSpan = row.querySelector('.project-todo-name');
          if (!nameSpan || nameSpan.querySelector('input')) return; // Already editing
          
          const currentName = nameSpan.textContent;
          const input = document.createElement('input');
          input.type = 'text';
          input.value = currentName;
          input.className = 'project-todo-name-input';
          input.style.width = '100%';
          input.style.background = 'rgba(255, 255, 255, 0.1)';
          input.style.border = '1px solid rgba(255, 255, 255, 0.3)';
          input.style.borderRadius = '0.3vh';
          input.style.padding = '0.5vh 1vh';
          input.style.color = 'inherit';
          input.style.fontSize = 'inherit';
          input.style.fontFamily = 'inherit';
          
          const saveName = () => {
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
              const todo = schedule.spontaneousEntries.find(t => t._uniqueId === todoId);
              if (todo) {
                // Preserve completed section state
                const wasOpen = project.completedSectionOpen;
                
                // OPTIMISTIC UI: Update immediately
                todo.ziel = newName;
                regenerateTrainsFromSchedule();
                processTrainData(schedule);
                
                // Re-render both views
                const freshProject = schedule.projects.find(p => p._uniqueId === project._uniqueId);
                if (freshProject) {
                  freshProject.completedSectionOpen = wasOpen;
                  renderProjectDrawer(freshProject);
                }
                renderProjectsPage();
                
                // Save in background
                saveSchedule();
              }
            } else {
              nameSpan.textContent = currentName;
            }
          };
          
          input.addEventListener('blur', saveName);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              input.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              nameSpan.textContent = currentName;
              input.blur();
            }
          });
          
          nameSpan.textContent = '';
          nameSpan.appendChild(input);
          input.focus();
          input.select();
        });
      });
      
      // Collapsible completed section toggle
      const completedHeader = drawer.querySelector('[data-action="toggle-completed"]');
      if (completedHeader) {
        completedHeader.addEventListener('click', async function() {
          const completedList = drawer.querySelector('[data-section="completed-list"]');
          const arrow = this.querySelector('.project-completed-arrow');
          
          if (completedList.style.display === 'none') {
            completedList.style.display = 'block';
            arrow.textContent = '▼';
            project.completedSectionOpen = true;
          } else {
            completedList.style.display = 'none';
            arrow.textContent = '▶';
            project.completedSectionOpen = false;
          }
          
          // Save the state
          await saveSchedule();
        });
      }
      
      // Statistics board toggle
      const statisticsToggle = drawer.querySelector('[data-action="toggle-statistics"]');
      if (statisticsToggle) {
        statisticsToggle.addEventListener('click', async function() {
          const statisticsContent = drawer.querySelector('.project-statistics-content');
          const arrow = this.querySelector('.project-statistics-toggle-arrow');
          
          if (statisticsContent.classList.contains('expanded')) {
            statisticsContent.classList.remove('expanded');
            arrow.classList.remove('expanded');
            project.statisticsExpanded = false;
          } else {
            statisticsContent.classList.add('expanded');
            arrow.classList.add('expanded');
            project.statisticsExpanded = true;
          }
          
          // Save the state
          await saveSchedule();
        });
      }
    }

    function openTaskEditor(projectId, taskId) {
      // Search in the same processed train data that the announcement panel uses
      // This ensures we get the train with proper source:'local' field
      const train = processedTrainData.allTrains.find(t => t._uniqueId === taskId);
      if (!train) return;
      
      // Keep project drawer open, show editor to the left
      // Use the regular editor drawer - same as clicking a train
      renderFocusMode(train);
    }

    // ==================== END PROJECT MANAGEMENT FUNCTIONS ====================

