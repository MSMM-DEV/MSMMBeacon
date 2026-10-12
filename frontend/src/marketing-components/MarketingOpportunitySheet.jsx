import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Badge, Button, Field, Input, Sheet, SheetBody, SheetContent, SheetDescription,
  SheetFooter, SheetHeader, SheetTitle, Tabs, TabsList, TabsTrigger, Textarea,
} from "@/ui";
import { Icon } from "../icons.jsx";
import {
  archiveMarketingOpportunity,
  loadMarketingOpportunityFresh,
  restoreMarketingOpportunity,
  updateMarketingOpportunity,
} from "../data.js";
import { MarketingConflictError } from "../marketing-model.js";
import { attemptMarketingSectionSave, changedMarketingFields } from "./marketing-sheet-model.js";

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "qualification", label: "Qualification" },
  { key: "activity", label: "Activity" },
  { key: "tasks", label: "Tasks" },
  { key: "documents", label: "Documents" },
  { key: "history", label: "History" },
];

const OVERVIEW_FIELDS = [
  "title", "clientId", "ownerId", "source", "introducer", "summary", "nextAction",
  "nextActionDueAt", "expectedCloseDate", "estimatedValue", "productTags", "probability",
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

const valuesFor = (opportunity, fields) => Object.fromEntries(fields.map(field => [field, Array.isArray(opportunity?.[field]) ? [...opportunity[field]] : (opportunity?.[field] ?? "")]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const displayDate = value => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not recorded";

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

export function MarketingOpportunitySheet({
  opportunity,
  contacts = [], activities = [], tasks = [], documents = [], history = [],
  lookups = {}, onSaved, onArchived, onRestored, onClose,
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
  const [conflict, setConflict] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const errorRef = useRef(null);

  useEffect(() => {
    setCurrent(opportunity);
    setOverview(valuesFor(opportunity, OVERVIEW_FIELDS));
    setQualification(valuesFor(opportunity, QUALIFICATION_FIELDS));
    setSnapshotVersion(opportunity?.version || 1);
    setError(""); setConflict(null);
  }, [opportunity?.id, opportunity?.version]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const baselineOverview = useMemo(() => valuesFor(current, OVERVIEW_FIELDS), [current]);
  const baselineQualification = useMemo(() => valuesFor(current, QUALIFICATION_FIELDS), [current]);
  const dirtyOverview = !same(overview, baselineOverview);
  const dirtyQualification = !same(qualification, baselineQualification);
  const dirty = dirtyOverview || dirtyQualification;
  const activeDraft = section === "qualification" ? qualification : overview;
  const setActiveDraft = section === "qualification" ? setQualification : setOverview;
  const users = lookups.users || [];
  const clients = lookups.clients || [];
  const userName = id => lookups.usersById?.[id]?.name || users.find(user => user.id === id)?.name || "Unknown user";
  const contactName = id => lookups.contactsById?.[id]?.name || contacts.find(contact => (contact.contactId || contact.id) === id)?.name || "Unknown contact";
  const setField = (key, value) => setActiveDraft(draft => ({ ...draft, [key]: value }));

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
    setBusySection(section); setError(""); setConflict(null);
    const fields = section === "overview" ? OVERVIEW_FIELDS : QUALIFICATION_FIELDS;
    const baseline = section === "overview" ? baselineOverview : baselineQualification;
    const draft = section === "overview" ? overview : qualification;
    const patch = Object.fromEntries(fields.filter(field => !same(draft[field], baseline[field])).map(field => [field, field === "productTags" || field === "showcaseProducts" ? (Array.isArray(draft[field]) ? draft[field] : String(draft[field] || "").split(",").map(value => value.trim()).filter(Boolean)) : draft[field]]));
    try {
      const saved = await attemptMarketingSectionSave({ api: updateApi, id: current.id, draft: patch, version: snapshotVersion });
      setCurrent(saved); setSnapshotVersion(saved.version);
      setOverview(valuesFor(saved, OVERVIEW_FIELDS)); setQualification(valuesFor(saved, QUALIFICATION_FIELDS));
      onSaved?.(saved);
    } catch (saveError) {
      if (saveError instanceof MarketingConflictError || saveError?.code === "MARKETING_CONFLICT") {
        setConflict({ error: saveError, latest: null });
      } else setError(saveError.message || "The section could not be saved. Your draft is still here; try again.");
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
    setBusySection("archive"); setError("");
    try { const saved = await archiveApi(current.id, snapshotVersion); onArchived?.(saved); }
    catch (archiveError) { setError(archiveError.message || "The opportunity could not be archived."); }
    finally { setBusySection(null); setConfirmArchive(false); }
  };

  const performRestore = async () => {
    setBusySection("restore"); setError("");
    try { const saved = await restoreApi(current.id, snapshotVersion); setCurrent(saved); setSnapshotVersion(saved.version); onRestored?.(saved); }
    catch (restoreError) { setError(restoreError.message || "The opportunity could not be restored."); }
    finally { setBusySection(null); }
  };

  if (!current) return null;
  const field = (label, key, props = {}) => <Field label={label} htmlFor={`marketing-${key}`} className={props.wide ? "marketing-field-wide" : undefined}><Input id={`marketing-${key}`} value={activeDraft[key] ?? ""} onChange={event => setField(key, event.target.value)} {...props.input}/></Field>;
  const area = (label, key) => <Field label={label} htmlFor={`marketing-${key}`} className="marketing-field-wide"><Textarea id={`marketing-${key}`} value={activeDraft[key] ?? ""} onChange={event => setField(key, event.target.value)}/></Field>;

  return (
    <>
      <Sheet open onOpenChange={open => { if (!open) requestClose(); }}>
        <SheetContent side="right" className="marketing-opportunity-sheet" aria-describedby="marketing-sheet-description">
          <SheetHeader>
            <div><Badge tone={current.outcome === "won" ? "success" : current.outcome === "lost" ? "danger" : "brand"}>{current.stage}</Badge></div>
            <SheetTitle>{current.title}</SheetTitle>
            <SheetDescription id="marketing-sheet-description">Complete the evidence for the current stage and keep the next action clear.</SheetDescription>
          </SheetHeader>
          <Tabs value={section} onValueChange={setSection}><TabsList variant="underline" className="marketing-sheet-tabs" aria-label="Opportunity details">{SECTIONS.map(item => <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>)}</TabsList></Tabs>
          <SheetBody>
            {error && <div ref={errorRef} tabIndex={-1}><Alert role="alert" tone="danger" title="Could not save">{error}<Button size="sm" variant="default" onClick={saveSection}>Retry</Button></Alert></div>}
            {conflict && <ConflictPanel conflict={conflict} draft={activeDraft} onReview={reviewLatest} onKeep={keepDraft} reviewing={reviewing}/>} 

            {section === "overview" && <div className="marketing-form-grid">
              {field("Opportunity name", "title", { wide: true })}
              <Field label="Organization" htmlFor="marketing-clientId"><select id="marketing-clientId" className="select" value={overview.clientId || ""} onChange={event => setField("clientId", event.target.value)}><option value="">Not set</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></Field>
              <Field label="Owner" htmlFor="marketing-ownerId"><select id="marketing-ownerId" className="select" value={overview.ownerId || ""} onChange={event => setField("ownerId", event.target.value)}><option value="">Unassigned</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
              {field("Source", "source")}{field("Introducer", "introducer")}{area("Summary", "summary")}{area("Next action", "nextAction")}
              {field("Next action due", "nextActionDueAt", { input: { type: "datetime-local" } })}{field("Expected close date", "expectedCloseDate", { input: { type: "date" } })}
              {field("Estimated value", "estimatedValue", { input: { type: "number", min: 0, step: "0.01" } })}{field("Probability", "probability", { input: { type: "number", min: 0, max: 100 } })}
              <Field label="Products" htmlFor="marketing-productTags" className="marketing-field-wide"><Input id="marketing-productTags" value={Array.isArray(overview.productTags) ? overview.productTags.join(", ") : overview.productTags} onChange={event => setField("productTags", event.target.value)}/></Field>
            </div>}

            {section === "qualification" && <div className="marketing-qualification">
              <fieldset><legend>Initial showcase</legend><div className="marketing-form-grid">{field("Meeting date", "showcaseMeetingAt", { input: { type: "datetime-local" } })}{field("Location", "showcaseLocation")}{area("Products showcased", "showcaseProducts")}{area("Attendees", "showcaseAttendeesSummary")}{area("Fit", "showcaseFit")}{area("Outcome", "showcaseOutcome")}</div></fieldset>
              <fieldset><legend>IQM - Initial Qualified Meeting</legend><div className="marketing-form-grid">{area("Problem statement", "problemStatement")}{area("Desired outcome", "desiredOutcome")}{area("Solution fit", "solutionFit")}{area("Clarifying questions", "clarifyingQuestions")}{field("Clarifying questions due", "clarifyingDueAt", { input: { type: "datetime-local" } })}{field("Answers status", "clarifyingAnswersStatus")}{field("Draft SOW status", "draftSowStatus")}</div></fieldset>
              <fieldset><legend>BANT - Budget Authority Need Time</legend><div className="marketing-bant-grid"><section><h4>Budget</h4>{field("Budget amount", "budgetAmount", { input: { type: "number", min: 0 } })}{field("Budget status", "budgetStatus")}{area("Budget notes", "budgetNotes")}</section><section><h4>Authority</h4>{field("Authority contact", "authorityContactId")}{area("Authority notes", "authorityNotes")}</section><section><h4>Need</h4>{area("Need summary", "needSummary")}</section><section><h4>Time</h4>{area("Timing summary", "timingSummary")}{area("Decision process", "decisionProcess")}</section></div></fieldset>
              <fieldset><legend>Proposal</legend><div className="marketing-form-grid">{field("Proposal version", "proposalVersion")}{field("Proposal value", "proposalValue", { input: { type: "number", min: 0 } })}{field("Proposal sent", "proposalSentAt", { input: { type: "datetime-local" } })}{field("Anticipated decision date", "anticipatedDecisionDate", { input: { type: "date" } })}{area("Scope summary", "scopeSummary")}</div></fieldset>
              <fieldset><legend>Verbal approval</legend><div className="marketing-form-grid">{field("Verbal approval date", "verbalApprovalAt", { input: { type: "datetime-local" } })}{field("Approver contact", "verbalApproverContactId")}{field("Target signature date", "targetSignatureDate", { input: { type: "date" } })}{area("Verbal terms", "verbalTerms")}{area("Signature risks", "signatureRisks")}{area("Resource planning note", "resourcePlanningNote")}</div></fieldset>
              <fieldset><legend>Legal and contract</legend><div className="marketing-form-grid">{field("MSA status", "msaStatus")}{field("SOW status", "sowStatus")}{field("Legal owner", "legalOwnerId")}{field("Customer legal contact", "customerLegalContactId")}{field("Redline status", "redlineStatus")}{field("Latest document version", "latestDocumentVersion")}{area("Legal issues", "legalIssues")}</div></fieldset>
            </div>}

            {section === "activity" && <section className="marketing-detail-list"><h3>Activity</h3>{activities.length ? activities.map(item => <article key={item.id}><strong>{item.activityType}</strong><time>{displayDate(item.occurredAt)}</time><p>{item.summary}</p>{item.outcome && <p>Outcome: {item.outcome}</p>}</article>) : <p>No activity logged yet.</p>}</section>}
            {section === "tasks" && <section className="marketing-detail-list"><h3>Tasks</h3>{tasks.length ? tasks.map(item => <article key={item.id}><strong>{item.title}</strong><Badge tone={item.status === "completed" ? "success" : "neutral"}>{item.status}</Badge><p>{item.dueAt ? displayDate(item.dueAt) : "No due date"}</p></article>) : <p>No tasks yet.</p>}</section>}
            {section === "documents" && <section className="marketing-detail-list"><h3>Documents</h3>{documents.length ? documents.map(item => <article key={item.id}><Icon name="file"/><strong>{item.fileName}</strong><span>{item.documentType}</span></article>) : <p>No documents uploaded yet.</p>}</section>}
            {section === "history" && <section className="marketing-detail-list"><h3>History</h3>{history.length ? history.map(item => <article key={item.id}><strong>{item.fromStage || "Created"} → {item.toStage}</strong><span>{userName(item.changedBy)} · {displayDate(item.changedAt)}</span>{item.transitionNote && <p>{item.transitionNote}</p>}</article>) : <p>No stage changes yet.</p>}</section>}
          </SheetBody>
          <SheetFooter>
            {current.archivedAt ? <Button variant="primary" onClick={performRestore} disabled={!!busySection}><Icon name="restore"/>Restore opportunity</Button> : <Button variant="destructive-soft" onClick={() => setConfirmArchive(true)} disabled={!!busySection}><Icon name="trash"/>Archive opportunity</Button>}
            {(section === "overview" || section === "qualification") && <Button variant="primary" onClick={saveSection} disabled={!!busySection || !(section === "overview" ? dirtyOverview : dirtyQualification)} loading={busySection === section}>Save {SECTIONS.find(item => item.key === section)?.label}</Button>}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle><AlertDialogDescription>Your draft changes have not been saved.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={onClose}>Discard and close</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive opportunity?</AlertDialogTitle><AlertDialogDescription>It will leave active views but can be restored later. No history is deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={performArchive}>Archive opportunity</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </>
  );
}

export default MarketingOpportunitySheet;
