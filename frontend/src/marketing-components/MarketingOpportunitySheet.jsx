import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Field, Input, Tabs, TabsList, TabsTrigger, Textarea,
} from "@/ui";
import { Icon } from "../icons.jsx";
import {
  addContact,
  addMarketingContact,
  archiveMarketingOpportunity,
  loadMarketingOpportunityFresh,
  reloadDirectory,
  removeMarketingContact,
  restoreMarketingOpportunity,
  updateMarketingContact,
  updateMarketingOpportunity,
} from "../data.js";
import { MARKETING_CONTACT_ROLES, MarketingConflictError, nextMarketingAction } from "../marketing-model.js";
import {
  attemptMarketingSectionSave,
  changedMarketingFields,
  fromMarketingDateTimeLocal,
  marketingDirectoryContactOptions,
  mergeMarketingRelations,
  saveMarketingStakeholder,
  toMarketingDateTimeLocal,
} from "./marketing-sheet-model.js";
import { MarketingActivityPanel } from "./MarketingActivityPanel.jsx";
import { MarketingTaskPanel } from "./MarketingTaskPanel.jsx";
import { MarketingDocumentPanel } from "./MarketingDocumentPanel.jsx";

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "qualification", label: "Qualification" },
  { key: "people", label: "People" },
  { key: "activity", label: "Activity" },
  { key: "tasks", label: "Tasks" },
  { key: "files", label: "Files & History" },
];

const OVERVIEW_FIELDS = [
  "title", "clientId", "ownerId", "source", "introducer", "summary", "nextAction",
  "nextActionDueAt", "expectedCloseDate", "estimatedValue", "productTags", "probability",
  "assignedTeam", "taskOrder", "deliveryStatus", "projectProgress", "sourceSalesPhase",
];
const QUALIFICATION_FIELDS = [
  "showcaseMeetingAt", "showcaseLocation", "showcaseProducts", "showcaseAttendeesSummary", "showcaseFit", "showcaseOutcome",
  "problemStatement", "desiredOutcome", "solutionFit", "clarifyingQuestions", "clarifyingOwnerId", "clarifyingDueAt", "clarifyingAnswersStatus", "draftSowStatus",
  "budgetAmount", "budgetStatus", "budgetNotes", "authorityContactId", "authorityNotes", "needSummary", "timingSummary", "decisionProcess",
  "proposalVersion", "proposalValue", "proposalSentAt", "scopeSummary", "anticipatedDecisionDate",
  "verbalApprovalAt", "verbalApproverContactId", "verbalTerms", "targetSignatureDate", "signatureRisks", "resourcePlanningNote",
  "msaStatus", "sowStatus", "legalOwnerId", "customerLegalContactId", "redlineStatus", "legalIssues", "latestDocumentVersion",
  "competitor", "lessonLearned",
];

const DATETIME_FIELDS = new Set([
  "nextActionDueAt", "showcaseMeetingAt", "clarifyingDueAt", "proposalSentAt", "verbalApprovalAt",
]);

