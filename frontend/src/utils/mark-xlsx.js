// "Print for Mark" / "Print for Mark - Subs" — Excel (.xlsx) exporters.
//
// These are the Excel counterparts to the existing PDF exports for the same two
// buttons. Layout is a month-COLUMN grid (one tab per year), which mirrors the
// on-screen InvoiceTable — distinct from "Print for Manish", which stacks the
// months as vertical sections on a single sheet.
//
//   • variant "grid"  → one row per project; each month cell is the project
//     total for that (year, month), same value the InvoiceTable shows.
//   • variant "subs"  → each project expands into a bold total row followed by
//     its constituent lines (subs, primes, MSMM, and — for MHZ/MHZ PM JV
//     projects — the prime remainder), whose month values sum back to the total.
//   • variant "msmm"  → one row per project; each month cell is MSMM's OWN
//     portion for that (year, month) — the value on the project's first (MSMM)
//     row in the InvoiceTable — instead of the project total. Same layout,
//     colors, and styling as "grid"; only the values differ. Backs the
//     "Print for Randy" button.
//
// The "subs" and "msmm" variants additionally carry three whole-project-scope
// summary columns per line — Contract (before the months) and Total Billed /
// Total Remaining (after the in-scope Total) — computed with the exact
// InvoiceTable math (Total Billed = Contract − Rollforward + attachment-gated
// Actuals from INVOICE_ACTUALS_MIN_YEAR onward; Remaining = Contract − Billed).
//
// Value resolution is shared with the InvoiceTable via the invoice-perspectives
// helpers so the numbers match the app exactly (incl. the independent MSMM sub
// on linked ENG↔MHZ / PM↔MHZ PM projects). Every sheet carries an export
// date+time banner. exceljs is dynamically imported so it stays out of the
// initial bundle until an export runs.

import {
  baseTypeForHz,
  isHzPrimeType,
  isMhzPerspectiveSub,
  invoiceRemainderValue,
  linkedMsmmValue,
  normInvoicePerspectiveNumber,
} from "../invoice-perspectives.js";
import {
  MONEY_FMT,
  FONT,
  statusFill,
  safeSheetName,
  downloadWorkbook,
} from "./manish-xlsx.js";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const HEADER_INK = "FF6E6659"; // --text-muted-ish, italic timestamp/notes

// Fixed columns: A Proj# · B Name · C Type · D… months · last Total.
const PROJ_COL = 1;
const NAME_COL = 2;
const TYPE_COL = 3;
const FIRST_MONTH_COL = 4;

// Ascending, numeric-aware ("017" < "202401", "9" < "10").
function byProjNumber(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, {
    numeric: true, sensitivity: "base",
  });
}

// [{year, monthIdx}] → [{ year, months:[idx…] }] ascending, de-duped.
function groupByYear(monthDescs) {
  const map = new Map();
  for (const d of monthDescs || []) {
    const y = Number(d.year);
    if (!Number.isFinite(y)) continue;
    if (!map.has(y)) map.set(y, new Set());
    map.get(y).add(Number(d.monthIdx));
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, set]) => ({ year, months: [...set].sort((a, b) => a - b) }));
}

