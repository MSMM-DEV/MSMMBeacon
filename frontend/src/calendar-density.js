// =============================================================================
// Team Calendar — the density cap behind the week/day grid.
//
// The problem this exists to solve
// ---------------------------------------------------------------------------
// The grid layout overlays every selected calendar into ONE day column. With
// twenty-five people on it, a Tuesday morning has fifteen or twenty concurrent
// events competing for ~150px, and no arrangement of fifteen rectangles in
// 150px is readable.
//
// The previous answer was a cascade: give every block a 26px box (enough for
// its identity rule and a two-letter monogram) and fan the boxes across the
// column so each one shows its left edge. The floor was on the wrong quantity.
// A block's box being 26px does not mean 26px of it is VISIBLE — what you see
// of block *i* is the STEP to block *i+1*, and the step is
//
//     step = (columnWidth - blockWidth) / (blocks - 1)
//
// which shrinks without bound as `blocks` grows. At twenty blocks in a 150px
// column the step is 6.5px: the 3px colour rule, a sliver of padding, and no
// room for the initials the whole scheme was built around. Twenty of those in
// a row is a barcode, which is what the grid had become.
//
// The fix
// ---------------------------------------------------------------------------
// Put the floor on the step — i.e. on what is actually seen — and accept the
// consequence: a column of width W can show at most a fixed number of blocks,
// full stop. Past that the extra events must be REPRESENTED rather than drawn,
// so this module caps each cluster at the number of columns that fit and rolls
// the remainder into "+N more" bands that open the existing day list.
//
// That is what Outlook and Google do when a slot is crowded, and it is the
// only option that keeps every event reachable: nothing is dropped, the
// overflow band states its own count, and one click lists what is inside it.
//
// Pure: events in, events out. No React, no DOM measurement — the caller
// passes the measured column width.
// =============================================================================

// The narrowest a block can be and still name its owner. Measured, not chosen:
// rendered in the roster font at --fs-2xs/700 the widest two-letter monogram
// ("WM") is 20.3px, and the block skin spends 3px on the identity rule plus
// 1px of padding — 24.3px of demand, rounded up.
export const BLOCK_MIN_PX = 26;

// Gap between evenly-divided columns.
export const BLOCK_GAP_PX = 2;

/**
 * How many blocks can sit side by side in a column of `colPx` and each still
 * clear the floor. `colPx <= 0` means "not measured yet" — the first paint,
 * before the ResizeObserver has read the grid — and returns Infinity so the
 * caller draws everything rather than capping against a width it doesn't know.
 */
export function columnCapacity(colPx) {
  if (!(colPx > 0)) return Infinity;
  return Math.max(1, Math.floor((colPx + BLOCK_GAP_PX) / (BLOCK_MIN_PX + BLOCK_GAP_PX)));
}

const startMs = (e) => +e.start;
const endMs   = (e) => Math.max(+e.end, +e.start);

/**
 * Greedy interval-graph colouring, scanned by start time — which makes the
 * greedy choice optimal, so a cluster's column count is exactly its peak
 * concurrency rather than the inflated number a naive pass produces.
 *
 * A cluster ends the moment an event starts after everything before it has
 * finished, so clusters are the natural unit to cap: two events in different
 * clusters never compete for width.
 */
export function clusterByOverlap(events) {
  const items = [...events]
    .filter(e => e && e.start != null && e.end != null)
    // Earliest first; longer of two equal starts first, so the block a
    // neighbour nests inside is the one on the left.
    //
    // Id breaks the remaining ties, and it is load-bearing rather than tidy:
    // a crowded slot is mostly events with IDENTICAL start and end, so without
    // it the column assignment — and therefore which blocks survive the cap —
    // would follow the order the rows happened to arrive in, and a refetch
    // that reordered ties would silently swap which four of twenty are drawn.
    .sort((a, b) =>
      (startMs(a) - startMs(b)) ||
      (endMs(b) - endMs(a)) ||
      String(a.id).localeCompare(String(b.id)));

  const clusters = [];
  let cur = null;
  for (const ev of items) {
    const s = startMs(ev), e = endMs(ev);
    if (!cur || s >= cur.end) {
      cur = { entries: [], colEnds: [], end: -Infinity };
      clusters.push(cur);
    }
    let col = cur.colEnds.findIndex(x => x <= s);
    if (col === -1) { col = cur.colEnds.length; cur.colEnds.push(e); }
    else cur.colEnds[col] = e;
    cur.entries.push({ event: ev, col, start: s, end: e });
    if (e > cur.end) cur.end = e;
  }
  return clusters;
}