const valuesFor = (opportunity, fields) => Object.fromEntries(fields.map(field => [
  field,
  DATETIME_FIELDS.has(field)
    ? toMarketingDateTimeLocal(opportunity?.[field])
    : Array.isArray(opportunity?.[field]) ? [...opportunity[field]] : (opportunity?.[field] ?? ""),
]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const displayDate = value => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not recorded";
const displayDay = value => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`)) : "Not recorded";
const displayMoney = value => value === null || value === undefined || value === ""
  ? "Not set"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));

function ConflictPanel({ conflict, draft, onReview, onKeep, reviewing }) {
  const changed = conflict.latest ? changedMarketingFields(conflict.latest, draft) : [];
  return (
    <Alert tone="warning" title="This opportunity changed after you opened it." icon={<Icon name="warn"/>}>
      <p>Beacon will not overwrite another person’s work. Review the current record, then choose whether to keep editing your draft.</p>
      {conflict.latest && <div className="marketing-conflict-values">{changed.map(field => <div key={field}><strong>{field}</strong><span>Latest: {String(conflict.latest[field] ?? "—")}</span><span>Your draft: {String(draft[field] ?? "—")}</span></div>)}</div>}
      <div className="marketing-inline-actions">
        <Button type="button" size="sm" variant="default" onClick={onReview} disabled={reviewing}>{reviewing ? "Loading…" : "Review latest"}</Button>
        <Button type="button" size="sm" variant="primary" onClick={onKeep} disabled={!conflict.latest}>Keep my draft</Button>
      </div>
    </Alert>
  );
}

function MarketingContactsPanel({ opportunity, contacts, clients, onChanged, onRefreshDirectory, refreshing }) {
  const company = clients.find(client => client.id === opportunity.clientId);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ contactId: "", role: "Champion", isPrimary: false, notes: "", newName: "", newEmail: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const available = useMemo(
    () => marketingDirectoryContactOptions(clients, contacts, search),
    [clients, contacts, search],
  );
  const submit = async event => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const result = await saveMarketingStakeholder({
        opportunityId: opportunity.id,
        companyId: opportunity.clientId,
        form,
        createContact: addContact,
        linkContact: addMarketingContact,
        refreshDirectory: onRefreshDirectory,
      });
      onChanged([...contacts, result.linked]);
      if (result.refreshError) setError(`Stakeholder linked, but the Directory could not refresh: ${result.refreshError}`);
      setForm({ contactId: "", role: "Champion", isPrimary: false, notes: "", newName: "", newEmail: "" });
      setSearch("");
    } catch (saveError) { setError(saveError.message || "The contact could not be linked."); }
    finally { setSaving(false); }
  };
  const update = async (link, patch) => {
    try {
      const saved = await updateMarketingContact(opportunity.id, link.contactId, patch);
      onChanged(contacts.map(item => item.contactId === saved.contactId ? saved : item));
    } catch (saveError) { setError(saveError.message || "The stakeholder could not be updated."); }
  };
  const unlink = async link => {
    try { await removeMarketingContact(opportunity.id, link.contactId); onChanged(contacts.filter(item => item.contactId !== link.contactId)); }
    catch (saveError) { setError(saveError.message || "The stakeholder could not be unlinked."); }
  };
  return (
    <section className="marketing-stakeholders">
      <header className="marketing-section-heading">
        <div><h3>People and decision-makers</h3><p>Connect anyone from the Directory, then record their role in this opportunity.</p></div>
        <Button type="button" size="sm" variant="ghost" onClick={() => onRefreshDirectory?.().catch(refreshError => setError(refreshError.message || "Directory contacts could not be refreshed."))} disabled={refreshing} loading={refreshing}><Icon name="refresh"/>Refresh Directory</Button>
      </header>
      {error && <Alert role="alert" tone="danger">{error}</Alert>}
      <div className="marketing-contact-list">
        {contacts.length ? contacts.map(link => {
          const organization = clients.find(client => client.id === link.companyId)?.name;
          return <article key={link.contactId}>
            <div className="marketing-contact-person"><strong>{link.name}</strong><span>{link.email || "No email"}</span>{organization && <small>{organization}</small>}</div>
            <select aria-label={`Role for ${link.name}`} value={link.role} onChange={event => update(link, { role: event.target.value })}>{MARKETING_CONTACT_ROLES.map(role => <option key={role}>{role}</option>)}</select>
            <label className="marketing-primary-check"><input type="checkbox" checked={link.isPrimary} onChange={event => update(link, { isPrimary: event.target.checked })}/> Primary</label>
            <Input aria-label={`Notes for ${link.name}`} placeholder="Relationship notes" defaultValue={link.notes || ""} onBlur={event => update(link, { notes: event.target.value })}/>
            <Button type="button" size="sm" variant="ghost" onClick={() => unlink(link)}>Unlink</Button>
          </article>;
        }) : <p className="marketing-empty-note">No stakeholders linked yet.</p>}
      </div>
      <form onSubmit={submit} className="marketing-contact-add">
        <div className="marketing-contact-add-heading"><h4>Link a stakeholder</h4><p>Search the full Directory or create a contact for {company?.name || "this opportunity’s organization"}.</p></div>
        <Field label="Search Directory" htmlFor="marketing-contact-search" className="marketing-field-wide"><Input id="marketing-contact-search" type="search" placeholder="Name, email, or organization" value={search} onChange={event => setSearch(event.target.value)}/></Field>
        <Field label="Directory contact" htmlFor="marketing-link-contact" className="marketing-field-wide">
          <select id="marketing-link-contact" value={form.contactId} onChange={event => setForm(current => ({ ...current, contactId: event.target.value, newName: event.target.value ? "" : current.newName, newEmail: event.target.value ? "" : current.newEmail }))}>
            <option value="">{available.length ? "Choose contact" : "No unlinked contacts match"}</option>
            {available.map(contact => <option key={contact.id} value={contact.id}>{contact.label}{contact.email ? ` · ${contact.email}` : ""}</option>)}
          </select>
        </Field>
        <div className="marketing-contact-divider marketing-field-wide"><span>or create a Directory contact</span></div>
        <Field label="Full name" htmlFor="marketing-new-contact"><Input id="marketing-new-contact" placeholder="Full name" value={form.newName} onChange={event => setForm(current => ({ ...current, contactId: event.target.value ? "" : current.contactId, newName: event.target.value }))}/></Field>
        <Field label="Email" htmlFor="marketing-new-contact-email"><Input id="marketing-new-contact-email" type="email" value={form.newEmail} onChange={event => setForm(current => ({ ...current, newEmail: event.target.value }))}/></Field>
        <Field label="Relationship role" htmlFor="marketing-contact-role"><select id="marketing-contact-role" value={form.role} onChange={event => setForm(current => ({ ...current, role: event.target.value }))}>{MARKETING_CONTACT_ROLES.map(role => <option key={role}>{role}</option>)}</select></Field>
        <Field label="Notes" htmlFor="marketing-contact-notes"><Input id="marketing-contact-notes" placeholder="Influence, priorities, follow-up" value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))}/></Field>
        <label className="marketing-primary-check"><input type="checkbox" checked={form.isPrimary} onChange={event => setForm(current => ({ ...current, isPrimary: event.target.checked }))}/> Primary contact</label>
        <Button type="submit" variant="primary" loading={saving} disabled={saving || (!form.contactId && !form.newName.trim())}>Link stakeholder</Button>
      </form>
    </section>
  );
}

export function MarketingOpportunitySheet({
  opportunity,
  contacts = [], activities = [], tasks = [], documents = [], history = [],
  lookups = {}, onSaved, onArchived, onRestored, onClose, onDirectoryRefresh,
  api = {},
}) {
  const updateApi = api.update || updateMarketingOpportunity;
  const archiveApi = api.archive || archiveMarketingOpportunity;
  const restoreApi = api.restore || restoreMarketingOpportunity;
  const freshApi = api.fresh || loadMarketingOpportunityFresh;
  const [section, setSection] = useState("overview");
  const [current, setCurrent] = useState(opportunity);
  const [overview, setOverview] = useState(() => valuesFor(opportunity, OVERVIEW_FIELDS));
  const [qualification, setQualification] = useState(() => valuesFor(opportunity, QUALIFICATION_FIELDS));
  const [snapshotVersion, setSnapshotVersion] = useState(opportunity?.version || 1);
  const [busySection, setBusySection] = useState(null);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [localContacts, setLocalContacts] = useState(contacts);
  const [localActivities, setLocalActivities] = useState(activities);
  const [localTasks, setLocalTasks] = useState(tasks);
  const [localDocuments, setLocalDocuments] = useState(documents);
  const [directoryClients, setDirectoryClients] = useState(lookups.clients || []);
  const [directoryRefreshing, setDirectoryRefreshing] = useState(false);
  const errorRef = useRef(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  // A newer copy of the SAME record arrives whenever one of our own writes
  // bumps its version (a save, a logged activity, a task change). Re-baseline
  // only the sections the user isn't editing: replacing a dirty draft here is
  // what made typed-but-unsaved Overview / Qualification text vanish.
  useEffect(() => {
    const previous = currentRef.current;
    const sameRecord = previous?.id === opportunity?.id;
    const rebase = fields => draft => (sameRecord && !same(draft, valuesFor(previous, fields)) ? draft : valuesFor(opportunity, fields));
    setCurrent(opportunity);
    setOverview(rebase(OVERVIEW_FIELDS));
    setQualification(rebase(QUALIFICATION_FIELDS));
    setSnapshotVersion(opportunity?.version || 1);
    if (!sameRecord) { setError(""); setErrorAction(null); setConflict(null); }
  }, [opportunity?.id, opportunity?.version]);
  useEffect(() => { setLocalContacts(contacts); }, [contacts]);
  useEffect(() => { setLocalActivities(activities); }, [activities]);
  useEffect(() => { setLocalTasks(tasks); }, [tasks]);
  useEffect(() => { setLocalDocuments(documents); }, [documents]);
  useEffect(() => { setDirectoryClients(lookups.clients || []); }, [lookups.clients]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const refreshDirectory = useCallback(async () => {
    setDirectoryRefreshing(true);
    try {
      const fresh = await reloadDirectory();
      setDirectoryClients(fresh);
      onDirectoryRefresh?.(fresh);
      return fresh;
    } finally { setDirectoryRefreshing(false); }
  }, [onDirectoryRefresh]);

  useEffect(() => {
    if (section !== "people") return undefined;
    refreshDirectory().catch(refreshError => setError(refreshError.message || "Directory contacts could not be refreshed."));
    return undefined;
  }, [section, refreshDirectory]);

  const baselineOverview = useMemo(() => valuesFor(current, OVERVIEW_FIELDS), [current]);
  const baselineQualification = useMemo(() => valuesFor(current, QUALIFICATION_FIELDS), [current]);
  const dirtyOverview = !same(overview, baselineOverview);
  const dirtyQualification = !same(qualification, baselineQualification);
  const dirty = dirtyOverview || dirtyQualification;
  const activeDraft = section === "qualification" ? qualification : overview;
  const setActiveDraft = section === "qualification" ? setQualification : setOverview;
  const users = lookups.users || [];
  const clients = directoryClients;
  const userName = id => lookups.usersById?.[id]?.name || users.find(user => user.id === id)?.name || "Unknown user";
  const contactName = id => lookups.contactsById?.[id]?.name || contacts.find(contact => (contact.contactId || contact.id) === id)?.name || "Unknown contact";
  const setField = (key, value) => setActiveDraft(draft => ({ ...draft, [key]: value }));
  const relations = () => ({
    contacts: localContacts, activities: localActivities, tasks: localTasks,
    documents: localDocuments, history: current?.history || history,
  });
  // Every opportunity write appends a history row server-side, so a re-read
  // record's history is newer than ours; keep ours only if it came back empty.
  const relationsFor = saved => ({ ...relations(), ...(saved?.history?.length ? { history: saved.history } : {}) });
  const reconcileRelation = (key, rows) => {
    if (key === "contacts") setLocalContacts(rows);
    if (key === "activities") setLocalActivities(rows);
    if (key === "tasks") setLocalTasks(rows);
    if (key === "documents") setLocalDocuments(rows);
    const enriched = mergeMarketingRelations(current, { ...relations(), [key]: rows });
    setCurrent(enriched);
    onSaved?.(enriched);
  };

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose?.();
  };

  const saveSection = async () => {
    if (section !== "overview" && section !== "qualification") return;
    if (section === "overview" && !String(overview.title || "").trim()) {
      setError("Opportunity name is required.");
      return;
    }
    setBusySection(section); setError(""); setErrorAction(null); setConflict(null);
    const fields = section === "overview" ? OVERVIEW_FIELDS : QUALIFICATION_FIELDS;
    const baseline = section === "overview" ? baselineOverview : baselineQualification;
    const draft = section === "overview" ? overview : qualification;
    const patch = Object.fromEntries(fields.filter(field => !same(draft[field], baseline[field])).map(field => [
      field,
      field === "productTags" || field === "showcaseProducts"
        ? (Array.isArray(draft[field]) ? draft[field] : String(draft[field] || "").split(",").map(value => value.trim()).filter(Boolean))
        : DATETIME_FIELDS.has(field) ? fromMarketingDateTimeLocal(draft[field]) : draft[field],
    ]));
    try {
      const saved = await attemptMarketingSectionSave({ api: updateApi, id: current.id, draft: patch, version: snapshotVersion });
      const enriched = mergeMarketingRelations(saved, relationsFor(saved));
      setCurrent(enriched); setSnapshotVersion(enriched.version);
      // Re-baseline only the section that was saved — the other one may hold
      // unsaved edits the user hasn't submitted yet.
      if (section === "overview") setOverview(valuesFor(enriched, OVERVIEW_FIELDS));
      else setQualification(valuesFor(enriched, QUALIFICATION_FIELDS));
      onSaved?.(enriched);
    } catch (saveError) {
      if (saveError instanceof MarketingConflictError || saveError?.code === "MARKETING_CONFLICT") {
        setConflict({ error: saveError, latest: null });
      } else { setError(saveError.message || "The section could not be saved. Your draft is still here; try again."); setErrorAction("save"); }
    } finally { setBusySection(null); }
  };

  const reviewLatest = async () => {
    setReviewing(true);
    try {
      const latest = await freshApi(current.id);
      setConflict(existing => ({ ...existing, latest }));
    } catch (reviewError) { setError(reviewError.message || "The latest record could not be loaded."); }
    finally { setReviewing(false); }
  };

  const keepDraft = () => {
    if (!conflict?.latest) return;
    setCurrent(conflict.latest);
    setSnapshotVersion(conflict.latest.version);
    setConflict(null);
  };

  const performArchive = async () => {
    setBusySection("archive"); setError(""); setErrorAction(null);
    try { const saved = await archiveApi(current.id, snapshotVersion); onArchived?.(saved); }
    catch (archiveError) { setError(archiveError.message || "The opportunity could not be archived."); setErrorAction("archive"); }
    finally { setBusySection(null); setConfirmArchive(false); }
  };

  const performRestore = async () => {
    setBusySection("restore"); setError(""); setErrorAction(null);
    try {
      const restored = await restoreApi(current.id, snapshotVersion);
      const saved = mergeMarketingRelations(restored, relationsFor(restored));
      setCurrent(saved); setSnapshotVersion(saved.version); onRestored?.(saved);
    }
    catch (restoreError) { setError(restoreError.message || "The opportunity could not be restored."); setErrorAction("restore"); }
    finally { setBusySection(null); }
  };

  const activityCreated = async row => {
    reconcileRelation("activities", [row, ...localActivities]);
    try {
      const latest = await freshApi(current.id);
      if (latest) {
        setCurrent(latest); setSnapshotVersion(latest.version);
        onSaved?.(latest);
      }
    } catch { /* Activity is safely stored; a later detail refresh catches up. */ }
  };

  const taskChanged = (row, action) => {
    reconcileRelation("tasks", action === "created" ? [row, ...localTasks] : localTasks.map(item => item.id === row.id ? row : item));
    freshApi(current.id).then(latest => {
      if (!latest) return;
      setCurrent(latest); setSnapshotVersion(latest.version); onSaved?.(latest);
    }).catch(() => {});
  };

  if (!current) return null;
  const field = (label, key, props = {}) => <Field label={label} htmlFor={`marketing-${key}`} className={props.wide ? "marketing-field-wide" : undefined}><Input id={`marketing-${key}`} value={activeDraft[key] ?? ""} onChange={event => setField(key, event.target.value)} {...props.input}/></Field>;
  const area = (label, key) => <Field label={label} htmlFor={`marketing-${key}`} className="marketing-field-wide"><Textarea id={`marketing-${key}`} value={activeDraft[key] ?? ""} onChange={event => setField(key, event.target.value)}/></Field>;
  const selectField = (label, key, options, emptyLabel) => <Field label={label} htmlFor={`marketing-${key}`}><select id={`marketing-${key}`} className="select" value={activeDraft[key] || ""} onChange={event => setField(key, event.target.value)}><option value="">{emptyLabel}</option>{options.map(option => <option key={option.id} value={option.id}>{option.name || option.display_name || option.email || "Unnamed"}</option>)}</select></Field>;
  const nextUp = nextMarketingAction(localTasks, overview.nextAction || "");
  const nextUpLabel = typeof nextUp === "string" ? nextUp : nextUp?.title;
  const contactOptions = localContacts.map(link => ({ id: link.contactId || link.id, name: link.name || contactName(link.contactId || link.id) }));

  return (
    <>
      <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
        <DialogContent size="xl" className="marketing-opportunity-dialog" aria-describedby="marketing-dialog-description">
          <DialogHeader className="marketing-dialog-header">
            <div className="marketing-dialog-kicker"><Badge tone={current.outcome === "won" ? "success" : current.outcome === "lost" ? "danger" : "brand"}>{current.stage}</Badge>{current.archivedAt && <Badge tone="neutral">Archived</Badge>}</div>
            <DialogTitle>{overview.title || current.title}</DialogTitle>
            <DialogDescription id="marketing-dialog-description">Keep the decision path, next action, and supporting evidence together.</DialogDescription>
            <div className="marketing-dialog-summary" aria-label="Opportunity summary">
              <div><span>Organization</span><strong>{clients.find(client => client.id === overview.clientId)?.name || current.organizationName || "Not set"}</strong></div>
              <div><span>Owner</span><strong>{users.find(user => user.id === overview.ownerId)?.name || current.ownerName || "Unassigned"}</strong></div>
              <div><span>Probability</span><strong>{overview.probability === "" || overview.probability === null ? "Not set" : `${overview.probability}%`}</strong></div>
              <div><span>Value</span><strong>{displayMoney(overview.estimatedValue)}</strong></div>
              <div className="marketing-dialog-next"><span>Next action</span><strong>{nextUpLabel || "No next action recorded"}</strong></div>
            </div>
          </DialogHeader>
          <Tabs value={section} onValueChange={setSection}><TabsList variant="underline" className="marketing-sheet-tabs" aria-label="Opportunity details">{SECTIONS.map(item => <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>)}</TabsList></Tabs>
          <DialogBody className="marketing-dialog-body">
            {error && <div ref={errorRef} tabIndex={-1}><Alert role="alert" tone="danger" title="Something needs attention">{error}{errorAction && <Button size="sm" variant="default" onClick={errorAction === "archive" ? performArchive : errorAction === "restore" ? performRestore : saveSection}>Retry</Button>}</Alert></div>}
            {conflict && <ConflictPanel conflict={conflict} draft={activeDraft} onReview={reviewLatest} onKeep={keepDraft} reviewing={reviewing}/>} 

            {section === "overview" && <div className="marketing-overview-sections">
              <section className="marketing-detail-section"><div className="marketing-section-heading"><div><h3>Opportunity essentials</h3><p>The account, ownership, source, and product context.</p></div></div><div className="marketing-form-grid">
                {field("Opportunity name", "title", { wide: true })}
                <Field label="Organization" htmlFor="marketing-clientId"><select id="marketing-clientId" className="select" value={overview.clientId || ""} onChange={event => setField("clientId", event.target.value)}><option value="">Not set</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></Field>
                <Field label="Owner" htmlFor="marketing-ownerId"><select id="marketing-ownerId" className="select" value={overview.ownerId || ""} onChange={event => setField("ownerId", event.target.value)}><option value="">Unassigned</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
                {field("Source", "source")}{field("Introducer", "introducer")}
                <Field label="Products" htmlFor="marketing-productTags" className="marketing-field-wide"><Input id="marketing-productTags" value={Array.isArray(overview.productTags) ? overview.productTags.join(", ") : overview.productTags} onChange={event => setField("productTags", event.target.value)}/></Field>
              </div></section>
              <section className="marketing-detail-section"><div className="marketing-section-heading"><div><h3>Next step and forecast</h3><p>What matters now, when it is due, and the current commercial outlook.</p></div></div><div className="marketing-form-grid">
                {area("Summary", "summary")}{area("Next action", "nextAction")}
                {field("Next action due", "nextActionDueAt", { input: { type: "datetime-local" } })}{field("Expected close date", "expectedCloseDate", { input: { type: "date" } })}
                {field("Estimated value", "estimatedValue", { input: { type: "number", min: 0, step: "0.01" } })}{field("Probability", "probability", { input: { type: "number", min: 0, max: 100 } })}
              </div></section>
              {current.outcome && <section className="marketing-detail-section" aria-label="Contract outcome"><div className="marketing-section-heading"><div><h3>Contract outcome</h3><p>Recorded when the opportunity moved to the final stage. Change it by moving the card again.</p></div></div><dl className="marketing-outcome-list">
                <div><dt>Outcome</dt><dd>{current.outcome === "won" ? "Won" : "Lost"}</dd></div>
                {current.outcome === "won" && <><div><dt>Signature date</dt><dd>{displayDay(current.signedAt)}</dd></div><div><dt>Final contract value</dt><dd>{displayMoney(current.finalContractValue)}</dd></div></>}
                {current.outcome === "lost" && <><div><dt>Loss reason</dt><dd>{current.lossReason || "Not recorded"}</dd></div><div className="marketing-field-wide"><dt>What we learned</dt><dd>{current.lossDetail || "Not recorded"}</dd></div></>}
              </dl></section>}
              <fieldset className="marketing-portfolio-context">
                <legend>Portfolio context</legend>
                <p>These fields preserve the operating view supplied by the marketing team. Beacon stage and probability remain the sales forecast controls.</p>
                <div className="marketing-form-grid">
                  {field("Assigned team", "assignedTeam")}
                  {field("Task order", "taskOrder")}
                  {area("Phases / Current Status", "deliveryStatus")}
                  {field("Project %", "projectProgress", { input: { type: "number", min: 0, max: 100, step: "0.01" } })}
                  {field("Original sales phase", "sourceSalesPhase", { wide: true })}
                </div>
              </fieldset>
            </div>}

            {section === "qualification" && <div className="marketing-qualification">
              <fieldset><legend>Initial showcase</legend><div className="marketing-form-grid">{field("Meeting date", "showcaseMeetingAt", { input: { type: "datetime-local" } })}{field("Location", "showcaseLocation")}{area("Products showcased", "showcaseProducts")}{area("Attendees", "showcaseAttendeesSummary")}{area("Fit", "showcaseFit")}{area("Outcome", "showcaseOutcome")}</div></fieldset>
              <fieldset><legend>IQM - Initial Qualified Meeting</legend><div className="marketing-form-grid">{area("Problem statement", "problemStatement")}{area("Desired outcome", "desiredOutcome")}{area("Solution fit", "solutionFit")}{area("Clarifying questions", "clarifyingQuestions")}{selectField("Clarifying owner", "clarifyingOwnerId", users, "Unassigned")}{field("Clarifying questions due", "clarifyingDueAt", { input: { type: "datetime-local" } })}{field("Answers status", "clarifyingAnswersStatus")}{field("Draft SOW status", "draftSowStatus")}</div></fieldset>
              <fieldset><legend>BANT - Budget Authority Need Time</legend><div className="marketing-bant-grid"><section><h4>Budget</h4>{field("Budget amount", "budgetAmount", { input: { type: "number", min: 0 } })}{field("Budget status", "budgetStatus")}{area("Budget notes", "budgetNotes")}</section><section><h4>Authority</h4>{selectField("Authority contact", "authorityContactId", contactOptions, "Not selected")}{area("Authority notes", "authorityNotes")}</section><section><h4>Need</h4>{area("Need summary", "needSummary")}</section><section><h4>Time</h4>{area("Timing summary", "timingSummary")}{area("Decision process", "decisionProcess")}</section></div></fieldset>
              <fieldset><legend>Proposal</legend><div className="marketing-form-grid">{field("Proposal version", "proposalVersion")}{field("Proposal value", "proposalValue", { input: { type: "number", min: 0 } })}{field("Proposal sent", "proposalSentAt", { input: { type: "datetime-local" } })}{field("Anticipated decision date", "anticipatedDecisionDate", { input: { type: "date" } })}{area("Scope summary", "scopeSummary")}</div></fieldset>
              <fieldset><legend>Verbal approval</legend><div className="marketing-form-grid">{field("Verbal approval date", "verbalApprovalAt", { input: { type: "datetime-local" } })}{selectField("Approver contact", "verbalApproverContactId", contactOptions, "Not selected")}{field("Target signature date", "targetSignatureDate", { input: { type: "date" } })}{area("Verbal terms", "verbalTerms")}{area("Signature risks", "signatureRisks")}{area("Resource planning note", "resourcePlanningNote")}</div></fieldset>
              <fieldset><legend>Legal and contract</legend><div className="marketing-form-grid">{field("MSA status", "msaStatus")}{field("SOW status", "sowStatus")}{selectField("Legal owner", "legalOwnerId", users, "Unassigned")}{selectField("Customer legal contact", "customerLegalContactId", contactOptions, "Not selected")}{field("Redline status", "redlineStatus")}{field("Latest document version", "latestDocumentVersion")}{area("Legal issues", "legalIssues")}{field("Competitor", "competitor")}{area("Lesson learned", "lessonLearned")}</div></fieldset>
            </div>}

            {section === "people" && <MarketingContactsPanel opportunity={current} contacts={localContacts} clients={clients} onChanged={rows => reconcileRelation("contacts", rows)} onRefreshDirectory={refreshDirectory} refreshing={directoryRefreshing}/>}
            {section === "activity" && <MarketingActivityPanel opportunityId={current.id} activities={localActivities} users={users} contacts={localContacts} onCreated={activityCreated}/>}
            {section === "tasks" && <MarketingTaskPanel opportunityId={current.id} tasks={localTasks} users={users} onChanged={taskChanged}/>}
            {section === "files" && <div className="marketing-files-history"><MarketingDocumentPanel opportunityId={current.id} documents={localDocuments} onChanged={rows => reconcileRelation("documents", rows)}/><section className="marketing-detail-list"><h3>Stage history</h3>{(current.history || history).length ? (current.history || history).map(item => <article key={item.id}><strong>{item.fromStage || "Created"} → {item.toStage}</strong><span>{userName(item.changedBy)} · {displayDate(item.changedAt)}</span>{item.transitionNote && <p>{item.transitionNote}</p>}</article>) : <p>No stage changes yet.</p>}</section></div>}
          </DialogBody>
          <DialogFooter className="marketing-detail-footer">
            <div>{current.archivedAt ? <Button variant="primary" onClick={performRestore} disabled={!!busySection}><Icon name="restore"/>Restore opportunity</Button> : <Button variant="destructive-soft" onClick={() => setConfirmArchive(true)} disabled={!!busySection}><Icon name="trash"/>Archive opportunity</Button>}</div>
            <div><Button variant="default" onClick={requestClose} disabled={!!busySection}>Close</Button>{(section === "overview" || section === "qualification") && <Button variant="primary" onClick={saveSection} disabled={!!busySection || !(section === "overview" ? dirtyOverview : dirtyQualification)} loading={busySection === section}>Save {SECTIONS.find(item => item.key === section)?.label}</Button>}</div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle><AlertDialogDescription>Your draft changes have not been saved.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={onClose}>Discard and close</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive opportunity?</AlertDialogTitle><AlertDialogDescription>It will leave active views but can be restored later. No history is deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={performArchive}>Archive opportunity</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </>
  );
}

export default MarketingOpportunitySheet;
