// Local presentation filter only; records and linked relationships stay intact.
export function matchesDirectoryQuery(record, query, relatedTerms = []) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [record.baseName, record.name, record.type, record.contact,
    record.email, record.phone, record.address, record.district, record.orgType,
    ...relatedTerms].filter(Boolean).join(" ").toLowerCase();
  if (haystack.includes(needle)) return true;
  const digits = needle.replace(/\D/g, "");
  return digits.length >= 3 && /^[\d\s()+.\-]+$/.test(needle)
    && String(record.phone || "").replace(/\D/g, "").includes(digits);
}
