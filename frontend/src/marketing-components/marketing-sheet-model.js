export async function attemptMarketingSectionSave({ api, id, draft, version }) {
  if (typeof api !== "function") throw new Error("A Marketing save API is required");
  return api(id, draft, version);
}

export function changedMarketingFields(server = {}, draft = {}) {
  return Object.keys(draft).filter(key => JSON.stringify(server[key] ?? null) !== JSON.stringify(draft[key] ?? null));
}
