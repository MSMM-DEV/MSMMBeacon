import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENDA_LENGTH,
  isToday,
  isViewingToday,
  isoWindow,
  navigateDate,
  rangeLabel,
  stepNoun,
  visibleRange,
} from "../src/calendar-range.js";

// Monday 10 August 2026, local time. Every assertion below is anchored to it
// so nothing here depends on when the suite runs.
const MON = new Date(2026, 7, 10, 9, 30);
const d = (y, m, day) => new Date(y, m, day);
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

test("a chevron moves the focus date by one step of the ACTIVE view", () => {
  // The regression: the chevrons had to move the date, and the header is a
  // pure function of that date, so these two facts together are what keeps
  // the header and the grid in step.
  assert.equal(ymd(navigateDate(MON, "day", "NEXT")), "2026-08-11");
  assert.equal(ymd(navigateDate(MON, "day", "PREV")), "2026-08-09");

  assert.equal(ymd(navigateDate(MON, "week", "NEXT")), "2026-08-17");
  assert.equal(ymd(navigateDate(MON, "week", "PREV")), "2026-08-03");

  assert.equal(ymd(navigateDate(MON, "month", "NEXT")), "2026-09-10");
  assert.equal(ymd(navigateDate(MON, "month", "PREV")), "2026-07-10");

  assert.equal(ymd(navigateDate(MON, "agenda", "NEXT")), "2026-09-10");
  assert.equal(ymd(navigateDate(MON, "agenda", "PREV")), "2026-07-10");
});

test("stepping forward then back returns to where it started", () => {
  for (const view of ["month", "week", "day", "agenda"]) {
    const there = navigateDate(MON, view, "NEXT");
    const back = navigateDate(there, view, "PREV");
    assert.equal(ymd(back), ymd(MON), `${view} did not round-trip`);
  }
});

test("month stepping keeps working across a short month and a year boundary", () => {
  assert.equal(ymd(navigateDate(d(2026, 0, 31), "month", "NEXT")), "2026-02-28");
  assert.equal(ymd(navigateDate(d(2026, 11, 15), "month", "NEXT")), "2027-01-15");
  assert.equal(ymd(navigateDate(d(2026, 0, 15), "month", "PREV")), "2025-12-15");
});

test("Today returns to the current date from anywhere, in every view", () => {
  const now = new Date(2026, 7, 10, 16, 45);
  for (const view of ["month", "week", "day", "agenda"]) {
    const faraway = d(2019, 2, 3);
    const home = navigateDate(faraway, view, "TODAY", now);
    assert.equal(ymd(home), "2026-08-10", `${view} did not come home`);
    assert.equal(isToday(home, now), true);
    assert.equal(isViewingToday(home, view, now), true);
  }
});

test("the visible range is the range the view actually draws", () => {
  // Week: Sunday-start, matching the localizer.
  const wk = visibleRange(MON, "week");
  assert.equal(ymd(wk.start), "2026-08-09");
  assert.equal(ymd(wk.end), "2026-08-15");

  // Day: exactly the one day.
  const day = visibleRange(MON, "day");
  assert.equal(ymd(day.start), "2026-08-10");
  assert.equal(ymd(day.end), "2026-08-10");

  // Month: includes the bracketing weeks the month grid renders. August 2026
  // starts on a Saturday, so the grid opens on Sunday 26 July.
  const mo = visibleRange(MON, "month");
  assert.equal(ymd(mo.start), "2026-07-26");
  assert.equal(ymd(mo.end), "2026-09-05");

  // Agenda: `length` days forward from the focus date.
  const ag = visibleRange(MON, "agenda");
  assert.equal(ymd(ag.start), "2026-08-10");
  assert.equal(ymd(ag.end), "2026-09-09");
  // `end` is the END of the last day, so measure day starts.
  assert.equal(Math.round((+d(2026, 8, 9) - +ag.start) / 86_400_000), AGENDA_LENGTH);
});

test("the header names the range being viewed and changes on every step", () => {
  assert.equal(rangeLabel(MON, "month"), "August 2026");
  assert.equal(rangeLabel(MON, "day"), "Monday · Aug 10, 2026");
  assert.equal(rangeLabel(MON, "week"), "Aug 9 – 15, 2026");
  // A week straddling two months spells both out.
  assert.equal(rangeLabel(d(2026, 7, 31), "week"), "Aug 30 – Sep 5, 2026");
  assert.equal(rangeLabel(MON, "agenda"), "Aug 10 – Sep 9, 2026");

  // The header never says "Today" — that was the bug. Stepping away from the
  // current date must produce a different string every time.
  for (const view of ["month", "week", "day", "agenda"]) {
    const seen = new Set();
    let cursor = MON;
    for (let i = 0; i < 4; i++) {
      const label = rangeLabel(cursor, view);
      assert.ok(!/today/i.test(label), `${view} header said "${label}"`);
      seen.add(label);
      cursor = navigateDate(cursor, view, "NEXT");
    }
    assert.equal(seen.size, 4, `${view} header repeated itself while navigating`);
  }
});

test("navigating away is detectable, so the Today button can show it has work to do", () => {
  const now = MON;
  for (const view of ["month", "week", "day", "agenda"]) {
    assert.equal(isViewingToday(now, view, now), true, `${view} should start on today`);
    const away = navigateDate(navigateDate(now, view, "NEXT"), view, "NEXT");
    assert.equal(isViewingToday(away, view, now), false, `${view} still claimed to be on today`);
  }
});

test("a week away from today still contains today when today is in that week", () => {
  // Sunday and Saturday of the same week are both "viewing today" on Monday.
  assert.equal(isViewingToday(d(2026, 7, 9), "week", MON), true);
  assert.equal(isViewingToday(d(2026, 7, 15), "week", MON), true);
  assert.equal(isViewingToday(d(2026, 7, 16), "week", MON), false);
});

test("the fetch window is the same arithmetic as the visible range", () => {
  for (const view of ["month", "week", "day", "agenda"]) {
    const range = visibleRange(MON, view);
    const win = isoWindow(MON, view);
    assert.equal(win.start, range.start.toISOString());
    assert.equal(win.end, range.end.toISOString());
  }
});

test("the nav buttons can name their step", () => {
  assert.equal(stepNoun("month"), "month");
  assert.equal(stepNoun("week"), "week");
  assert.equal(stepNoun("day"), "day");
  assert.equal(stepNoun("agenda"), "30 days");
});
