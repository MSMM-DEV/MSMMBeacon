export function invoiceIsOrange(row, orangeSourceIds) {
  if (!row) return false;
  if (row.invoiceOrange != null) return !!row.invoiceOrange;
  return !!(row.sourceId && orangeSourceIds?.has?.(row.sourceId));
}

export function nextInvoiceOrangePatch(row, orangeSourceIds) {
  return { invoiceOrange: !invoiceIsOrange(row, orangeSourceIds) };
}
