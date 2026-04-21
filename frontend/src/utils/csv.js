// Minimal, dependency-free CSV exporter.
// Produces RFC 4180-compliant output with a UTF-8 BOM so Excel opens it correctly.

function normalize(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return String(v);
  return String(v);
}

function escapeCell(s) {
  // Wrap in quotes if the value contains comma, double-quote, CR or LF.
  // Internal double-quotes are doubled up per RFC 4180.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportCSV(columns, rows, filename = "export.csv") {
  const header = columns.map(c => escapeCell(normalize(c.label))).join(",");
  const body = (rows || []).map(row =>
    columns.map(c => {
      const raw = c.get ? c.get(row) : row[c.key];
      return escapeCell(normalize(raw));
    }).join(",")
  );

  // UTF-8 BOM + RFC 4180 CRLF separators.
  const text = "\uFEFF" + [header, ...body].join("\r\n");

  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
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
