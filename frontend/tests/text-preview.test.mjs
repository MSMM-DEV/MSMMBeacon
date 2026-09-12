import test from "node:test";
import assert from "node:assert/strict";
import { textPreview } from "../src/lib/text-preview.js";

test("empty and whitespace-only details have no preview or ellipsis", () => {
  for (const value of [null, undefined, "", "  \n\t "]) {
    assert.deepEqual(textPreview(value), { text: "", truncated: false });
  }
});

test("exactly twenty words are shown without an ellipsis", () => {
  const value = Array.from({ length: 20 }, (_, i) => `word${i + 1}`).join(" ");
  assert.deepEqual(textPreview(value), { text: value, truncated: false });
});

test("long details show twenty words followed by three literal dots", () => {
  const words = Array.from({ length: 25 }, (_, i) => `word${i + 1}`);
  assert.deepEqual(textPreview(words.join(" ")), {
    text: `${words.slice(0, 20).join(" ")}...`, truncated: true,
  });
});

test("normalizes display whitespace without altering the original text", () => {
  const value = "  first\nsecond\t third   fourth  ";
  assert.deepEqual(textPreview(value, 3), { text: "first second third...", truncated: true });
  assert.equal(value, "  first\nsecond\t third   fourth  ");
});

test("a long unbroken token is one word, left for visual wrapping", () => {
  const value = "x".repeat(1000);
  assert.deepEqual(textPreview(value), { text: value, truncated: false });
});