// Per-(row, year, monthIdx) resolvers. `allRows` lets an HZ row locate its
// linked base (ENG/PM) row that owns the authoritative MSMM figures.
// `actualsMinYear` gates the Total-Billed "Actuals" sum (attachment-counted
// months) to INVOICE_ACTUALS_MIN_YEAR onward, mirroring the InvoiceTable —
// pre-2026 billing is already captured by Contract − Rollforward.
function makeResolvers(allRows, subInvoices, actualsMinYear = 2026) {
  const entriesFor   = (r) => subInvoices?.get(r.sourceId) || [];
  const subListFor   = (r) => entriesFor(r).filter(s => (s.kind || "sub") === "sub");
  const primeListFor = (r) => entriesFor(r).filter(s => s.kind === "prime");

  const partyAmt  = (s, y, i) => Number(s?.byYear?.[y]?.amounts?.[i] || 0);
  const partyPaid = (s, y, i) => !!(s?.byYear?.[y]?.paid && s.byYear[y].paid[i]);
  const partyFile = (s, y, i) => ((s?.byYear?.[y]?.files && s.byYear[y].files[i]) || []).length > 0;

  const msmmSourceFor = (r) => {
    const baseType = baseTypeForHz(r.type);
    if (!baseType) return r;
    const number = normInvoicePerspectiveNumber(r.projectNumber);
    return (allRows || []).find(c =>
      (c.type || "ENG") === baseType && (
        (r.sourceId && c.sourceId === r.sourceId) ||
        (number && normInvoicePerspectiveNumber(c.projectNumber) === number)
      )) || r;
  };
  const msmmAt = (r, y, i) => {
    const src = msmmSourceFor(r);
    const yr = src.byYear?.[y];
    if (!yr) return 0;
    return linkedMsmmValue({
      linked: isMhzPerspectiveSub(src, allRows),
      storedValue: yr.msmmValues?.[i],
      total: Number(yr.values?.[i] || 0),
      subValues: subListFor(src).map(s => partyAmt(s, y, i)),
    });
  };

  const projTotalAt = (r, y, i) => Number(r.byYear?.[y]?.values?.[i] || 0);
  const primePaidAt = (r, y, i) => !!(r.byYear?.[y]?.primePaid && r.byYear[y].primePaid[i]);
  const primeFileAt = (r, y, i) => ((r.byYear?.[y]?.primeFiles && r.byYear[y].primeFiles[i]) || []).length > 0;
  // JV (HZ) prime remainder: project total − Σ real subs − MSMM.
  const hzRemainderAt = (r, y, i) => invoiceRemainderValue(projTotalAt(r, y, i), [
    ...subListFor(r).map(s => partyAmt(s, y, i)),
    msmmAt(r, y, i),
  ]);

  // ---- Contract / Total Billed / Total Remaining (whole-project scope) ----
  // Mirrors the InvoiceTable math exactly (tables.jsx):
  //   Total Billed    = Contract − Rollforward + Actuals(attached, ≥ actualsMinYear)
  //   Total Remaining = Contract − Total Billed
  // Rollforward = the stored "remaining to bill at year start", else the line's
  // full contract (nothing billed before the loaded window).
  const yearsOfRow = (r) => Object.keys(r?.byYear || {}).map(Number);
  const projectBilledAttached = (r) => yearsOfRow(r).reduce((a, y) => {
    if (y < actualsMinYear) return a;
    const yr = r.byYear?.[y]; if (!yr) return a;
    let t = 0;
    for (let m = 0; m < 12; m++) if (((yr.primeFiles || [])[m] || []).length > 0) t += Number(yr.values?.[m] || 0);
    return a + t;
  }, 0);
  const subBilledAttached = (s) => Object.entries(s?.byYear || {}).reduce((a, [y, yr]) => {
    if (Number(y) < actualsMinYear) return a;
    let t = 0;
    for (let m = 0; m < 12; m++) if (((yr?.files || [])[m] || []).length > 0) t += Number(yr?.amounts?.[m] || 0);
    return a + t;
  }, 0);
  // MSMM Actuals — a month's MSMM value counts only when the base row's
  // total/prime cell has an invoice attached (MSMM's attachments live on the
  // base ENG/PM row's prime store).
  const msmmBilledAttached = (r) => {
    const src = msmmSourceFor(r);
    return yearsOfRow(src).reduce((a, y) => {
      if (y < actualsMinYear) return a;
      const yr = src.byYear?.[y]; if (!yr) return a;
      let t = 0;
      for (let m = 0; m < 12; m++) if (((yr.primeFiles || [])[m] || []).length > 0) t += msmmAt(src, y, m);
      return a + t;
    }, 0);
  };
  // ---- Contract AMENDMENTS -----------------------------------------------
  // Contract Value = contract amount + Σ amendments, exactly as the on-screen
  // InvoiceTable computes it. App.jsx annotates each merged row with
  // `amendmentsTotal` and each real sub entry with `amendments` before calling
  // in; both fall back to 0/[] so an un-annotated caller gets the old numbers.
  const amdTotal = (list) => (list || []).reduce((a, x) => a + Number(x?.amount || 0), 0);
  const projContract = (r) => Number(r?.amount || 0) + Number(r?.amendmentsTotal || 0);
  const subContract  = (s) => Number(s?.contractAmount || 0) + amdTotal(s?.amendments);

  const msmmContract = (r) => {
    const src = msmmSourceFor(r);
    return linkedMsmmValue({
      linked: isMhzPerspectiveSub(src, allRows),
      storedValue: src.msmmAmount,
      total: projContract(src),
      subValues: subListFor(src).map(subContract),
    });
  };
  const projectRollforward = (r) => (r.totalRemainingStart != null && r.totalRemainingStart !== "") ? Number(r.totalRemainingStart) : projContract(r);
  const subRollforward     = (s) => (s.remainingStart != null && s.remainingStart !== "") ? Number(s.remainingStart) : subContract(s);
  const msmmRollforward    = (r) => {
    const src = msmmSourceFor(r);
    return (src.remainingStart != null && src.remainingStart !== "") ? Number(src.remainingStart) : msmmContract(r);
  };
  const projectTotalBilled = (r) => projContract(r) - projectRollforward(r) + projectBilledAttached(r);
  const subTotalBilled     = (s) => subContract(s) - subRollforward(s) + subBilledAttached(s);
  const msmmTotalBilled    = (r) => msmmContract(r) - msmmRollforward(r) + msmmBilledAttached(r);

  return {
    subListFor, primeListFor, partyAmt, partyPaid, partyFile,
    msmmAt, projTotalAt, primePaidAt, primeFileAt, hzRemainderAt,
    msmmContract, projectTotalBilled, subTotalBilled, msmmTotalBilled,
    projContract, subContract,
  };
}

