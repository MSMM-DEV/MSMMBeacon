import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupPreviewUrls,
  importReducer,
  initialImportState,
  replaceChunkCandidates,
  zeroCardNotice,
} from "../src/lib/business-card-import-state.js";

test("successful chunks remain when a later chunk fails", () => {
  let state = initialImportState();
  state = importReducer(state, {
    type: "chunkSucceeded",
    chunkId: "a",
    candidates: [{ sourceId: "1" }],
  });
  state = importReducer(state, { type: "chunkFailed", chunkId: "b", error: "network" });

  assert.equal(state.candidates.length, 1);
  assert.deepEqual(state.failedChunks, [{ chunkId: "b", error: "network" }]);
});

test("retry replaces only the failed chunk and keeps earlier candidates", () => {
  let state = initialImportState();
  state = importReducer(state, {
    type: "analysisStarted",
    chunks: [{ id: "a" }, { id: "b" }],
  });
  state = importReducer(state, {
    type: "chunkSucceeded",
    chunkId: "a",
    candidates: [{ sourceId: "1" }],
  });
  state = importReducer(state, { type: "chunkFailed", chunkId: "b", error: "network" });
  state = importReducer(state, {
    type: "chunkSucceeded",
    chunkId: "b",
    candidates: [{ sourceId: "2" }],
  });

  assert.deepEqual(state.candidates.map(candidate => candidate.sourceId), ["1", "2"]);
  assert.deepEqual(state.failedChunks, []);
  assert.equal(state.chunks.find(chunk => chunk.id === "a").status, "complete");
  assert.equal(state.chunks.find(chunk => chunk.id === "b").status, "complete");
});

test("cleanup revokes every unique preview URL and clears private image data", () => {
  const seen = [];
  const images = [
    { previewUrl: "blob:a", dataB64: "secret", blob: {} },
    { previewUrl: "blob:a", dataB64: "secret", blob: {} },
    { previewUrl: "blob:b", dataB64: "secret", blob: {} },
  ];

  cleanupPreviewUrls(images, url => seen.push(url));

  assert.deepEqual(seen, ["blob:a", "blob:b"]);
  assert.ok(images.every(image => image.previewUrl === null && image.dataB64 === null && image.blob === null));
});

test("completion releases image and extracted review state", () => {
  const before = {
    ...initialImportState(),
    phase: "saving",
    images: [{ previewUrl: null }],
    chunks: [{ id: "a" }],
    candidates: [{ sourceId: "1" }],
    reviewItems: [{ id: "review-1" }],
  };
  const after = importReducer(before, { type: "saveSucceeded", summary: { contacts_created: 1 } });
  assert.equal(after.phase, "complete");
  assert.deepEqual(after.images, []);
  assert.deepEqual(after.chunks, []);
  assert.deepEqual(after.candidates, []);
  assert.deepEqual(after.reviewItems, []);
  assert.equal(after.summary.contacts_created, 1);
});

test("retry candidate replacement preserves successful chunks for cross-chunk matching", () => {
  const next = replaceChunkCandidates([
    { sourceId: "kept", _chunkId: "a" },
    { sourceId: "old", _chunkId: "b" },
  ], "b", [{ sourceId: "retried", _chunkId: "b" }]);
  assert.deepEqual(next.map(candidate => candidate.sourceId), ["kept", "retried"]);
});

test("successful photos with zero detected cards are named for reviewer action", () => {
  const notice = zeroCardNotice([
    { id: "one", filename: "table.jpg" },
    { id: "two", filename: "blurry.jpg" },
  ], [{ sourceId: "one" }]);
  assert.match(notice, /blurry\.jpg/);
  assert.doesNotMatch(notice, /table\.jpg/);
});
