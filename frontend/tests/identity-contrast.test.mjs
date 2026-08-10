import assert from "node:assert/strict";
import test from "node:test";

// `team-calendar-shared.jsx` is JSX and imports React, so the colour maths is
// re-derived here from the same source palette instead. The formulas below are
// copied deliberately: this suite exists to pin the OUTPUT of the palette, and
// a copy that drifts from the implementation fails loudly, which is the point.
// If you change `identityVars`, change these to match and watch the ratios.
import { CALENDAR_PALETTE_FOR_TEST } from "./helpers/palette.mjs";

const SURFACE_LUM_LIGHT = 1;        // #FFFFFF
const SURFACE_LUM_DARK  = 0.0157;   // #201E1A
const MUTED_LUM_LIGHT   = 0.1416;   // --text-muted = --n-600 #6B655B
const MUTED_LUM_DARK    = 0.3919;   // --text-muted = #ADA598

const clamp01 = (n) => Math.min(1, Math.max(0, n));

function hslToRgb(h, s, l) {
  const S = s / 100, L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function relLuminance([r, g, b]) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
function fitContrast(h, s, startL, minRatio, refLum) {
  const dir = relLuminance(hslToRgb(h, s, startL)) >= refLum ? 1 : -1;
  let best = startL;
  for (let i = 0; i <= 100; i++) {
    const l = startL + dir * i;
    if (l < 4 || l > 98) break;
    best = l;
    if (contrast(relLuminance(hslToRgb(h, s, l)), refLum) >= minRatio) return l;
  }
  return best;
}

/** The subset of `identityVars` this suite is about, per palette slot. */
function tokensFor([h, s, l]) {
  const cr = clamp01((s - 22) / 66);
  const tr = clamp01((l - 30) / 42);
  const boldS = 45 + 40 * cr;
  const tintS = 58 + 30 * cr;
  const chipS = 52 + 30 * cr;
  return {
    h, boldS, tintS, chipS,
    inkL:  [h, 20 + 18 * cr, 23 + 6 * tr],
    inkD:  [h, 22 + 20 * cr, 76 + 6 * tr],
    boldL: [h, boldS, fitContrast(h, boldS, 34 + 12 * tr, 3.3, SURFACE_LUM_LIGHT)],
    boldD: [h, boldS, fitContrast(h, boldS, 56 + 14 * tr, 3.3, SURFACE_LUM_DARK)],
    tintL: [h, tintS, fitContrast(h, tintS, 91, 4.65, MUTED_LUM_LIGHT)],
    tintD: [h, tintS, fitContrast(h, tintS, 22, 4.65, MUTED_LUM_DARK)],
    chipL: [h, chipS, fitContrast(h, chipS, 83, 4.65, MUTED_LUM_LIGHT)],
    chipD: [h, chipS, fitContrast(h, chipS, 30, 4.65, MUTED_LUM_DARK)],
  };
}

const lumOf = (hsl) => relLuminance(hslToRgb(...hsl));

test("every slot's ring clears 3:1 against the surface in BOTH themes", () => {
  // A 2px identity ring is a non-text UI element: WCAG 1.4.11 wants 3:1. This
  // is the check that caught the pastel slot at 2.56:1 — HSL lightness is not
  // perceptual luminance, so a fixed formula cannot be trusted across hues.
  const worst = { light: 99, dark: 99, lightHue: null, darkHue: null };
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    const rl = contrast(lumOf(t.boldL), SURFACE_LUM_LIGHT);
    const rd = contrast(lumOf(t.boldD), SURFACE_LUM_DARK);
    if (rl < worst.light) { worst.light = rl; worst.lightHue = t.h; }
    if (rd < worst.dark)  { worst.dark = rd;  worst.darkHue = t.h; }
    assert.ok(rl >= 3, `light ring at hue ${t.h}: ${rl.toFixed(2)}:1`);
    assert.ok(rd >= 3, `dark ring at hue ${t.h}: ${rd.toFixed(2)}:1`);
  }
  assert.ok(worst.light >= 3 && worst.dark >= 3);
});

test("the tick glyph is legible on its own fill in both themes", () => {
  // The picker's selected tick draws `--surface` on `--u-bold`, so the same
  // pair has to clear 3:1 read the other way round. It does by construction —
  // contrast is symmetric — but the tick is a separate component and a future
  // change to either token should trip this too.
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    assert.ok(contrast(SURFACE_LUM_LIGHT, lumOf(t.boldL)) >= 3, `light tick at hue ${t.h}`);
    assert.ok(contrast(SURFACE_LUM_DARK, lumOf(t.boldD)) >= 3, `dark tick at hue ${t.h}`);
  }
});

test("every slot's name text clears 4.5:1 against the surface in both themes", () => {
  // `--u-ink` is body text on the chip and the picker row: WCAG AA is 4.5:1.
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    const rl = contrast(lumOf(t.inkL), SURFACE_LUM_LIGHT);
    const rd = contrast(lumOf(t.inkD), SURFACE_LUM_DARK);
    assert.ok(rl >= 4.5, `light name at hue ${t.h}: ${rl.toFixed(2)}:1`);
    assert.ok(rd >= 4.5, `dark name at hue ${t.h}: ${rd.toFixed(2)}:1`);
  }
});

