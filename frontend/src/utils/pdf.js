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

/**
 * Draw a filled five-point star as vector geometry.
 *
 * The reason this exists rather than a "★" in a cell: jsPDF's stock Helvetica
 * is WinAnsi/Latin-1 and has no U+2605, and jsPDF writes the code point's high
 * byte when it meets one — so "★★★" printed as "&&&". Falling back to ASCII
 * "***" encodes correctly but Helvetica's asterisk is a small superscript
 * glyph; at 7pt a row of them reads as apostrophes, not as a rating.
 *
 * A path has no encoding, no font, and no size floor. It is the same shape at
 * any scale and needs nothing embedded in the file.
 *
 * @param doc    jsPDF instance
 * @param cx,cy  centre, in the document's units (mm here)
 * @param outerR outer radius; the star spans 2*outerR
 * @param color  [r,g,b], 0-255
 */
export function drawStar(doc, cx, cy, outerR, color) {
  // 0.382 is the classic five-point ratio (1/phi^2) — the inner vertices sit
  // where the arms' edges would intersect if extended, which is what makes the
  // points read as sharp rather than as a blunt decagon.
  const innerR = outerR * 0.382;
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const angle = ((-90 + k * 36) * Math.PI) / 180;
    const r = k % 2 === 0 ? outerR : innerR;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  // doc.lines() takes RELATIVE segments from a starting point, so walk the
  // absolute vertices into deltas. `closed` joins the last point back to the
  // first; "F" fills without stroking, which keeps the edges crisp at 2mm.
  const deltas = [];
  for (let i = 1; i < pts.length; i++) {
    deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  }
  doc.setFillColor(color[0], color[1], color[2]);
  doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], "F", true);
}

/** Public path of the company mark drawn in the PDF footer.
 *  3299x816 RGBA, so roughly 4:1 — the drawing code reads the real ratio off
 *  the asset rather than assuming it, and a replacement of any proportion
 *  will render correctly. */
export const PDF_FOOTER_LOGO_SRC = "/msmm_logo.png";

/**
 * Load the footer logo once per session as a data URL.
 *
 * jsPDF's addImage needs the bytes, not a URL, so the file is fetched and read
 * into a data URL; the natural dimensions come back with it so the caller can
 * size by height and let the width follow the real aspect ratio rather than a
 * hardcoded guess that would squash the logo if the asset is ever replaced.
 *
 * Resolves to null on any failure, including the file simply not being there.
 * That is deliberate: a missing brand asset should cost you the logo, not the
 * export. The footer falls back to the "MSMM Beacon" wordmark.
 */
let _footerLogo;
export function loadFooterLogo() {
  if (_footerLogo !== undefined) return _footerLogo;
  _footerLogo = (async () => {
    try {
      const res = await fetch(PDF_FOOTER_LOGO_SRC, { cache: "force-cache" });
      if (!res.ok) return null;
      const blob = await res.blob();
      // A 200 is not proof the file exists. The dev server and most SPA hosts
      // answer an unknown path with index.html rather than a 404, so without a
      // type check the "logo" would be a page of markup that only fails later,
      // during decode.
      if (!blob.size || !/^image\//.test(blob.type)) return null;
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error("read failed"));
        fr.readAsDataURL(blob);
      });
      const dims = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = dataUrl;
      });
      if (!dims?.w || !dims?.h) return null;
      return { dataUrl, ratio: dims.w / dims.h };
    } catch {
      return null;
    }
  })();
  return _footerLogo;
}

export async function exportPDF(columns, rows, filename, options = {}) {
  const {
    title,
    subtitle,
    rowColor,             // (row) => [r,g,b] | null — row-level default fill
    cellStyle,            // (row, colIndex, col) => {fillColor?, textColor?, fontStyle?, halign?, lineWidth?, lineColor?} | null
    columnWidths,         // array of mm widths, or undefined to auto-plan
    format = "a4",        // "a4" | "a3" | "letter" | "tabloid" etc. Invoice uses a3
                          // so 12 month columns + totals can fit without
                          // crushing the Project column width below legibility.
    alternateRows = true, // Zebra striping; disabled for tables with rich
                          // per-cell coloring (like Invoice) so the striping
                          // doesn't fight the fill palette.
    onDidDrawCell,        // (data, row, col) => void — optional hook called
                          // after each body cell is drawn. Use to draw custom
                          // decorations (e.g. group bounding boxes) on top of
                          // the table. Receives autotable's `data` (which
                          // exposes `data.cell.{x,y,width,height}` and
                          // `data.doc`) plus the originating row+column.
    stampTime = true,     // Print "Exported <now>" in the header meta line.
                          // Turn off when the caller supplies its own stamp in
                          // `subtitle` so the line doesn't carry two.
    footerLogo = false,   // Draw the company logo in the page footer instead
                          // of the "MSMM Beacon" wordmark. Falls back to the
                          // wordmark when the asset is missing.
  } = options;

  const { jsPDF, autoTable } = await loadPdfDeps();
  // Resolved before the table is laid out because didDrawPage fires
  // synchronously per page and cannot await.
  const logo = footerLogo ? await loadFooterLogo() : null;
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
  // `stampTime: false` suppresses this line's own timestamp. Callers that put
  // one in `subtitle` themselves — with the app's formatting and the
  // exporter's name attached — would otherwise print the same fact twice, in
  // two different formats, on one line. Defaults to on so every existing
  // caller keeps the timestamp it has always had.
  const stamp = stampTime ? `Exported ${new Date().toLocaleString()} · ` : "";
  const meta = `${subtitle ? subtitle + " · " : ""}${stamp}${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
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
      // orange tinting. lineWidth/lineColor are honored too so callers
      // can suppress the default cell border (e.g. on spacer rows used
      // for group separation).
      if (cellStyle) {
        const col = columns[data.column.index];
        const s = cellStyle(row, data.column.index, col);
        if (s) {
          if (s.fillColor)         data.cell.styles.fillColor  = s.fillColor;
          if (s.textColor)         data.cell.styles.textColor  = s.textColor;
          if (s.fontStyle)         data.cell.styles.fontStyle  = s.fontStyle;
          if (s.halign)            data.cell.styles.halign     = s.halign;
          if (s.lineWidth != null) data.cell.styles.lineWidth  = s.lineWidth;
          if (s.lineColor)         data.cell.styles.lineColor  = s.lineColor;
        }
      }
    },
    didDrawCell: onDidDrawCell
      ? (data) => {
          if (data.section !== "body") return;
          const row = rows[data.row.index];
          const col = columns[data.column.index];
          onDidDrawCell(data, row, col);
        }
      : undefined,
    didDrawPage: (data) => {
      const pageNum = doc.getCurrentPageInfo().pageNumber;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(147, 137, 116);
      if (logo) {
        // Sized by height so the mark sits on the same baseline as the page
        // number; the width follows the asset's real aspect ratio.
        const h = 6;
        doc.addImage(logo.dataUrl, "PNG", margin, pageH - 3 - h, h * logo.ratio, h);
      } else {
        doc.text("MSMM Beacon", margin, pageH - 5);
      }
      doc.text(`Page ${pageNum}`, pageW - margin, pageH - 5, { align: "right" });
    },
  });

  doc.save(filename);
}
