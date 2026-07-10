export const INVOICE_TYPE_OPTIONS = ["ENG", "PM", "MHZ", "MHZ PM"];

// Perspective pairs. A "base" invoice type (ENG / PM) and its linked "hz" (MHZ /
// JV-prime) perspective behave identically: same linking, project-level sync,
// role derivation, MSMM-as-sub injection, per-view identity, and export handling.
//   ENG ↔ MHZ      (MHZ is the JV prime of an ENG project; MSMM is a sub)
//   PM  ↔ MHZ PM   (MHZ PM is the JV prime of a PM project;  MSMM is a sub)
// Two rows only ever LINK within the SAME pair — an ENG row never links to a PM
// or MHZ PM row even when they share a project number/source project.
export const INVOICE_PERSPECTIVE_PAIRS = [
  { base: "ENG", hz: "MHZ" },
  { base: "PM",  hz: "MHZ PM" },
];

// Flat list of every type that participates in a perspective pair (base or hz),
// for the .includes() gates in App.jsx.
export const HZ_INVOICE_TYPES = INVOICE_PERSPECTIVE_PAIRS.flatMap(p => [p.base, p.hz]);

const LINKED_INVOICE_SYNC_KEYS = new Set([
  "sourceId",
  "projectNumber",
  "name",
  "pmIds",
  "amount",
  // NOTE: msmmAmount / msmmValues are intentionally NOT synced. MSMM is a
  // purely derived value (Total − subs) computed per perspective — the base
  // (MSMM's own portion) and hz (MSMM-as-a-sub) views compute different MSMM
  // numbers from the same shared totals, so a stored override must never cross
  // between siblings.
  "remainingStart",
  "totalRemainingStart",
  "values",
  "primePaid",
  "invoiceNumbers",
  "year",
  "ytdActualOverride",
  "rollforwardOverride",
  "notes",
  "description",
  "billingState",
  "invoiceOrange",
  "egnyteFolderPath",
]);

// The pair a type belongs to (or null when the type isn't part of a pair).
export function perspectivePairOf(type) {
  const t = type || "ENG";
  return INVOICE_PERSPECTIVE_PAIRS.find(p => p.base === t || p.hz === t) || null;
}

// The OTHER member of a type's pair: ENG↔MHZ, PM↔MHZ PM. null if not in a pair.
export function pairSiblingOf(type) {
  const pair = perspectivePairOf(type);
  if (!pair) return null;
  return (type || "ENG") === pair.hz ? pair.base : pair.hz;
}

// A base (MSMM-billing) type: ENG or PM.
export function isBaseInvoiceType(type) {
  return INVOICE_PERSPECTIVE_PAIRS.some(p => p.base === (type || "ENG"));
}

// An hz (MHZ-side / JV-prime) type: MHZ or MHZ PM.
export function isHzPrimeType(type) {
  return INVOICE_PERSPECTIVE_PAIRS.some(p => p.hz === type);
}

// The hz type for a base type: ENG→MHZ, PM→MHZ PM. null otherwise.
export function hzTypeForBase(baseType) {
  const pair = INVOICE_PERSPECTIVE_PAIRS.find(p => p.base === (baseType || "ENG"));
  return pair ? pair.hz : null;
}

// The base type for an hz type: MHZ→ENG, MHZ PM→PM. null otherwise.
export function baseTypeForHz(hzType) {
  const pair = INVOICE_PERSPECTIVE_PAIRS.find(p => p.hz === hzType);
  return pair ? pair.base : null;
}

export function projectNameSuggestsMhz(name) {
  return /(^|[^a-z0-9])m?hz([^a-z0-9]|$)/i.test(String(name || ""));
}

export function invoiceTypeTone(type) {
  if (type === "ENG") return "sage";
  if (type === "PM") return "blue";
  if (type === "MHZ") return "amber";
  if (type === "MHZ PM") return "rose";
  return "muted";
}

export function linkedInvoicePatch(patch = {}) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (LINKED_INVOICE_SYNC_KEYS.has(key)) out[key] = value;
  }
  return out;
}

