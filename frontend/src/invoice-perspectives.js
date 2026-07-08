export const INVOICE_TYPE_OPTIONS = ["ENG", "PM", "MHZ"];
export const HZ_INVOICE_TYPES = ["ENG", "MHZ"];

const LINKED_INVOICE_SYNC_KEYS = new Set([
  "sourceId",
  "projectNumber",
  "name",
  "pmIds",
  "amount",
  // NOTE: msmmAmount / msmmValues are intentionally NOT synced. MSMM is a
  // purely derived value (Total − subs) computed per perspective — the ENG
  // (MSMM's own portion) and MHZ (MSMM-as-a-sub) views compute different MSMM
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

export function projectNameSuggestsMhz(name) {
  return /(^|[^a-z0-9])m?hz([^a-z0-9]|$)/i.test(String(name || ""));
}

export function invoiceTypeTone(type) {
  if (type === "ENG") return "sage";
  if (type === "PM") return "blue";
  if (type === "MHZ") return "amber";
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
  return HZ_INVOICE_TYPES.includes(type || "ENG");
}

export function linkedInvoiceIdsFor(row, rows = []) {
  if (!row?.id) return [];
  const rowType = row.type || "ENG";
  if (!isHzInvoiceType(rowType)) return [row.id];

  const rowNumber = normInvoicePerspectiveNumber(row.projectNumber);
  const ids = rows
    .filter(candidate => {
      if (!candidate?.id || !isHzInvoiceType(candidate.type || "ENG")) return false;
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
  if (type === "MHZ") return true;
  if (type !== "ENG") return false;
  return linkedInvoiceIdsFor(row, rows).some(id => {
    const linked = rows.find(candidate => candidate.id === id);
    return linked?.id !== row?.id && linked?.type === "MHZ";
  });
}

export function invoicePerspectiveRole(row, rows = []) {
  const type = row?.type || "ENG";
  if (type === "MHZ") return "Prime";
  if (type === "ENG" && invoicePerspectiveRoleIsDerived(row, rows)) return "Sub";
  return row?.role || "Prime";
}

// True when this ENG row is MSMM's SUB view of an MHZ-prime project — i.e. an
// ENG row that has a linked MHZ sibling (MHZ is the prime; MSMM is one of its
// subs). From MSMM's viewpoint it must see ONLY the MHZ prime line + the total,
// never MHZ's sibling subs (A, B, C). This is distinct from a NORMAL ENG
// project where MSMM is a genuine sub to a real external prime (role='Sub' but
// NO MHZ sibling → not derived → keeps showing its real subs), and from the
// MHZ row itself (type='MHZ', which shows its subs + MSMM as prime).
export function isMhzPerspectiveSub(row, rows = []) {
  return (row?.type || "ENG") === "ENG" && invoicePerspectiveRoleIsDerived(row, rows);
}

// The base sub-entry list for an Invoice row's expand, BEFORE withPerspectiveRows
// injects the synthetic perspective line. Three cases:
//   • Prime row (incl. the MHZ row)      → its own subs only (subEntries).
//   • MHZ-perspective Sub (ENG view of   → [] — nothing real; withPerspectiveRows
//     an MHZ-prime project)                 injects exactly ONE MHZ prime line, so
//                                           A/B/C are hidden and there is never a
//                                           duplicate/mismatched prime.
//   • Genuine external-prime Sub          → the upstream prime + its subs.
export function perspectiveSubListBase({ isPrimeRow, mhzPerspectiveSub, primeEntry, subEntries } = {}) {
  const subs = subEntries || [];
  if (isPrimeRow) return subs;
  if (mhzPerspectiveSub) return [];
  return [...(primeEntry ? [primeEntry] : []), ...subs];
}
