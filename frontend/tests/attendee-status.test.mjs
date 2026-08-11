import assert from "node:assert/strict";
import test from "node:test";

import {
  RESPONSE_STATUS,
  RESPONSE_UNKNOWN,
  applyResolvedResponses,
  attendeeStatus,
  compareAttendees,
  isExplicitResponse,
  normalizeResponse,
  resolveAttendeeResponses,
  statusTooltip,
} from "../src/attendee-status.js";

// ---------------------------------------------------------------------------
// The live case this module was written for.
//
// RR402 - Field Discussion for ADA Ramps, 2026-08-10, mirrored into three
// MSMM mailboxes. Copied verbatim (trimmed to the MSMM attendees) from
// beacon_v2.user_calendar_events. Stephen's own copy records his acceptance;
// the other two copies are not entitled to it and report "none".
// ---------------------------------------------------------------------------
const ORGANIZER = { name: "Avery, Travis", email: "travisav@barriere.com" };

const RR402_COPIES = [
  {
    ownerEmail: "SLeonard@msmmeng.com",
    organizer: ORGANIZER,
    attendees: [
      { name: "Avery, Travis", email: "travisav@barriere.com", response: "none" },
      { name: "Stephen Leonard", email: "SLeonard@msmmeng.com", response: "accepted" },
      { name: "George Grimes Jr", email: "GGrimes@msmmeng.com", response: "none" },
      { name: "Christopher Mills, PE", email: "cmills@msmmeng.com", response: "none" },
    ],
  },
  {
    ownerEmail: "GGrimes@msmmeng.com",
    organizer: ORGANIZER,
    attendees: [
      { name: "Avery, Travis", email: "travisav@barriere.com", response: "none" },
      { name: "Stephen Leonard", email: "SLeonard@msmmeng.com", response: "none" },
      { name: "George Grimes Jr", email: "GGrimes@msmmeng.com", response: "accepted" },
      { name: "Christopher Mills, PE", email: "cmills@msmmeng.com", response: "none" },
    ],
  },
  {
    ownerEmail: "cmills@msmmeng.com",
    organizer: ORGANIZER,
    attendees: [
      { name: "Avery, Travis", email: "travisav@barriere.com", response: "none" },
      { name: "Stephen Leonard", email: "SLeonard@msmmeng.com", response: "none" },
      { name: "George Grimes Jr", email: "GGrimes@msmmeng.com", response: "none" },
      { name: "Christopher Mills, PE", email: "cmills@msmmeng.com", response: "none" },
    ],
  },
];

const at = (map, email) => map.get(email.toLowerCase());

test("RR402: Stephen reads Accepted from every copy of the meeting, not just his own", () => {
  const resolved = resolveAttendeeResponses(RR402_COPIES);
  assert.equal(at(resolved, "SLeonard@msmmeng.com").response, "accepted");
  assert.equal(at(resolved, "SLeonard@msmmeng.com").source, "self");
  assert.equal(at(resolved, "GGrimes@msmmeng.com").response, "accepted");
});

test("RR402: the answer does not depend on which block was clicked", () => {
  const resolved = resolveAttendeeResponses(RR402_COPIES);
  // Whichever owner's copy is rendered, the reconciled roster is identical —
  // that is the regression this pins. Before the fix, opening the event from
  // George's block said "Awaiting" for Stephen and from Stephen's said
  // "Accepted".
  const rosters = RR402_COPIES.map(copy =>
    applyResolvedResponses(copy.attendees, resolved)
      .map(a => `${a.email.toLowerCase()}=${a.response}`)
      .join("|")
  );
  assert.equal(new Set(rosters).size, 1, `attendee status differed per copy: ${rosters.join("\n")}`);
  assert.match(rosters[0], /sleonard@msmmeng\.com=accepted/);
});

test("RR402: silence in someone's own copy stays Awaiting — presence is not acceptance", () => {
  const resolved = resolveAttendeeResponses(RR402_COPIES);
  // Christopher's copy is loaded and says nothing, so he has not answered.
  // The meeting still sits on his calendar; that must not upgrade him.
  const chris = at(resolved, "cmills@msmmeng.com");
  assert.equal(chris.response, RESPONSE_UNKNOWN);
  assert.equal(attendeeStatus(chris.response).label, "Awaiting");
});

