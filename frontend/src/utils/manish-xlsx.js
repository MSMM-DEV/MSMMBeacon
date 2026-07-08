// "Print for Manish" — Excel (.xlsx) exporter for the Invoice page.
//
// ONE consolidated sheet (was one sheet per month). The 12 months stack
// vertically as titled sections ("JANUARY 2026", …), each with its own header
// row and one data row per qualifying project (Prime role + ≥1 sub). Rows are
// sorted ascending by project number. Layout notes:
//   • Optional bold, larger, merged TITLE banner on row 1 (the export scope:
//     period · types · sort) — merged across the full width so it never clips.
//   • Legend swatches below the title (Green=Paid / Red=Unpaid / Yellow=Submitted).
//   • Everything is LEFT-aligned — text and money alike (the plain currency
//     format below replaces the accounting format, which would otherwise force
//     its own $-left / number-right layout and ignore the alignment).
//   • Invoice No. column is populated from each month's prime/total invoice
//     number (captured per month in-app).
//   • Total Invoice is a live =SUM(MSMM:lastAmount) — text Sub-Name cells are
//     skipped, so it totals MSMM + every sub amount.
//   • Per-cell color mirrors the in-app InvoiceTable signal:
//       paid tick → green · invoice PDF attached → yellow · amount only → red.
//   • Columns are auto-sized tight (no extra slack) from the widest content.
//
// exceljs is loaded via dynamic import() so it only ships when the button is
// actually clicked (keeps it out of the initial bundle).

import { invoicePerspectiveRole } from "../invoice-perspectives.js";

const GREEN  = "FF00B050";
const YELLOW = "FFFFFF00";
const RED    = "FFFF0000";
// Plain currency (no accounting padding) so values sit flush-left with no gap
// and actually honor the left alignment.
const MONEY_FMT = '"$"#,##0.00';
const FONT  = { name: "Aptos Narrow", size: 11 };
const ALIGN = { horizontal: "left", vertical: "middle" };
const MONTH_FULL = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const LEGEND = [
  ["Green = Paid", GREEN],
  ["Red = Unpaid", RED],
  ["Yellow = Submitted", YELLOW],
];
const MIN_EXPORT_YEAR = 2020;

// Fixed-position columns (exceljs 1-based numbers). Subs start at FIRST_SUB_COL
// and occupy 2 columns each (Name, Amount). MSMM is the first amount column, so
// SUM(MSMM:lastAmount) totals MSMM + every sub amount (text names are skipped).
const PROJNO_COL = 2;     // B
const NAME_COL   = 3;     // C
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

// Apply shared font/alignment (+ optional money format / fill / bold / size).
function style(cell, { money = false, fill = null, bold = false, size = null } = {}) {
  cell.font = (bold || size)
    ? { ...FONT, ...(bold ? { bold: true } : {}), ...(size ? { size } : {}) }
    : FONT;
  cell.alignment = ALIGN;
  if (money) cell.numFmt = MONEY_FMT;
  if (fill) cell.fill = fill;
}

// Approximate the on-screen length of a value, for column auto-sizing.
const textLen = (v) => (v == null ? 0 : String(v).length);
// Money renders as plain "$#,##0.00" now — estimate that formatted length.
function moneyLen(v) {
  if (v == null || Number(v) === 0) return 0;
  const s = Math.abs(Number(v)).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return ("$" + s).length;
}

// One width per column from the widest content across ALL months. Returns
// { colNum: width }. Title rows are merged (B:E) so they never widen a column.
function computeColWidths(data) {
  const { maxSubs, rows } = data;
  const need = {}; // colNum → max content length seen
  const bump = (col, len) => { if (len > (need[col] || 0)) need[col] = len; };

  // Header labels (no trailing padding spaces anymore).
  bump(PROJNO_COL, textLen("Project No."));
  bump(NAME_COL,   textLen("Project Name"));
  bump(INVNO_COL,  textLen("Invoice No."));
  bump(TOTAL_COL,  textLen("Total Invoice"));
  bump(MSMM_COL,   textLen("MSMM"));
  for (let s = 0; s < maxSubs; s++) {
    bump(FIRST_SUB_COL + s * 2,     textLen(`Sub ${s + 1} Name`));
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
      bump(INVNO_COL, textLen(m.invoiceNumber));
      const subTotal = m.subs.reduce((a, x) => a + (Number(x.amount) || 0), 0);
      bump(TOTAL_COL, moneyLen((Number(m.msmmAmount) || 0) + subTotal));
      bump(MSMM_COL,  moneyLen(m.msmmAmount));
      for (let s = 0; s < maxSubs; s++) bump(FIRST_SUB_COL + s * 2 + 1, moneyLen(m.subs[s]?.amount));
    }
  }

  // Tight sizing — the narrow "Aptos Narrow" font makes char-count slightly
  // over-estimate real width, so factor 1.0 + a single pad char fits with no
  // extra slack (the old 1.15×+2 left columns visibly too wide).
  const MIN = 8, MAX = 60, PAD = 1, FACTOR = 1.0;
  const widths = {};
  for (const [col, len] of Object.entries(need)) {
    widths[col] = Math.min(MAX, Math.max(MIN, Math.ceil(len * FACTOR) + PAD));
  }
  return widths;
}

