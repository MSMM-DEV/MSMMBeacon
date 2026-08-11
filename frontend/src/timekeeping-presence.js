// =============================================================================
// Live presence — is this person at their desk RIGHT NOW?
//
// One rule, one place. It exists because there were two.
//
// Punch direction is the source of truth and every punch TOGGLES:
// `fn_punch_reconcile` closes the open interval and opens a fresh one of the
// opposite presence. So a person's current state is entirely decided by the
// interval that is still running:
//
//   in     the open interval's direction is IN — at their desk
//   out    the open interval's direction is OUT — at lunch, on site, or done
//          for the day
//   none   there is no open interval: they have not punched today
//
// `out` is NOT the complement of `in`. Someone who never punched never went
// out; they simply are not here, and folding them into "who is out" answers a
// question nobody asked.
//
// Why "the LATEST open interval" and not "an open interval"
// ---------------------------------------------------------------------------
// A partial unique index is supposed to make two simultaneous open intervals
// impossible, and in practice they still happen — a reconcile that half-ran, a
// punch replayed, a row edited by hand. `loadPunchState` in data.js already
// defends against exactly this ("intentionally takes the *most recent* row …
// a bug elsewhere shouldn't brick the punch button").
//
// When it happens, WHICH open interval you pick decides the answer, and the
// two callers used to pick differently: the In chip searched for any open IN
// (`find(i => !i.endAt && !i.isOut)`) while the In/Out filter took the first
// open interval of either direction. A stale unclosed OUT sitting before a
// live IN therefore showed a person with an "In" chip on their row while the
// filter counted them as Out — the same person, two answers, on one screen.
//
// The latest-starting open interval is the one the last punch created, so it
// is the person's actual state. Everything reads it from here.
//
// Pure — an array of intervals in, a string out. No React, no clock, no fetch.
// =============================================================================

export const PRESENCE_IN   = "in";
export const PRESENCE_OUT  = "out";
export const PRESENCE_NONE = "none";

/**
 * The interval that is still running: the latest-STARTING one with no end.
 * Ties on start time are broken towards the later element, so a row appended
 * after an identical-timestamp sibling wins — the same "most recent write"
 * bias `loadPunchState` uses.
 *
 * @param {Array<{startAt?: string, endAt?: string|null, isOut?: boolean}>} intervals
 * @returns {object|null}
 */
export function openIntervalOf(intervals) {
  if (!Array.isArray(intervals)) return null;
  let best = null;
  let bestStart = -Infinity;
  for (const iv of intervals) {
    if (!iv || iv.endAt) continue;
    const t = iv.startAt ? +new Date(iv.startAt) : NaN;
    // An open interval with an unparseable start still counts as open — it is
    // better to report the person's presence from a bad timestamp than to
    // silently drop them into "never punched".
    const start = Number.isNaN(t) ? -Infinity : t;
    if (best === null || start >= bestStart) {
      best = iv;
      bestStart = start;
    }
  }
  return best;
}

/**
 * 'in' | 'out' | 'none' for a day's intervals.
 * @returns {"in"|"out"|"none"}
 */
export function livePresence(intervals) {
  const open = openIntervalOf(intervals);
  if (!open) return PRESENCE_NONE;
  return open.isOut ? PRESENCE_OUT : PRESENCE_IN;
}

/**
 * ISO start of the interval a person has been AT THEIR DESK since, or null if
 * they are not currently in. Drives the "In since 1:00 PM" line, and is the
 * same decision `livePresence` makes so the chip and the filter cannot drift.
 */
export function inSince(intervals) {
  const open = openIntervalOf(intervals);
  return open && !open.isOut ? (open.startAt || null) : null;
}
