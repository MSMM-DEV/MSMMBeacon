// "Print for Manish" — Excel (.xlsx) exporter for the Invoice page.
//
// Reproduces the customer-supplied template (one sheet per month, JAN–DEC):
//   • Legend in B1:B3 (Green=Paid / Red=Unpaid / Yellow=Submitted)
//   • Header row 4: Project No. | Invoice No. | Total Invoice | MSMM |
//                   Sub 1 Name | Sub 1 Amount | … (extends past 3 when a
//                   project has more than 3 subs)
//   • One row per qualifying project (Prime role + ≥1 sub). Total Invoice
//     is a live =SUM(E:lastAmount) — the text Sub-Name cells are ignored by
//     SUM, so it totals MSMM + every sub amount.
//   • Per-cell color mirrors the in-app InvoiceTable signal:
//       paid tick → green · invoice PDF attached → yellow · amount only → red
//     MSMM + Total follow the prime invoice's paid/attachment status; each
//     Sub Name+Amount pair follows that sub's own status.
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

// 1 → "A", 2 → "B", … 27 → "AA". Used to build the SUM(E#:?#) range.
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

function buildMonthSheet(ws, monthIdx, data) {
  const { maxSubs, rows } = data;
  // Column geometry: B=ProjNo C=InvNo D=Total E=MSMM, then 2 cols per sub.
  const FIRST_SUB_COL = 6;                       // F
  const lastAmountCol = 5 + maxSubs * 2;         // E(5) + 2 per sub

  // Column widths (mirror the template; subs repeat the F/G widths).
  ws.getColumn(2).width = 23.55;  // B Project No.
  ws.getColumn(3).width = 9.89;   // C Invoice No.
  ws.getColumn(4).width = 10.89;  // D Total Invoice
  ws.getColumn(5).width = 8.89;   // E MSMM
  for (let s = 0; s < maxSubs; s++) {
    ws.getColumn(FIRST_SUB_COL + s * 2).width = 10.89;     // Sub Name
    ws.getColumn(FIRST_SUB_COL + s * 2 + 1).width = 11.89; // Sub Amount
  }

  // Legend (B1:B3).
  const legend = [
    ["Green = Paid", GREEN],
    ["Red = Unpaid", RED],
    ["Yellow = Submitted", YELLOW],
  ];
  legend.forEach(([text, argb], i) => {
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
  setHeader(2, "Project No.");
  setHeader(3, "Invoice No.");
  setHeader(4, "Total Invoice");
  setHeader(5, "MSMM ");
  for (let s = 0; s < maxSubs; s++) {
    setHeader(FIRST_SUB_COL + s * 2, `Sub ${s + 1} Name `);
    setHeader(FIRST_SUB_COL + s * 2 + 1, `Sub ${s + 1} Amount`);
  }

  // Data rows from row 5.
  let rowNum = 5;
  for (const r of rows) {
    const m = r.months[monthIdx];
    const row = ws.getRow(rowNum);

    // B — Project number.
    const bCell = row.getCell(2);
    bCell.value = r.projectNumber || "";
    style(bCell);

    // C — Invoice number (left blank per spec).
    style(row.getCell(3));

    // Total amount used only to decide the Total cell's red coloring; the
    // displayed value is a live SUM formula so it recomputes if edited.
    const subTotal = m.subs.reduce((a, s) => a + (Number(s.amount) || 0), 0);
    const totalAmount = (Number(m.msmmAmount) || 0) + subTotal;

    // D — Total Invoice (=SUM(E:lastAmount)). Colored by prime status.
    const dCell = row.getCell(4);
    dCell.value = { formula: `SUM(E${rowNum}:${colLetter(lastAmountCol)}${rowNum})` };
    style(dCell, { money: true, fill: statusFill(m.primePaid, m.primeHasFile, totalAmount) });

    // E — MSMM portion. Colored by the same prime status, gated on its own amount.
    const eCell = row.getCell(5);
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
//   rows: [{ projectNumber, subNames:[…maxSubs], months:[…12 of
//            { msmmAmount, primePaid, primeHasFile,
//              subs:[…maxSubs of { amount, paid, hasFile }] }] }]
// }
// Pure builder — returns a populated exceljs Workbook (no DOM/download).
// Split out so it can be unit-tested in Node without browser APIs.
export async function buildManishWorkbookObject(data) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MSMM Beacon";
  for (let mi = 0; mi < 12; mi++) {
    const ws = wb.addWorksheet(MONTH_LABELS[mi]);
    buildMonthSheet(ws, mi, data);
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