// Ascending by project number, numeric-aware ("202309" before "202401",
// "9" before "10").
function byProjectNumber(a, b) {
  return String(a.projectNumber || "").localeCompare(
    String(b.projectNumber || ""), undefined, { numeric: true, sensitivity: "base" });
}

const monthTitle = (d) => `${MONTH_FULL[d.monthIdx]} ${d.year}`;
const monthLabel = (year, monthIdx) =>
  `${MONTH_FULL[monthIdx].slice(0, 1)}${MONTH_FULL[monthIdx].slice(1, 3).toLowerCase()} ${year}`;
const ymAbs = (year, monthIdx) => Number(year) * 12 + Number(monthIdx);
const absToDesc = (abs) => {
  const year = Math.floor(abs / 12);
  const monthIdx = abs - year * 12;
  return { year, monthIdx, label: monthLabel(year, monthIdx) };
};

export function manishMonthDescsBetween(startYear, startMonthIdx, endYear, endMonthIdx) {
  const start = ymAbs(startYear, startMonthIdx);
  const end = ymAbs(endYear, endMonthIdx);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => absToDesc(start + i));
}

export function manishAvailableYears(rows = [], currentYear = new Date().getFullYear()) {
  let maxYear = Math.max(MIN_EXPORT_YEAR, Number(currentYear) || MIN_EXPORT_YEAR);
  for (const r of rows || []) {
    for (const y of Object.keys(r?.byYear || {})) {
      const n = Number(y);
      if (Number.isFinite(n) && n >= MIN_EXPORT_YEAR) maxYear = Math.max(maxYear, n);
    }
  }
  return Array.from({ length: maxYear - MIN_EXPORT_YEAR + 1 }, (_, i) => MIN_EXPORT_YEAR + i);
}

export function buildManishExportData({ baseRows = [], subInvoices = new Map(), monthDescs = [], title = "" } = {}) {
  const subListFor = (r) =>
    (subInvoices?.get(r.sourceId) || []).filter(s => (s.kind || "sub") === "sub");

  const msmmAtDesc = (r, d) => {
    const yr = r.byYear?.[d.year];
    if (!yr) return 0;
    // MSMM is purely derived — stored override is no longer consulted.
    const total = Number(yr.values?.[d.monthIdx] || 0);
    const subSum = subListFor(r).reduce(
      (a, s) => a + Number(s.byYear?.[d.year]?.amounts?.[d.monthIdx] || 0), 0);
    return total - subSum;
  };

  // Include by the row's PERSPECTIVE role, matching the on-screen InvoiceTable
  // (invoicePerspectiveRole): a type='MHZ' row is always Prime — even though its
  // raw r.role is inherited from the source project where MSMM is a sub of MHZ
  // ("Sub"). Filtering on raw r.role dropped every MHZ row → "No Prime projects
  // with subs" despite the table clearly showing MHZ as Prime with subs A/B/C.
  // baseRows is the perspective set for sibling detection; when the export is
  // scoped to MHZ only, MHZ→Prime resolves without needing the ENG sibling.
  const included = (baseRows || []).filter(r =>
    invoicePerspectiveRole(r, baseRows) === "Prime" && subListFor(r).length > 0);

  const maxSubs = Math.max(3, ...included.map(r => subListFor(r).length));
  const rows = included.map(r => {
    const subs = subListFor(r);
    const subNames = Array.from({ length: maxSubs }, (_, j) => subs[j]?.companyName || "");
    const months = monthDescs.map((d) => {
      const yr = r.byYear?.[d.year] || {};
      return {
        msmmAmount: msmmAtDesc(r, d),
        invoiceNumber: (yr.invoiceNumbers && yr.invoiceNumbers[d.monthIdx]) || null,
        primePaid: !!(yr.primePaid && yr.primePaid[d.monthIdx]),
        primeHasFile: ((yr.primeFiles && yr.primeFiles[d.monthIdx]) || []).length > 0,
        subs: Array.from({ length: maxSubs }, (_, j) => {
          const s = subs[j];
          const sy = s?.byYear?.[d.year];
          if (!s) return { amount: null, paid: false, hasFile: false };
          return {
            amount: (sy?.amounts && sy.amounts[d.monthIdx]) ?? null,
            paid: !!(sy?.paid && sy.paid[d.monthIdx]),
            hasFile: ((sy?.files && sy.files[d.monthIdx]) || []).length > 0,
          };
        }),
      };
    });
    return { projectNumber: r.projectNumber, name: r.name, subNames, months };
  });

  return {
    monthTitles: monthDescs.map(monthTitle),
    maxSubs,
    rows,
    includedCount: included.length,
    title,
  };
}

