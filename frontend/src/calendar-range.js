// =============================================================================
// Team Calendar — the date arithmetic behind the toolbar.
//
// Why this is ours and not react-big-calendar's
// ---------------------------------------------------------------------------
// rbc renders its toolbar INSIDE `.rbc-calendar`, which on this page sits
// inside the horizontal scroller that lets a seven-column grid keep its
// minimum column width on a narrow window. So the header, the chevrons and the
// Today button scrolled sideways with the grid: scroll right to reach the
// chevrons and the date you are checking against has left the screen, which is
// what made navigation feel like it was not moving the header.
//
// The toolbar is therefore lifted out of the Calendar and driven from this
// module instead. The page's `date` state is the single source of truth: the
// chevrons move it, the header formats it, and rbc receives it as a prop. One
// value, so the header and the grid cannot disagree.
//
// `visibleRange` is also what the loader window is derived from, so "what is
// on screen", "what the header says" and "what was fetched" are all the same
// arithmetic rather than three copies of it.
//
// Pure: dates in, dates and strings out. Nothing here reads `Date.now()`
// except `isToday`/`todayIn`, which take an explicit `now` so tests can pin it.
// =============================================================================

import {
  addDays, addMonths, format,
  startOfDay, endOfDay,
  startOfMonth, endOfMonth,
  startOfWeek, endOfWeek,
  isSameDay, isSameMonth,
} from "date-fns";

// Sunday-start, matching the localizer configured in team-calendar.jsx. Both
// must agree or the header would name a different week than the grid draws.
const WEEK_OPTS = { weekStartsOn: 0 };

// rbc's agenda view shows `length` days from the focus date; the page passes
// length={30}, so a page of agenda is 31 days inclusive and stepping moves by
// a full page.
export const AGENDA_LENGTH = 30;

export const VIEWS = ["month", "week", "day", "agenda"];

/**
 * The half-open interval a view actually draws for a focus date.
 * Month includes the bracketing week's leading/trailing days, because that is
 * what the month grid renders.
 */
export function visibleRange(date, view) {
  const d = date instanceof Date ? date : new Date(date);
  switch (view) {
    case "month":
      return {
        start: startOfWeek(startOfMonth(d), WEEK_OPTS),
        end:   endOfWeek(endOfMonth(d), WEEK_OPTS),
      };
    case "week":
      return { start: startOfWeek(d, WEEK_OPTS), end: endOfWeek(d, WEEK_OPTS) };
    case "day":
      return { start: startOfDay(d), end: endOfDay(d) };
    case "agenda":
    default:
      return { start: startOfDay(d), end: endOfDay(addDays(d, AGENDA_LENGTH)) };
  }
}

/**
 * Move the focus date by one step of the active view.
 *
 * The steps are the ones the matching rbc view uses, so lifting the toolbar
 * out did not change what a chevron does: month ±1 month, week ±7 days,
 * day ±1 day, agenda ±1 agenda page.
 *
 * @param {Date} date current focus date
 * @param {"month"|"week"|"day"|"agenda"} view
 * @param {"PREV"|"NEXT"|"TODAY"} action
 * @param {Date} [now] what "today" means; injected so tests are not clock-bound
 */
export function navigateDate(date, view, action, now = new Date()) {
  if (action === "TODAY") return startOfDay(now);
  const dir = action === "PREV" ? -1 : action === "NEXT" ? 1 : 0;
  if (dir === 0) return date;
  switch (view) {
    case "month":  return addMonths(date, dir);
    case "week":   return addDays(date, 7 * dir);
    case "day":    return addDays(date, dir);
    case "agenda":
    default:       return addDays(date, (AGENDA_LENGTH + 1) * dir);
  }
}

/**
 * The header. Says the range being LOOKED AT, never the word "Today" — a
 * header that reads "Today" after three clicks of the chevron is the bug this
 * page had. Whether the range happens to contain today is a separate signal
 * (`isViewingToday` below), shown as a marker beside the date rather than
 * replacing it.
 */
export function rangeLabel(date, view) {
  const d = date instanceof Date ? date : new Date(date);
  if (view === "month") return format(d, "MMMM yyyy");
  if (view === "day")   return format(d, "EEEE · MMM d, yyyy");
  const { start, end } = visibleRange(d, view);
  if (isSameMonth(start, end)) {
    return `${format(start, "MMM d")} – ${format(end, "d, yyyy")}`;
  }
  return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
}

/** A short spoken form for the nav buttons, e.g. "Previous week". */
export function stepNoun(view) {
  return view === "month" ? "month"
    : view === "week"     ? "week"
    : view === "day"      ? "day"
    : "30 days";
}

/** Is `date` the same calendar day as `now`? */
export function isToday(date, now = new Date()) {
  return isSameDay(date, now);
}

/**
 * Does the range currently on screen contain today? Drives whether the Today
 * button is offered as an action or shown as satisfied — the button stays
 * rendered either way, so it never disappears after navigating.
 */
export function isViewingToday(date, view, now = new Date()) {
  const { start, end } = visibleRange(date, view);
  return +now >= +start && +now <= +end;
}

/** ISO window for the loader, straight off `visibleRange`. */
export function isoWindow(date, view) {
  const { start, end } = visibleRange(date, view);
  return { start: start.toISOString(), end: end.toISOString() };
}