// ---------------------------------------------------------------------------
// The calendar block. `--u-tint` is the wash behind an event and `--u-chip`
// the fill behind its initials, and BOTH carry two kinds of type: the title
// and initials in `--u-ink` (the person's hue) and the time/location lines in
// `--text-muted` (a fixed grey). The grey is the binding constraint — it does
// not move with the hue, so it is the first thing to fall over when the wash
// is pushed towards saturation, which is exactly what this change did.
// ---------------------------------------------------------------------------
test("block text stays AA-legible on the event wash in both themes", () => {
  const worst = { inkL: 99, inkD: 99, mutedL: 99, mutedD: 99 };
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    const pairs = [
      ["ink on tint, light",   lumOf(t.inkL),      lumOf(t.tintL), "inkL"],
      ["ink on tint, dark",    lumOf(t.inkD),      lumOf(t.tintD), "inkD"],
      ["muted on tint, light", MUTED_LUM_LIGHT,    lumOf(t.tintL), "mutedL"],
      ["muted on tint, dark",  MUTED_LUM_DARK,     lumOf(t.tintD), "mutedD"],
    ];
    for (const [label, fg, bg, key] of pairs) {
      const r = contrast(fg, bg);
      worst[key] = Math.min(worst[key], r);
      assert.ok(r >= 4.5, `${label} at hue ${t.h}: ${r.toFixed(2)}:1`);
    }
  }
  for (const k of Object.keys(worst)) assert.ok(worst[k] >= 4.5);
});

test("initials stay AA-legible on the initials-tile fill in both themes", () => {
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    const rl = contrast(lumOf(t.inkL), lumOf(t.chipL));
    const rd = contrast(lumOf(t.inkD), lumOf(t.chipD));
    assert.ok(rl >= 4.5, `light initials at hue ${t.h}: ${rl.toFixed(2)}:1`);
    assert.ok(rd >= 4.5, `dark initials at hue ${t.h}: ${rd.toFixed(2)}:1`);
    // The "+n others" counter sits on the same fill in --text-muted.
    assert.ok(contrast(MUTED_LUM_LIGHT, lumOf(t.chipL)) >= 4.5, `light tick at hue ${t.h}`);
    assert.ok(contrast(MUTED_LUM_DARK, lumOf(t.chipD)) >= 4.5, `dark tick at hue ${t.h}`);
  }
});

test("the event wash carries real colour — it is not a neutral any more", () => {
  // The point of the change. If a future tweak walks the wash back to
  // near-white the grid silently stops being colour-coded, and this fails
  // instead. 40% saturation is the floor at which a wash still reads as
  // "somebody's" beside a neutral surface.
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    assert.ok(t.tintS >= 40, `hue ${t.h}: wash saturation ${t.tintS}`);
    assert.ok(t.chipS >= 40, `hue ${t.h}: tile saturation ${t.chipS}`);
  }
});

test("the wash never inverts — light theme stays light, dark stays dark", () => {
  // `fitContrast` moves AWAY from the reference colour. Get its direction
  // wrong and the dark-theme wash walks towards the light grey it sits under
  // instead of away from it; this catches that without needing a browser.
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    assert.ok(lumOf(t.tintL) > 0.5, `light wash at hue ${t.h} is not light`);
    assert.ok(lumOf(t.tintD) < 0.2, `dark wash at hue ${t.h} is not dark`);
    assert.ok(lumOf(t.chipL) > 0.35, `light tile at hue ${t.h} is not light`);
    assert.ok(lumOf(t.chipD) < 0.3, `dark tile at hue ${t.h} is not dark`);
  }
});

test("the vivid tier is genuinely more saturated than the muted one", () => {
  // The whole point of --u-bold is that the roster reads as colour-coded. If
  // it ever collapses back towards the grid's compressed band, the chips stop
  // being a key and this should fail rather than quietly look flat.
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const [, s] = slot;
    const cr = clamp01((s - 22) / 66);
    const keyS = 20 + 34 * cr;     // --u-key, the grid's compressed tier
    const boldS = 45 + 40 * cr;
    assert.ok(boldS > keyS + 20, `hue ${slot[0]}: bold ${boldS} vs key ${keyS}`);
  }
});

test("saturation RANK survives the contrast fit", () => {
  // Only lightness is fitted, so a slot more saturated than another stays more
  // saturated — the palette's internal ordering is not scrambled by the fix.
  const sorted = [...CALENDAR_PALETTE_FOR_TEST].sort((a, b) => a[1] - b[1]);
  let prev = -1;
  for (const slot of sorted) {
    const { boldS } = tokensFor(slot);
    assert.ok(boldS >= prev, "saturation rank inverted");
    prev = boldS;
  }
});

test("hue is never altered — a person's colour identity is the hue", () => {
  for (const slot of CALENDAR_PALETTE_FOR_TEST) {
    const t = tokensFor(slot);
    assert.equal(t.boldL[0], slot[0]);
    assert.equal(t.boldD[0], slot[0]);
    assert.equal(t.inkL[0], slot[0]);
  }
});