export function buildManishYearSheets({ years = [], baseRows = [], subInvoices = new Map(), titleFor = null } = {}) {
  const sheets = (years || []).map(year => ({
    name: String(year),
    ...buildManishExportData({
      baseRows,
      subInvoices,
      monthDescs: manishMonthDescsBetween(Number(year), 0, Number(year), 11),
      title: titleFor ? titleFor(year) : "",
    }),
  }));
  return {
    sheets,
    includedCount: Math.max(0, ...sheets.map(s => s.includedCount || 0)),
  };
}

function safeSheetName(name, fallback = "Invoices") {
  const cleaned = String(name || fallback).replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
  return cleaned || fallback;
}

function buildConsolidatedSheet(ws, data, colWidths) {
  // monthTitles drives the section titles (e.g. "MARCH 2026") and the number of
  // stacked sections — one per month in the rolling window (spans years).
  const { maxSubs, monthTitles, title } = data;
  const rows = [...data.rows].sort(byProjectNumber);
  const lastAmt = lastAmountCol(maxSubs);

  // Column widths.
  for (const [col, width] of Object.entries(colWidths)) {
    ws.getColumn(Number(col)).width = width;
  }

  let rowNum = 1;

  // Export title — a bold, larger, WRAPPED banner describing what this export
  // is for (time period · types · sort). Merged across the full used width
  // (B → last amount column) so it can never be hidden behind a narrow column.
  if (title) {
    const lastCol = Math.max(TOTAL_COL, lastAmt);
    ws.mergeCells(rowNum, PROJNO_COL, rowNum, lastCol);
    const tCell = ws.getRow(rowNum).getCell(PROJNO_COL);
    tCell.value = title;
    tCell.font = { ...FONT, bold: true, size: 15 };
    tCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    ws.getRow(rowNum).height = 34;
    rowNum += 2; // title + a blank spacer row
  }

  // Legend (three swatch rows in column B).
  LEGEND.forEach(([text, argb], i) => {
    const cell = ws.getCell(`B${rowNum + i}`);
    cell.value = text;
    style(cell, { fill: { type: "pattern", pattern: "solid", fgColor: { argb } } });
  });
  rowNum += LEGEND.length + 1; // legend rows + a gap before the first month
  for (let mi = 0; mi < monthTitles.length; mi++) {
    // Month title — merged across B:E, bold, slightly larger.
    ws.mergeCells(rowNum, PROJNO_COL, rowNum, TOTAL_COL);
    const titleCell = ws.getRow(rowNum).getCell(PROJNO_COL);
    titleCell.value = monthTitles[mi];
    style(titleCell, { bold: true, size: 12 });
    rowNum++;

    // Header row (bold).
    const setHeader = (col, text) => {
      const cell = ws.getRow(rowNum).getCell(col);
      cell.value = text;
      style(cell, { bold: true });
    };
    setHeader(PROJNO_COL, "Project No.");
    setHeader(NAME_COL,   "Project Name");
    setHeader(INVNO_COL,  "Invoice No.");
    setHeader(TOTAL_COL,  "Total Invoice");
    setHeader(MSMM_COL,   "MSMM");
    for (let s = 0; s < maxSubs; s++) {
      setHeader(FIRST_SUB_COL + s * 2,     `Sub ${s + 1} Name`);
      setHeader(FIRST_SUB_COL + s * 2 + 1, `Sub ${s + 1} Amount`);
    }
    rowNum++;

    // Data rows.
    for (const r of rows) {
      const m = r.months[mi];
      const row = ws.getRow(rowNum);

      // B — Project number.
      row.getCell(PROJNO_COL).value = r.projectNumber || "";
      style(row.getCell(PROJNO_COL));

      // C — Project name.
      row.getCell(NAME_COL).value = r.name || "";
      style(row.getCell(NAME_COL));

      // D — Invoice number for this month (the prime/total invoice number).
      const invCell = row.getCell(INVNO_COL);
      invCell.value = m.invoiceNumber || "";
      style(invCell);

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

      // F — MSMM portion. Colored by the same prime status, gated on its amount.
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

    // Blank separator row before the next month.
    rowNum++;
  }
}

// data = {
//   monthTitles: ["MARCH 2026", …],   // one section per rolling-window month
//   maxSubs,
//   rows: [{ projectNumber, name, subNames:[…maxSubs], months:[…monthTitles.length of
//            { msmmAmount, invoiceNumber, primePaid, primeHasFile,
//              subs:[…maxSubs of { amount, paid, hasFile }] }] }]
// }
// Pure builder — returns a populated exceljs Workbook (no DOM/download).
// Split out so it can be unit-tested in Node without browser APIs.
export async function buildManishWorkbookObject(data) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MSMM Beacon";
  const sheets = Array.isArray(data?.sheets) && data.sheets.length > 0
    ? data.sheets
    : [{ name: "Invoices", ...data }];
  for (const sheet of sheets) {
    const colWidths = computeColWidths(sheet);
    const ws = wb.addWorksheet(safeSheetName(sheet.name));
    buildConsolidatedSheet(ws, sheet, colWidths);
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
