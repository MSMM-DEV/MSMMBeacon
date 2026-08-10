// Team Calendar — primitives shared by both calendar layouts.
//
// The page offers two ways of drawing the same loaded events (see
// `CAL_LAYOUTS` in team-calendar.jsx): the traditional time grid and the
// people-lane views. Everything in here is used by both, so it lives in its
// own module rather than in either one, which keeps the two layout files from
// importing each other.
//
// Nothing here fetches, stores or derives new data. It is per-person colour,
// two formatters and a tile.
// ---------------------------------------------------------------------------

import React from "react";
import { userColorTokens } from "./data.js";

// Placeholder for a value the row genuinely does not carry. An en dash, not
// an em dash.
export const EMPTY = "–";

// ---------------------------------------------------------------------------
// Per-person identity colour.
//
// WHICH palette slot a person gets is decided in data.js (`userColorTokens`,
// rotated per department) and is not touched here. What that slot RENDERS AS
// is decided here.
//
// The projection keeps the slot's HUE exactly — the hue is the person's
// identity and nothing below ever moves it — and keeps its *rank* on the
// other two axes: a slot more saturated than its neighbours stays more
// saturated, a darker slot stays darker. Only the absolute values are
// re-fitted, and only ever along lightness.
//
// The palette runs at two strengths, and which one a surface gets is a
// judgement about how many instances of it are on screen at once:
//
//   --u-tint / --u-chip / --u-key   the calendar block: its wash, its
//     initials tile, its outline. A week can hold a hundred blocks, so these
//     were once near-neutral. The density cap (calendar-density.js) bounded a
//     slot at about five drawn blocks, which is what made it safe to let the
//     wash carry real colour — a request, and a reasonable one: a calendar
//     colour-coded per person is only useful if you can see the colour.
//
//   --u-bold                        the roster chips and picker rows, and the
//     block's 3px identity rule. One instance per person, or one hairline, so
//     this runs at close to the palette's real saturation.
//
// Every lightness above is FITTED against the type or surface it has to work
// with rather than chosen — see `fitContrast` — so the whole palette is
// provably legible instead of mostly legible. The live floors, measured
// across every slot in both themes, are pinned by
// `tests/identity-contrast.test.mjs`; read them there rather than trusting a
// number in a comment that nothing checks.
//
// Five values are emitted per theme; `.bxtc-ident` in styles.css picks the
// matching pair, so nothing downstream needs a `dark:` variant.
// ---------------------------------------------------------------------------
export const IDENT = "bxtc-ident";

// `userColorTokens().stripe` is the slot's raw `hsl(H S% L%)`. Hue also comes
// back on its own; saturation and lightness are only available through this
// string, so a parse failure falls back to mid chroma and mid tone, which
// still leaves the hue doing the separating.
const SLOT_HSL_RE = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const hslStr = (h, s, l) =>
  `hsl(${h} ${Math.round(s * 10) / 10}% ${Math.round(l * 10) / 10}%)`;

// ---------------------------------------------------------------------------
// Contrast-fitting the vivid tier.
//
// HSL lightness is NOT perceptual luminance, and across a 24-hue palette the
// gap is enormous: hsl(60 65% 45%) — a mid olive — is more than twice as
// bright as hsl(240 65% 45%) at the identical L. So any fixed L formula
// produces rings that are comfortably dark at one hue and invisible at
// another; measured against white, the pastel slot in this palette came out
// at 2.56:1 where a non-text UI element needs 3:1.
//
// So the vivid tier is FITTED rather than computed: pick the hue and
// saturation, then walk the lightness until the colour actually clears the
// ratio against the surface it will sit on. Slow-looking, but it is a dozen
// integer steps over 24 slots, memoised by `userColorTokens`' own caller, and
// it is the difference between "usually accessible" and "provably".
// ---------------------------------------------------------------------------

// The surfaces and inks the fit is measured against. Hard-coded because they
// are design tokens and this runs where computed styles are not available;
// `tests/identity-contrast.test.mjs` re-derives the same numbers, so a token
// change that invalidates them fails the suite rather than dimming the UI.
//   --surface     = --n-0 (#FFFFFF) light, #201E1A dark
//   --text-muted  = --n-600 (#6B655B) light, #ADA598 dark
const SURFACE_LUM_LIGHT = 1;          // #FFFFFF
const SURFACE_LUM_DARK  = 0.0157;     // #201E1A
const MUTED_LUM_LIGHT   = 0.1416;     // #6B655B
const MUTED_LUM_DARK    = 0.3919;     // #ADA598

