# Template System Refactoring

## Overview

The application previously had dynamic HTML scattered throughout `app.js` using extensive `document.createElement()` chains. This has been refactored into a clean template system.

## Architecture

### Files Structure

```
public/
├── mobile.html          # Static HTML with template definitions
├── style.css            # All styling
├── templates.js         # NEW: HTML template functions
└── app.js              # Application logic (now much cleaner)
```

## Template System (`templates.js`)

The `templates.js` module provides reusable functions that return HTML strings. Each template function:

1. **Accepts data parameters** (train objects, timestamps, configuration)
2. **Returns HTML string** ready to be inserted into DOM
3. **Handles all conditional logic** for styling and classes
4. **Uses template literals** for clean, readable HTML

### Available Templates

#### Train Display Templates

- **`Templates.trainEntry(train, now, isFirstTrain)`**
  - Creates a complete train entry for list view
  - Handles canceled trains, delays, and current status indicators
  - Automatically generates line icons with fallback to badges
  
- **`Templates.belegungsplanBlock(train, pos, overlapLevel, now)`**
  - Creates occupancy plan train blocks
  - Handles overlap indentation classes
  - Conditionally shows content based on duration (30+ minutes)

#### Layout & UI Templates

- **`Templates.daySeparator(trainDate)`**
  - Day separator with formatted date

- **`Templates.belegungsplanHourLine(markerTime, markerY, isNewDay)`**
  - Hour markers with time display
  - Special styling for midnight crossings

- **`Templates.belegungsplanDateSeparator(markerTime, markerY)`**
  - Date separators for occupancy timeline

- **`Templates.belegungsplanCurrentTimeLine(currentTimeY)`**
  - Current time indicator line

#### Utility Templates

- **`Templates.lineIcon(linie, className, fontSize)`**
  - Reusable line icon with fallback
  
- **`Templates.trainBadge(type, isFixed)`**
  - Badges for DB API or fixed schedule trains
  
- **`Templates.emptyState(message)`**
  - Empty state messages

## Usage Pattern

### Before (Old Code)
```javascript
const entry = document.createElement('div');
entry.className = 'train-entry';
entry.dataset.linie = train.linie || '';
// ... 50+ more lines of DOM manipulation
```

### After (New Code)
```javascript
const htmlString = Templates.trainEntry(train, now, isFirstTrain);
const template = document.createElement('template');
template.innerHTML = htmlString.trim();
const entry = template.content.firstChild;
// Add event listeners
```

## Benefits

### 1. **Readability**
- HTML structure is visible and understandable
- No nested createElement chains
- Clear separation of concerns

### 2. **Maintainability**
- Changes to HTML are localized in templates.js
- Easy to update styling or structure
- Reusable across different contexts

### 3. **Performance**
- Browser-native HTML parsing
- Fewer function calls
- Cleaner memory management

### 4. **Testability**
- Templates can be tested independently
- Mock data injection is straightforward
- HTML output is inspectable

## Migration Strategy

The refactoring was done incrementally:

1. ✅ Created `templates.js` with all template functions
2. ✅ Updated `mobile.html` to load templates.js before app.js
3. ✅ Refactored `createTrainEntry()` function
4. ✅ Refactored `renderBelegungsplan()` train blocks
5. ✅ Refactored day separators in `renderTrainList()`
6. ✅ Refactored Belegungsplan hour lines and markers

## Future Enhancements

Additional templates that could be created:

- Focus mode panel content (currently uses `<template>` tag in HTML)
- Announcement panels
- Conflict resolution UI
- Mobile popup content
- Station selection overlay

## Code Quality Improvements

### Removed Code Smell
- ❌ 100+ line functions with nested DOM creation
- ❌ Repetitive createElement/appendChild patterns
- ❌ Mixed logic and presentation

### Added Best Practices
- ✅ Single Responsibility Principle
- ✅ DRY (Don't Repeat Yourself)
- ✅ Template literal usage
- ✅ Functional composition

## Testing Recommendations

After this refactor, verify:

1. **Train list view** displays correctly
2. **Belegungsplan (occupancy) view** renders all blocks
3. **Day separators** appear at correct positions
4. **Hour markers** align with time blocks
5. **Click handlers** still work for focus mode
6. **Mobile view** continues to function
7. **Canceled trains** display with strikethrough
8. **Current train indicators** show correctly

## Notes

- The existing `<template>` tags in `mobile.html` (focus-template, announcement-template, etc.) are still used for complex components that require extensive DOM manipulation after creation
- Templates.js is loaded **before** app.js to ensure functions are available
- All helper functions (formatClock, parseTime, getTrainSVG, etc.) must remain in app.js as they're used by templates
