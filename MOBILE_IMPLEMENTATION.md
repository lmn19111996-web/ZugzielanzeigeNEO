# Mobile Dashboard Implementation

## Overview
The mobile.html file has been transformed into a fully functional mobile-optimized train dashboard application with touch-friendly interactions and a popup-based editing interface.

## Key Features Implemented

### 1. Mobile-Optimized Layout
- **Compact Train Entries**: Adjusted to fit 15 train entries per screen (reduced from 7.5vh to 6vh height)
- **Responsive Font Sizes**: All text elements scale appropriately for narrow screens
- **Touch-Friendly Buttons**: Larger tap targets with proper touch feedback
- **Horizontal Top Taskbar**: 
  - Add train button (+)
  - Station selection button
  - View mode toggle (list/occupancy)
  - Date selector on the right side

### 2. Focus Mode as Popup
The focus.html layout has been integrated as a full-screen popup overlay that appears when tapping on any train entry:

**Popup Features:**
- Full-screen overlay with smooth fade-in animation
- Mobile-optimized layout matching focus.html design
- Touch-editable fields for all train properties
- Action buttons in top toolbar:
  - ← Return (closes popup)
  - ✕ Cancel/Reactivate train
  - -5, +5, +10, +30 (delay adjustment)
  - 🗑 Delete train
- System back button support (Android/iOS)
- Tap outside to close

### 3. Touch-Editable Fields
All fields in the popup are tap-to-edit when viewing local schedule trains:

- **Line Number**: Tap to enter text input
- **Destination**: Tap to enter text input
- **Date**: Tap to open date picker (spontaneous entries only)
- **Arrival Time (Plan)**: Tap to open time picker
- **Actual Time**: Tap to open time picker
- **Duration**: Tap to enter number input
- **Stops**: Tap to open full-screen textarea

**Auto-save**: Changes are automatically saved when field loses focus

### 4. View Modes

**List View (Timetable)**:
- Compact train entries with line icon, destination, and departure time
- 15 entries fit on screen
- Wrapping destination text (max 2 lines)
- Day separators between dates

**Occupancy View (Belegungsplan)**:
- Vertical timeline with hourly markers
- Color-coded train blocks by S-Bahn line
- Overlap detection with 4-level indentation
- Reduced font sizes for mobile
- Current time indicator line

### 5. Train Entry Features
- **Status Indicators**:
  - Solid dot for current/occupying trains
  - X symbol for cancelled trains
- **Visual States**:
  - FEX trains: White background
  - S-Bahn trains: Color-coded by line
  - Selected train: Highlighted background
- **Delay Display**:
  - Plan time shown normally
  - Actual time in white box if delayed
  - Countdown for next train in top ribbon

### 6. Badges and Indicators
- **DB API Trains**: "DB API - Nur Lesen" badge (read-only)
- **Fixed Schedule Trains**: "🔒 Wiederholender Termin" badge (date not editable)
- Both badges appear in top-right of popup

### 7. Date Selector
- Tap on date display (top-right of taskbar)
- Opens native date picker
- Shows "Heute", "Morgen", "Gestern", or formatted date
- Future enhancement: Filter trains by selected date

### 8. Mobile-Specific Optimizations

**Typography**:
- Train entries: 3.2vh destination text
- Belegungsplan: 2.2vh for blocks, 1.6vh for markers
- Popup: 4vh destination, 3.5vh times, 2.2vh stops

**Touch Targets**:
- Minimum 7vh height for buttons
- 4vw padding for text fields
- Large tap areas for all interactive elements

**Scrolling**:
- Smooth scrolling with `-webkit-overflow-scrolling: touch`
- Hidden scrollbars for cleaner appearance
- Scroll position preservation during updates

### 9. Responsive Behavior
The app automatically detects screen width and switches between desktop and mobile modes:
- **≤768px**: Mobile mode with popup
- **>768px**: Desktop mode with side panel

## Usage Instructions

### Adding a New Train
1. Tap the "+" button in top-left taskbar
2. Popup opens with blank train form
3. Tap each field to enter information
4. Changes auto-save on blur
5. Tap "←" to close when done

### Editing an Existing Train
1. Tap any train entry in the list or occupancy view
2. Popup opens with train details
3. Tap any field to edit (local trains only)
4. Use quick delay buttons for time adjustments
5. Tap "←" or press back button to close

### Adjusting Delays
- **-5**: Subtract 5 minutes from delay
- **+5, +10, +30**: Add minutes to delay
- Actual time is automatically calculated from plan time + delay

### Cancelling/Reactivating
- Tap "✕" to cancel a train
- Shows strikethrough on all text
- Tap "✓" (green) to reactivate

### Deleting
- Tap "🗑" button
- Confirmation dialog appears
- Train is permanently removed from schedule

### Changing Date
- Tap date display in top-right
- Native date picker appears
- Select date to update display
- (Future: will filter trains to selected date)

### Switching Views
- Tap the list icon in taskbar
- Toggles between List (timetable) and Occupancy (timeline) views
- View preference is saved to localStorage

### Selecting Station
- Tap DB logo button
- Station selection overlay appears
- Search and select station
- Empty input returns to personal schedule

## Technical Details

### CSS Classes
- `.mobile-focus-popup`: Main popup overlay
- `.mobile-focus-container`: Popup content layout
- `.mobile-focus-btn`: Action buttons in popup toolbar
- `.mobile-train-badge`: Status badges (read-only, fixed schedule)

### Data Flow
1. User taps train → `renderFocusMode()` detects mobile
2. Calls `renderMobileFocusPopup(train)`
3. Populates all fields from train object
4. Attaches tap-to-edit listeners
5. On edit → Updates train object in schedule
6. Calls `saveSchedule()` → Server API
7. SSE event triggers re-render

### Browser Support
- Modern mobile browsers (Chrome, Safari, Firefox)
- iOS Safari (tested on iPhone)
- Android Chrome (tested on Android devices)
- Progressive Web App (PWA) compatible

## Future Enhancements
1. **Date Filtering**: Filter train list by selected date
2. **Swipe Gestures**: Swipe left/right to change announcement pages
3. **Pull to Refresh**: Refresh train data with pull-down gesture
4. **Offline Mode**: Cache trains for offline viewing
5. **Push Notifications**: Alerts for upcoming trains
6. **Calendar Integration**: Export trains to device calendar

## Files Modified
- `mobile.html`: Complete mobile implementation with popup and touch editing

## Dependencies
- Same as Dashboard.html (no additional dependencies)
- Uses existing SVG icons and server API
- Compatible with existing data format