// Build layout-ready sheet objects (pure — unit-testable without exceljs).
// Returns { sheets: [{ name, title, exportedAt, monthCols, rows, includedCount }], includedCount }.
// A project is skipped on a year's sheet when it billed nothing in that sheet's
// in-scope months, so per-year tabs only list the projects active that year.
export function buildInvoiceGridSheets({
  variant = "grid",
  baseRows = [],
  allRows = baseRows,
  subInvoices = new Map(),
  monthDescs = [],
  titleFor = null,
  isActualMonth = () => true,
  exportedAt = "",
  actualsMinYear = 2026,
} = {}) {
  const R = makeResolvers(allRows, subInvoices, actualsMinYear);
  const groups = groupByYear(monthDescs);
  // "subs" + "msmm" carry three whole-project-scope summary columns per line
  // (Contract · Total Billed · Total Remaining), mirroring the InvoiceTable's
  // pinned pair + Contract column. The plain Mark grid stays unchanged.
  const hasSummary = variant !== "grid";
  const displayNumber = (r) => isHzPrimeType(r.type) ? (r.mhzProjectNumber || r.projectNumber) : r.projectNumber;
  const displayName   = (r) => isHzPrimeType(r.type) ? (r.mhzProjectName || r.name) : r.name;

  let includedTotal = 0;

  const sheets = groups.map(({ year, months }) => {
    const monthCols = months.map(i => ({
      monthIdx: i,
      label: `${MONTHS_SHORT[i]} ${year}`,
      isActual: !!isActualMonth(year, i),
    }));
    const projects = [...baseRows].sort((a, b) => byProjNumber(displayNumber(a), displayNumber(b)));

    const rows = [];
    let included = 0;

    const cellsFor = (fillPaid, fillFile, valueAt) =>
      monthCols.map(mc => {
        const value = valueAt(mc.monthIdx);
        return { value, fill: mc.isActual ? statusFill(fillPaid(mc.monthIdx), fillFile(mc.monthIdx), value) : null };
      });

    for (const r of projects) {
      const proj = displayNumber(r);
      const name = displayName(r);
      const type = r.type || "ENG";

      // Whole-project-scope summaries (year-independent — the same on every
      // sheet). summarize() derives Remaining as Contract − Billed at each line.
      const summarize = (contract, billed) => ({
        contract: Number(contract || 0),
        billed: Number(billed || 0),
        remaining: Number(contract || 0) - Number(billed || 0),
      });

      // "msmm" (Print for Randy) exports MSMM's own portion per month instead
      // of the project total; the skip rule then keys off the exported metric.
      const valueAt = variant === "msmm"
        ? (i) => R.msmmAt(r, year, i)
        : (i) => R.projTotalAt(r, year, i);
      const projCells = cellsFor(
        (i) => R.primePaidAt(r, year, i),
        (i) => R.primeFileAt(r, year, i),
        valueAt,
      );
      // Skip projects with no billing in this sheet's months.
      if (!projCells.some(c => c.value)) continue;
      included += 1;

      if (variant === "msmm") {
        rows.push({
          proj, name, type, level: 0, bold: false, cells: projCells,
          ...summarize(R.msmmContract(r), R.msmmTotalBilled(r)),
        });
        continue;
      }
      if (variant !== "subs") {
        rows.push({ proj, name, type, level: 0, bold: false, cells: projCells });
        continue;
      }

      // subs variant — total row + constituent lines.
      rows.push({
        proj, name, type, level: 0, bold: true, cells: projCells,
        ...summarize(R.projContract(r), R.projectTotalBilled(r)),
      });

      // HZ prime remainder (base ENG/PM projects have none: total = MSMM + subs).
      if (isHzPrimeType(r.type)) {
        const rem = cellsFor(
          (i) => R.primePaidAt(r, year, i),
          (i) => R.primeFileAt(r, year, i),
          (i) => R.hzRemainderAt(r, year, i),
        );
        // Remainder summary mirrors the in-app HZ white first row: project-scope
        // value minus every constituent line (real subs + MSMM), per column.
        const remContract = invoiceRemainderValue(R.projContract(r), [
          ...R.subListFor(r).map(R.subContract), R.msmmContract(r)]);
        const remBilled = invoiceRemainderValue(R.projectTotalBilled(r), [
          ...R.subListFor(r).map(R.subTotalBilled), R.msmmTotalBilled(r)]);
        if (rem.some(c => c.value)) rows.push({
          proj: "", name: "MHZ (prime)", type: "Prime", level: 1, bold: false, cells: rem,
          ...summarize(remContract, remBilled),
        });
      }

      for (const s of R.subListFor(r)) {
        const disc = s.discipline ? ` (${s.discipline})` : "";
        rows.push({
          proj: "", name: `Sub · ${s.companyName || "Sub"}${disc}`, type: "Sub", level: 1, bold: false,
          cells: cellsFor((i) => R.partyPaid(s, year, i), (i) => R.partyFile(s, year, i), (i) => R.partyAmt(s, year, i)),
          ...summarize(R.subContract(s), R.subTotalBilled(s)),
        });
      }
      for (const p of R.primeListFor(r)) {
        rows.push({
          proj: "", name: `Prime · ${p.companyName || "Prime"}`, type: "Prime", level: 1, bold: false,
          cells: cellsFor((i) => R.partyPaid(p, year, i), (i) => R.partyFile(p, year, i), (i) => R.partyAmt(p, year, i)),
          ...summarize(R.subContract(p), R.subTotalBilled(p)),
        });
      }

      const msmm = cellsFor(
        (i) => R.primePaidAt(r, year, i),
        (i) => R.primeFileAt(r, year, i),
        (i) => R.msmmAt(r, year, i),
      );
      if (msmm.some(c => c.value)) rows.push({
        proj: "", name: "MSMM", type: "MSMM", level: 1, bold: false, cells: msmm,
        ...summarize(R.msmmContract(r), R.msmmTotalBilled(r)),
      });

      rows.push({ spacer: true, cells: monthCols.map(() => ({ value: null })) });
    }

    // Trim a trailing spacer.
    while (rows.length && rows[rows.length - 1].spacer) rows.pop();

    // Row totals (Σ in-scope months).
    for (const row of rows) {
      row.total = row.spacer ? null : row.cells.reduce((a, c) => a + (Number(c.value) || 0), 0);
    }

    includedTotal = Math.max(includedTotal, included);
    return {
      name: String(year),
      title: titleFor ? titleFor(year) : "",
      exportedAt,
      monthCols,
      rows,
      hasSummary,
      includedCount: included,
    };
  }).filter(s => s.rows.length > 0);

  return { sheets, includedCount: includedTotal };
}

