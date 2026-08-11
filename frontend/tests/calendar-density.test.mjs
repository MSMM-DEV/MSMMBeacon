import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCK_GAP_PX,
  BLOCK_MIN_PX,
  applyDensityCap,
  capDayConcurrency,
  clusterByOverlap,
  columnCapacity,
  dayKeyOf,
} from "../src/calendar-density.js";

// Tuesday 11 August 2026, local.
const D = (h, m = 0) => new Date(2026, 7, 11, h, m, 0, 0);
const ev = (id, sh, eh, userId = `u-${id}`) => ({
  id: String(id),
  title: `Event ${id}`,
  start: D(sh),
  end: D(eh),
  allDay: false,
  resource: { userId, _user: { id: userId, initials: String(id).slice(0, 2).toUpperCase() } },
});

const ids = (list) => list.map(e => e.id).sort();

test("capacity is how many blocks clear the legibility floor, not how many boxes fit", () => {
  // A 150px column at a 26px floor and a 2px gutter fits five.
  assert.equal(columnCapacity(150), Math.floor((150 + BLOCK_GAP_PX) / (BLOCK_MIN_PX + BLOCK_GAP_PX)));
  assert.equal(columnCapacity(150), 5);
  assert.equal(columnCapacity(28), 1);
  assert.equal(columnCapacity(10), 1);      // never zero — one block always tries
  // Unmeasured column: draw everything rather than cap against a width we do
  // not know yet.
  assert.equal(columnCapacity(0), Infinity);
  assert.equal(columnCapacity(-1), Infinity);
  assert.equal(columnCapacity(undefined), Infinity);
});

test("clusters are peak concurrency, and two events that never overlap never compete", () => {
  // 9–10, 9–10, 9–10 overlap; 11–12 is its own cluster.
  const clusters = clusterByOverlap([ev(1, 9, 10), ev(2, 9, 10), ev(3, 9, 10), ev(4, 11, 12)]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].colEnds.length, 3);
  assert.equal(clusters[1].colEnds.length, 1);
});

test("a back-to-back chain reuses ONE column", () => {
  // 9–10, 10–11, 11–12 touch but never overlap: peak concurrency is 1.
  const clusters = clusterByOverlap([ev(1, 9, 10), ev(2, 10, 11), ev(3, 11, 12)]);
  assert.equal(clusters.length, 3);
  for (const c of clusters) assert.equal(c.colEnds.length, 1);
});

test("under capacity nothing is capped and nothing is invented", () => {
  const events = [ev(1, 9, 10), ev(2, 9, 10), ev(3, 9, 10)];
  const { kept, overflow } = capDayConcurrency(events, 5);
  assert.deepEqual(ids(kept), ["1", "2", "3"]);
  assert.equal(overflow.length, 0);
});

test("over capacity: the drawn count is bounded and NOTHING is dropped", () => {
  // The screenshot case: twenty concurrent events in one column.
  const events = Array.from({ length: 20 }, (_, i) => ev(i + 1, 9, 12));
  const capacity = 5;
  const { kept, overflow } = capDayConcurrency(events, capacity);

  // capacity - 1 blocks are drawn; the last column is the band.
  assert.equal(kept.length, capacity - 1);
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].events.length, 20 - (capacity - 1));

  // Every single event is still reachable — either drawn or inside a band.
  const reachable = new Set([...kept, ...overflow.flatMap(o => o.events)].map(e => e.id));
  assert.equal(reachable.size, 20);
});

test("the total number of columns drawn never exceeds capacity", () => {
  for (const capacity of [1, 2, 3, 5, 8]) {
    for (const n of [1, 2, 5, 12, 40]) {
      const events = Array.from({ length: n }, (_, i) => ev(i + 1, 9, 12));
      const { kept, overflow } = capDayConcurrency(events, capacity);
      // Concurrent kept blocks + at most one band per run at any instant.
      const drawn = kept.length + (overflow.length > 0 ? 1 : 0);
      assert.ok(
        drawn <= Math.max(capacity, 1),
        `capacity ${capacity}, ${n} events → ${drawn} columns drawn`
      );
    }
  }
});

test("a capacity of one puts the whole cluster in a band rather than drawing a sliver", () => {
  const events = Array.from({ length: 6 }, (_, i) => ev(i + 1, 9, 12));
  const { kept, overflow } = capDayConcurrency(events, 1);
  assert.equal(kept.length, 0);
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].events.length, 6);
});