function hslToRgb(h, s, l) {
  const S = s / 100, L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
// WCAG relative luminance. Channels arrive already in 0–1.
function relLuminance([r, g, b]) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(lumA, lumB) {
  const hi = Math.max(lumA, lumB), lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The hue at `s`, moved along L until it clears `minRatio` against a reference
 * colour of luminance `refLum`.
 *
 * The direction is derived from which SIDE of the reference the starting
 * colour is already on, not from whether the reference is light — "away from
 * the reference" is the only rule that holds for all four uses here: a dark
 * ring on a white surface (darken), a light ring on a dark surface (lighten),
 * a pale wash under dark grey text (lighten), and a deep wash under light
 * grey text (darken). Keying off an absolute threshold gets the last one
 * backwards and quietly makes dark-theme blocks LESS readable.
 *
 * Returns the closest it got if the hue cannot reach the ratio at all, which
 * for this palette never happens — the contrast suite pins that.
 */
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

export function identityVars(userId) {
  const c = userColorTokens(userId);
  const m = SLOT_HSL_RE.exec(c.stripe || "");
  const h = m ? Number(m[1]) : (c.hue ?? 0);
  const s = m ? Number(m[2]) : 55;
  const l = m ? Number(m[3]) : 48;
  // Rank of this slot within the source palette's own range (S 22–88, L 30–72).
  const cr = clamp01((s - 22) / 66);
  const tr = clamp01((l - 30) / 42);
  // Saturation for the vivid tier. Kept out of the fitting loop below so only
  // ONE axis moves: a slot that is more saturated than its neighbour stays
  // more saturated whatever the contrast fit does to its lightness.
  const boldS = 45 + 40 * cr;

  // The block wash and the initials-tile fill, at the saturation the grid now
  // gets to carry. They used to be near-neutral (S 30–52 at L96) because a
  // crowded slot drew twenty of them at once and twenty saturated washes is a
  // paint chart; the density cap means a slot draws about five, so the wash
  // can do real identity work.
  //
  // Their LIGHTNESS is fitted, not chosen, and the binding constraint is not
  // the hue-coloured type on them — it is `--text-muted`, a fixed grey, which
  // the block's time and location lines use. Push the wash darker and that
  // grey is the first thing to fall under 4.5:1, so the fit walks the wash
  // back towards the surface until it clears. Saturation is untouched, so a
  // slot that is more saturated than its neighbour stays that way.
  const tintS = 58 + 30 * cr;
  const chipS = 52 + 30 * cr;
  const mutedLum = { l: MUTED_LUM_LIGHT, d: MUTED_LUM_DARK };
  return {
    "--u-key-l":  hslStr(h, 20 + 34 * cr, 29 + 17 * tr),
    "--u-key-d":  hslStr(h, 22 + 30 * cr, 54 + 15 * tr),
    "--u-ink-l":  hslStr(h, 20 + 18 * cr, 23 + 6 * tr),
    "--u-ink-d":  hslStr(h, 22 + 20 * cr, 76 + 6 * tr),
    "--u-tint-l": hslStr(h, tintS, fitContrast(h, tintS, 91, 4.65, mutedLum.l)),
    "--u-tint-d": hslStr(h, tintS, fitContrast(h, tintS, 22, 4.65, mutedLum.d)),
    "--u-chip-l": hslStr(h, chipS, fitContrast(h, chipS, 83, 4.65, mutedLum.l)),
    "--u-chip-d": hslStr(h, chipS, fitContrast(h, chipS, 30, 4.65, mutedLum.d)),
    // --u-bold: the slot at close to its real saturation, for the surfaces
    // where identity is the POINT rather than a side-note — the roster chips
    // and the picker rows, where there is one instance per person and colour
    // is what you came to read. Everything above stays compressed, because
    // the grid still has to hold a hundred blocks at once.
    //
    // Two jobs, and the stricter one sets the target: it is a 2px ring (a
    // non-text UI element, 3:1) AND the fill behind the picker's tick glyph
    // (also 3:1, with `--surface` as the glyph). 3.2 gives both a little air
    // against rounding. The lightness is fitted rather than assumed — see
    // `fitContrast` — so every slot in the palette clears it, not most.
    "--u-bold-l": hslStr(h, boldS, fitContrast(h, boldS, 34 + 12 * tr, 3.3, SURFACE_LUM_LIGHT)),
    "--u-bold-d": hslStr(h, boldS, fitContrast(h, boldS, 56 + 14 * tr, 3.3, SURFACE_LUM_DARK)),
  };
}

// Someone who is not on the roster (an external attendee) gets the neutral
// surface ramp rather than a colour they do not own.
export const NEUTRAL_IDENT = {
  "--u-key-l":  "var(--border-strong)", "--u-key-d":  "var(--border-strong)",
  "--u-ink-l":  "var(--text-muted)",    "--u-ink-d":  "var(--text-muted)",
  "--u-tint-l": "var(--surface-2)",     "--u-tint-d": "var(--surface-2)",
  "--u-chip-l": "var(--surface-3)",     "--u-chip-d": "var(--surface-3)",
  "--u-bold-l": "var(--border-strong)", "--u-bold-d": "var(--border-strong)",
};

// An event whose owner is no longer on the roster still has to render. Giving
// it the neutral ramp and a real glyph is what keeps a block from coming out
// as a fully-bordered box with nothing legible inside it.
export const UNKNOWN_OWNER = "Not on the roster";

export function ownerIdentity(r) {
  const u = r?._user;
  if (u) {
    return {
      style: identityVars(r.userId),
      initials: u.initials || "?",
      name: u.name || UNKNOWN_OWNER,
    };
  }
  return { style: NEUTRAL_IDENT, initials: "?", name: UNKNOWN_OWNER };
}

/**
 * Initials tile in the owner's colour. `aria-hidden` because the owner's
 * name is always rendered (or announced) alongside it: colour is never the
 * only signal. Skin lives in `.bxtc-swatch`; only the size varies per site.
 */
export function Swatch({ initials, className = "" }) {
  return (
    <span className={`bxtc-swatch ${className}`} aria-hidden="true">
      {initials || "··"}
    </span>
  );
}

// "9am" / "9:30am". No space before the meridiem: these sit inside blocks
// measured in the tens of pixels.
export const fmtTime = (d) => {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "am" : "pm";
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, "0")}${ampm}`;
};

// How many people were INVITED to an event (resource shape). The Pass-B mirror
// stores every attendee, internal and external, in a single jsonb array.
//
// It is a headcount, not an RSVP tally, and the `+N` ticks it feeds are
// labelled "invited" for that reason: an unanswered invitation counts here
// exactly like an accepted one. Whether a given person accepted is a separate
// question with a separate answer — see attendee-status.js — and reading it
// off this number is how the two ended up disagreeing.
export function attendeeCount(r) {
  return (r?.attendees || []).filter(a => a?.email).length;
}