function paintGridSheet(ws, sheet, exportedAt) {
  const { monthCols = [], rows = [], title = "", hasSummary = false } = sheet;
  // With summaries, a "Contract" column slots in before the months and the
  // "Total Billed" / "Total Remaining" pair follows the in-scope "Total" —
  // mirroring the InvoiceTable's Contract column + pinned end pair.
  const contractCol = hasSummary ? FIRST_MONTH_COL : null;
  const firstMonthCol = hasSummary ? FIRST_MONTH_COL + 1 : FIRST_MONTH_COL;
  const totalCol = firstMonthCol + monthCols.length;
  const billedCol = hasSummary ? totalCol + 1 : null;
  const remainCol = hasSummary ? totalCol + 2 : null;
  const lastCol = hasSummary ? remainCol : totalCol;

  const styleC = (cell, { money = false, bold = false, fill = null, size = null, italic = false, color = null, indent = 0, align = "left" } = {}) => {
    cell.font = {
      ...FONT,
      ...(bold ? { bold: true } : {}),
      ...(size ? { size } : {}),
      ...(italic ? { italic: true } : {}),
      ...(color ? { color: { argb: color } } : {}),
    };
    cell.alignment = { horizontal: align, vertical: "middle", ...(indent ? { indent } : {}) };
    if (money) cell.numFmt = MONEY_FMT;
    if (fill) cell.fill = fill;
  };

  let rowNum = 1;

  // Export timestamp — every sheet.
  if (exportedAt) {
    ws.mergeCells(rowNum, PROJ_COL, rowNum, lastCol);
    const c = ws.getRow(rowNum).getCell(PROJ_COL);
    c.value = `Exported ${exportedAt}`;
    styleC(c, { italic: true, size: 10, color: HEADER_INK });
    rowNum += 1;
  }

  // Title banner.
  if (title) {
    ws.mergeCells(rowNum, PROJ_COL, rowNum, lastCol);
    const t = ws.getRow(rowNum).getCell(PROJ_COL);
    t.value = title;
    t.font = { ...FONT, bold: true, size: 14 };
    t.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    ws.getRow(rowNum).height = 30;
    rowNum += 2;
  }

  // Header row.
  const hdr = ws.getRow(rowNum);
  const setH = (col, text) => { const cc = hdr.getCell(col); cc.value = text; styleC(cc, { bold: true }); };
  setH(PROJ_COL, "Project No.");
  setH(NAME_COL, "Project Name");
  setH(TYPE_COL, "Type");
  if (hasSummary) setH(contractCol, "Contract");
  monthCols.forEach((mc, i) => setH(firstMonthCol + i, mc.label));
  setH(totalCol, "Total");
  if (hasSummary) { setH(billedCol, "Total Billed"); setH(remainCol, "Total Remaining"); }
  rowNum++;

  // Data rows.
  for (const row of rows) {
    if (row.spacer) { rowNum++; continue; }
    const r = ws.getRow(rowNum);
    const indent = row.level ? 1 : 0;

    const projCell = r.getCell(PROJ_COL);
    projCell.value = row.proj || "";
    styleC(projCell, { bold: row.bold });

    const nameCell = r.getCell(NAME_COL);
    nameCell.value = row.name || "";
    styleC(nameCell, { bold: row.bold, indent });

    const typeCell = r.getCell(TYPE_COL);
    typeCell.value = row.type || "";
    styleC(typeCell, { bold: row.bold });

    const moneyAt = (col, value, { bold = row.bold } = {}) => {
      const cell = r.getCell(col);
      cell.value = (value != null && value !== 0) ? Number(value) : null;
      styleC(cell, { money: true, bold });
    };
    if (hasSummary) moneyAt(contractCol, row.contract);

    row.cells.forEach((c, i) => {
      const cell = r.getCell(firstMonthCol + i);
      cell.value = (c.value != null && c.value !== 0) ? Number(c.value) : null;
      styleC(cell, { money: true, bold: row.bold, fill: c.fill });
    });

    moneyAt(totalCol, row.total, { bold: true });
    if (hasSummary) { moneyAt(billedCol, row.billed); moneyAt(remainCol, row.remaining); }

    rowNum++;
  }

  // Column widths.
  ws.getColumn(PROJ_COL).width = 12;
  ws.getColumn(NAME_COL).width = 34;
  ws.getColumn(TYPE_COL).width = 9;
  if (hasSummary) ws.getColumn(contractCol).width = 14;
  monthCols.forEach((_, i) => { ws.getColumn(firstMonthCol + i).width = 13; });
  ws.getColumn(totalCol).width = 15;
  if (hasSummary) { ws.getColumn(billedCol).width = 14; ws.getColumn(remainCol).width = 16; }
}

export async function buildInvoiceGridWorkbookObject({ sheets = [], exportedAt = "" } = {}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MSMM Beacon";
  const list = sheets.length ? sheets : [{ name: "Invoices", monthCols: [], rows: [] }];
  for (const sheet of list) {
    const ws = wb.addWorksheet(safeSheetName(sheet.name));
    paintGridSheet(ws, sheet, sheet.exportedAt || exportedAt);
  }
  return wb;
}

export async function exportInvoiceGridWorkbook(payload, filename = "invoice-mark.xlsx") {
  const wb = await buildInvoiceGridWorkbookObject(payload);
  await downloadWorkbook(wb, filename);
}
