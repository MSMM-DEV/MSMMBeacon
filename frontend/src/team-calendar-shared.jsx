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
// is decided here, and that is the whole point of this section: the raw slot
// is a fully-saturated hue, and twenty fully-saturated hues sharing one week
// grid is a barcode, not information.
//
// The projection below keeps the slot's hue exactly, and keeps its *rank* on
// the two other axes (a slot more saturated than its neighbours stays more
// saturated; a darker slot stays darker) but compresses both ranks into a
// narrow, deliberately dull band. The hue then only ever appears as a 3px
// rule, a small initials tile, or an all-day outline, while the event body
// sits on a near-neutral wash of the same hue.
//
// Measured across all 30 slots in both themes: --u-ink on --u-tint is 7.1:1
// at worst, --u-ink on --u-chip 5.4:1, --text-muted on --u-tint 5.1:1, and
// the --u-key rule holds 3.3:1 against whatever it sits on.
//
// Four values are emitted per theme; `.bxtc-ident` in styles.css picks the
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

export function identityVars(userId) {
  const c = userColorTokens(userId);
  const m = SLOT_HSL_RE.exec(c.stripe || "");
  const h = m ? Number(m[1]) : (c.hue ?? 0);
  const s = m ? Number(m[2]) : 55;
  const l = m ? Number(m[3]) : 48;
  // Rank of this slot within the source palette's own range (S 22–88, L 30–72).
  const cr = clamp01((s - 22) / 66);
  const tr = clamp01((l - 30) / 42);
  return {
    "--u-key-l":  hslStr(h, 20 + 34 * cr, 29 + 17 * tr),
    "--u-key-d":  hslStr(h, 22 + 30 * cr, 54 + 15 * tr),
    "--u-ink-l":  hslStr(h, 20 + 18 * cr, 23 + 6 * tr),
    "--u-ink-d":  hslStr(h, 22 + 20 * cr, 76 + 6 * tr),
    "--u-tint-l": hslStr(h, 30 + 22 * cr, 96),
    "--u-tint-d": hslStr(h, 14 + 10 * cr, 17),
    "--u-chip-l": hslStr(h, 28 + 22 * cr, 89),
    "--u-chip-d": hslStr(h, 18 + 12 * cr, 26),
  };
}

// Someone who is not on the roster (an external attendee) gets the neutral
// surface ramp rather than a colour they do not own.
export const NEUTRAL_IDENT = {
  "--u-key-l":  "var(--border-strong)", "--u-key-d":  "var(--border-strong)",
  "--u-ink-l":  "var(--text-muted)",    "--u-ink-d":  "var(--text-muted)",
  "--u-tint-l": "var(--surface-2)",     "--u-tint-d": "var(--surface-2)",
  "--u-chip-l": "var(--surface-3)",     "--u-chip-d": "var(--surface-3)",
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

// Total attendees on an event (resource shape). The Pass-B mirror stores
// every attendee, internal and external, in a single jsonb array.
export function attendeeCount(r) {
  return (r?.attendees || []).filter(a => a?.email).length;
}
