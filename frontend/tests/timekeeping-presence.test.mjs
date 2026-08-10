import assert from "node:assert/strict";
import test from "node:test";

import {
  PRESENCE_IN,
  PRESENCE_NONE,
  PRESENCE_OUT,
  inSince,
  livePresence,
  openIntervalOf,
} from "../src/timekeeping-presence.js";

const at = (h, m = 0) => new Date(2026, 7, 10, h, m, 0, 0).toISOString();
const iv = (startH, endH, isOut = false) => ({
  id: `${startH}-${endH ?? "open"}${isOut ? "-out" : ""}`,
  startAt: at(startH),
  endAt: endH == null ? null : at(endH),
  isOut,
});

test("a normal day at your desk reads as in", () => {
  const day = [iv(8, 12), iv(12, 13, true), iv(13, null)];
  assert.equal(livePresence(day), PRESENCE_IN);
  assert.equal(inSince(day), at(13));
});

test("punched out for lunch reads as out, not as in and not as absent", () => {
  const day = [iv(8, 12), iv(12, null, true)];
  assert.equal(livePresence(day), PRESENCE_OUT);
  assert.equal(inSince(day), null);
});

test("punched out at the end of the day still reads as out", () => {
  // The end-of-day OUT punch opens an OUT interval that stays open, so "gone
  // home" and "at lunch" are the same state as far as presence goes.
  const day = [iv(8, 12), iv(12, 13, true), iv(13, 17), iv(17, null, true)];
  assert.equal(livePresence(day), PRESENCE_OUT);
});

test("never punched is 'none' — NOT out", () => {
  // The distinction the In/Out filter got wrong: somebody who has not punched
  // never went out, and must not be counted among people who are out.
  assert.equal(livePresence([]), PRESENCE_NONE);
  assert.equal(livePresence(null), PRESENCE_NONE);
  assert.equal(livePresence(undefined), PRESENCE_NONE);
  assert.equal(inSince([]), null);
});

test("a fully closed day is 'none' — everything ended, nothing is running", () => {
  const day = [iv(8, 12), iv(12, 13, true), iv(13, 17)];
  assert.equal(livePresence(day), PRESENCE_NONE);
  assert.equal(inSince(day), null);
});

// ---------------------------------------------------------------------------
// The regression. A stale unclosed OUT sitting BEFORE a live IN is what made
// one person show an "In" chip on their row while the filter bucketed them
// under Out. Two rules for one fact; there is now one.
// ---------------------------------------------------------------------------
test("a stale unclosed OUT before a live IN reads as IN — the latest punch wins", () => {
  const day = [iv(8, null, true), iv(9, null)];   // both open, OUT first
  assert.equal(livePresence(day), PRESENCE_IN, "the person is at their desk");
  assert.equal(inSince(day), at(9));
  // The old filter rule — first open interval of any direction — said "out".
  assert.notEqual(day.find(i => !i.endAt).isOut, false === true);
  assert.equal(day.find(i => !i.endAt).isOut, true, "…which is why it was wrong");
});

test("a stale unclosed IN before a live OUT reads as OUT — same rule, other way", () => {
  const day = [iv(8, null), iv(12, null, true)];  // both open, IN first
  assert.equal(livePresence(day), PRESENCE_OUT);
  assert.equal(inSince(day), null);
  // The old chip rule — any open IN — said "In since 8:00". Also wrong.
  assert.equal(day.find(i => !i.endAt && !i.isOut)?.startAt, at(8),
    "…which is why the chip and the filter disagreed");
});

test("the chip and the filter can no longer disagree, whatever the day looks like", () => {
  // Every arrangement of up to three intervals with any mix of open/closed and
  // in/out: `inSince` is non-null exactly when `livePresence` says in.
  const parts = [iv(8, 12), iv(8, null), iv(8, null, true), iv(12, 13, true),
                 iv(12, null, true), iv(13, null), iv(17, null, true)];
  for (const a of parts) for (const b of parts) for (const c of parts) {
    const day = [a, b, c];
    const p = livePresence(day);
    const since = inSince(day);
    assert.equal(p === PRESENCE_IN, since !== null,
      `disagreement on ${day.map(x => x.id).join(",")}: presence=${p} inSince=${since}`);
  }
});

test("order in the array does not decide the answer — the timestamp does", () => {
  const forward = [iv(8, null, true), iv(9, null)];
  const reverse = [...forward].reverse();
  assert.equal(livePresence(forward), livePresence(reverse));
  assert.equal(inSince(forward), inSince(reverse));
});

test("three open intervals: the latest still wins", () => {
  const day = [iv(8, null), iv(10, null, true), iv(14, null)];
  assert.equal(livePresence(day), PRESENCE_IN);
  assert.equal(inSince(day), at(14));
  assert.equal(openIntervalOf(day).startAt, at(14));
});

test("a malformed open interval still reports presence rather than vanishing", () => {
  // A bad timestamp must not drop somebody into "never punched" — reporting
  // their direction from a broken row beats reporting that they are absent.
  assert.equal(livePresence([{ startAt: "not-a-date", endAt: null, isOut: true }]), PRESENCE_OUT);
  assert.equal(livePresence([{ endAt: null }]), PRESENCE_IN);
  // …but a real timestamp always outranks a broken one.
  const day = [{ startAt: "not-a-date", endAt: null, isOut: true }, iv(9, null)];
  assert.equal(livePresence(day), PRESENCE_IN);
});

test("closed intervals are never the answer, however late they are", () => {
  const day = [iv(9, null, true), iv(16, 17)];
  assert.equal(livePresence(day), PRESENCE_OUT, "the closed 4pm block is not running");
  assert.equal(openIntervalOf(day).startAt, at(9));
});