test("overflow collapses into contiguous RUNS, not one band per event", () => {
  // Ten at 9–10 and ten at 2–3pm: two separate runs, not twenty bands.
  const morning = Array.from({ length: 10 }, (_, i) => ev(`m${i}`, 9, 10));
  const afternoon = Array.from({ length: 10 }, (_, i) => ev(`a${i}`, 14, 15));
  const { overflow } = capDayConcurrency([...morning, ...afternoon], 3);
  assert.equal(overflow.length, 2);
  assert.equal(+overflow[0].start, +D(9));
  assert.equal(+overflow[0].end, +D(10));
  assert.equal(+overflow[1].start, +D(14));
  assert.equal(+overflow[1].end, +D(15));
});

test("a band spans exactly the events inside it", () => {
  const events = [
    ...Array.from({ length: 6 }, (_, i) => ev(`k${i}`, 9, 17)),
    ev("late1", 15, 16),
    ev("late2", 15, 16),
  ];
  const { overflow } = capDayConcurrency(events, 3);
  const all = overflow.flatMap(o => o.events);
  for (const o of overflow) {
    for (const e of o.events) {
      assert.ok(+e.start >= o.start && +e.end <= o.end, `${e.id} sits outside its band`);
    }
  }
  assert.ok(all.length > 0);
});

test("capping is deterministic — same input, same survivors, in any order", () => {
  const events = Array.from({ length: 15 }, (_, i) => ev(i + 1, 9, 12));
  const a = capDayConcurrency(events, 4);
  const b = capDayConcurrency([...events].reverse(), 4);
  assert.deepEqual(ids(a.kept), ids(b.kept));
  assert.deepEqual(
    a.overflow.map(o => ids(o.events)),
    b.overflow.map(o => ids(o.events))
  );
});

// ---------------------------------------------------------------------------
// The whole-list pass the calendar actually calls.
// ---------------------------------------------------------------------------
test("days are capped independently — a busy Tuesday does not hide Wednesday", () => {
  const tue = Array.from({ length: 12 }, (_, i) => ev(`t${i}`, 9, 12));
  const wed = [{ ...ev("w1", 9, 10), start: new Date(2026, 7, 12, 9), end: new Date(2026, 7, 12, 10) }];
  const out = applyDensityCap([...tue, ...wed], 4);
  const wedOut = out.filter(e => dayKeyOf(e.start) === dayKeyOf(new Date(2026, 7, 12, 0)));
  assert.equal(wedOut.length, 1);
  assert.equal(wedOut[0].id, "w1");
});

test("all-day events pass straight through — they never compete for the time column", () => {
  const allDay = { ...ev("ad", 0, 23), allDay: true };
  const busy = Array.from({ length: 12 }, (_, i) => ev(i, 9, 12));
  const out = applyDensityCap([allDay, ...busy], 3);
  assert.equal(out.filter(e => e.allDay).length, 1);
  assert.equal(out.find(e => e.allDay).id, "ad");
});

test("an unmeasured column draws everything rather than flashing content away", () => {
  const events = Array.from({ length: 20 }, (_, i) => ev(i, 9, 12));
  const out = applyDensityCap(events, columnCapacity(0));
  assert.equal(out.length, 20);
  assert.equal(out.filter(e => e.resource?._overflow).length, 0);
});

test("the band names its own count and the people inside it", () => {
  const events = Array.from({ length: 9 }, (_, i) => ev(i + 1, 9, 12, `user-${i % 3}`));
  const out = applyDensityCap(events, 3);
  const bands = out.filter(e => e.resource?._overflow);
  assert.equal(bands.length, 1);
  const band = bands[0];
  assert.equal(band.resource._count, 9 - 2);
  assert.equal(band.title, `${band.resource._count} more`);
  // Distinct owners, so "7 more" can also say how many people that is.
  assert.equal(band.resource._people, 3);
  assert.equal(band.resource._initials.length, 3);
  // It carries the events so activating it can list them.
  assert.equal(band.resource._events.length, band.resource._count);
  // And it belongs to nobody — it stands for several.
  assert.equal(band.resource.userId, undefined);
});

test("every event is drawn or inside exactly one band, never both and never neither", () => {
  const events = Array.from({ length: 30 }, (_, i) => ev(i, 8 + (i % 4), 12 + (i % 3)));
  const out = applyDensityCap(events, 4);
  const drawn = out.filter(e => !e.resource?._overflow).map(e => e.id);
  const banded = out.filter(e => e.resource?._overflow).flatMap(e => e.resource._events.map(x => x.id));
  assert.equal(new Set([...drawn, ...banded]).size, 30);
  assert.equal(drawn.length + banded.length, 30, "an event was counted twice");
});
