// =============================================================================
// Attendee response status — the ONE place the Team Calendar decides what an
// attendee's RSVP is and how it is described.
//
// Why this module exists
// ---------------------------------------------------------------------------
// `beacon_v2.user_calendar_events` is a PER-MAILBOX mirror: one row per Graph
// event per mailbox. A meeting with three MSMM people on it therefore lands as
// three rows that share an `ical_uid` and a start time, and each row carries
// its own `attendees` jsonb snapshot taken from THAT mailbox's copy of the
// event.
//
// Exchange only populates an attendee's `status.response` in the copies that
// are entitled to know it: the attendee's own mailbox, and the organizer's.
// Every other copy reports `none` for that person. Live example, the RR402
// field discussion on 2026-08-10 (one meeting, three mirrored rows):
//
//   copy owned by Stephen  → SLeonard@msmmeng.com: "accepted"   GGrimes: "none"
//   copy owned by George   → SLeonard@msmmeng.com: "none"       GGrimes: "accepted"
//   copy owned by Chris    → SLeonard@msmmeng.com: "none"       GGrimes: "none"
//
// A dialog that reads only the copy belonging to the block you happened to
// click therefore says "Awaiting" for Stephen on George's block and "Accepted"
// for Stephen on Stephen's own block. Same meeting, same person, two answers.
// That is the inconsistency this module removes.
//
// The rule
// ---------------------------------------------------------------------------
// For attendee X on meeting M, the authoritative response is, in order:
//
//   1. self       — X's own mirrored copy of M. Exchange writes X's response
//                   there first and it is never stale relative to the others.
//   2. organizer  — the organizer's copy, which is the tracking copy Outlook
//                   shows in its own "Tracking" tab.
//   3. peer       — any other copy carrying an EXPLICIT response for X. Only
//                   used when neither of the above is loaded; a peer copy can
//                   lag, so it is the weakest evidence we accept.
//   4. otherwise  — "notResponded". Unknown is reported as awaiting, never
//                   upgraded.
//
// What is deliberately NOT evidence: the fact that M sits on X's calendar at
// all. An unanswered invitation still occupies the invitee's calendar, so
// presence says "invited", not "accepted", and inferring otherwise is exactly
// the bug above with the sign flipped.
//
// Everything here is pure — no React, no fetch, no dates beyond comparison —
// so `frontend/tests/attendee-status.test.mjs` can pin the whole contract.
// =============================================================================

// ----- Graph response vocabulary ------------------------------------------
// Microsoft Graph `attendee.status.response`:
//   'none' | 'organizer' | 'tentativelyAccepted' | 'accepted' | 'declined'
//            | 'notResponded'
// 'none' and 'notResponded' are the same fact ("no answer recorded") and Graph
// uses them interchangeably across API versions, so they collapse to one key.
export const RESPONSE_UNKNOWN = "notResponded";

/**
 * The canonical descriptor for every state, and the only source for the label,
 * the badge tone, the icon and the tooltip. Any surface that shows a status
 * reads it from here, which is what keeps the text, the colour and the icon
 * from ever disagreeing.
 *
 *   key     canonical Graph value
 *   label   the visible word — matched exactly by the icon and tone below
 *   tone    Beacon badge tone (sage = yes, rose = no, blue = maybe,
 *           accent = waiting, outline = not a response at all)
 *   cls     legacy `.is-*` hook kept for the CSS that already targets it
 *   icon    key into the Icon registry in icons.jsx
 *   sort    display order within an attendee group
 *   hint    the tooltip, and the sentence a screen reader gets
 */
export const RESPONSE_STATUS = {
  organizer: {
    key: "organizer", label: "Organizer", tone: "outline", cls: "is-organizer",
    icon: "userCheck", sort: 0,
    hint: "Organized this meeting — an organizer does not RSVP",
  },
  accepted: {
    key: "accepted", label: "Accepted", tone: "success", cls: "is-accepted",
    icon: "checkCircle", sort: 1,
    hint: "Accepted the invitation",
  },
  tentativelyAccepted: {
    key: "tentativelyAccepted", label: "Tentative", tone: "info", cls: "is-tentative",
    icon: "help", sort: 2,
    hint: "Accepted tentatively",
  },
  notResponded: {
    key: "notResponded", label: "Awaiting", tone: "brand", cls: "is-noresp",
    icon: "hourglass", sort: 3,
    hint: "Has not responded to the invitation yet",
  },
  declined: {
    key: "declined", label: "Declined", tone: "danger", cls: "is-declined",
    icon: "ban", sort: 4,
    hint: "Declined the invitation",
  },
};

// Graph value → canonical key. Anything unrecognised (a null, a future Graph
// value, a hand-seeded row) reads as unknown rather than being guessed at.
const RESPONSE_ALIASES = {
  none:                RESPONSE_UNKNOWN,
  notresponded:        RESPONSE_UNKNOWN,
  "not_responded":     RESPONSE_UNKNOWN,
  organizer:           "organizer",
  accepted:            "accepted",
  tentativelyaccepted: "tentativelyAccepted",
  tentative:           "tentativelyAccepted",
  declined:            "declined",
};

/** Graph value (any case, possibly null) → canonical key. */
export function normalizeResponse(raw) {
  if (!raw) return RESPONSE_UNKNOWN;
  return RESPONSE_ALIASES[String(raw).trim().toLowerCase()] || RESPONSE_UNKNOWN;
}

/**
 * The descriptor for a raw or canonical response. Total: every input returns a
 * complete descriptor, so no caller ever has to fall back to a default and
 * accidentally invent a fifth appearance.
 */
export function attendeeStatus(raw) {
  return RESPONSE_STATUS[normalizeResponse(raw)];
}

