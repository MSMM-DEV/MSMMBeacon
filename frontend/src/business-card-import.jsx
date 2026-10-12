import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Progress,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from "@/ui";
import {
  applyBusinessCardImport,
  extractBusinessCards,
  reloadDirectory,
} from "./data.js";
import {
  chunkCardImages,
  normalizeCardImage,
  validateCardFiles,
} from "./lib/business-card-images.js";
import {
  buildImportPayload,
  matchBusinessCards,
  normalizeCompanyName,
} from "./lib/business-card-matching.js";
import {
  cleanupPreviewUrls,
  importReducer,
  initialImportState,
  replaceChunkCandidates,
  zeroCardNotice,
} from "./lib/business-card-import-state.js";

const ACCEPTED_IMAGES = "image/jpeg,image/png,image/webp,image/heic,image/heif";
const ORG_TYPES = ["", "City", "State", "Federal", "Local", "Parish", "Regional", "Other"];

const STATUS_META = {
  needs_attention: { label: "Needs attention", tone: "danger" },
  update_existing: { label: "Review updates", tone: "info" },
  new_contact: { label: "New contact", tone: "success" },
  possible_duplicate: { label: "Possible duplicate", tone: "warning" },
  already_current: { label: "Already current", tone: "neutral" },
};

const CANDIDATE_FIELDS = [
  ["personName", "Person name"],
  ["title", "Title"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["companyName", "Company name"],
  ["companyWebsite", "Company website"],
  ["companyAddress", "Company address"],
  ["district", "District"],
  ["orgType", "Organization type"],
];

const COMPANY_PROPOSAL = {
  name: "companyName",
  website: "companyWebsite",
  address: "companyAddress",
  district: "district",
  orgType: "orgType",
  notes: null,
};

const CONTACT_PROPOSAL = {
  name: "personName",
  title: "title",
  email: "email",
  phone: "phone",
  notes: "notes",
};

const FIELD_LABELS = {
  name: "Name",
  title: "Title",
  email: "Email",
  phone: "Phone",
  website: "Website",
  address: "Address",
  district: "District",
  orgType: "Organization type",
  notes: "Notes",
};

const clean = value => String(value || "").trim();
const same = (a, b) => clean(a).toLowerCase().replace(/\s+/g, " ") === clean(b).toLowerCase().replace(/\s+/g, " ");
const newImportKey = () => typeof crypto !== "undefined" && crypto.randomUUID
  ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, token => {
    const value = Math.floor(Math.random() * 16);
    return (token === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });

function reviewedDiffs(existing, candidate, mapping, prior = {}) {
  const diffs = {};
  for (const [field, candidateField] of Object.entries(mapping)) {
    const card = candidateField ? clean(candidate?.[candidateField]) : "";
    if (!card) continue;
    const current = clean(existing?.[field]);
    if (same(current, card)) continue;
    diffs[field] = {
      existing: current,
      card,
      decision: prior[field]?.decision === "use_card" ? "use_card" : "keep",
    };
  }
  return diffs;
}

function bytesLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function focusImportTrigger() {
  requestAnimationFrame(() => document.querySelector("[data-business-card-import-trigger]")?.focus());
}

function itemProblem(item) {
  if (!item.include) return "";
  if (!item.reviewed) return "Review this card before importing it.";
  if (item.companyMode === "unresolved") return "Choose an existing company or create a new one.";
  if (item.companyMode === "existing" && !item.selectedCompanyId) return "Choose the company.";
  if (item.companyMode === "new" && !clean(item.candidate?.companyName)) return "Enter the new company name.";
  if (item.contactMode === "unresolved") return "Choose an existing person or create a new contact.";
  if (item.contactMode === "existing" && !item.selectedContactId) return "Choose the existing person.";
  if (item.contactMode === "new" && !clean(item.candidate?.personName)) return "Enter the person's name.";
  return "";
}

function DiffChoice({ group, field, diff, onChange }) {
  const id = `${group}-${field}`.replace(/[^a-z0-9_-]/gi, "-");
  return (
    <fieldset className="bci-diff-row">
      <legend>{FIELD_LABELS[field] || field}</legend>
      <RadioGroup value={diff.decision} onValueChange={onChange} className="bci-diff-options">
        <label htmlFor={`${id}-keep`} className={diff.decision === "keep" ? "is-selected" : ""}>
          <RadioGroupItem id={`${id}-keep`} value="keep" />
          <span><strong>Existing</strong><small>{diff.existing || "Empty"}</small></span>
        </label>
        <label htmlFor={`${id}-card`} className={diff.decision === "use_card" ? "is-selected" : ""}>
          <RadioGroupItem id={`${id}-card`} value="use_card" />
          <span><strong>Card</strong><small>{diff.card || "Empty"}</small></span>
        </label>
      </RadioGroup>
    </fieldset>
  );
}

function ReviewItem({ item, index, images, companies, onPatch }) {
  const [companyQuery, setCompanyQuery] = useState("");
  const source = images.find(image => image.id === item.candidate.sourceId);
  const selectedCompany = companies.find(company => company.id === item.selectedCompanyId) || item.companyMatch || null;
  const companyContacts = selectedCompany?.contacts || [];
  const meta = STATUS_META[item.status] || STATUS_META.needs_attention;
  const problem = itemProblem(item);
  const matchingCompanies = useMemo(() => {
    const query = companyQuery.trim().toLowerCase();
    if (!query) return companies;
    return companies.filter(company => company.id === item.selectedCompanyId || [company.name, company.website, company.district]
      .some(value => clean(value).toLowerCase().includes(query)));
  }, [companies, companyQuery, item.selectedCompanyId]);

  const editCandidate = (field, value) => {
    const candidate = { ...item.candidate, [field]: value };
    onPatch({
      candidate,
      reviewed: true,
      companyDiffs: item.companyMode === "existing" && item.companyMatch
        ? reviewedDiffs(item.companyMatch, candidate, COMPANY_PROPOSAL, item.companyDiffs)
        : item.companyDiffs,
      contactDiffs: item.contactMode === "existing" && item.contactMatch
        ? reviewedDiffs(item.contactMatch, candidate, CONTACT_PROPOSAL, item.contactDiffs)
        : item.contactDiffs,
    });
  };

  const chooseCompany = value => {
    if (value === "__new__") {
      onPatch({
        companyMode: "new",
        contactMode: "new",
        selectedCompanyId: null,
        selectedContactId: null,
        companyMatch: null,
        contactMatch: null,
        companyDiffs: {},
        contactDiffs: {},
        status: "new_contact",
        reviewed: true,
      });
      return;
    }
    const company = companies.find(entry => entry.id === value);
    if (!company) return;
    onPatch({
      companyMode: "existing",
      contactMode: "new",
      selectedCompanyId: company.id,
      selectedContactId: null,
      companyMatch: company,
      contactMatch: null,
      companyDiffs: reviewedDiffs(company, item.candidate, COMPANY_PROPOSAL),
      contactDiffs: {},
      status: "new_contact",
      reviewed: true,
    });
  };

  const chooseContact = value => {
    if (value === "__new__") {
      onPatch({
        contactMode: "new",
        selectedContactId: null,
        contactMatch: null,
        contactDiffs: {},
        status: "new_contact",
        reviewed: true,
      });
      return;
    }
    const contact = companyContacts.find(entry => entry.id === value);
    if (!contact) return;
    onPatch({
      contactMode: "existing",
      selectedContactId: contact.id,
      contactMatch: contact,
      contactDiffs: reviewedDiffs(contact, item.candidate, CONTACT_PROPOSAL),
      status: Object.keys(reviewedDiffs(contact, item.candidate, CONTACT_PROPOSAL)).length
        || Object.keys(item.companyDiffs || {}).length ? "update_existing" : "already_current",
      reviewed: true,
    });
  };

  const setDiff = (kind, field, decision) => {
    const key = kind === "company" ? "companyDiffs" : "contactDiffs";
    onPatch({
      [key]: { ...item[key], [field]: { ...item[key][field], decision } },
      reviewed: true,
    });
  };

  return (
    <article className={`bci-review-card${item.include ? " is-included" : ""}`}>
      <header className="bci-review-card-head">
        <div>
          <span className="bci-card-number">Card {index + 1}</span>
          <Badge tone={meta.tone} dot>{meta.label}</Badge>
        </div>
        <label className="bci-include" htmlFor={`bci-include-${item.id}`}>
          <Checkbox
            id={`bci-include-${item.id}`}
            checked={item.include}
            onCheckedChange={checked => onPatch({ include: checked === true, reviewed: checked === true || item.reviewed })}
          />
          <span>{item.include ? "Included" : "Skip"}</span>
        </label>
      </header>

      <div className="bci-review-grid">
        <div className="bci-source-pane">
          {source?.previewUrl ? <img src={source.previewUrl} alt={`Source image for card ${index + 1}`} /> : null}
          <p>{source?.filename || "Uploaded image"}</p>
          {item.reasons?.length ? (
            <ul>{item.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}</ul>
          ) : null}
          {item.candidate.warnings?.length ? (
            <Alert tone="warning" className="bci-inline-alert">
              {item.candidate.warnings.join(" ")}
            </Alert>
          ) : null}
        </div>

        <div className="bci-review-form">
          <section className="bci-section">
            <div className="bci-section-title"><span>1</span><div><h3>Company match</h3><p>Choose where this person belongs.</p></div></div>
            <Field label="Search companies" htmlFor={`bci-company-search-${item.id}`}>
              <Input
                id={`bci-company-search-${item.id}`}
                value={companyQuery}
                onChange={event => setCompanyQuery(event.target.value)}
                placeholder="Filter by name, website or district"
              />
            </Field>
            <Field label="Company" htmlFor={`bci-company-${item.id}`} required>
              <select
                id={`bci-company-${item.id}`}
                className="bci-native-select"
                value={item.companyMode === "new" ? "__new__" : item.companyMode === "existing" ? item.selectedCompanyId || "" : ""}
                onChange={event => chooseCompany(event.target.value)}
                aria-invalid={item.include && (item.companyMode === "unresolved" || (item.companyMode === "existing" && !item.selectedCompanyId))}
              >
                <option value="" disabled>Resolve company…</option>
                <option value="__new__">Create a new company</option>
                {matchingCompanies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </Field>
            {item.companyMode === "existing" ? (
              <Field label="Person at this company" htmlFor={`bci-contact-${item.id}`} required>
                <select
                  id={`bci-contact-${item.id}`}
                  className="bci-native-select"
                  value={item.contactMode === "new" ? "__new__" : item.contactMode === "existing" ? item.selectedContactId || "" : ""}
                  onChange={event => chooseContact(event.target.value)}
                  aria-invalid={item.include && item.contactMode === "unresolved"}
                >
                  <option value="" disabled>Resolve person…</option>
                  <option value="__new__">Add as a new contact</option>
                  {companyContacts.map(contact => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}{contact.email ? ` — ${contact.email}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </section>

          <section className="bci-section">
            <div className="bci-section-title"><span>2</span><div><h3>Extracted card</h3><p>Correct anything the scan misread.</p></div></div>
            <div className="bci-field-grid">
              {CANDIDATE_FIELDS.map(([field, label]) => (
                <Field key={field} label={label} htmlFor={`bci-${field}-${item.id}`} required={field === "personName" || field === "companyName"}>
                  {field === "orgType" ? (
                    <select
                      id={`bci-${field}-${item.id}`}
                      className="bci-native-select"
                      value={item.candidate[field] || ""}
                      onChange={event => editCandidate(field, event.target.value)}
                    >
                      {ORG_TYPES.map(value => <option key={value || "empty"} value={value}>{value || "Not specified"}</option>)}
                    </select>
                  ) : (
                    <Input
                      id={`bci-${field}-${item.id}`}
                      value={item.candidate[field] || ""}
                      onChange={event => editCandidate(field, event.target.value)}
                      inputMode={field === "email" ? "email" : field === "phone" ? "tel" : undefined}
                    />
                  )}
                </Field>
              ))}
            </div>
            <Field label="Notes and other details" htmlFor={`bci-notes-${item.id}`}>
              <Textarea id={`bci-notes-${item.id}`} rows={3} value={item.candidate.notes || ""} onChange={event => editCandidate("notes", event.target.value)} />
            </Field>
          </section>

          {(Object.keys(item.companyDiffs || {}).length || Object.keys(item.contactDiffs || {}).length) ? (
            <section className="bci-section">
              <div className="bci-section-title"><span>3</span><div><h3>Choose updates</h3><p>Existing values are kept unless you select the card value.</p></div></div>
              <div className="bci-diffs">
                {Object.entries(item.companyDiffs || {}).map(([field, diff]) => (
                  <DiffChoice key={`company-${field}`} group={`${item.id}-company`} field={field} diff={diff} onChange={value => setDiff("company", field, value)} />
                ))}
                {Object.entries(item.contactDiffs || {}).map(([field, diff]) => (
                  <DiffChoice key={`contact-${field}`} group={`${item.id}-contact`} field={field} diff={diff} onChange={value => setDiff("contact", field, value)} />
                ))}
              </div>
            </section>
          ) : null}

          <label className="bci-primary" htmlFor={`bci-primary-${item.id}`}>
            <Checkbox id={`bci-primary-${item.id}`} checked={item.isPrimary} onCheckedChange={checked => onPatch({ isPrimary: checked === true, reviewed: true })} />
            <span>Make this the primary contact for the company</span>
          </label>
          {problem ? <p className="bci-item-error" role="alert">{problem}</p> : null}
        </div>
      </div>
    </article>
  );
}

export function BusinessCardImport({ companies = [], onComplete, onClose, onToast }) {
  const [state, dispatch] = useReducer(importReducer, undefined, initialImportState);
  const [directoryCompanies, setDirectoryCompanies] = useState(companies);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const imagesRef = useRef([]);
  const mountedRef = useRef(true);
  const preparingRef = useRef(false);
  const importKeyRef = useRef(newImportKey());
  const processingChunk = state.chunks.some(chunk => chunk.status === "running" || chunk.status === "pending");
  const busy = state.phase === "saving" || preparing || processingChunk;

  useEffect(() => { setDirectoryCompanies(companies); }, [companies]);
  useEffect(() => { imagesRef.current = state.images; }, [state.images]);
  useEffect(() => () => {
    mountedRef.current = false;
    cleanupPreviewUrls(imagesRef.current);
  }, []);

  const close = () => {
    if (busy) return;
    cleanupPreviewUrls(imagesRef.current);
    imagesRef.current = [];
    onClose?.();
    focusImportTrigger();
  };

  const addFiles = async fileList => {
    if (preparingRef.current) return;
    const { accepted, rejected } = validateCardFiles(fileList, { existingCount: imagesRef.current.length });
    const errors = rejected.map(entry => ({ name: entry.name, error: entry.error }));
    if (!accepted.length) {
      if (errors.length) dispatch({ type: "imagesAdded", images: [], errors });
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    const results = await Promise.allSettled(accepted.map((file, index) => normalizeCardImage(file, {
      id: `${Date.now()}-${index}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`,
    })));
    const images = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") images.push(result.value);
      else errors.push({ name: accepted[index]?.name || "Image", error: result.reason?.message || "This image could not be prepared." });
    });
    if (!mountedRef.current) {
      cleanupPreviewUrls(images);
      return;
    }
    dispatch({ type: "imagesAdded", images, errors });
    preparingRef.current = false;
    setPreparing(false);
  };

  const removeImage = image => {
    cleanupPreviewUrls([image]);
    dispatch({ type: "imageRemoved", imageId: image.id });
  };

  const analyze = async () => {
    if (!state.images.length) return;
    let groups;
    try {
      groups = chunkCardImages(state.images).map((images, index) => ({ id: `chunk-${index + 1}`, images }));
    } catch (error) {
      dispatch({ type: "error", phase: "upload", error: error.message });
      return;
    }
    dispatch({ type: "analysisStarted", chunks: groups });
    const successes = [];
    const readImages = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < groups.length) {
        const group = groups[cursor];
        cursor += 1;
        dispatch({ type: "chunkRunning", chunkId: group.id });
        try {
          const response = await extractBusinessCards(group.images);
          const candidates = response.candidates.map(candidate => ({ ...candidate, _chunkId: group.id }));
          successes.push(...candidates);
          readImages.push(...group.images);
          dispatch({ type: "chunkSucceeded", chunkId: group.id, candidates });
        } catch (error) {
          dispatch({ type: "chunkFailed", chunkId: group.id, error: error.message || String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, groups.length) }, worker));
    if (successes.length) {
      dispatch({
        type: "reviewReady",
        reviewItems: matchBusinessCards({ candidates: successes, companies: directoryCompanies }),
        notice: zeroCardNotice(readImages, successes),
      });
    } else {
      dispatch({
        type: "error",
        phase: "analyzing",
        error: "No business cards were extracted. Retry any failed group, or return to upload and use a clearer photo.",
      });
    }
  };

  const retryChunk = async chunkId => {
    const chunk = state.chunks.find(entry => entry.id === chunkId);
    if (!chunk) return;
    dispatch({ type: "chunkRunning", chunkId });
    try {
      const response = await extractBusinessCards(chunk.images);
      const candidates = response.candidates.map(candidate => ({ ...candidate, _chunkId: chunkId }));
      dispatch({ type: "chunkSucceeded", chunkId, candidates });
      const allCandidates = replaceChunkCandidates(state.candidates, chunkId, candidates);
      if (allCandidates.length) {
        const previous = new Map(state.reviewItems.map(item => [item.id, item]));
        const nextItems = matchBusinessCards({ candidates: allCandidates, companies: directoryCompanies })
          .map(item => item.candidate._chunkId !== chunkId && previous.has(item.id) ? previous.get(item.id) : item);
        const completedImages = state.chunks
          .filter(entry => entry.id === chunkId || entry.status === "complete")
          .flatMap(entry => entry.images || []);
        dispatch({
          type: "reviewReady",
          reviewItems: nextItems,
          notice: zeroCardNotice(completedImages, allCandidates),
        });
      } else if (!state.reviewItems.length) {
        dispatch({ type: "error", phase: "analyzing", error: "No cards were detected in that image group." });
      }
    } catch (error) {
      dispatch({ type: "chunkFailed", chunkId, error: error.message || String(error) });
    }
  };

  const updateReview = (itemId, patch) => dispatch({ type: "reviewUpdated", itemId, patch });
  const included = state.reviewItems.filter(item => item.include);
  const includedIds = new Set(included.map(item => item.id));
  const primaryCounts = new Map();
  for (const item of included.filter(entry => entry.isPrimary)) {
    const target = item.companyMode === "existing"
      ? `existing:${item.selectedCompanyId || item.companyMatch?.id || ""}`
      : `new:${normalizeCompanyName(item.candidate?.companyName)}`;
    primaryCounts.set(target, (primaryCounts.get(target) || 0) + 1);
  }
  const problems = [
    ...included.map(itemProblem).filter(Boolean),
    ...included.filter(item => item.duplicateOf && includedIds.has(item.duplicateOf))
      .map(() => "Select only one copy of a possible duplicate card."),
    ...[...primaryCounts.values()].filter(count => count > 1)
      .map(() => "Choose only one primary contact for each company."),
  ];
  const canSave = included.length > 0 && problems.length === 0 && !processingChunk;

  const save = async () => {
    if (!canSave) return;
    dispatch({ type: "savingStarted" });
    let summary;
    try {
      const payload = buildImportPayload(state.reviewItems);
      summary = await applyBusinessCardImport(payload, importKeyRef.current);
    } catch (error) {
      const message = error.message || String(error);
      if (/stale|changed after review/i.test(message)) {
        try {
          const freshCompanies = await reloadDirectory();
          setDirectoryCompanies(freshCompanies);
          const rematched = matchBusinessCards({
            candidates: state.reviewItems.map(item => item.candidate),
            companies: freshCompanies,
          });
          dispatch({
            type: "reviewsReplaced",
            reviewItems: rematched,
            error: "The Directory changed while you were reviewing. Matches were refreshed; please review the selected cards again.",
          });
        } catch (reloadError) {
          dispatch({ type: "error", phase: "review", error: `${message}. Refresh failed: ${reloadError.message || reloadError}` });
        }
      } else {
        dispatch({ type: "error", phase: "review", error: message });
      }
      return;
    }

    // The transaction has committed at this point. A follow-up refresh failure
    // must never put the UI back on Save (which could duplicate creates).
    let refreshWarning = "";
    try {
      const freshCompanies = await reloadDirectory();
      setDirectoryCompanies(freshCompanies);
      await onComplete?.(summary, freshCompanies);
    } catch (error) {
      refreshWarning = `The import was saved, but the Directory could not refresh: ${error.message || error}`;
    }
    cleanupPreviewUrls(imagesRef.current);
    imagesRef.current = [];
    dispatch({ type: "saveSucceeded", summary: { ...summary, refresh_warning: refreshWarning } });
    onToast?.(refreshWarning || "Business cards imported", refreshWarning ? "warn" : "check");
  };

  const completedChunks = state.chunks.filter(chunk => chunk.status === "complete").length;
  const progress = state.chunks.length ? ((completedChunks + state.chunks.filter(chunk => chunk.status === "failed").length) / state.chunks.length) * 100 : 0;

  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent
        size="full"
        className="bci-dialog"
        showClose={!busy && state.phase !== "analyzing"}
        onEscapeKeyDown={event => { if (busy || state.phase === "analyzing") event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
      >
        <DialogHeader className="bci-header">
          <div className="bci-heading-row">
            <div>
              <DialogTitle>Import business cards</DialogTitle>
              <DialogDescription>
                Upload several photos or one photo containing several cards. Review every match before anything is saved.
              </DialogDescription>
            </div>
            <div className="bci-stepper" aria-label={`Step ${state.phase === "upload" ? 1 : state.phase === "analyzing" ? 2 : state.phase === "review" || state.phase === "saving" ? 3 : 4} of 4`}>
              {[
                ["upload", "Upload"], ["analyzing", "Analyze"], ["review", "Review"], ["complete", "Done"],
              ].map(([phase, label], index) => {
                const order = { upload: 0, analyzing: 1, review: 2, saving: 2, complete: 3 };
                const current = order[state.phase] ?? 0;
                return <span key={phase} className={index === current ? "is-current" : index < current ? "is-complete" : ""}>{index + 1}<small>{label}</small></span>;
              })}
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="bci-body">
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {state.error || (state.phase === "analyzing" ? `${completedChunks} of ${state.chunks.length} image groups analyzed` : "")}
          </div>

          {state.phase === "upload" ? (
            <div className="bci-upload-stage">
              <div
                className={`bci-dropzone${dragging ? " is-dragging" : ""}`}
                onDragEnter={event => { event.preventDefault(); setDragging(true); }}
                onDragOver={event => event.preventDefault()}
                onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }}
                onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
              >
                <span className="bci-drop-icon"><Icon name="upload" size={22} /></span>
                <h3>Drop card photos here</h3>
                <p>JPEG, PNG, WebP, HEIC or HEIF · up to 20 photos · 10 MB each</p>
                <div className="bci-upload-actions">
                  <label className="bci-file-button">
                    <Input type="file" accept={ACCEPTED_IMAGES} multiple onChange={event => { addFiles(event.target.files); event.target.value = ""; }} />
                    <span><Icon name="upload" size={14} />Choose photos</span>
                  </label>
                  <label className="bci-file-button is-secondary">
                    <Input type="file" accept={ACCEPTED_IMAGES} multiple capture="environment" onChange={event => { addFiles(event.target.files); event.target.value = ""; }} />
                    <span>Use camera</span>
                  </label>
                </div>
                {preparing ? <p className="bci-preparing">Preparing photos in this browser…</p> : null}
              </div>

              <Alert tone="info" className="bci-privacy-note">
                <strong>Temporary processing.</strong> Photos are sent securely to the configured AI provider for text extraction, are not saved to Beacon, and are discarded when this import finishes or is cancelled.
              </Alert>

              {state.images.length ? (
                <section className="bci-image-list" aria-label="Selected card photos">
                  <div className="bci-list-head"><h3>Selected photos</h3><span>{state.images.length} / 20</span></div>
                  <div className="bci-image-grid">
                    {state.images.map(image => (
                      <figure key={image.id}>
                        <img src={image.previewUrl} alt="" />
                        <figcaption><strong>{image.filename}</strong><span>{bytesLabel(image.byteSize)}</span></figcaption>
                        <button type="button" onClick={() => removeImage(image)} aria-label={`Remove ${image.filename}`}><Icon name="x" size={13} /></button>
                      </figure>
                    ))}
                  </div>
                </section>
              ) : null}

              {state.fileErrors.length ? (
                <Alert tone="danger" className="bci-errors" role="alert">
                  <strong>Some files were not added.</strong>
                  <ul>{state.fileErrors.map((entry, index) => <li key={`${entry.name}-${index}`}><b>{entry.name}:</b> {entry.error}</li>)}</ul>
                </Alert>
              ) : null}
              {state.error ? <Alert tone="danger" role="alert">{state.error}</Alert> : null}
            </div>
          ) : null}

          {state.phase === "analyzing" ? (
            <div className="bci-analysis-stage">
              <span className="bci-analysis-mark"><Icon name="sparkles" size={26} /></span>
              <h3>Reading every visible card</h3>
              <p>You can upload one card per photo or spread several cards across a table. Successful groups are kept if another group needs a retry.</p>
              <Progress value={progress} />
              <div className="bci-chunks">
                {state.chunks.map((chunk, index) => (
                  <div key={chunk.id} data-status={chunk.status}>
                    <span>Image group {index + 1} · {chunk.images.length} photo{chunk.images.length === 1 ? "" : "s"}</span>
                    <strong>{chunk.status === "complete" ? "Complete" : chunk.status === "failed" ? "Needs retry" : chunk.status === "running" ? "Analyzing…" : "Waiting"}</strong>
                    {chunk.status === "failed" ? <Button size="sm" variant="secondary" onClick={() => retryChunk(chunk.id)}><Icon name="refresh" size={13} />Retry</Button> : null}
                  </div>
                ))}
              </div>
              {state.error ? <Alert tone="danger" role="alert">{state.error}</Alert> : null}
            </div>
          ) : null}

          {state.phase === "review" || state.phase === "saving" ? (
            <div className={`bci-review-stage${state.phase === "saving" ? " is-saving" : ""}`} aria-busy={state.phase === "saving"}>
              <div className="bci-review-summary">
                <div><h3>Review before saving</h3><p>{included.length} of {state.reviewItems.length} cards selected for import. Existing values stay unchanged unless you choose the card value.</p></div>
                <Badge tone={problems.length ? "danger" : included.length ? "success" : "neutral"}>{problems.length ? `${problems.length} unresolved` : `${included.length} ready`}</Badge>
              </div>
              {state.failedChunks.length ? (
                <Alert tone="warning" className="bci-retry-banner">
                  <div><strong>{state.failedChunks.length} image group{state.failedChunks.length === 1 ? "" : "s"} could not be read.</strong><span>You can review successful cards now and retry only the failed group.</span></div>
                  {state.failedChunks.map(failure => <Button key={failure.chunkId} size="sm" variant="secondary" disabled={state.phase === "saving"} onClick={() => retryChunk(failure.chunkId)}><Icon name="refresh" size={13} />Retry group</Button>)}
                </Alert>
              ) : null}
              {state.notice ? <Alert tone="warning">{state.notice}</Alert> : null}
              {state.error ? <Alert tone="danger" role="alert" className="bci-review-error">{state.error}</Alert> : null}
              <div className="bci-review-list">
                {state.reviewItems.map((item, index) => (
                  <ReviewItem
                    key={item.id}
                    item={item}
                    index={index}
                    images={state.images}
                    companies={directoryCompanies}
                    onPatch={patch => updateReview(item.id, patch)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {state.phase === "complete" ? (
            <div className="bci-complete-stage">
              <span><Icon name="checkCircle" size={32} /></span>
              <h3>Import complete</h3>
              <p>The reviewed changes were saved atomically, and the temporary photos have been discarded.</p>
              {state.summary?.refresh_warning ? <Alert tone="warning">{state.summary.refresh_warning}</Alert> : null}
              <dl>
                <div><dt>Companies created</dt><dd>{state.summary?.companies_created || 0}</dd></div>
                <div><dt>Companies updated</dt><dd>{state.summary?.companies_updated || 0}</dd></div>
                <div><dt>Contacts created</dt><dd>{state.summary?.contacts_created || 0}</dd></div>
                <div><dt>Contacts updated</dt><dd>{state.summary?.contacts_updated || 0}</dd></div>
                <div><dt>Cards skipped</dt><dd>{state.summary?.skipped || 0}</dd></div>
              </dl>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter className="bci-footer">
          {state.phase === "upload" ? (
            <><Button variant="ghost" onClick={close} disabled={preparing}>Cancel</Button><Button onClick={analyze} disabled={!state.images.length || preparing}><Icon name="sparkles" size={14} />Analyze {state.images.length || ""} photo{state.images.length === 1 ? "" : "s"}</Button></>
          ) : null}
          {state.phase === "analyzing" ? (
            processingChunk ? (
              <span className="bci-footer-status">Analysis must finish before this window can close.</span>
            ) : (
              <>
                <Button variant="ghost" onClick={close}>Cancel import</Button>
                <Button variant="secondary" onClick={() => dispatch({ type: "returnToUpload" })}>Back to photos</Button>
              </>
            )
          ) : null}
          {state.phase === "review" ? (
            <><Button variant="ghost" onClick={close}>Cancel import</Button><Button onClick={save} disabled={!canSave}>{canSave ? `Import ${included.length} card${included.length === 1 ? "" : "s"}` : "Resolve selected cards"}</Button></>
          ) : null}
          {state.phase === "saving" ? <span className="bci-footer-status">Saving the reviewed batch atomically…</span> : null}
          {state.phase === "complete" ? <Button onClick={close}>Done</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
