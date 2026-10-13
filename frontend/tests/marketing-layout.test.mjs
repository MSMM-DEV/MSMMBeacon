import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../src/design/pages/marketing.css", import.meta.url);
const rule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
};

test("desktop Kanban: fluid columns, one horizontal scroller, no nested vertical scroll", async () => {
  const css = await readFile(cssUrl, "utf8");
  const board = rule(css, ".marketing-board");
  assert.match(board, /grid-template-columns:\s*repeat\(7,\s*minmax\(var\(--lane-min\),\s*1fr\)\)/);
  assert.match(board, /overflow-x:\s*auto/);
  assert.doesNotMatch(board, /\bheight:/, "the board must not cap its height — the page scrolls");
  // Bleed into the page gutter so edge columns / focus rings are not clipped.
  assert.match(board, /margin-inline:\s*calc\(-1 \* var\(--board-bleed\)\)/);
  assert.match(board, /scroll-padding-inline:\s*var\(--board-bleed\)/);

  for (const selector of [".marketing-lane", ".marketing-lane-cards"]) {
    const body = rule(css, selector);
    assert.ok(body, `${selector} rule exists`);
    assert.doesNotMatch(body, /overflow(-y)?:\s*(auto|scroll)/, `${selector} must not scroll`);
    assert.doesNotMatch(body, /max-height/, `${selector} must not cap its height`);
  }
});

test("mobile Kanban returns to document scrolling", async () => {
  const css = await readFile(cssUrl, "utf8");
  const mobile = css.match(/@media \(max-width: 767px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(mobile, /\.marketing-board\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
  assert.match(mobile, /\.marketing-lane\[data-mobile-active="true"\]\s*\{[^}]*display:\s*block;[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
  assert.match(mobile, /\.marketing-lane-cards\s*\{[^}]*overflow:\s*visible;/s);
});
