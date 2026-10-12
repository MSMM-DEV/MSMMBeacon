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
