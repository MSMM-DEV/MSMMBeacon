function normalizeContact(contact) {
  return {
    ...contact,
    id: contact.id,
    companyId: contact.companyId ?? contact.company_id ?? null,
    name: contact.name || "",
    title: contact.title || "",
    email: contact.email || "",
    phone: contact.phone || "",
    notes: contact.notes || "",
    isPrimary: !!(contact.isPrimary ?? contact.is_primary),
    ord: contact.ord ?? 0,
    createdAt: contact.createdAt ?? contact.created_at ?? null,
    updatedAt: contact.updatedAt ?? contact.updated_at ?? null,
  };
}

export function sortDirectoryContacts(contacts = []) {
  return contacts
    .map(normalizeContact)
    .sort((a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) ||
      (a.ord ?? 0) - (b.ord ?? 0) ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
    );
}

export function adaptDirectoryCompany(row, contacts = [], relationshipRoles = []) {
  const orderedContacts = sortDirectoryContacts(contacts);
  const primary = orderedContacts[0] || null;
  return {
    id: row.id,
    name: row.name || "",
    baseName: row.name || "",
    district: row.district || "",
    orgType: row.org_type ?? row.orgType ?? "",
    website: row.website || "",
    address: row.address || "",
    notes: row.notes || "",
    isMsmm: !!(row.is_msmm ?? row.isMsmm),
    relationshipRoles: [...new Set(relationshipRoles.filter(Boolean))].sort(),
    contacts: orderedContacts,
    contact: primary?.name || row.contact_person || row.contact || "",
    email: primary?.email || row.email || "",
    phone: primary?.phone || row.phone || "",
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

export function companyPickerOptions(companies = []) {
  return [...companies]
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map(company => ({ value: company.id, label: company.name }));
}
