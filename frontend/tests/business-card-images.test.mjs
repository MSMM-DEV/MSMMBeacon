import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  validateCardFiles,
  chunkCardImages,
  releaseCardImages,
} from "../src/lib/business-card-images.js";

const source = readFileSync(new URL("../src/lib/business-card-images.js", import.meta.url), "utf8");

test("rejects unsupported and oversized inputs per file", () => {
  const result = validateCardFiles([
    { name: "card.jpg", type: "image/jpeg", size: 1000 },
    { name: "card.svg", type: "image/svg+xml", size: 1000 },
    { name: "huge.png", type: "image/png", size: 11 * 1024 * 1024 },
  ]);
  assert.deepEqual(result.accepted.map(x => x.name), ["card.jpg"]);
  assert.equal(result.rejected.length, 2);
});

test("enforces the twenty-image batch limit without losing per-file reasons", () => {
  const files = Array.from({ length: 22 }, (_, i) => ({ name: `${i}.jpg`, type: "image/jpeg", size: 1000 }));
  const result = validateCardFiles(files);
  assert.equal(result.accepted.length, 20);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].error, /20/);
});

test("chunks normalized images without crossing byte or count limits", () => {
  const images = [1, 2, 3].map(i => ({ id: `i${i}`, byteSize: 9 }));
  assert.deepEqual(chunkCardImages(images, { maxBytes: 18, maxCount: 4 }).map(c => c.length), [2, 1]);
  assert.throws(() => chunkCardImages([{ id: "large", byteSize: 19 }], { maxBytes: 18, maxCount: 4 }), /too large/i);
});

test("normalization honors phone orientation and bounds output dimensions", () => {
  assert.match(source, /imageOrientation:\s*["']from-image["']/);
  assert.match(source, /2048/);
  assert.match(source, /0\.86/);
});

test("release revokes every unique preview and discards in-memory image data", () => {
  const seen = [];
  const images = [
    { previewUrl: "blob:a", dataB64: "one", blob: {} },
    { previewUrl: "blob:a", dataB64: "two", blob: {} },
    { previewUrl: "blob:b", dataB64: "three", blob: {} },
  ];
  releaseCardImages(images, url => seen.push(url));
  assert.deepEqual(seen, ["blob:a", "blob:b"]);
  assert.equal(images.every(image => image.dataB64 == null && image.blob == null && image.previewUrl == null), true);
});
