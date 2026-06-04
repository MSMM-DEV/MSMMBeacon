// "Print for Manish" — Excel (.xlsx) exporter for the Invoice page.
//
// Reproduces the customer-supplied template (one sheet per month, JAN–DEC):
//   • Legend in B1:B3 (Green=Paid / Red=Unpaid / Yellow=Submitted)
//   • Header row 4: Project No. | Project Name | Invoice No. | Total Invoice |
//                   MSMM | Sub 1 Name | Sub 1 Amount | … (extends past 3 when
//                   a project has more than 3 subs)
//   • One row per qualifying project (Prime role + ≥1 sub). Total Invoice is
//     a live =SUM(MSMM:lastAmount) — the text Sub-Name cells are ignored by
//     SUM, so it totals MSMM + every sub amount.
//   • Per-cell color mirrors the in-app InvoiceTable signal:
//       paid tick → green · invoice PDF attached → yellow · amount only → red
//     MSMM + Total follow the prime invoice's paid/attachment status; each
//     Sub Name+Amount pair follows that sub's own status.
//   • Every column is auto-sized to its widest content (incl. formatted
//     currency + the legend text) so nothing is clipped on open.
//
// exceljs is loaded via dynamic import() so it only ships when the button is
// actually clicked (keeps it out of the initial bundle).

const GREEN  = "FF00B050";
const YELLOW = "FFFFFF00";
const RED    = "FFFF0000";
const MONEY_FMT =
  '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
const FONT  = { name: "Aptos Narrow", size: 11 };
const ALIGN = { horizontal: "center", vertical: "center" };
const MONTH_LABELS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const LEGEND = [
  ["Green = Paid", GREEN],
  ["Red = Unpaid", RED],
  ["Yellow = Submitted", YELLOW],
];

// Fixed-position columns (exceljs 1-based numbers). Subs start at FIRST_SUB_COL
// and occupy 2 columns each (Name, Amount). MSMM is the first amount column, so
// SUM(MSMM:lastAmount) totals MSMM + every sub amount (text names are skipped).
const PROJNO_COL = 2;     // B
const NAME_COL   = 3;     // C  (Project Name — new)
const INVNO_COL  = 4;     // D
const TOTAL_COL  = 5;     // E
const MSMM_COL   = 6;     // F
const FIRST_SUB_COL = 7;  // G
const lastAmountCol = (maxSubs) => MSMM_COL + maxSubs * 2;

