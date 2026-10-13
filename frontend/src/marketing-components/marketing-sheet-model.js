export async function attemptMarketingSectionSave({ api, id, draft, version }) {
  if (typeof api !== "function") throw new Error("A Marketing save API is required");
  return api(id, draft, version);
}

export function changedMarketingFields(server = {}, draft = {}) {
  return Object.keys(draft).filter(key => JSON.stringify(server[key] ?? null) !== JSON.stringify(draft[key] ?? null));
}

export function mergeMarketingRelations(opportunity, relations = {}) {
  return {
    ...opportunity,
    contacts: relations.contacts || [],
    activities: relations.activities || [],
    tasks: relations.tasks || [],
    documents: relations.documents || [],
    history: relations.history || [],
  };
}

export function marketingDirectoryContactOptions(companies = [], linkedContacts = [], search = "") {
  const linkedIds = new Set((linkedContacts || []).map(link => link.contactId || link.id).filter(Boolean));
  const query = String(search || "").trim().toLowerCase();
  return (companies || []).flatMap(company => (company.contacts || []).map(contact => ({
    id: contact.id,
    name: contact.name || "Unnamed contact",
    email: contact.email || "",
    companyId: company.id,
    companyName: company.name || "Unnamed organization",
    label: `${contact.name || "Unnamed contact"} — ${company.name || "Unnamed organization"}`,
  }))).filter(contact => {
    if (!contact.id || linkedIds.has(contact.id)) return false;
    if (!query) return true;
    return `${contact.name} ${contact.email} ${contact.companyName}`.toLowerCase().includes(query);
  }).sort((a, b) =>
    a.companyName.localeCompare(b.companyName) || a.name.localeCompare(b.name)
  );
}

export async function saveMarketingStakeholder({
  opportunityId,
  companyId,
  form = {},
  createContact,
  linkContact,
  refreshDirectory,
}) {
  let contactId = form.contactId || null;
  let created = false;
  if (!contactId && String(form.newName || "").trim()) {
    if (!companyId) throw new Error("Choose an organization before creating a Directory contact.");
    const contact = await createContact({
      companyId,
      name: String(form.newName).trim(),
      email: String(form.newEmail || "").trim(),
    });
    contactId = contact.id;
    created = true;
  }
  if (!contactId) throw new Error("Choose or create a Directory contact.");
  const linked = await linkContact({
    opportunityId,
    contactId,
    role: form.role || "Other",
    isPrimary: !!form.isPrimary,
    notes: form.notes || "",
  });
  let directory = null;
  let refreshError = null;
  if (created && refreshDirectory) {
    try { directory = await refreshDirectory(); }
    catch (error) { refreshError = error?.message || "Directory refresh failed"; }
  }
  return refreshError ? { linked, directory, refreshError } : { linked, directory };
}

export function toMarketingDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromMarketingDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
