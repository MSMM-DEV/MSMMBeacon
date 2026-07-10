// Detect a failed dynamic import() of a lazily-loaded chunk (exceljs for the
// Excel exports, jspdf for the PDF exports).
//
// After a deploy replaces the content-hashed chunk files, a tab that has been
// open since before the deploy still references the OLD chunk URL. When the
// user triggers a lazy import, the server no longer has that file and the SPA
// rewrite returns index.html — so the browser rejects it ("Expected a
// JavaScript module but the server responded with MIME type text/html") or the
// fetch fails outright. This is a version-skew signal: the fix is to reload and
// pick up the current build, not to show a raw "export failed" error.
export function isChunkLoadError(err) {
  const msg = String((err && (err.message || err)) || "");
  return /dynamically imported module|module script|importing a module script failed|MIME type|ChunkLoadError|Loading chunk\s+\S+\s+failed|error loading dynamically imported/i.test(msg);
}
