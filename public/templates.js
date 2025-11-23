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
  }
};

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Templates;
}