// 1 → "A", 2 → "B", … 27 → "AA". Used to build the SUM range.
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Three-state fill, matching the InvoiceTable cell coloring. Returns an
// exceljs fill object or null (no fill).
function statusFill(paid, hasFile, amount) {
  let argb = null;
  if (paid) argb = GREEN;
  else if (hasFile) argb = YELLOW;
  else if (amount != null && amount !== 0) argb = RED;
  if (!argb) return null;
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

// Apply shared font/alignment (+ optional money format + fill) to a cell.
function style(cell, { money = false, fill = null } = {}) {
  cell.font = FONT;
  cell.alignment = ALIGN;
  if (money) cell.numFmt = MONEY_FMT;
  if (fill) cell.fill = fill;
}

// Approximate the on-screen length of a value, used for column auto-sizing.
const textLen = (v) => (v == null ? 0 : String(v).length);
// Money cells render as the accounting format ($ left, value right, ".00",
// thousands separators) — estimate that formatted length, not the raw number.
function moneyLen(v) {
  if (v == null || Number(v) === 0) return 4; // "$  -"
  const s = Math.abs(Number(v)).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return ("$" + s).length + 2; // leading "$" + accounting edge padding
}

// Compute one width per column from the widest content across ALL months, so
// the 12 sheets share a consistent, clip-free layout. Returns { colNum: width }.
function computeColWidths(data) {
  const { maxSubs, rows } = data;
  const need = {}; // colNum → max content length seen
  const bump = (col, len) => { if (len > (need[col] || 0)) need[col] = len; };

  // Header labels.
  bump(PROJNO_COL, textLen("Project No."));
  bump(NAME_COL,   textLen("Project Name"));
  bump(INVNO_COL,  textLen("Invoice No."));
  bump(TOTAL_COL,  textLen("Total Invoice"));
  bump(MSMM_COL,   textLen("MSMM "));
  for (let s = 0; s < maxSubs; s++) {
    bump(FIRST_SUB_COL + s * 2,     textLen(`Sub ${s + 1} Name `));
    bump(FIRST_SUB_COL + s * 2 + 1, textLen(`Sub ${s + 1} Amount`));
  }
  // Legend text sits in column B (PROJNO_COL).
  for (const [text] of LEGEND) bump(PROJNO_COL, textLen(text));

  // Row content.
  for (const r of rows) {
    bump(PROJNO_COL, textLen(r.projectNumber));
    bump(NAME_COL,   textLen(r.name));
    for (let s = 0; s < maxSubs; s++) bump(FIRST_SUB_COL + s * 2, textLen(r.subNames[s]));
    for (const m of r.months) {
      const subTotal = m.subs.reduce((a, x) => a + (Number(x.amount) || 0), 0);
      bump(TOTAL_COL, moneyLen((Number(m.msmmAmount) || 0) + subTotal));
      bump(MSMM_COL,  moneyLen(m.msmmAmount));
      for (let s = 0; s < maxSubs; s++) bump(FIRST_SUB_COL + s * 2 + 1, moneyLen(m.subs[s]?.amount));
    }
  }

  // Content length → Excel width (char units). Generous so text never clips:
  // our cells use the narrow "Aptos Narrow" font while width units are sized
  // to the wider default, so a small factor + padding always over-fits.
  const MIN = 9, MAX = 80, PAD = 2, FACTOR = 1.15;
  const widths = {};
  for (const [col, len] of Object.entries(need)) {
    widths[col] = Math.min(MAX, Math.max(MIN, Math.ceil(len * FACTOR) + PAD));
  }
  return widths;
}

function buildMonthSheet(ws, monthIdx, data, colWidths) {
  const { maxSubs, rows } = data;
  const lastAmt = lastAmountCol(maxSubs);

  // Column widths (auto-sized, same on every sheet).
  for (const [col, width] of Object.entries(colWidths)) {
    ws.getColumn(Number(col)).width = width;
  }

  // Legend (B1:B3).
  LEGEND.forEach(([text, argb], i) => {
    const cell = ws.getCell(`B${i + 1}`);
    cell.value = text;
    style(cell, { fill: { type: "pattern", pattern: "solid", fgColor: { argb } } });
  });

  // Header row 4.
  const setHeader = (col, text) => {
    const cell = ws.getRow(4).getCell(col);
    cell.value = text;
    style(cell);
  };
  setHeader(PROJNO_COL, "Project No.");
  setHeader(NAME_COL,   "Project Name");
  setHeader(INVNO_COL,  "Invoice No.");
  setHeader(TOTAL_COL,  "Total Invoice");
  setHeader(MSMM_COL,   "MSMM ");
  for (let s = 0; s < maxSubs; s++) {
    setHeader(FIRST_SUB_COL + s * 2,     `Sub ${s + 1} Name `);
    setHeader(FIRST_SUB_COL + s * 2 + 1, `Sub ${s + 1} Amount`);
  }

  // Data rows from row 5.
  let rowNum = 5;
  for (const r of rows) {
    const m = r.months[monthIdx];
    const row = ws.getRow(rowNum);

    // B — Project number.
    row.getCell(PROJNO_COL).value = r.projectNumber || "";
    style(row.getCell(PROJNO_COL));

    // C — Project name.
    row.getCell(NAME_COL).value = r.name || "";
    style(row.getCell(NAME_COL));

    // D — Invoice number (left blank per spec).
    style(row.getCell(INVNO_COL));

    // Total amount used only to decide the Total cell's red coloring; the
    // displayed value is a live SUM formula so it recomputes if edited.
    const subTotal = m.subs.reduce((a, s) => a + (Number(s.amount) || 0), 0);
    const totalAmount = (Number(m.msmmAmount) || 0) + subTotal;

    // E — Total Invoice (=SUM(MSMM:lastAmount)). Colored by prime status.
    const dCell = row.getCell(TOTAL_COL);
    dCell.value = {
      formula: `SUM(${colLetter(MSMM_COL)}${rowNum}:${colLetter(lastAmt)}${rowNum})`,
    };
    style(dCell, { money: true, fill: statusFill(m.primePaid, m.primeHasFile, totalAmount) });

    // F — MSMM portion. Colored by the same prime status, gated on its own amount.
    const eCell = row.getCell(MSMM_COL);
    eCell.value = (m.msmmAmount != null && m.msmmAmount !== 0) ? Number(m.msmmAmount) : null;
    style(eCell, { money: true, fill: statusFill(m.primePaid, m.primeHasFile, m.msmmAmount) });

    // Sub pairs.
    for (let s = 0; s < maxSubs; s++) {
      const nameCol = FIRST_SUB_COL + s * 2;
      const amtCol = nameCol + 1;
      const sub = m.subs[s] || { amount: null, paid: false, hasFile: false };
      const fill = statusFill(sub.paid, sub.hasFile, sub.amount);

      const nameCell = row.getCell(nameCol);
      nameCell.value = r.subNames[s] || "";
      style(nameCell, { fill });

      const amtCell = row.getCell(amtCol);
      amtCell.value = (sub.amount != null && sub.amount !== 0) ? Number(sub.amount) : null;
      style(amtCell, { money: true, fill });
    }

    rowNum++;
  }
}

// data = {
//   year, maxSubs,
//   rows: [{ projectNumber, name, subNames:[…maxSubs], months:[…12 of
//            { msmmAmount, primePaid, primeHasFile,
//              subs:[…maxSubs of { amount, paid, hasFile }] }] }]
// }
// Pure builder — returns a populated exceljs Workbook (no DOM/download).
// Split out so it can be unit-tested in Node without browser APIs.
export async function buildManishWorkbookObject(data) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MSMM Beacon";
  const colWidths = computeColWidths(data);
  for (let mi = 0; mi < 12; mi++) {
    const ws = wb.addWorksheet(MONTH_LABELS[mi]);
    buildMonthSheet(ws, mi, data, colWidths);
  }
  return wb;
}

export async function exportManishWorkbook(data, filename = "invoice-manish.xlsx") {
  const wb = await buildManishWorkbookObject(data);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
