// Landscape-A4 PDF export via jsPDF + jspdf-autotable.
//
// Design goals:
//  • All columns fit ON ONE PAGE WIDTH (landscape).
//  • Rows overflow to multiple pages — that's fine.
//  • Nothing gets cut: cells wrap (overflow: linebreak).
//  • Per-row fill color (e.g. Potential probability stripe) preserved.
//
// Usage:
//   exportPDF(columns, rows, "filename.pdf", {
//     title: "MSMM Beacon — Potential Projects",
//     rowColor: r => r.probability === "High" ? [213,226,197] : null,
//   });

// jsPDF + autotable are lazy-loaded on first export so the initial page bundle stays small.
let _pdfDeps = null;
const loadPdfDeps = async () => {
  if (!_pdfDeps) {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]);
    _pdfDeps = { jsPDF, autoTable };
  }
  return _pdfDeps;
};

// Serialize a cell value to a PDF-safe string.
// Note: we don't thousands-separate numbers here — callers pass money values
// already formatted (via fmtMoney). Bare numbers (years, counts) stay as-is.
const cellText = (v) => {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return String(v);
  return String(v);
};

// Match column width hints to the total usable width. Columns with a `wMm`
// hint get that fixed size; the rest share remaining width proportionally.
function planColumnWidths(columns, usableWidth) {
  const fixed = columns.map(c => (typeof c.wMm === "number" ? c.wMm : null));
  const fixedTotal = fixed.reduce((a, b) => a + (b || 0), 0);
  const flexCount = fixed.filter(x => x == null).length;
  const remaining = Math.max(0, usableWidth - fixedTotal);
  const flexW = flexCount ? remaining / flexCount : 0;
  return fixed.map(x => x == null ? flexW : x);
}

export async function exportPDF(columns, rows, filename, options = {}) {
  const {
    title,
    subtitle,
    rowColor,             // (row) => [r,g,b] | null
    columnWidths,         // array of mm widths, or undefined to auto-plan
  } = options;

  const { jsPDF, autoTable } = await loadPdfDeps();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();    // 297
  const pageH = doc.internal.pageSize.getHeight();   // 210
  const margin = 10;
  const usableW = pageW - margin * 2;                // 277

  // Header ------------------------------------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(34, 32, 28);
  doc.text(title || filename.replace(/\.pdf$/i, ""), margin, margin + 4);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110, 102, 89);
  const meta = `${subtitle ? subtitle + " · " : ""}Exported ${new Date().toLocaleString()} · ${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  doc.text(meta, margin, margin + 10);

  // Thin divider line
  doc.setDrawColor(214, 205, 188);
  doc.setLineWidth(0.2);
  doc.line(margin, margin + 12.5, pageW - margin, margin + 12.5);

  // Body --------------------------------------------------------------------
  const head = [columns.map(c => c.label)];
  const body = rows.map(r => columns.map(c => cellText(c.get ? c.get(r) : r[c.key])));

  const plannedWidths = columnWidths || planColumnWidths(columns, usableW);
  const columnStyles = {};
  plannedWidths.forEach((w, i) => {
    columnStyles[i] = { cellWidth: w };
  });

  autoTable(doc, {
    head,
    body,
    startY: margin + 15,
    margin: { left: margin, right: margin, top: margin + 15, bottom: margin + 8 },
    tableWidth: usableW,                    // pin to page width — no horizontal overflow
    styles: {
      font: "helvetica",
      fontSize: 7.8,
      cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
      overflow: "linebreak",               // wrap inside cell rather than clip
      lineColor: [230, 223, 209],
      lineWidth: 0.1,
      valign: "top",
      textColor: [34, 32, 28],
    },
    headStyles: {
      fillColor: [243, 238, 229],
      textColor: [34, 32, 28],
      fontStyle: "bold",
      fontSize: 7.5,
      lineColor: [214, 205, 188],
      lineWidth: 0.15,
    },
    alternateRowStyles: {
      fillColor: [251, 248, 242],
    },
    columnStyles,
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (!rowColor) return;
      const row = rows[data.row.index];
      const color = rowColor(row);
      if (color) data.cell.styles.fillColor = color;
    },
    didDrawPage: (data) => {
      const pageNum = doc.getCurrentPageInfo().pageNumber;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(147, 137, 116);
      doc.text("MSMM Beacon", margin, pageH - 5);
      doc.text(`Page ${pageNum}`, pageW - margin, pageH - 5, { align: "right" });
    },
  });

  doc.save(filename);
}