test("the organizer is never rendered as an RSVP", () => {
  const resolved = resolveAttendeeResponses(RR402_COPIES);
  const org = at(resolved, "travisav@barriere.com");
  // Outlook lists the organizer among the attendees at 'none', which would
  // otherwise read "Awaiting" for the person who called the meeting.
  assert.equal(org.response, "organizer");
  assert.equal(attendeeStatus(org.response).label, "Organizer");
});

test("a single copy resolves to exactly what that copy says", () => {
  const resolved = resolveAttendeeResponses([RR402_COPIES[1]]);
  assert.equal(at(resolved, "GGrimes@msmmeng.com").response, "accepted");
  assert.equal(at(resolved, "SLeonard@msmmeng.com").response, RESPONSE_UNKNOWN);
});

test("resolution is independent of copy order", () => {
  const forward = resolveAttendeeResponses(RR402_COPIES);
  const reverse = resolveAttendeeResponses([...RR402_COPIES].reverse());
  for (const key of forward.keys()) {
    assert.deepEqual(reverse.get(key), forward.get(key), `differed for ${key}`);
  }
});

test("the organizer's copy outranks a peer copy, and self outranks both", () => {
  const copies = [
    {
      ownerEmail: "boss@msmmeng.com",
      organizer: { email: "boss@msmmeng.com" },
      attendees: [{ email: "kim@msmmeng.com", response: "tentativelyAccepted" }],
    },
    {
      ownerEmail: "peer@msmmeng.com",
      organizer: { email: "boss@msmmeng.com" },
      attendees: [{ email: "kim@msmmeng.com", response: "declined" }],
    },
  ];
  assert.equal(at(resolveAttendeeResponses(copies), "kim@msmmeng.com").response, "tentativelyAccepted");
  assert.equal(at(resolveAttendeeResponses(copies), "kim@msmmeng.com").source, "organizer");

  const withSelf = [
    ...copies,
    {
      ownerEmail: "kim@msmmeng.com",
      organizer: { email: "boss@msmmeng.com" },
      attendees: [{ email: "kim@msmmeng.com", response: "accepted" }],
    },
  ];
  assert.equal(at(resolveAttendeeResponses(withSelf), "kim@msmmeng.com").response, "accepted");
  assert.equal(at(resolveAttendeeResponses(withSelf), "kim@msmmeng.com").source, "self");
});

test("a peer copy is only believed when it carries an explicit answer", () => {
  // Silence from a mailbox that is not entitled to the answer says nothing,
  // so it must not overwrite a real response from another peer.
  const copies = [
    { ownerEmail: "a@msmmeng.com", attendees: [{ email: "zoe@x.com", response: "none" }] },
    { ownerEmail: "b@msmmeng.com", attendees: [{ email: "zoe@x.com", response: "declined" }] },
  ];
  const resolved = resolveAttendeeResponses(copies);
  assert.equal(at(resolved, "zoe@x.com").response, "declined");
  assert.equal(at(resolved, "zoe@x.com").source, "peer");
});

test("two peers of equal standing disagreeing is reported, not silently picked over", () => {
  const copies = [
    { ownerEmail: "a@msmmeng.com", attendees: [{ email: "zoe@x.com", response: "accepted" }] },
    { ownerEmail: "b@msmmeng.com", attendees: [{ email: "zoe@x.com", response: "declined" }] },
  ];
  const resolved = resolveAttendeeResponses(copies);
  assert.equal(at(resolved, "zoe@x.com").conflict, true);
  // Deterministic winner: copies are ordered by owner email before resolving.
  assert.equal(at(resolved, "zoe@x.com").response, "accepted");
});

test("empty and malformed input never throws and never invents a status", () => {
  assert.equal(resolveAttendeeResponses(undefined).size, 0);
  assert.equal(resolveAttendeeResponses([]).size, 0);
  assert.equal(resolveAttendeeResponses([null, { attendees: null }]).size, 0);
  const resolved = resolveAttendeeResponses([
    { ownerEmail: "a@msmmeng.com", attendees: [{ email: "", response: "accepted" }, { response: "accepted" }] },
  ]);
  assert.equal(resolved.size, 0);
});

