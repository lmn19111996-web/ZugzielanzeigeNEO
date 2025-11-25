/**
 * HTML Template System for ZugzielanzeigeNEO
 * 
 * This module provides reusable HTML templates to replace dynamic DOM creation
 * scattered throughout app.js. Each template is a function that returns an HTML string
 * or DocumentFragment, ready to be inserted into the DOM.
 */

const Templates = {
  /**
   * Create a train entry for the train list view
   */
  trainEntry(train, now, isFirstTrain = false) {
    const delay = train.canceled ? 0 : getDelay(train.plan, train.actual, now, train.date);
    const tTime = parseTime(train.actual || train.plan, now, train.date);
    const occEnd = getOccupancyEnd(train, now);
    const isCurrent = train.actual && occEnd && parseTime(train.actual, now, train.date) <= now && occEnd > now;
    
    // Determine indicator class
    let indicatorClass = 'indicator-dot';
    if (train.canceled) {
      indicatorClass += ' cancelled';
    } else if (isCurrent) {
      indicatorClass += ' current';
    }
    
    // Determine train symbol HTML
    let trainSymbolHTML = '';
    if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
      trainSymbolHTML = `<img class="train-symbol" src="${getTrainSVG(train.linie)}" alt="${train.linie}" onerror="this.outerHTML='<div class=\\'line-badge\\'>${train.linie || ''}</div>'">`;
    } else {
      trainSymbolHTML = `<div class="line-badge">${train.linie || ''}</div>`;
    }
    
    // Determine destination text
    const destinationText = train.canceled ? 'Zug fällt aus' : (train.ziel || '');
    
    // Entry classes
    const entryClasses = ['train-entry'];
    if (isFirstTrain) entryClasses.push('first-train');
    if (train.linie === 'FEX') entryClasses.push('fex-entry');
    
    // Create a temporary container for departure HTML
    const tempDiv = document.createElement('div');
    if (isFirstTrain) {
      tempDiv.appendChild(formatCountdown(train, now));
    } else {
      tempDiv.appendChild(formatDeparture(train.plan, train.actual, now, delay, train.dauer, train.date));
    }
    const departureHTML = tempDiv.innerHTML;
    
    return `
      <div class="${entryClasses.join(' ')}" 
           data-linie="${train.linie || ''}" 
           data-plan="${train.plan || ''}" 
           data-date="${train.date || ''}" 
           data-unique-id="${train._uniqueId || ''}">
        <div class="train-info">
          <div class="${indicatorClass}"></div>
          <div class="symbol-slot">
            ${trainSymbolHTML}
          </div>
          <div class="zugziel">${destinationText}</div>
        </div>
        <div class="right-block">
          <div class="departure-slot">
            <div class="departure" 
                 data-departure="1" 
                 data-plan="${train.plan || ''}" 
                 data-actual="${train.actual || ''}" 
                 data-dauer="${train.dauer != null ? String(train.dauer) : ''}" 
                 data-date="${train.date || ''}" 
                 data-canceled="${train.canceled ? 'true' : 'false'}" 
                 ${isFirstTrain ? 'data-is-headline="true"' : ''}>
              ${departureHTML}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Create a day separator element
   */
  daySeparator(trainDate) {
    const dateObj = new Date(trainDate);
    const dateText = dateObj.toLocaleDateString('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit'
    });
    
    return `
      <div class="day-separator">
        <span class="day-separator-date">${dateText}</span>
        <div class="day-separator-line"></div>
      </div>
    `;
  },

  /**
   * Create a Belegungsplan train block
   */
  belegungsplanBlock(train, pos, overlapLevel, now) {
    const blockClasses = ['belegungsplan-train-block', `overlap-${overlapLevel}`];
    
    // Add FEX class
    if (train.linie === 'FEX') {
      blockClasses.push('fex-entry');
    } else if (typeof train.linie === 'string' && /^S\d+/i.test(train.linie)) {
      // Add S-Bahn color class
      const lineClass = `s-bahn-${train.linie.toLowerCase()}`;
      blockClasses.push(lineClass);
    }
    
    // Check if currently occupying
    const trainStart = parseTime(train.actual || train.plan, now, train.date);
    const trainEnd = getOccupancyEnd(train, now);
    if (trainStart && trainEnd && trainStart <= now && trainEnd > now) {
      blockClasses.push('current');
    }
    
    // Only show header content for blocks 30 minutes or longer
    const duration = Number(train.dauer) || 0;
    let headerHTML = '';
    
    if (duration >= 30) {
      let lineIconHTML = '';
      if (typeof train.linie === 'string' && (/^S\d+/i.test(train.linie) || train.linie === 'FEX' || /^\d+$/.test(train.linie))) {
        lineIconHTML = `<img class="belegungsplan-line-icon" src="${getTrainSVG(train.linie)}" alt="${train.linie}" onerror="this.outerHTML='<div class=\\'line-badge\\' style=\\'font-size: 2.5vh\\'>${train.linie || ''}</div>'">`;
      } else {
        lineIconHTML = `<div class="line-badge" style="font-size: 2.5vh">${train.linie || ''}</div>`;
      }
      
      headerHTML = `
        <div class="belegungsplan-header">
          ${lineIconHTML}
          <div class="belegungsplan-destination">${train.ziel || ''}</div>
        </div>
      `;
    }
    
    return `
      <div class="${blockClasses.join(' ')}" 
           style="top: ${pos.top}vh; height: ${pos.height}vh;" 
           data-unique-id="${train._uniqueId || ''}" 
           data-linie="${train.linie || ''}" 
           data-plan="${train.plan || ''}">
        ${headerHTML}
      </div>
    `;
  },

  /**
   * Create a Belegungsplan hour line with marker
   */
  belegungsplanHourLine(markerTime, markerY, isNewDay) {
    const lineClass = isNewDay ? 'belegungsplan-hour-line midnight' : 'belegungsplan-hour-line';
    
    return `
      <div class="${lineClass}" style="top: ${markerY}vh;"></div>
      <div class="belegungsplan-time-marker" style="top: ${markerY}vh;">${formatClock(markerTime)}</div>
    `;
  },

  /**
   * Create a Belegungsplan date separator
   */
  belegungsplanDateSeparator(markerTime, markerY) {
    const dateObj = new Date(markerTime);
    const dateText = dateObj.toLocaleDateString('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
    });
    
    return `
      <div class="belegungsplan-date-separator" style="top: ${markerY}vh;">${dateText}</div>
    `;
  },

  /**
   * Create current time indicator line for Belegungsplan
   */
  belegungsplanCurrentTimeLine(currentTimeY) {
    return `<div class="belegungsplan-current-time-line" style="top: ${currentTimeY}vh;"></div>`;
  },

  /**
   * Create an editable field wrapper
   */
  editableField(fieldName, value, inputType, placeholder, additionalStyles = '') {
    return `
      <div data-field="${fieldName}" 
           data-value="${value || ''}" 
           data-input-type="${inputType}" 
           data-placeholder="${placeholder || ''}" 
           data-editable="true" 
           style="cursor: pointer; ${additionalStyles}">
        ${value || ''}
      </div>
    `;
  },

  /**
   * Create a train badge for API or fixed schedule indicators
   */
  trainBadge(type, isFixed = false) {
    if (type === 'db-api') {
      return `<div style="position: absolute; top: 1vh; right: 1vw; font-size: 1.5vh; color: rgba(255,255,255,0.5); background: rgba(0,0,0,0.3); padding: 0.5vh 1vw; border-radius: 2px;">DB API - Nur Lesen</div>`;
    } else if (type === 'fixed-schedule') {
      return `<div style="position: absolute; top: 1vh; right: 1vw; font-size: 1.5vh; color: rgba(255,200,100,0.8); background: rgba(100,60,0,0.4); padding: 0.5vh 1vw; border-radius: 2px; border: 1px solid rgba(255,200,100,0.3);" title="Datum kann nicht bearbeitet werden - dieser Termin wiederholt sich wöchentlich">🔒 Wiederholender Termin</div>`;
    }
    return '';
  },

  /**
   * Create mobile train badge
   */
  mobileBadge(type) {
    if (type === 'db-api') {
      return `<div class="mobile-train-badge" style="position: fixed; top: 6vh; right: 2vw; font-size: 1.8vh; color: rgba(255,255,255,0.6); background: rgba(0,0,0,0.4); padding: 0.5vh 2vw; border-radius: 4px; z-index: 5001;">DB API - Nur Lesen</div>`;
    } else if (type === 'fixed-schedule') {
      return `<div class="mobile-train-badge" style="position: fixed; top: 6vh; right: 2vw; font-size: 1.8vh; color: rgba(255,200,100,0.9); background: rgba(100,60,0,0.5); padding: 0.5vh 2vw; border-radius: 4px; border: 1px solid rgba(255,200,100,0.4); z-index: 5001;">🔒 Wiederholender Termin</div>`;
    }
    return '';
  },

  /**
   * Create empty state message
   */
  emptyState(message) {
    return `<div style="font-size: 2vw; color: rgba(255,255,255,0.5); text-align: center; padding: 2vh;">${message}</div>`;
  },

  /**
   * Create line icon element (img or badge)
   */
  lineIcon(linie, className = 'train-symbol', fontSize = 'inherit') {
    if (typeof linie === 'string' && (/^S\d+/i.test(linie) || linie === 'FEX' || /^\d+$/.test(linie))) {
      return `<img class="${className}" src="${getTrainSVG(linie)}" alt="${linie}" onerror="this.outerHTML='<div class=\\'line-badge\\' style=\\'font-size: ${fontSize}\\'>${linie || ''}</div>'">`;
    } else {
      return `<div class="line-badge" style="font-size: ${fontSize}">${linie || ''}</div>`;
    }
  },

  /**
   * Create focus mode date display
   */
  focusDateDisplay(train, now) {
    const trainDate = train.date ? new Date(train.date) : now;
    const dateDisplay = trainDate.toLocaleDateString('de-DE', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    return dateDisplay;
  },

  /**
   * Create focus mode arrival time HTML
   */
  focusArrivalTime(train, isEditable) {
    const planHTML = `
      <div class="focus-plan" 
           data-field="plan" 
           data-value="${train.plan || ''}" 
           data-input-type="time" 
           ${isEditable ? 'data-editable="true" style="cursor: pointer;"' : ''}
           ${train.canceled ? 'style="text-decoration: line-through;"' : ''}>
        ${train.plan || ''}
      </div>
    `;
    
    const hasDelay = train.actual && train.actual !== train.plan;
    const delayedStyle = hasDelay ? 'display: block;' : (isEditable ? 'display: block; opacity: 0.5;' : 'display: none;');
    
    const delayedHTML = `
      <div class="focus-delayed" 
           style="${delayedStyle} ${train.canceled ? 'text-decoration: line-through;' : ''}" 
           data-field="actual" 
           data-value="${train.actual || ''}" 
           data-input-type="time" 
           ${isEditable ? 'data-editable="true" style="cursor: pointer;"' : ''}>
        ${train.actual || train.plan || ''}
      </div>
    `;
    
    return planHTML + delayedHTML;
  },

  /**
   * Create focus mode departure time HTML
   */
  focusDepartureTime(train, now) {
    if (!train.plan || !train.dauer) {
      return '';
    }
    
    const arrivalDate = parseTime(train.plan, now, train.date);
    const depDate = new Date(arrivalDate.getTime() + Number(train.dauer) * 60000);
    const depPlan = formatClock(depDate);
    
    const planHTML = `
      <div class="focus-plan" ${train.canceled ? 'style="text-decoration: line-through;"' : ''}>
        ${depPlan}
      </div>
    `;
    
    const hasDepDelay = train.actual && train.actual !== train.plan;
    let delayedHTML = '';
    
    if (hasDepDelay) {
      const actualArrivalDate = parseTime(train.actual, now, train.date);
      const actualDepDate = new Date(actualArrivalDate.getTime() + Number(train.dauer) * 60000);
      const depActual = formatClock(actualDepDate);
      
      delayedHTML = `
        <div class="focus-delayed" 
             style="display: block; ${train.canceled ? 'text-decoration: line-through;' : ''}" >
          ${depActual}
        </div>
      `;
    }
    
    return planHTML + delayedHTML;
  },

  /**
   * Create mobile line description field
   */
  mobileLineDescription(train) {
    const descriptionPresets = {
      'S1': ' - Pause',
      'S2': ' - Vorbereitung',
      'S3': ' - Kreativität',
      'S4': " - Girls' Night Out",
      'S45': ' - FLURUS',
      'S46': ' - Fachschaftsarbeit',
      'S5': ' - Sport',
      'S6': ' - Lehrveranstaltung',
      'S60': ' - Vortragsübung',
      'S62': ' - Tutorium',
      'S7': ' - Selbststudium',
      'S8': ' - Reise',
      'S85': ' - Reise'
    };
    
    const defaultDescription = descriptionPresets[train.linie] || '';
    
    return `
      <div class="mobile-line-description" 
           data-field="beschreibung" 
           data-value="${defaultDescription}" 
           data-input-type="text" 
           data-placeholder="Linienbeschreibung...">
        ${train.beschreibung || defaultDescription}
      </div>
    `;
  },

  /**
   * Create focus mode button group
   */
  focusButtons() {
    return `
      <div class="focus-buttons">
        <button class="focus-btn focus-btn-cancel" data-focus-action="cancel">✕</button>
        <button class="focus-btn focus-btn-minus5" data-focus-action="minus5">-5</button>
        <button class="focus-btn focus-btn-plus5" data-focus-action="plus5">+5</button>
        <button class="focus-btn focus-btn-plus10" data-focus-action="plus10">+10</button>
        <button class="focus-btn focus-btn-plus30" data-focus-action="plus30">+30</button>
        <button class="focus-btn focus-btn-delete" data-focus-action="delete">Löschen</button>
      </div>
    `;
  },

  /**
   * Create mobile focus button group
   */
  mobileFocusButtons() {
    return `
      <div class="mobile-taskbar-placeholder">
        <button class="mobile-focus-btn mobile-focus-btn-return" data-mobile-focus-action="return">←</button>
        <button class="mobile-focus-btn mobile-focus-btn-cancel" data-mobile-focus-action="cancel">✕</button>
        <button class="mobile-focus-btn" data-mobile-focus-action="minus5">-5</button>
        <button class="mobile-focus-btn" data-mobile-focus-action="plus5">+5</button>
        <button class="mobile-focus-btn" data-mobile-focus-action="plus10">+10</button>
        <button class="mobile-focus-btn" data-mobile-focus-action="plus30">+30</button>
        <button class="mobile-focus-btn mobile-focus-btn-delete" data-mobile-focus-action="delete">🗑</button>
      </div>
    `;
  },

  /**
   * Create "train deleted" message for focus panel
   */
  trainDeletedMessage() {
    return '<div style="font-size: 2vw; color: rgba(255,255,255,0.5); text-align: center; padding: 2vh;">Zug gelöscht</div>';
  },

  /**
   * Create "no announcements" message
   */
  noAnnouncementsMessage() {
    return '<div style="font-size: 2vw; color: rgba(255,255,255,0.5); text-align: center;">Keine Ankündigungen</div>';
  },

  /**
   * Create strikethrough text for cancelled trains
   */
  strikethrough(text) {
    return `<s>${text || ''}</s>`;
  },

  /**
   * Create line picker option button (mobile)
   */
  linePickerOption(linie, beschreibung) {
    const iconHTML = (typeof linie === 'string' && (/^S\d+/i.test(linie) || linie === 'FEX' || /^\d+$/.test(linie)))
      ? `<img src="${getTrainSVG(linie)}" alt="${linie}" style="height: 2vh; width: auto;" onerror="this.outerHTML='<div style=\\'padding: 0.5vh 1vw; background: rgba(255,255,255,0.2); border-radius: 2px; font-weight: bold; font-size: 2vh;\\'>${linie}</div>'">`
      : `<div style="padding: 0.5vh 1vw; background: rgba(255,255,255,0.2); border-radius: 2px; font-weight: bold; font-size: 2vh;">${linie}</div>`;
    
    return `
      <button class="line-picker-option" data-linie="${linie}" data-beschreibung="${beschreibung}" style="
        width: 100%;
        padding: 1vh 3vw;
        margin: 1vh 0;
        background: rgba(255, 255, 255, 0.1);
        border: 0.3px solid rgba(255, 255, 255, 0.2);
        border-radius: 3px;
        color: white;
        font-size: 2.5vh;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 2vw;
        transition: background 0.2s;
      ">
        ${iconHTML}
        <span style="flex: 1; text-align: left; color: rgba(255, 255, 255, 0.8);">${beschreibung}</span>
      </button>
    `;
  },

  /**
   * Create line picker overlay (mobile)
   */
  linePickerOverlay() {
    const lineOptions = [
      { linie: 'S1', beschreibung: 'Pause' },
      { linie: 'S2', beschreibung: 'Vorbereitung' },
      { linie: 'S3', beschreibung: 'Kreativität' },
      { linie: 'S4', beschreibung: "Girls' Night Out" },
      { linie: 'S45', beschreibung: 'FLURUS' },
      { linie: 'S46', beschreibung: 'Fachschaftsarbeit' },
      { linie: 'S5', beschreibung: 'Sport' },
      { linie: 'S6', beschreibung: 'Lehrveranstaltung' },
      { linie: 'S60', beschreibung: 'Vortragsübung' },
      { linie: 'S62', beschreibung: 'Tutorium' },
      { linie: 'S7', beschreibung: 'Selbststudium' },
      { linie: 'S8', beschreibung: 'Reise' },
      { linie: 'S85', beschreibung: 'Reise' },
      { linie: 'FEX', beschreibung: 'Wichtig ' }
    ];

    const optionsHTML = lineOptions.map(opt => this.linePickerOption(opt.linie, opt.beschreibung)).join('');

    return `
      <div class="line-picker-overlay" style="
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        z-index: 5002;
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <div class="line-picker-dropdown" style="
          background: #1a1f4d;
          border-radius: 8px;
          padding: 2vh;
          width: 70vw;
          max-height: 70vh;
          overflow-y: auto;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
          scrollbar-width: none;
        ">
          <div style="
            font-size: 3vh;
            font-weight: bold;
            color: white;
            margin-bottom: 2vh;
            text-align: center;
          ">Linie auswählen</div>
          ${optionsHTML}
        </div>
      </div>
    `;
  },

  /**
   * Create mobile line picker button (when no line selected)
   */
  mobileLinePickerButton() {
    return `
      <button class="mobile-line-picker-button" style="
        background: rgba(255, 255, 255, 0.1);
        border: 2px dashed rgba(255, 255, 255, 0.3);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.7);
        padding: 2vh 4vw;
        font-size: 2.5vh;
        cursor: pointer;
        width: 100%;
        text-align: center;
        margin: 1vh 0;
      ">Linie auswählen</button>
    `;
  },

  /**
   * Create line badge for focus mode (when line icon fails to load or is not an S-Bahn)
   */
  lineBadge(linie, isEditable, fontSize = 'clamp(18px, 5vh, 40px)') {
    const editableAttrs = isEditable 
      ? `data-editable="true" style="cursor: pointer; font-size: ${fontSize};"` 
      : `style="font-size: ${fontSize};"`;
    
    return `
      <div class="line-badge" 
           data-field="linie" 
           data-value="${linie || ''}" 
           data-input-type="text" 
           data-placeholder="Linie" 
           ${editableAttrs}>
        ${linie || ''}
      </div>
    `;
  },

  /**
   * Create DB API badge indicator
   */
  dbApiBadge() {
    return `
      <div style="position: absolute; top: 1vh; right: 1vw; font-size: 1.5vh; color: rgba(255,255,255,0.5); background: rgba(0,0,0,0.3); padding: 0.5vh 1vw; border-radius: 2px;">
        DB API - Nur Lesen
      </div>
    `;
  },

  /**
   * Create fixed schedule badge indicator
   */
  fixedScheduleBadge() {
    return `
      <div style="position: absolute; top: 1vh; right: 1vw; font-size: 1.5vh; color: rgba(255,200,100,0.8); background: rgba(100,60,0,0.4); padding: 0.5vh 1vw; border-radius: 2px; border: 1px solid rgba(255,200,100,0.3);" title="Datum kann nicht bearbeitet werden - dieser Termin wiederholt sich wöchentlich">
        🔒 Wiederholender Termin
      </div>
    `;
  },

  /**
   * Create mobile DB API badge
   */
  mobileDbApiBadge() {
    return `
      <div class="mobile-train-badge" style="position: fixed; top: 3vh; right: 2vw; font-size: 1.8vh; color: rgba(255,255,255,0.6); background: rgba(0,0,0,0.4); padding: 0.5vh 2vw; border-radius: 4px; z-index: 5001;">
        DB API - Nur Lesen
      </div>
    `;
  },

  /**
   * Create mobile fixed schedule badge
   */
  mobileFixedScheduleBadge() {
    return `
      <div class="mobile-train-badge" style="position: fixed; top: 3vh; right: 2vw; font-size: 1.8vh; color: rgba(255,200,100,0.9); background: rgba(100,60,0,0.5); padding: 0.5vh 2vw; border-radius: 4px; border: 0.5px solid rgba(255,200,100,0.4); z-index: 5001;">
        🔒 Wiederholender Termin
      </div>
    `;
  },

  /**
   * Create pagination dots for announcement carousel
   */
  paginationDots(totalPages, currentPage) {
    let dotsHTML = '';
    for (let i = 0; i < totalPages; i++) {
      const activeClass = i === currentPage ? ' active' : '';
      dotsHTML += `<div class="pagination-dot${activeClass}"></div>`;
    }
    return `<div class="pagination-dots">${dotsHTML}</div>`;
  },

  /**
   * Create station search suggestion item
   */
  stationSuggestion(station) {
    const label = station.ds100 ? `${station.name} (${station.ds100})` : station.name;
    return `
      <div class="suggestion-item" title="${label}">
        ${label}
      </div>
    `;
  },

  /**
   * Create mobile announcement card
   */
  mobileAnnouncementCard(announcement) {
    // Determine colors and background based on announcement type
    let stripeColor = 'rgba(255, 255, 255, 0.3)';
    let headingColor = 'white';
    let backgroundColor = 'rgba(30, 35, 95, 0.6)';
    let borderColor = 'rgba(255, 255, 255, 0.15)';
    let headingText = '';
    
    switch(announcement.announcementType) {
      case 'cancelled':
        stripeColor = '#ff4444';
        headingColor = '#ff4444';
        backgroundColor = 'rgba(80, 20, 20, 0.4)';
        borderColor = 'rgba(255, 68, 68, 0.3)';
        headingText = '✕ Zug fällt aus';
        break;
      case 'delayed':
        stripeColor = '#ffaa00';
        headingColor = '#ffaa00';
        backgroundColor = 'rgba(80, 60, 0, 0.4)';
        borderColor = 'rgba(255, 170, 0, 0.3)';
        headingText = '⚠︎ Verspätung';
        break;
      case 'zusatzfahrt':
        stripeColor = '#00aaff';
        headingColor = '#00aaff';
        backgroundColor = 'rgba(0, 60, 100, 0.4)';
        borderColor = 'rgba(0, 170, 255, 0.3)';
        headingText = '⇄ Ersatzfahrt';
        break;
      case 'ersatzfahrt':
        stripeColor = '#00aaff';2
        headingColor = '#00aaff';
        backgroundColor = 'rgba(0, 60, 100, 0.4)';
        borderColor = 'rgba(0, 170, 255, 0.3)';
        headingText = '⇄ Ersatzfahrt';
        break;
      case 'konflikt':
        stripeColor = '#ff4444';
        headingColor = '#ff4444';
        backgroundColor = 'rgba(80, 20, 20, 0.4)';
        borderColor = 'rgba(255, 68, 68, 0.3)';
        headingText = '⚠︎ Konflikt';
        break;
      case 'note':
        stripeColor = '#ffffff';
        headingColor = 'white';
        backgroundColor = 'rgba(50, 55, 115, 0.5)';
        borderColor = 'rgba(255, 255, 255, 0.2)';
        headingText = announcement.ziel || 'Ankündigung';
        break;
    }
    
    // For non-note types, add train info to heading
    if (announcement.announcementType !== 'note') {
      if (announcement.linie) {
        headingText += ' · ' + announcement.linie;
      }
      if (announcement.ziel) {
        headingText += ' → ' + announcement.ziel.replace('[ZF] ', '');
      }
      if (announcement.plan) {
        headingText += ' (' + announcement.plan + ')';
      }
    }
    
    // Get preview text
    let previewText = 'Für Details antippen';
    if (announcement.zwischenhalte && announcement.zwischenhalte.length > 0) {
      const stops = Array.isArray(announcement.zwischenhalte) 
        ? announcement.zwischenhalte 
        : announcement.zwischenhalte.split('\n');
      const stopsText = stops.filter(s => s.trim()).join(', ');
      if (stopsText) previewText = stopsText;
    }
    
    return `
      <div class="mobile-announcement-card" 
           data-unique-id="${announcement._uniqueId || ''}"
           style="
             display: flex;
             margin: 1.5vh 2vw;
             background: ${backgroundColor};
             border: 1px solid ${borderColor};
             border-radius: 8px;
             overflow: hidden;
             cursor: pointer;
             box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
             transition: transform 0.2s, box-shadow 0.2s;
             min-height: 10vh;
           ">
        <div style="
          width: 1vw;
          min-width: 4px;
          background: ${stripeColor};
          flex-shrink: 0;
        "></div>
        <div style="
          flex: 1;
          padding: 2vh 3vw;
          display: flex;
          flex-direction: column;
          gap: 1vh;
        ">
          <div style="
            color: ${headingColor};
            font-weight: bold;
            font-size: 2.2vh;
            line-height: 1.3;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          ">${headingText}</div>
          <div style="
            color: rgba(255, 255, 255, 0.8);
            font-size: 1.8vh;
            line-height: 1.5;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
          ">${previewText}</div>
        </div>
      </div>
    `;
  },

  /**
   * Create mobile announcements empty state
   */
  mobileNoAnnouncements() {
    return `
      <div style="
        color: rgba(255, 255, 255, 0.5);
        text-align: center;
        padding: 4vh 0;
        font-size: 2.5vh;
      ">Keine Ankündigungen vorhanden</div>
    `;
  },

  /**
   * Create line picker cancel button
   */
  linePickerCancelButton() {
    return `
      <button style="
        width: 100%;
        margin-top: 1vh;
        padding: 1vh;
        background: rgba(255, 100, 100, 0.3);
        border: none;
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.6);
        font-size: 2vh;
        cursor: pointer;
      ">Abbrechen</button>
    `;
  }
};

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Templates;
}
