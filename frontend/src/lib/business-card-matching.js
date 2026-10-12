const LEGAL_SUFFIXES = /\b(incorporated|inc|llc|ltd|limited|corporation|corp|company|co|pllc|llp|lp)\b/g;
const GENERIC_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com",
  "aol.com", "proton.me", "protonmail.com",
]);

const clean = value => String(value || "").trim();
const normalizeText = value => clean(value).toLowerCase().replace(/\s+/g, " ");

export const normalizeEmail = value => clean(value).toLowerCase();

export const normalizePhone = value => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};

export const normalizeCompanyName = value => String(value || "")
  .toLowerCase()
  .replace(LEGAL_SUFFIXES, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

function normalizeDomain(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return "";
  const emailAt = raw.lastIndexOf("@");
  if (emailAt >= 0) return raw.slice(emailAt + 1).replace(/^www\./, "").split(/[/?#]/)[0];
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  }
}

function candidateShape(raw = {}) {
  const extraDetails = Array.isArray(raw.extraDetails) ? raw.extraDetails.filter(Boolean) : [];
  return {
    ...raw,
    sourceId: clean(raw.sourceId),
    cardIndex: Number.isFinite(Number(raw.cardIndex)) ? Number(raw.cardIndex) : 0,
    personName: clean(raw.personName),
    title: clean(raw.title),
    email: clean(raw.email),
    phone: clean(raw.phone),
    companyName: clean(raw.companyName),
    companyWebsite: clean(raw.companyWebsite),
    companyAddress: clean(raw.companyAddress),
    district: clean(raw.district),
    orgType: clean(raw.orgType),
    notes: clean(raw.notes) || extraDetails.join("\n"),
    extraDetails,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean) : [],
  };
}

function indexBy(list, keyOf) {
  const map = new Map();
  for (const value of list) {
    const key = keyOf(value);
    if (!key) continue;
    const bucket = map.get(key) || [];
    bucket.push(value);
    map.set(key, bucket);
  }
  return map;
}

function uniqueById(list) {
  return [...new Map(list.map(value => [value.id, value])).values()];
}

function levenshtein(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const FIELD_EQUAL = {
  email: (a, b) => normalizeEmail(a) === normalizeEmail(b),
  phone: (a, b) => normalizePhone(a) === normalizePhone(b),
  name: (a, b) => normalizeText(a) === normalizeText(b),
  title: (a, b) => normalizeText(a) === normalizeText(b),
  website: (a, b) => normalizeDomain(a) === normalizeDomain(b),
  address: (a, b) => normalizeText(a) === normalizeText(b),
  district: (a, b) => normalizeText(a) === normalizeText(b),
  orgType: (a, b) => normalizeText(a) === normalizeText(b),
  notes: (a, b) => clean(a) === clean(b),
};

function buildDiffs(existing, proposed, fields) {
  const diffs = {};
  for (const field of fields) {
    const card = clean(proposed[field]);
    if (!card) continue;
    const current = clean(existing?.[field]);
    const equal = FIELD_EQUAL[field] || ((a, b) => clean(a) === clean(b));
    if (!equal(current, card)) {
      diffs[field] = { existing: current, card, decision: "keep" };
    }
  }
  return diffs;
}

function batchKey(candidate) {
  const email = normalizeEmail(candidate.email);
  if (email) return `email:${email}`;
  const phone = normalizePhone(candidate.phone);
  return phone ? `phone:${phone}` : "";
}

function batchConflict(a, b) {
  const peopleDiffer = normalizeText(a.personName) && normalizeText(b.personName)
    && normalizeText(a.personName) !== normalizeText(b.personName);
  const companiesDiffer = normalizeCompanyName(a.companyName) && normalizeCompanyName(b.companyName)
    && normalizeCompanyName(a.companyName) !== normalizeCompanyName(b.companyName);
  return peopleDiffer || companiesDiffer;
}

function companyProposal(candidate) {
  return {
    name: candidate.companyName,
    website: candidate.companyWebsite,
    address: candidate.companyAddress,
    district: candidate.district,
    orgType: candidate.orgType,
    notes: "",
  };
}

function contactProposal(candidate) {
  return {
    name: candidate.personName,
    title: candidate.title,
    email: candidate.email,
    phone: candidate.phone,
    notes: candidate.notes,
  };
}

export function matchBusinessCards({ candidates = [], companies = [] } = {}) {
  const contacts = companies.flatMap(company => (company.contacts || []).map(contact => ({
    ...contact,
    companyId: contact.companyId || company.id,
    _company: company,
  })));
  const contactsByEmail = indexBy(contacts, contact => normalizeEmail(contact.email));
  const contactsByPhone = indexBy(contacts, contact => normalizePhone(contact.phone));
  const companiesByName = indexBy(companies, company => normalizeCompanyName(company.name));
  const companiesByDomain = indexBy(companies, company => normalizeDomain(company.website));
  const seenBatch = new Map();

  return candidates.map((raw, index) => {
    const candidate = candidateShape(raw);
    const id = `${candidate.sourceId || "image"}:${candidate.cardIndex}:${index}`;
    const reasons = [];
    let companyMatch = null;
    let contactMatch = null;
    let companyMode = "new";
    let contactMode = "new";
    let status = "new_contact";

    const emailMatches = contactsByEmail.get(normalizeEmail(candidate.email)) || [];
    const phoneMatches = contactsByPhone.get(normalizePhone(candidate.phone)) || [];
    const exactContacts = uniqueById([...emailMatches, ...phoneMatches]);

    if (exactContacts.length > 1) {
      status = "needs_attention";
      companyMode = "unresolved";
      contactMode = "unresolved";
      reasons.push("Exact email and phone signals point to different contacts.");
    } else if (exactContacts.length === 1) {
      contactMatch = exactContacts[0];
      companyMatch = contactMatch._company || companies.find(c => c.id === contactMatch.companyId) || null;
      companyMode = "existing";
      contactMode = "existing";
      if (emailMatches.length) reasons.push("Exact email match.");
      if (phoneMatches.length) reasons.push("Exact phone match.");
    }

    const nameMatches = companiesByName.get(normalizeCompanyName(candidate.companyName)) || [];
    if (nameMatches.length > 1) {
      status = "needs_attention";
      companyMode = "unresolved";
      reasons.push("Several companies have the same normalized name.");
    } else if (nameMatches.length === 1) {
      const namedCompany = nameMatches[0];
      if (companyMatch && companyMatch.id !== namedCompany.id) {
        status = "needs_attention";
        companyMode = "unresolved";
        contactMode = "unresolved";
        reasons.push("The contact match and company-name match disagree.");
      } else {
        companyMatch = namedCompany;
        companyMode = "existing";
        reasons.push("Exact company-name match.");
      }
    }

    if (!contactMatch && companyMatch && status !== "needs_attention") {
      const personName = normalizeText(candidate.personName);
      const personMatches = (companyMatch.contacts || []).filter(contact => normalizeText(contact.name) === personName && personName);
      if (personMatches.length === 1) {
        contactMatch = personMatches[0];
        contactMode = "existing";
        reasons.push("Same person name within the matched company.");
      } else if (personMatches.length > 1) {
        status = "needs_attention";
        contactMode = "unresolved";
        reasons.push("More than one contact has this name at the company.");
      }
    }

    if (!companyMatch && status !== "needs_attention") {
      const domain = normalizeDomain(candidate.email) || normalizeDomain(candidate.companyWebsite);
      const domainMatches = domain && !GENERIC_DOMAINS.has(domain) ? (companiesByDomain.get(domain) || []) : [];
      if (domainMatches.length === 1) {
        companyMatch = domainMatches[0];
        companyMode = "unresolved";
        status = "needs_attention";
        reasons.push(`Company domain suggests ${companyMatch.name}.`);
      }
    }

    if (!companyMatch && status !== "needs_attention" && candidate.companyName) {
      const normalized = normalizeCompanyName(candidate.companyName);
      const suggestions = companies
        .map(company => ({ company, score: similarity(normalized, normalizeCompanyName(company.name)) }))
        .filter(entry => entry.score >= 0.72)
        .sort((a, b) => b.score - a.score || a.company.name.localeCompare(b.company.name));
      if (suggestions.length) {
        companyMatch = suggestions[0].company;
        companyMode = "unresolved";
        status = "needs_attention";
        reasons.push(`Similar company name suggests ${companyMatch.name}.`);
      }
    }

    const companyDiffs = companyMatch
      ? buildDiffs(companyMatch, companyProposal(candidate), ["name", "website", "address", "district", "orgType", "notes"])
      : {};
    const contactDiffs = contactMatch
      ? buildDiffs(contactMatch, contactProposal(candidate), ["name", "title", "email", "phone", "notes"])
      : {};

    if (status !== "needs_attention") {
      if (contactMatch) {
        status = Object.keys(companyDiffs).length || Object.keys(contactDiffs).length
          ? "update_existing"
          : "already_current";
      } else {
        status = "new_contact";
        contactMode = "new";
      }
    }

    let duplicateOf = null;
    const key = batchKey(candidate);
    if (key && seenBatch.has(key)) {
      const prior = seenBatch.get(key);
      if (batchConflict(prior.candidate, candidate)) {
        status = "needs_attention";
        companyMode = "unresolved";
        contactMode = "unresolved";
        reasons.push("This card conflicts with another card in the same batch that has the same email or phone.");
      } else {
        status = "possible_duplicate";
        duplicateOf = prior.id;
        reasons.push("Exact email or phone duplicates another card in this batch.");
      }
    } else if (key) {
      seenBatch.set(key, { id, candidate });
    }

    return {
      id,
      candidate,
      status,
      companyMatch,
      contactMatch,
      reasons,
      companyDiffs,
      contactDiffs,
      duplicateOf,
      companyMode,
      contactMode,
      selectedCompanyId: companyMode === "existing" ? companyMatch?.id || null : null,
      selectedContactId: contactMode === "existing" ? contactMatch?.id || null : null,
      companyTempId: `company:${id}`,
      include: false,
      reviewed: false,
      isPrimary: false,
    };
  });
}

function compactPatch(values, mapping) {
  const patch = {};
  for (const [source, target = source] of mapping) {
    const value = clean(values[source]);
    if (value) patch[target] = value;
  }
  return patch;
}

function selectedDiffPatch(diffs = {}) {
  const patch = {};
  for (const [field, diff] of Object.entries(diffs)) {
    if (diff?.decision === "use_card") patch[field] = clean(diff.card);
  }
  return patch;
}

export function buildImportPayload(reviewItems = []) {
  const companies = [];
  const contacts = [];
  const companyTempIds = new Set();
  let skipped = 0;

  for (const item of reviewItems) {
    if (!item?.include) {
      skipped += 1;
      continue;
    }
    if (!item.reviewed) throw new Error("Every included card must be reviewed before saving.");
    const candidate = candidateShape(item.candidate);

    let companyId = null;
    let companyTempId = null;
    if (item.companyMode === "existing") {
      companyId = item.selectedCompanyId || item.companyMatch?.id || null;
      if (!companyId) throw new Error("Choose a company for every included card.");
      const patch = selectedDiffPatch(item.companyDiffs);
      if (Object.keys(patch).length) {
        companies.push({
          action: "update",
          companyId,
          expectedUpdatedAt: item.companyMatch?.updatedAt || item.expectedCompanyUpdatedAt || null,
          patch,
        });
      }
    } else if (item.companyMode === "new") {
      if (!candidate.companyName) throw new Error("A company name is required for a new contact.");
      companyTempId = item.companyTempId || `company:${item.id}`;
      if (!companyTempIds.has(companyTempId)) {
        companyTempIds.add(companyTempId);
        companies.push({
          tempId: companyTempId,
          action: "create",
          patch: compactPatch(companyProposal(candidate), [
            ["name"], ["district"], ["orgType", "org_type"], ["website"], ["address"], ["notes"],
          ]),
        });
      }
    } else {
      throw new Error("Resolve the company match before saving.");
    }

    if (item.contactMode === "existing") {
      const contactId = item.selectedContactId || item.contactMatch?.id || null;
      if (!contactId) throw new Error("Resolve the contact match before saving.");
      const patch = selectedDiffPatch(item.contactDiffs);
      if (item.isPrimary) patch.is_primary = true;
      if (Object.keys(patch).length) {
        contacts.push({
          action: "update",
          contactId,
          companyId,
          expectedUpdatedAt: item.contactMatch?.updatedAt || item.expectedContactUpdatedAt || null,
          patch,
        });
      }
    } else if (item.contactMode === "new") {
      if (!candidate.personName) throw new Error("A person name is required for a new contact.");
      if (!companyId && !companyTempId) throw new Error("A company name is required for a new contact.");
      const operation = {
        action: "create",
        ...(companyId ? { companyId } : { companyTempId }),
        patch: compactPatch(contactProposal(candidate), [
          ["name"], ["title"], ["email"], ["phone"], ["notes"],
        ]),
      };
      if (item.isPrimary) operation.patch.is_primary = true;
      contacts.push(operation);
    } else {
      throw new Error("Resolve the contact match before saving.");
    }
  }

  return { companies, contacts, skipped };
}