// ---------------------------------------------------------------------------
// The four states, and the guarantee that one status means one appearance
// everywhere.
// ---------------------------------------------------------------------------
test("every Graph response value maps to exactly one canonical state", () => {
  assert.equal(normalizeResponse("accepted"), "accepted");
  assert.equal(normalizeResponse("declined"), "declined");
  assert.equal(normalizeResponse("tentativelyAccepted"), "tentativelyAccepted");
  assert.equal(normalizeResponse("organizer"), "organizer");
  // The two ways Graph spells "no answer" collapse to one.
  assert.equal(normalizeResponse("none"), RESPONSE_UNKNOWN);
  assert.equal(normalizeResponse("notResponded"), RESPONSE_UNKNOWN);
  // Case and whitespace from hand-seeded rows.
  assert.equal(normalizeResponse("  ACCEPTED "), "accepted");
  // Unknown input is awaiting, never a guess.
  assert.equal(normalizeResponse(null), RESPONSE_UNKNOWN);
  assert.equal(normalizeResponse("someFutureGraphValue"), RESPONSE_UNKNOWN);
});

test("label, tone, icon and tooltip are one lookup, so they cannot disagree", () => {
  const expected = {
    organizer:           { label: "Organizer", tone: "outline", icon: "userCheck" },
    accepted:            { label: "Accepted",  tone: "success", icon: "checkCircle" },
    tentativelyAccepted: { label: "Tentative", tone: "info",    icon: "help" },
    notResponded:        { label: "Awaiting",  tone: "brand",   icon: "hourglass" },
    declined:            { label: "Declined",  tone: "danger",  icon: "ban" },
  };
  for (const [key, want] of Object.entries(expected)) {
    const s = attendeeStatus(key);
    assert.equal(s.key, key);
    assert.equal(s.label, want.label);
    assert.equal(s.tone, want.tone);
    assert.equal(s.icon, want.icon);
    assert.ok(s.hint && s.hint.length > 0, `${key} has no tooltip`);
  }
  // Every alias of a state lands on the identical descriptor object, which is
  // what stops one surface reading "none" and another "notResponded".
  assert.equal(attendeeStatus("none"), attendeeStatus("notResponded"));
  assert.equal(attendeeStatus("tentative"), attendeeStatus("tentativelyAccepted"));
  // No two states share a label, a tone or an icon.
  const rows = Object.values(RESPONSE_STATUS);
  for (const field of ["label", "tone", "icon", "cls", "sort"]) {
    assert.equal(new Set(rows.map(r => r[field])).size, rows.length, `${field} is not unique per state`);
  }
});

test("the tooltip names the same state as the badge, and says where it came from", () => {
  assert.equal(
    statusTooltip("Stephen Leonard", "accepted", "self"),
    "Stephen Leonard: Accepted the invitation (from their own calendar)"
  );
  assert.equal(
    statusTooltip("Kim", "declined", "organizer"),
    "Kim: Declined the invitation (from the organizer's copy)"
  );
  assert.equal(statusTooltip("Kim", "none", "row"), "Kim: Has not responded to the invitation yet");
  // Organizing is a role, not an answer, so it never claims a source copy.
  assert.equal(
    statusTooltip("Travis", "organizer", "organizer"),
    "Travis: Organized this meeting — an organizer does not RSVP"
  );
  for (const key of Object.keys(RESPONSE_STATUS)) {
    assert.ok(statusTooltip("X", key, "self").includes(attendeeStatus(key).hint));
  }
});

test("isExplicitResponse separates an answer from silence and from organizing", () => {
  assert.equal(isExplicitResponse("accepted"), true);
  assert.equal(isExplicitResponse("declined"), true);
  assert.equal(isExplicitResponse("tentativelyAccepted"), true);
  assert.equal(isExplicitResponse("none"), false);
  assert.equal(isExplicitResponse("organizer"), false);
});

test("attendees sort organizer, accepted, tentative, awaiting, declined, then by name", () => {
  const list = [
    { name: "Dana", response: "declined" },
    { name: "Bo",   response: "none" },
    { name: "Alex", response: "accepted" },
    { name: "Cass", response: "organizer" },
    { name: "Ada",  response: "accepted" },
    { name: "Eve",  response: "tentativelyAccepted" },
  ];
  assert.deepEqual(
    [...list].sort(compareAttendees).map(a => a.name),
    ["Cass", "Ada", "Alex", "Eve", "Bo", "Dana"]
  );
});

test("applyResolvedResponses normalises even without a resolution map", () => {
  const rows = applyResolvedResponses(
    [{ email: "a@x.com", response: "none" }, { email: "b@x.com", response: "accepted" }, { name: "no email" }],
    null
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].response, RESPONSE_UNKNOWN);
  assert.equal(rows[0]._responseSource, "row");
  assert.equal(rows[1].response, "accepted");
});
