// generate-pwa-icons.mjs
//
// Rasterise public/icon-source.svg into the PNG sizes the PWA manifest +
// iOS + browsers need. Idempotent: run any time the source SVG changes.
//
// Uses @resvg/resvg-js — pure-Node SVG renderer with pre-built native
// binaries (no compilation), much lighter than `sharp`.
//
//   192x192            — Android home screen, install prompts
//   512x512            — Android splash, PWA promo
//   512x512 maskable   — Android adaptive icons (safe-zone preserved by
//                        the source SVG; rendered with extra cream padding
//                        for the cropped region's background)
//   180x180 apple      — iOS home screen ("apple-touch-icon")
//    32x32             — favicon (browser tab)
//    16x16             — small favicon (some browsers)
//
// Run:
//   npm run pwa:icons

import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const SOURCE     = path.join(PUBLIC_DIR, "icon-source.svg");

if (!fs.existsSync(SOURCE)) {
  console.error(`✗ source not found: ${SOURCE}`);
  process.exit(1);
}

const svgBuf = fs.readFileSync(SOURCE);

/** Render the source SVG at a given size, optionally with a solid background
 *  fill (used for the maskable variant so corner pixels aren't transparent). */
function rasterise(size, { background } = {}) {
  const resvg = new Resvg(svgBuf, {
    fitTo: { mode: "width", value: size },
    background: background || "transparent",
    font: { loadSystemFonts: false },   // we draw paths, not text — keep it deterministic
  });
  return resvg.render().asPng();
}

const targets = [
  { name: "icon-192.png",          size: 192 },
  { name: "icon-512.png",          size: 512 },
  // Maskable: same SVG (the design already reserves a 10% safe zone) but
  // fill the canvas edge-to-edge with terracotta so the cropped corners
  // don't reveal transparent pixels.
  { name: "icon-512-maskable.png", size: 512, background: "#C8823B" },
  { name: "apple-touch-icon.png",  size: 180 },
  { name: "favicon-32.png",        size: 32  },
  { name: "favicon-16.png",        size: 16  },
];

for (const t of targets) {
  const png = rasterise(t.size, { background: t.background });
  const out = path.join(PUBLIC_DIR, t.name);
  fs.writeFileSync(out, png);
  console.log(`✓ ${t.name.padEnd(24)} ${png.length.toString().padStart(7)} bytes`);
}

// Tiny .ico-shaped favicon — many browsers still ask for /favicon.ico by
// default. We emit the 32×32 PNG bytes under that name. Modern browsers
// happily accept a PNG with a .ico extension.
fs.copyFileSync(path.join(PUBLIC_DIR, "favicon-32.png"), path.join(PUBLIC_DIR, "favicon.ico"));
console.log("✓ favicon.ico (copy of favicon-32.png)");

console.log("\nDone. Commit the generated PNGs alongside the SVG source.");
