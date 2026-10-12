import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../src/design/pages/marketing.css", import.meta.url);

test("desktop Kanban keeps its horizontal scrollbar reachable while lanes scroll", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /\.marketing-board\s*\{[^}]*height:\s*clamp\([^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
  assert.match(css, /\.marketing-lane\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.marketing-lane-cards\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
});

test("mobile Kanban returns to document scrolling", async () => {
  const css = await readFile(cssUrl, "utf8");
  const mobile = css.match(/@media \(max-width: 767px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(mobile, /\.marketing-board\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
  assert.match(mobile, /\.marketing-lane\[data-mobile-active="true"\]\s*\{[^}]*display:\s*block;[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
  assert.match(mobile, /\.marketing-lane-cards\s*\{[^}]*overflow:\s*visible;/s);
});
