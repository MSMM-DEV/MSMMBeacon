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

// Serialize a cell value to a PDF-safe string. Long text is capped so a
// single 2000-char Notes cell can't blow up a row's rendered height into
// multiple pages — we trade completeness for layout integrity here (the
// full text is still viewable in the app; PDF is an at-a-glance export).
const CELL_MAX_CHARS = 400;
const cellText = (v) => {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = typeof v === "number" ? String(v) : String(v);
  if (s.length > CELL_MAX_CHARS) return s.slice(0, CELL_MAX_CHARS - 1) + "…";
  return s;
};

// Adaptive column width planner.
//
// Prior bug: `Math.max(0, usableWidth - fixedTotal)` could yield 0 for a
// flex column when declared fixed widths already exceeded the page
// (invoice: 12 month columns × 16 mm = 192 mm alone, plus the rest totaled
// 300 mm > 277 mm usable). That made `Project` 0 mm wide, wrapping every
// character onto its own line → row heights of many hundreds of mm → one
// row per many pages. Awaiting/Awarded had the softer variant: flex
// columns squeezed to 5–7 mm, making Notes wrap into 60+ lines per row.
//
// Invariants now enforced:
//   • Every flex column is guaranteed at least MIN_FLEX_MM width.
//   • If declared fixed widths overrun `usableWidth - flexReserve`, all
//     fixed widths scale DOWN proportionally instead of starving flex.
//   • Sum of returned widths always equals `usableWidth` (±rounding).
const MIN_FLEX_MM = 14;
function planColumnWidths(columns, usableWidth) {
  const fixed = columns.map(c => (typeof c.wMm === "number" ? c.wMm : null));
  const flexCount = fixed.filter(x => x == null).length;
  const declaredFixedTotal = fixed.reduce((a, b) => a + (b || 0), 0);

  // Reserve at least MIN_FLEX_MM for each flex column, or 25% of the page
  // (whichever is larger) so text-heavy columns always have room.
  const flexReserve = flexCount > 0
    ? Math.max(MIN_FLEX_MM * flexCount, usableWidth * 0.25)
    : 0;
  const fixedBudget = usableWidth - flexReserve;

  if (declaredFixedTotal === 0) {
    const flexW = flexCount ? usableWidth / flexCount : usableWidth;
    return fixed.map(() => flexW);
  }
  if (declaredFixedTotal <= fixedBudget) {
    // Plenty of room — keep declared fixed widths, share the rest.
    const flexW = flexCount > 0 ? (usableWidth - declaredFixedTotal) / flexCount : 0;
    return fixed.map(x => x == null ? flexW : x);
  }
  // Too much fixed — scale fixed columns down; flex columns each get MIN_FLEX_MM
  // (or their share of flexReserve if larger).
  const scale = fixedBudget / declaredFixedTotal;
  const flexW = flexCount > 0 ? flexReserve / flexCount : 0;
  return fixed.map(x => x == null ? flexW : x * scale);
}

export async function exportPDF(columns, rows, filename, options = {}) {
  const {
    title,
    subtitle,
    rowColor,             // (row) => [r,g,b] | null — row-level default fill
    cellStyle,            // (row, colIndex, col) => {fillColor?, textColor?, fontStyle?, halign?} | null
    columnWidths,         // array of mm widths, or undefined to auto-plan
    format = "a4",        // "a4" | "a3" | "letter" | "tabloid" etc. Invoice uses a3
                          // so 12 month columns + totals can fit without
                          // crushing the Project column width below legibility.
    alternateRows = true, // Zebra striping; disabled for tables with rich
                          // per-cell coloring (like Invoice) so the striping
                          // doesn't fight the fill palette.
  } = options;

  const { jsPDF, autoTable } = await loadPdfDeps();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const usableW = pageW - margin * 2;

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
    // Per-column overflow strategy:
    //   • Fixed-width columns (those that declared `wMm`) are intentionally
    //     short — truncate with "…" rather than wrap so Year / Role / Date
    //     cells stay single-line and don't drive row height up.
    //   • Flex columns (no `wMm`) are for variable content like project
    //     names and notes — wrap with linebreak so nothing is hidden.
    //   • Explicit `wrap: true` on a column forces linebreak regardless.
    //   • Explicit `truncate: true` forces ellipsize regardless.
    const col = columns[i];
    const isFixed = typeof col?.wMm === "number";
    let overflow;
    if (col?.wrap) overflow = "linebreak";
    else if (col?.truncate) overflow = "ellipsize";
    else overflow = isFixed ? "ellipsize" : "linebreak";
    const style = { cellWidth: w, overflow };
    // Column-level text alignment, e.g. right-align for money columns so
    // the export tracks the Invoice table's tabular-nums convention.
    if (col?.halign) style.halign = col.halign;
    columnStyles[i] = style;
  });

  autoTable(doc, {
    head,
    body,
    startY: margin + 15,
    margin: { left: margin, right: margin, top: margin + 15, bottom: margin + 8 },
    tableWidth: usableW,                    // pin to page width — no horizontal overflow
    styles: {
      font: "helvetica",
      // Tighter typography — dropping 7.8→7pt with 1.6mm padding gains ~15%
      // more characters per mm, which keeps flex columns usable on
      // column-heavy tables (awaiting, awarded, invoice).
      fontSize: 7,
      cellPadding: { top: 1.6, right: 1.8, bottom: 1.6, left: 1.8 },
      // Per-column mode (set in columnStyles above) overrides this default.
      // Kept at linebreak so any column without an explicit strategy wraps
      // rather than silently clips.
      overflow: "linebreak",
      lineColor: [230, 223, 209],
      lineWidth: 0.1,
      valign: "top",
      textColor: [34, 32, 28],
    },
    headStyles: {
      fillColor: [243, 238, 229],
      textColor: [34, 32, 28],
      fontStyle: "bold",
      fontSize: 6.8,
      lineColor: [214, 205, 188],
      lineWidth: 0.15,
      // Header row keeps linebreak so multi-word labels like "MSMM
      // Remaining" wrap neatly rather than ellipsize mid-word.
      overflow: "linebreak",
    },
    alternateRowStyles: alternateRows ? {
      fillColor: [251, 248, 242],
    } : {},
    columnStyles,
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const row = rows[data.row.index];

      // Layer 1: row-level default fill (e.g. Potential probability stripe)
      if (rowColor) {
        const color = rowColor(row);
        if (color) data.cell.styles.fillColor = color;
      }

      // Layer 2: per-cell overrides. cellStyle wins over rowColor so the
      // Invoice export can paint actual-month cells amber even on an
      // orange row — matching the Invoice UI's class precedence where
      // .month-actual / .month-proj / .total-cell override row-level
      // orange tinting.
      if (cellStyle) {
        const col = columns[data.column.index];
        const s = cellStyle(row, data.column.index, col);
        if (s) {
          if (s.fillColor)  data.cell.styles.fillColor  = s.fillColor;
          if (s.textColor)  data.cell.styles.textColor  = s.textColor;
          if (s.fontStyle)  data.cell.styles.fontStyle  = s.fontStyle;
          if (s.halign)     data.cell.styles.halign     = s.halign;
        }
      }
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