/** Union of intervals into contiguous runs, earliest first. */
function mergeRuns(entries) {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const runs = [];
  for (const it of sorted) {
    const last = runs[runs.length - 1];
    if (last && it.start <= last.end) {
      last.end = Math.max(last.end, it.end);
      last.entries.push(it);
    } else {
      runs.push({ start: it.start, end: it.end, entries: [it] });
    }
  }
  return runs;
}

/**
 * Cap one day's events to what the column can legibly show.
 *
 * Keeps the first `capacity - 1` columns of each cluster and reserves the last
 * for the overflow band, so the drawn count never exceeds `capacity`. Which
 * events survive is decided by the greedy column assignment — i.e. by start
 * time — so it is stable across renders and independent of roster order.
 *
 * @returns {{kept: Array, overflow: Array<{start:number,end:number,events:Array}>}}
 *   `overflow` runs are the contiguous spans the hidden events cover, each
 *   carrying every event inside it. One band per run rather than one per
 *   event, because one band per event is the barcode again.
 */
export function capDayConcurrency(events, capacity) {
  if (!Array.isArray(events) || events.length === 0) return { kept: [], overflow: [] };
  if (!Number.isFinite(capacity) || capacity >= events.length) {
    return { kept: [...events], overflow: [] };
  }

  const kept = [];
  const overflowRuns = [];

  for (const cluster of clusterByOverlap(events)) {
    const cols = cluster.colEnds.length;
    if (cols <= capacity) {
      for (const it of cluster.entries) kept.push(it.event);
      continue;
    }
    // One column is spent on the band itself, so `capacity - 1` are drawn.
    // At capacity 1 there is no room for even one real block, and the whole
    // cluster becomes a band — the honest outcome for a column that narrow.
    const drawnCols = Math.max(0, capacity - 1);
    const hidden = [];
    for (const it of cluster.entries) {
      if (it.col < drawnCols) kept.push(it.event);
      else hidden.push(it);
    }
    for (const run of mergeRuns(hidden)) {
      overflowRuns.push({
        start: run.start,
        end: run.end,
        events: run.entries.map(e => e.event),
      });
    }
  }

  return { kept, overflow: overflowRuns };
}

/** Local-midnight key, so events are capped within the day they are drawn in. */
export function dayKeyOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return +d;
}

/**
 * Apply the cap across a whole event list, day by day, and return the display
 * list: the events that survived plus one synthetic event per overflow run.
 *
 * A synthetic event is a normal rbc event whose `resource._overflow` is true;
 * the block renderer draws it as a neutral "+N more" band and activating it
 * opens the day list with `resource._events`. It deliberately carries no
 * owner, because it stands for several.
 *
 * `capacity === Infinity` (column width not measured yet) returns the input
 * untouched, so the first paint draws everything and the cap lands with the
 * first measurement rather than flashing content away.
 */
export function applyDensityCap(events, capacity) {
  if (!Array.isArray(events) || events.length === 0) return [];
  if (!Number.isFinite(capacity)) return events;

  const byDay = new Map();
  for (const ev of events) {
    // All-day events live in rbc's separate header row and never compete for
    // the time column, so they are passed straight through.
    if (ev.allDay) continue;
    const key = dayKeyOf(ev.start);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const out = events.filter(e => e.allDay);
  for (const [key, dayEvents] of byDay) {
    const { kept, overflow } = capDayConcurrency(dayEvents, capacity);
    out.push(...kept);
    overflow.forEach((run, i) => {
      const owners = [];
      const seen = new Set();
      for (const e of run.events) {
        const u = e.resource?._user;
        const id = u?.id || e.resource?.userId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        owners.push(u?.initials || "?");
      }
      out.push({
        id: `overflow:${key}:${i}`,
        title: `${run.events.length} more`,
        start: new Date(run.start),
        end: new Date(run.end),
        allDay: false,
        resource: {
          _overflow: true,
          _events: run.events,
          _count: run.events.length,
          _people: owners.length,
          _initials: owners,
        },
      });
    });
  }
  return out;
}
