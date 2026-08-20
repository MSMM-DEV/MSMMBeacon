// ============================================================================
// Invoice contract AMENDMENTS — pure helpers.
//
// An amendment is a signed change to a contract's value: one attachment, one
// dollar amount, one note. A line's Contract Value is
//
//     Contract Value = contract amount + Σ (its amendments)
//
// and that amended figure is what the Invoice page reads everywhere — Total
// Billed, Total Remaining, the MSMM `Total − Σ subs` auto-calc, the cash-flow
// charts and every export. See supabase/migrations_v2/20260820120000.
//
// Two scopes:
//   * PROJECT — keyed on an anticipated_invoice id. Raises the project's Total
//     Contract Value (the "Project total" row).
//   * SUB — keyed on (project_id, company_id, kind), the same natural key
//     sub_invoices and updateProjectSub use for sub identity.
//
// Everything here is pure so the money math is unit-testable without React or
// Supabase — see frontend/tests/invoice-amendments.test.mjs.
// ============================================================================

/** Coerce a possibly-string/null money field to a finite number. */
const money = (v) => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Sum of a list of amendments. An amendment amount may be negative — a
 * deductive change order is a real thing, and nothing here assumes otherwise.
 */
export function amendmentsTotal(list) {
  return (list || []).reduce((a, am) => a + money(am?.amount), 0);
}

/**
 * The headline number: contract amount + every amendment on that line.
 * `base` is the stored contract (anticipated_invoice.contract_amount for a
 * project, project_subs.amount for a sub).
 */
export function contractValue(base, list) {
  return money(base) + amendmentsTotal(list);
}

/**
 * Rows for the breakdown popover: the original contract, then one entry per
 * amendment in creation order, then the total. Kept here (not in the
 * component) so the popover and any export can never disagree about what the
 * breakdown says.
 */
export function contractBreakdown(base, list) {
  const items = (list || []).map((am, i) => ({
    id: am?.id ?? `am-${i}`,
    label: `Amendment ${i + 1}`,
    amount: money(am?.amount),
    notes: am?.notes || "",
    fileName: am?.fileName || null,
    createdAt: am?.createdAt || null,
  }));
  return {
    base: money(base),
    items,
    total: money(base) + items.reduce((a, it) => a + it.amount, 0),
  };
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

/**
 * Natural key for a SUB-scoped amendment. Mirrors sub_invoices'
 * (project_id, kind, company_id) identity. `kind` defaults to 'sub' the same
 * way it does everywhere else in the app.
 */
export function subAmendmentKey(projectId, companyId, kind = "sub") {
  return `${projectId || ""}::${kind || "sub"}::${companyId || ""}`;
}

/** Key for a DB row, whichever scope it carries. Null if the row is malformed. */
export function amendmentRowKey(row) {
  if (!row) return null;
  if (row.invoiceId) return `inv::${row.invoiceId}`;
  if (row.projectId && row.companyId) {
    return `sub::${subAmendmentKey(row.projectId, row.companyId, row.kind)}`;
  }
  return null;
}

/**
 * Bucket a flat list of amendment rows into the two lookups the table needs.
 * Insertion order is preserved inside each bucket, so "Amendment 1/2/3"
 * numbering stays stable as long as the caller loads in a stable order.
 */
export function groupAmendments(rows) {
  const byInvoiceId = new Map();
  const bySubKey = new Map();
  for (const row of rows || []) {
    if (row?.invoiceId) {
      const list = byInvoiceId.get(row.invoiceId) || [];
      list.push(row);
      byInvoiceId.set(row.invoiceId, list);
    } else if (row?.projectId && row?.companyId) {
      const key = subAmendmentKey(row.projectId, row.companyId, row.kind);
      const list = bySubKey.get(key) || [];
      list.push(row);
      bySubKey.set(key, list);
    }
  }
  return { byInvoiceId, bySubKey };
}

/**
 * Every amendment for a MERGED invoice row.
 *
 * A merged row folds all of a project's per-year rows together, and an ENG row
 * shares its contract with its MHZ perspective sibling — so the row's
 * amendments are the union across `ids` (the group ids + linked sibling ids
 * the caller already computes via mergeInvoiceYears / linkedInvoiceIdsFor).
 * De-duped by amendment id, because a group id and a linked id can overlap.
 */
export function amendmentsForInvoiceIds(byInvoiceId, ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids || []) {
    for (const am of byInvoiceId.get(id) || []) {
      if (am?.id && seen.has(am.id)) continue;
      if (am?.id) seen.add(am.id);
      out.push(am);
    }
  }
  return out;
}

/** Amendments for one sub line. */
export function amendmentsForSub(bySubKey, projectId, companyId, kind = "sub") {
  return bySubKey.get(subAmendmentKey(projectId, companyId, kind)) || [];
}

/**
 * A sub entry is amendable only if it is a REAL project_subs row. The two
 * synthetic lines the perspective layer injects are not:
 *   * syntheticPerspective — MSMM shown as a sub on an MHZ/MHZ PM view. Its
 *     contract is the linked base row's MSMM value; amend the project instead.
 *   * syntheticMhzPrime — a pure `total − Σ subs` remainder. Amending a
 *     remainder is meaningless; it would silently unbalance the breakdown.
 */
export function subIsAmendable(s) {
  return !!s && !s.syntheticPerspective && !s.syntheticMhzPrime && !!s.companyId;
}
