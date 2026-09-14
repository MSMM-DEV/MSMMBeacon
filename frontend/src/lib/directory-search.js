// Local presentation filter only; records and linked relationships stay intact.
// A record may carry MANY contact people (`record.contacts`, see
// beacon_v2.contacts); every person's name / title / email / phone is
// searchable, not just the primary's summary trio.
export function matchesDirectoryQuery(record, query, relatedTerms = []) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const people = Array.isArray(record.contacts) ? record.contacts : [];
  const haystack = [record.baseName, record.name, record.type, record.contact,
    record.email, record.phone, record.address, record.district, record.orgType,
    ...people.flatMap(p => [p.name, p.title, p.email, p.phone, p.notes]),
    ...relatedTerms].filter(Boolean).join(" ").toLowerCase();
  if (haystack.includes(needle)) return true;
  const digits = needle.replace(/\D/g, "");
  if (!(digits.length >= 3 && /^[\d\s()+.\-]+$/.test(needle))) return false;
  const phones = [record.phone, ...people.map(p => p.phone)].filter(Boolean);
  return phones.some(ph => String(ph).replace(/\D/g, "").includes(digits));
}
