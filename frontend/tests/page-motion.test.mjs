import test from "node:test";
import assert from "node:assert/strict";
import { playPageArrival } from "../src/lib/page-motion.js";

test("each navigation can restart the same page's arrival without remounting content", () => {
  const calls = [];
  let cancelled = 0;
  const page = { animate: (...args) => { calls.push(args); return { cancel: () => cancelled++ }; } };
  const first = playPageArrival(page, { duration: 260 });
  first();
  const second = playPageArrival(page, { duration: 260 });
  assert.equal(calls.length, 2);
  assert.equal(cancelled, 1);
  assert.equal(calls[1][0].at(-1).opacity, 1);
  assert.equal(calls[1][0].at(-1).transform, "none");
  assert.equal(calls[1][1].duration, 260);
  second();
  assert.equal(cancelled, 2);
});

test("reduced motion never starts a page animation", () => {
  const page = { animate: () => assert.fail("motion must not start") };
  assert.doesNotThrow(() => playPageArrival(page, { reducedMotion: true })());
});

test("missing pages and browsers without Web Animations leave content usable", () => {
  assert.doesNotThrow(() => playPageArrival(null)());
  assert.doesNotThrow(() => playPageArrival({})());
});
