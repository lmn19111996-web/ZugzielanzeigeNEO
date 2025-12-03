# Stellung im Stundenplan - Auto-Suggestion Feature

## Overview
This feature provides intelligent time slot suggestions for tasks/trains that have a duration assigned but no specific time scheduled. It helps users quickly find available time windows in their schedule.

## How It Works

### Activation
The "Stellung im Stundenplan" button appears automatically when:
- A task is being edited (local train only)
- The task has a duration (dauer) greater than 0
- The task does NOT have a time (plan) assigned

### Location
The button replaces the time field in the top-right corner of the focus/edit panel on both:
- Desktop view (focus panel)
- Mobile view (mobile focus popup)

### User Flow
1. **Create/Edit Task**: When creating or editing a task with duration but no time
2. **Click Button**: The "Stellung im Stundenplan" button appears in place of the time
3. **View Suggestions**: Clicking the button opens an overlay showing available time slots
4. **Preview**: Click on any suggested time slot to preview the task at that position
   - The task appears in gray in the train list or occupancy plan
   - The list automatically scrolls to show the task in its suggested position
5. **Accept or Cancel**:
   - Click "Annehmen" to confirm the selected time slot
   - Click "Abbrechen" to cancel and return to editing

## Technical Implementation

### Core Functions

#### `findAvailableTimeSlots(taskDuration, maxSlots = 10)`
- Searches the next 7 days for available time windows
- Checks for conflicts with existing scheduled trains
- Returns slots in 30-minute increments
- Parameters:
  - `taskDuration`: Duration of the task in minutes
  - `maxSlots`: Maximum number of suggestions to return (default: 10)

#### `showTimeSuggestionOverlay(train)`
- Creates and displays the suggestion overlay
- Shows list of available time slots
- Handles slot selection and preview

#### `previewTaskAtTime(train, slot)`
- Temporarily assigns the suggested time to the task
- Marks the task with `_isPreview` flag for gray styling
- Re-renders the train list/occupancy plan
- Scrolls to the preview position

#### `acceptTimeSuggestion()`
- Permanently assigns the selected time to the task
- Saves the schedule
- Re-renders with final position
- Closes the overlay

#### `closeTimeSuggestionOverlay()`
- Closes the overlay
- Clears any active preview
- Resets the suggestion state

### UI Components

#### Button Styling
```css
.time-suggestion-button (Desktop)
.mobile-time-suggestion-button (Mobile)
```
- Semi-transparent background
- White border
- Hover effects
- Responsive font sizing

#### Overlay Panel
- Full-screen dark backdrop with blur effect
- Centered panel with gradient background
- Scrollable list of time slots
- Action buttons (Accept/Cancel)

#### Preview Styling
```css
.preview-train
```
- 50% opacity
- Grayscale filter (70%)
- Gray background tint
- Applied to both train list entries and occupancy plan blocks

### Data Flow

1. **State Management**:
```javascript
timeSuggestionState = {
  activeTrain: null,      // Current train being scheduled
  selectedSlot: null,     // Currently selected time slot
  isPreviewActive: false  // Whether preview is showing
}
```

2. **Preview Mechanism**:
   - Task object receives `_isPreview: true` flag
   - Template functions check for this flag
   - CSS applies gray styling to preview elements

3. **Conflict Detection**:
   - Compares proposed time slot with all scheduled trains
   - Checks for time overlap using train start and end times
   - Excludes the task being scheduled from conflict checks

### View Mode Support

The feature works seamlessly in both view modes:

#### Train List View (Zuglistenansicht)
- Shows preview train entry in chronological order
- Scrolls to position in the list
- Gray styling applied to entry

#### Occupancy Plan (Belegungsplan)
- Shows preview block at calculated vertical position
- Maintains overlap level calculations
- Gray styling applied to block
- Scrolls to time position

## Visual Design

### Color Scheme
- **Button**: `rgba(255, 255, 255, 0.15)` background with white border
- **Overlay**: Dark backdrop (`rgba(0, 0, 0, 0.7)`) with blur
- **Panel**: Gradient from `#1a1f4d` to `#161B75`
- **Preview**: Gray with 50% opacity and grayscale filter

### Typography
- Button: `clamp(12px, 1.6vh, 18px)` (Desktop), `clamp(14px, 2vh, 20px)` (Mobile)
- Title: `clamp(18px, 2.5vh, 28px)`
- Slots: `clamp(14px, 1.8vh, 20px)`

### Spacing
- Panel padding: `3vh 2vw`
- Slot gap: `1vh`
- Button gap: `1vw`

## User Experience

### Desktop
- Hover effects on all interactive elements
- Smooth transitions
- Click outside overlay to cancel
- Keyboard navigation support (inherent)

### Mobile
- Touch-optimized button sizes
- Swipe-friendly overlay
- Clear visual feedback
- Responsive layout

## Accessibility

- Semantic HTML structure
- Clear button labels
- Visual feedback on interactions
- Smooth scroll animations
- High contrast preview state

## Edge Cases Handled

1. **No Available Slots**: Shows message when no free time is found
2. **No Duration**: Button doesn't appear without valid duration
3. **Already Scheduled**: Button hidden if task has a time
4. **Fixed Schedule Trains**: Only works for editable spontaneous entries
5. **Multiple Previews**: Previous preview cleared when new one selected
6. **Overlay Closure**: Proper cleanup when closing without accepting

## Integration Points

### Modified Files
- `app.js`: Core logic and overlay functionality
- `templates.js`: Added `_isPreview` support to train entry and belegungsplan templates
- `style.css`: Preview styling classes

### Dependencies
- Existing schedule management system
- Train rendering functions (`renderTrains`, `processTrainData`)
- Time parsing utilities (`parseTime`, `formatClock`)
- Occupancy calculations (`getOccupancyEnd`)

## Future Enhancements

Potential improvements:
- Smart suggestions based on common patterns
- Multiple duration options
- Week view in suggestion panel
- Recurring time slot suggestions
- Integration with external calendar systems
- AI-powered optimal time recommendations
