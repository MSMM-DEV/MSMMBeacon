export const INVOICE_TYPE_OPTIONS = ["ENG", "PM", "MHZ"];
export const HZ_INVOICE_TYPES = ["ENG", "MHZ"];

const LINKED_INVOICE_SYNC_KEYS = new Set([
  "sourceId",
  "projectNumber",
  "name",
  "pmIds",
  "amount",
  "msmmAmount",
  "msmmValues",
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
