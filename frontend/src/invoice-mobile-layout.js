import React from "react";

// Presentation only: the selected descriptor never changes the loaded window,
// financial calculations, export snapshot, or the existing editor instances.
export function resolveInvoiceFocusMonth(months, preferredAbs, year, monthIdx) {
  if (!months.length) return null;
  if (months.some(month => month.abs === preferredAbs)) return preferredAbs;
  const current = months.find(month => month.year === year && month.monthIdx === monthIdx);
  if (current) return current.abs;
  const target = preferredAbs ?? year * 12 + monthIdx;
  return months.reduce((nearest, month) =>
    Math.abs(month.abs - target) < Math.abs(nearest.abs - target) ? month : nearest).abs;
}

const META_LABELS = [null, "Project number", null, "Role", "Type", "Project managers", "Contract", "Rollforward"];
const TOTAL_LABELS = ["Total billed", "Total remaining", null];

// Decorate the existing native rows instead of creating a second mobile billing
// renderer. Children.map traverses arrays while retaining their stable keys;
// fragments remain fragments, handlers and original cell content stay intact.
// Column offsets follow the ledger header, including its explicit colSpans.
export function decorateInvoiceLedger(children, months, selectedAbs) {
  return React.Children.map(children, child => {
    if (!React.isValidElement(child)) return child;
    if (child.type === React.Fragment) {
      return React.cloneElement(child, {}, decorateInvoiceLedger(child.props.children, months, selectedAbs));
    }
    if (child.type !== "tr") return child;
    let column = 0;
    return React.cloneElement(child, { role: "row" }, React.Children.map(child.props.children, cell => {
      if (!React.isValidElement(cell) || cell.type !== "td") return cell;
      const start = column;
      const span = Number(cell.props.colSpan || 1);
      column += span;
      const month = span === 1 && start >= 8 ? months[start - 8] : null;
      const monthBasis = /\bmonth-proj\b/.test(cell.props.className || "") ? "Projection"
        : /\bmonth-promoted\b/.test(cell.props.className || "") ? "Actual · billed ahead"
          : /\bmonth-actual\b/.test(cell.props.className || "") ? "Actual" : "";
      const monthLabel = month ? `${month.label}${monthBasis ? ` · ${monthBasis}` : ""}` : null;
      const label = span > 1 ? null : monthLabel ??
        (start < 8 ? META_LABELS[start] : TOTAL_LABELS[start - 8 - months.length]);
      const empty = cell.props.children == null || cell.props.children === false;
      const className = [cell.props.className, `invoice-mobile-col-${start < 8 ? start : month ? "month" : start - months.length}`,
        span > 1 && "invoice-mobile-wide", empty && "invoice-mobile-empty"].filter(Boolean).join(" ");
      return React.cloneElement(cell, {
        className,
        role: "cell",
        ...(month ? { "data-mobile-selected": month.abs === selectedAbs } : {}),
      }, label && !empty ? [
        React.createElement("span", { className: "invoice-mobile-field-label", key: "mobile-field-label" }, label),
        React.createElement(React.Fragment, { key: "mobile-content" }, cell.props.children),
      ] : cell.props.children);
    }));
  });
}