/** `true` when this response is an actual answer rather than silence. */
export function isExplicitResponse(raw) {
  const key = normalizeResponse(raw);
  return key !== RESPONSE_UNKNOWN && key !== "organizer";
}

const lower = (s) => String(s || "").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Cross-copy resolution
// ---------------------------------------------------------------------------

// Evidence strength, high wins. Mirrors the numbered rule in the banner.
const SOURCE_RANK = { self: 3, organizer: 2, peer: 1 };

/**
 * Resolve every attendee's authoritative response across all mirrored copies
 * of one meeting.
 *
 * @param {Array<{
 *   ownerEmail?: string,          // mailbox this copy was mirrored from
 *   organizer?: {email?: string},
 *   attendees?: Array<{email?: string, name?: string, response?: string}>,
 * }>} copies
 *   Every row we hold for the meeting, in any order. One copy is enough — the
 *   function then simply reports what that copy says.
 *
 * @returns {Map<string, {response: string, source: string, conflict: boolean}>}
 *   Keyed by lowercased email. `source` is which rule decided it ('self' |
 *   'organizer' | 'peer' | 'default'), kept so the UI can explain itself and
 *   so tests can assert WHY, not just what. `conflict` flags two copies of
 *   equal standing disagreeing, which should not happen and is worth seeing.
 */
export function resolveAttendeeResponses(copies) {
  const out = new Map();
  const list = Array.isArray(copies) ? copies.filter(Boolean) : [];
  if (list.length === 0) return out;

  // The organizer is a property of the meeting, not of a copy, so take the
  // first one any copy names. Copies are sorted by owner email first so the
  // choice — and every later tie-break — is independent of fetch order.
  const sorted = [...list].sort((a, b) => lower(a.ownerEmail).localeCompare(lower(b.ownerEmail)));
  const organizerEmail = lower(sorted.find(c => c.organizer?.email)?.organizer?.email);

  for (const copy of sorted) {
    const owner = lower(copy.ownerEmail);
    const copyIsOrganizers = !!owner && owner === organizerEmail;

    for (const a of copy.attendees || []) {
      const email = lower(a?.email);
      if (!email) continue;

      // The organizer is never an RSVP, whatever any copy's attendee row says
      // about them — Outlook lists the organizer among the attendees and
      // leaves their status at 'none', which would otherwise read "Awaiting".
      if (email === organizerEmail) {
        out.set(email, { response: "organizer", source: "organizer", conflict: false });
        continue;
      }

      const response = normalizeResponse(a?.response);
      const source = email === owner ? "self" : copyIsOrganizers ? "organizer" : "peer";

      // Silence from a peer copy is not evidence — that copy is not entitled
      // to the answer. Silence from the person's OWN copy is.
      if (source === "peer" && !isExplicitResponse(response)) continue;

      const prev = out.get(email);
      if (!prev || prev.source === "default") {
        out.set(email, { response, source, conflict: false });
        continue;
      }
      const rank = SOURCE_RANK[source] || 0;
      const prevRank = SOURCE_RANK[prev.source] || 0;
      if (rank > prevRank) {
        out.set(email, { response, source, conflict: false });
      } else if (rank === prevRank && prev.response !== response) {
        // Same standing, different answers. Keep the first (deterministic by
        // the sort above) and say so rather than flip-flopping per render.
        out.set(email, { ...prev, conflict: true });
      }
    }
  }

  // Anyone named by a copy but never given an explicit answer is awaiting.
  for (const copy of sorted) {
    for (const a of copy.attendees || []) {
      const email = lower(a?.email);
      if (!email || out.has(email)) continue;
      out.set(email, { response: RESPONSE_UNKNOWN, source: "default", conflict: false });
    }
  }

  return out;
}

/**
 * Apply a resolution map to one copy's attendee list, so the caller renders a
 * single reconciled roster instead of whatever the clicked copy happened to
 * hold. Attendee identity, name and type are untouched; only `response` is
 * replaced, and `_responseSource` / `_responseConflict` are attached for the
 * tooltip.
 *
 * Falls back to the row's own value when the map has nothing, which is what
 * makes this safe to call before the cross-copy fetch resolves.
 */
export function applyResolvedResponses(attendees, resolved) {
  const map = resolved instanceof Map ? resolved : new Map();
  return (Array.isArray(attendees) ? attendees : [])
    .filter(a => a?.email)
    .map(a => {
      const hit = map.get(lower(a.email));
      const response = hit ? hit.response : normalizeResponse(a.response);
      return {
        ...a,
        response,
        _responseSource: hit ? hit.source : "row",
        _responseConflict: !!hit?.conflict,
      };
    });
}

/** Group ordering: organizer, accepted, tentative, awaiting, declined; then name. */
export function compareAttendees(a, b) {
  const d = attendeeStatus(a?.response).sort - attendeeStatus(b?.response).sort;
  if (d !== 0) return d;
  return String(a?.name || a?.email || "").localeCompare(String(b?.name || b?.email || ""));
}

/**
 * The sentence a status gets on hover and in the accessibility tree. One
 * function so the tooltip can never drift from the badge beside it.
 */
export function statusTooltip(name, rawResponse, source) {
  const s = attendeeStatus(rawResponse);
  const who = name ? `${name}: ` : "";
  // Organizing is a role, not an answer, so there is no copy it "came from" —
  // naming a source there would imply an RSVP that does not exist.
  if (s.key === "organizer") return `${who}${s.hint}`;
  if (source === "row" || source === "default" || !source) return `${who}${s.hint}`;
  const from =
    source === "self"      ? "from their own calendar"
  : source === "organizer" ? "from the organizer's copy"
  :                          "from another attendee's copy";
  return `${who}${s.hint} (${from})`;
}
