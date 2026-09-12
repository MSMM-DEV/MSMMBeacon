# Events & Other — page design

## Purpose and user tasks
The shared relationship calendar records meetings, partner touchpoints, conferences, and other events independently of the project pipeline. Users need to identify the event, understand when it occurs, see who is attending, distinguish cancelled and completed events, and keep notes or reminders. Outlook owns synced titles, times, and attendees; the redesign must communicate this authority without making those fields look editable.

## Information and action hierarchy
1. Event title and date/time are the primary scanning anchors.
2. Type and status explain the event; attendees provide participation context.
3. Details and reminder actions remain consistently visible at the row edge. Rating and notes remain available through existing table controls.
4. Calendar period navigation sits next to its date heading; view selection is distinct from secondary calendar-key and sync actions.
5. Agenda provides a readable alternative to spatial calendar density and is the default presentation on phones. Full names wrap in list and agenda contexts; timed slots retain the full-title disclosure.

## Composition
The event register uses a clean white/graphite work surface, a quiet introductory strip, identity-first columns, wrapped names and visible row actions. The calendar uses a stronger date heading, grouped period controls, a polished neutral grid, restrained category rails, and a readable agenda mode on desktop as well as mobile. Both share the cobalt focus and selection treatment from MASTER.md. Glass is confined to light surface chrome; working content remains opaque and high contrast.

## Interaction and accessibility
Keep existing sorting, filtering, column customization, inline editors, drawer, reminder handlers, date calculations and Outlook sync intact. Use 44px mobile controls, readable text, keyboard labels, and reduced-motion overrides. Type and status are named, never conveyed only by color. Reflow toolbar groups rather than clipping controls. Scope wide-grid scrolling to the grid.

## Implementation
Owned boundaries: EventsTable in tables.jsx; events-calendar.jsx; design/pages/events.css. No backend, API, data-layer, dependency or mutation changes.
