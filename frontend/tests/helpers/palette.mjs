// The Team Calendar's source palette, read out of `src/data.js` at test time.
//
// It is NOT copied here on purpose. The palette is hand-curated and grows when
// the roster does, and a copy would drift — the contrast suite would then be
// pinning colours nobody ships. Reading the real array means adding a slot
// with a bad hue fails the contrast test, which is the whole reason that suite
// exists.
//
// `data.js` cannot simply be imported: it constructs a Supabase client at
// module scope and pulls in `import.meta.env`. So this extracts just the
// literal, and throws loudly if the shape it expects has moved.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA_JS = fileURLToPath(new URL("../../src/data.js", import.meta.url));

function extractPalette() {
  const src = readFileSync(DATA_JS, "utf8");
  const start = src.indexOf("const CALENDAR_PALETTE = [");
  if (start === -1) {
    throw new Error("CALENDAR_PALETTE not found in src/data.js — has it been renamed or moved?");
  }
  const open = src.indexOf("[", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error("CALENDAR_PALETTE literal is unterminated in src/data.js");

  const body = src
    .slice(open, end + 1)
    .replace(/\/\/[^\n]*/g, "")      // strip the per-slot comments
    .replace(/,\s*]/g, "]");         // and the trailing comma they leave behind

  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CALENDAR_PALETTE parsed to nothing");
  }
  for (const slot of parsed) {
    if (!Array.isArray(slot) || slot.length !== 3 || slot.some(n => typeof n !== "number")) {
      throw new Error(`CALENDAR_PALETTE slot is not [h, s, l]: ${JSON.stringify(slot)}`);
    }
  }
  return parsed;
}

export const CALENDAR_PALETTE_FOR_TEST = extractPalette();