export function normInvoicePerspectiveNumber(projectNumber) {
  return projectNumber != null && String(projectNumber).trim() !== ""
    ? String(projectNumber).trim().toLowerCase()
    : "";
}

export function isHzInvoiceType(type) {
  return perspectivePairOf(type) != null;
}

export function linkedInvoiceIdsFor(row, rows = []) {
  if (!row?.id) return [];
  const pair = perspectivePairOf(row.type || "ENG");
  if (!pair) return [row.id];
  // Only ever link within the SAME pair — ENG↔MHZ or PM↔MHZ PM. ENG and PM rows
  // share a project number, so this scoping keeps the two pairs from bleeding
  // into each other's sync fan-out.
  const pairTypes = new Set([pair.base, pair.hz]);

  const rowNumber = normInvoicePerspectiveNumber(row.projectNumber);
  const ids = rows
    .filter(candidate => {
      if (!candidate?.id || !pairTypes.has(candidate.type || "ENG")) return false;
      const sameSource = row.sourceId && candidate.sourceId === row.sourceId;
      const sameNumber =
        rowNumber &&
        normInvoicePerspectiveNumber(candidate.projectNumber) === rowNumber;
      return sameSource || sameNumber || candidate.id === row.id;
    })
    .map(candidate => candidate.id);

  return ids.includes(row.id) ? ids : [row.id, ...ids];
}

export function invoicePerspectiveRoleIsDerived(row, rows = []) {
  const type = row?.type || "ENG";
  if (isHzPrimeType(type)) return true;         // MHZ / MHZ PM are the JV prime
  if (!isBaseInvoiceType(type)) return false;   // not a base perspective (ENG/PM)
  const hzType = hzTypeForBase(type);
  return linkedInvoiceIdsFor(row, rows).some(id => {
    const linked = rows.find(candidate => candidate.id === id);
    return linked?.id !== row?.id && linked?.type === hzType;
  });
}

export function invoicePerspectiveRole(row, rows = []) {
  const type = row?.type || "ENG";
  if (isHzPrimeType(type)) return "Prime";
  if (isBaseInvoiceType(type) && invoicePerspectiveRoleIsDerived(row, rows)) return "Sub";
  return row?.role || "Prime";
}

// True when this BASE row (ENG or PM) is MSMM's SUB view of an MHZ-prime project
// — i.e. a base row that has a linked hz sibling (MHZ / MHZ PM is the prime;
// MSMM is one of its subs). From MSMM's viewpoint it must see ONLY the hz prime
// line + the total, never the hz sibling's other subs (A, B, C). This is
// distinct from a NORMAL base project where MSMM is a genuine sub to a real
// external prime (role='Sub' but NO hz sibling → not derived → keeps showing its
// real subs), and from the hz row itself (MHZ / MHZ PM, which shows its subs +
// MSMM as prime).
export function isMhzPerspectiveSub(row, rows = []) {
  const type = row?.type || "ENG";
  return isBaseInvoiceType(type) && invoicePerspectiveRoleIsDerived(row, rows);
}

// The base sub-entry list for an Invoice row's expand, BEFORE withPerspectiveRows
// injects the synthetic perspective line. Three cases:
//   • Prime row (incl. the hz row)       → its own subs only (subEntries).
//   • MHZ-perspective Sub (base view of  → [] — nothing real; withPerspectiveRows
//     an hz-prime project)                  injects exactly ONE hz prime line, so
//                                           A/B/C are hidden and there is never a
//                                           duplicate/mismatched prime.
//   • Genuine external-prime Sub          → the upstream prime + its subs.
export function perspectiveSubListBase({ isPrimeRow, mhzPerspectiveSub, primeEntry, subEntries } = {}) {
  const subs = subEntries || [];
  if (isPrimeRow) return subs;
  if (mhzPerspectiveSub) return [];
  return [...(primeEntry ? [primeEntry] : []), ...subs];
}
