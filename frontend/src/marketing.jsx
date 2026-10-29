import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, EmptyState, Field, Input, InputGroup,
  Tabs, TabsList, TabsTrigger, Textarea,
} from "@/ui";
import { Icon } from "./icons.jsx";
import {
  createMarketingOpportunity,
  loadMarketingOpportunityFresh,
  loadMarketingWorkspace,
  transitionMarketingOpportunity,
} from "./data.js";
import {
  MARKETING_STAGE_NAMES,
  buildMarketingInsights,
  filterMarketingOpportunities,
} from "./marketing-rules.js";
import { MarketingBoard } from "./marketing-components/MarketingBoard.jsx";
import { MarketingTransitionDialog } from "./marketing-components/MarketingTransitionDialog.jsx";
import { MarketingOpportunitySheet } from "./marketing-components/MarketingOpportunitySheet.jsx";
import { MarketingList } from "./marketing-components/MarketingList.jsx";
import { MarketingInsights } from "./marketing-components/MarketingInsights.jsx";

const VIEW_LABELS = { pipeline: "Pipeline", list: "Opportunity list", insights: "Insights" };
const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
const MARKETING_VIEW_KEY = "beacon.marketing.view";
const MARKETING_STAGE_KEY = "beacon.marketing.stage";
const DEFAULT_MARKETING_FILTERS = Object.freeze({
  search: "", ownerId: "all", clientId: "all", stage: "all", product: "all",
  health: "all", closePeriod: "all", outcome: "all", archiveMode: "active",
});

function storedMarketingValue(key) {
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}

function initialMarketingView(fallback, allowed) {
  try {
    const routeView = new URLSearchParams(window.location.search).get("view");
    if (allowed.includes(routeView)) return routeView;
  } catch { /* Use the saved choice or the permitted fallback. */ }
  const saved = storedMarketingValue(MARKETING_VIEW_KEY);
  return allowed.includes(saved) ? saved : (allowed.includes(fallback) ? fallback : (allowed[0] || "pipeline"));
}

export function applyAuthoritativeOpportunity(rows, returned) {
  if (!returned?.id) return [...(rows || [])];
  const found = (rows || []).some(row => row.id === returned.id);
  return found ? rows.map(row => row.id === returned.id ? withDisplayEmbeds(returned, row) : row) : [returned, ...(rows || [])];
}

// A bare RPC row carries client_id/owner_id but not the joined names. Keep the
// names we already had while the ids still match, so the card never flips to
// "Organization not set" just because a save answered without the join.
function withDisplayEmbeds(returned, previous) {
  const keepClient = !returned.client && previous?.client && previous.clientId === returned.clientId;
  const keepOwner = !returned.owner && previous?.owner && previous.ownerId === returned.ownerId;
  if (!keepClient && !keepOwner) return returned;
  const next = { ...returned };
  if (keepClient) {
    next.client = previous.client;
    next.organizationName = next.organizationName || previous.organizationName;
  }
  if (keepOwner) {
    next.owner = previous.owner;
    next.ownerName = next.ownerName || previous.ownerName;
  }
  return next;
}

export function reconcileMarketingWorkspace(workspace, returned) {
  if (!workspace || !returned?.id) return workspace;
  const replaceSupporting = (key, rows) => Array.isArray(returned[key])
    ? [...(rows || []).filter(item => item.opportunityId !== returned.id), ...returned[key]]
    : rows;
  return {
    ...workspace,
    opportunities: returned.archivedAt
      ? (workspace.opportunities || []).filter(row => row.id !== returned.id)
      : applyAuthoritativeOpportunity(workspace.opportunities, returned),
    archivedOpportunities: returned.archivedAt
      ? applyAuthoritativeOpportunity(workspace.archivedOpportunities, returned)
      : (workspace.archivedOpportunities || []).filter(row => row.id !== returned.id),
    contacts: replaceSupporting("contacts", workspace.contacts),
    activities: replaceSupporting("activities", workspace.activities),
    tasks: replaceSupporting("tasks", workspace.tasks),
    documents: replaceSupporting("documents", workspace.documents),
    history: replaceSupporting("history", workspace.history),
  };
}

export async function runMarketingTransition({ api = transitionMarketingOpportunity, opportunity, transition }) {
  return api(opportunity.id, { ...transition, stage: transition.toStage || transition.stage }, opportunity.version);
}

function updateMarketingUrl(view, opportunityId) {
  const params = new URLSearchParams(window.location.search);
  params.set("tab", "marketing");
  params.set("view", view);
  if (opportunityId) params.set("opportunity", opportunityId);
  else params.delete("opportunity");
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function emptyCreateForm(currentUser) {
  return {
    title: "", clientId: "", ownerId: currentUser?.id || "", nextAction: "",
    estimatedValue: "", expectedCloseDate: "", productTags: "", primaryContactId: "",
    newOrganization: false, organizationName: "", contactName: "", contactEmail: "",
    recoveredOrganizationName: "",
  };
}

function MarketingCreateDialog({ open, clients, users, currentUser, onCancel, onCreated }) {
  const [form, setForm] = useState(() => emptyCreateForm(currentUser));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef(null);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const selectedClient = clients.find(client => client.id === form.clientId);
  const contacts = selectedClient?.contacts || [];

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (open) { setError(""); setSaving(false); } }, [open]);

  const submit = async event => {
    event.preventDefault();
    const title = form.title.trim();
    const organizationReady = form.newOrganization ? form.organizationName.trim() : form.clientId;
    if (!title || !organizationReady || !form.ownerId || !form.nextAction.trim()) {
      setError("Complete opportunity name, organization, owner, and first next action.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      let row = await createMarketingOpportunity({
        title,
        clientId: form.newOrganization ? null : form.clientId,
        newClient: form.newOrganization ? { name: form.organizationName, contactPerson: form.contactName, email: form.contactEmail } : null,
        ownerId: form.ownerId,
        nextAction: form.nextAction,
        estimatedValue: form.estimatedValue,
        expectedCloseDate: form.expectedCloseDate,
        productTags: form.productTags.split(",").map(tag => tag.trim()).filter(Boolean),
        primaryContactId: form.primaryContactId || null,
        stage: MARKETING_STAGE_NAMES[0],
        probability: 5,
      });
      onCreated(row);
      setForm(emptyCreateForm(currentUser));
    } catch (saveError) {
      if (saveError.createdClientId) {
        setForm(current => ({
          ...current,
          newOrganization: false,
          clientId: saveError.createdClientId,
          recoveredOrganizationName: saveError.createdClientName || current.organizationName,
        }));
      }
      setError(saveError.message || "The opportunity could not be created.");
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !saving) onCancel(); }}>
      <DialogContent size="lg" aria-describedby="marketing-create-description">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New Sales opportunity</DialogTitle>
            <DialogDescription id="marketing-create-description">Start with the essentials. Qualification details can be completed as the relationship develops.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error && <div ref={errorRef} tabIndex={-1}><Alert role="alert" tone="danger" title="Check the opportunity">{error}</Alert></div>}
            <div className="marketing-form-grid">
              <Field label="Opportunity name" htmlFor="marketing-title" required><Input id="marketing-title" autoFocus required value={form.title} onChange={event => set("title", event.target.value)}/></Field>
              <Field label="Organization" htmlFor="marketing-client" required>
                {!form.newOrganization ? (
                  <select id="marketing-client" className="select" required value={form.clientId} onChange={event => { set("clientId", event.target.value); set("primaryContactId", ""); }}>
                    <option value="">Choose from Directory</option>
                    {form.recoveredOrganizationName && !clients.some(client => client.id === form.clientId) && <option value={form.clientId}>{form.recoveredOrganizationName} (created)</option>}
                    {clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                  </select>
                ) : <Input id="marketing-client" required value={form.organizationName} onChange={event => set("organizationName", event.target.value)}/>}
                <Button type="button" size="sm" variant="ghost" onClick={() => set("newOrganization", !form.newOrganization)}>{form.newOrganization ? "Choose existing organization" : "Add a new organization"}</Button>
              </Field>
              {form.newOrganization && (<>
                <Field label="First contact" htmlFor="marketing-contact-name"><Input id="marketing-contact-name" value={form.contactName} onChange={event => set("contactName", event.target.value)}/></Field>
                <Field label="Contact email" htmlFor="marketing-contact-email"><Input id="marketing-contact-email" type="email" value={form.contactEmail} onChange={event => set("contactEmail", event.target.value)}/></Field>
              </>)}
              {!form.newOrganization && contacts.length > 0 && <Field label="Primary contact" htmlFor="marketing-contact"><select id="marketing-contact" className="select" value={form.primaryContactId} onChange={event => set("primaryContactId", event.target.value)}><option value="">Add later</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select></Field>}
              <Field label="Owner" htmlFor="marketing-owner" required><select id="marketing-owner" className="select" required value={form.ownerId} onChange={event => set("ownerId", event.target.value)}><option value="">Choose owner</option>{users.map(user => <option key={user.id} value={user.id}>{user.name || user.display_name}</option>)}</select></Field>
              <Field label="First next action" htmlFor="marketing-next-action" required className="marketing-field-wide"><Textarea id="marketing-next-action" required value={form.nextAction} onChange={event => set("nextAction", event.target.value)} placeholder="For example: Dan to introduce us to the prospect"/></Field>
              <Field label="Estimated value" htmlFor="marketing-estimated-value"><Input id="marketing-estimated-value" type="number" min="0" step="0.01" value={form.estimatedValue} onChange={event => set("estimatedValue", event.target.value)}/></Field>
              <Field label="Expected close date" htmlFor="marketing-close"><Input id="marketing-close" type="date" value={form.expectedCloseDate} onChange={event => set("expectedCloseDate", event.target.value)}/></Field>
              <Field label="Products" htmlFor="marketing-products" description="Separate products with commas" className="marketing-field-wide"><Input id="marketing-products" value={form.productTags} onChange={event => set("productTags", event.target.value)} placeholder="AI assistant, SaaS platform"/></Field>
            </div>
          </DialogBody>
          <DialogFooter><Button type="button" variant="default" onClick={onCancel} disabled={saving}>Cancel</Button><Button type="submit" variant="primary" disabled={saving} loading={saving}>{saving ? "Creating…" : "Create opportunity"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const EXTRA_FILTER_KEYS = ["clientId", "stage", "closePeriod", "outcome"];

function MarketingToolbar({ filters, setFilters, users, clients, onCreate }) {
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  const extraActive = EXTRA_FILTER_KEYS.filter(key => filters[key] && filters[key] !== "all").length + (filters.archiveMode !== "active" ? 1 : 0);
  const anyActive = Boolean(filters.search) || filters.ownerId !== "all" || filters.health !== "all" || extraActive > 0;
  const [moreOpen, setMoreOpen] = useState(() => extraActive > 0);
  return (
    <div className="marketing-toolbar" role="group" aria-label="Sales filters">
      <div className="marketing-toolbar-row">
        <InputGroup className="marketing-toolbar-search" type="search" aria-label="Search opportunities" placeholder="Search opportunities…" value={filters.search} onChange={event => update("search", event.target.value)} leading={<Icon name="search"/>}/>
        <select aria-label="Filter by owner" value={filters.ownerId} onChange={event => update("ownerId", event.target.value)}><option value="all">All owners</option>{users.map(user => <option key={user.id} value={user.id}>{user.name || user.display_name}</option>)}</select>
        <select aria-label="Filter by health" value={filters.health} onChange={event => update("health", event.target.value)}><option value="all">All health</option><option value="on_track">On track</option><option value="attention">Needs attention</option><option value="stalled">Stalled</option></select>
        <Button variant="default" className="marketing-more-toggle" aria-expanded={moreOpen} aria-controls="marketing-more-filters" onClick={() => setMoreOpen(open => !open)}>
          <Icon name="sliders"/>More filters{extraActive > 0 && <span className="marketing-filter-count" aria-label={`${extraActive} active`}>{extraActive}</span>}
        </Button>
        {anyActive && <Button variant="ghost" className="marketing-clear-filters" onClick={() => setFilters({ ...DEFAULT_MARKETING_FILTERS })}><Icon name="x"/>Clear</Button>}
        <Button variant="primary" className="marketing-new-button" onClick={onCreate}><Icon name="plus"/>New opportunity</Button>
      </div>
      {moreOpen && (
        <div id="marketing-more-filters" className="marketing-toolbar-more">
          <label><span>Organization</span><select value={filters.clientId} onChange={event => update("clientId", event.target.value)}><option value="all">All organizations</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label><span>Stage</span><select value={filters.stage} onChange={event => update("stage", event.target.value)}><option value="all">All stages</option>{MARKETING_STAGE_NAMES.map(stage => <option key={stage} value={stage}>{stage}</option>)}</select></label>
          <label><span>Close date</span><select value={filters.closePeriod} onChange={event => update("closePeriod", event.target.value)}><option value="all">Any close date</option><option value="overdue">Overdue</option><option value="month">This month</option><option value="quarter">This quarter</option></select></label>
          <label><span>Outcome</span><select value={filters.outcome} onChange={event => update("outcome", event.target.value)}><option value="all">All outcomes</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select></label>
          <label><span>Records</span><select value={filters.archiveMode} onChange={event => update("archiveMode", event.target.value)}><option value="active">Active only</option><option value="archived">Archived only</option><option value="all">Active and archived</option></select></label>
        </div>
      )}
    </div>
  );
}

function MarketingKpis({ insights }) {
  const cards = [
    ["Active pipeline", insights.activeCount, money(insights.activeValue)],
    ["Weighted pipeline", money(insights.weightedValue), `${insights.closingThisQuarterCount} closing this quarter`],
    ["Won", insights.wonCount, money(insights.wonValue)],
    ["Needs attention", insights.overdueTaskCount + insights.stalledCount, `${insights.stalledCount} stalled`],
  ];
  return <section className="marketing-kpis" aria-label="Sales summary">{cards.map(([label, value, note]) => <div key={label}><p>{label}</p><strong>{value}</strong><span>{note}</span></div>)}</section>;
}

export function MarketingPage({ access, users = [], clients = [], currentUser = null, initialView = "pipeline", initialOpportunityId = null, onDirectoryRefresh }) {
  const visibleViews = useMemo(() => access.visibleChildren("page.marketing").filter(node => node.view), [access]);
  const allowedNames = useMemo(() => visibleViews.map(node => node.view), [visibleViews]);
  const [view, setView] = useState(() => initialMarketingView(initialView, allowedNames));
  const [workspace, setWorkspace] = useState(null);
  const [selectedId, setSelectedId] = useState(initialOpportunityId);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [moveIntent, setMoveIntent] = useState(null);
  const [moveSaving, setMoveSaving] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [notice, setNotice] = useState("");
  const [terminalOutcome, setTerminalOutcome] = useState("all");
  const [mobileStage, setMobileStage] = useState(() => {
    const saved = storedMarketingValue(MARKETING_STAGE_KEY);
    return MARKETING_STAGE_NAMES.includes(saved) ? saved : MARKETING_STAGE_NAMES[0];
  });
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_MARKETING_FILTERS }));
  const launchControlRef = useRef(null);
  const previousViewRef = useRef(view);

  const load = useCallback(async () => {
    setStatus("loading"); setError(null);
    try { setWorkspace(await loadMarketingWorkspace()); setStatus("ready"); }
    catch (loadError) { setError(loadError); setStatus("error"); }
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);
  useEffect(() => { if (allowedNames.length && !allowedNames.includes(view)) setView(allowedNames[0]); }, [allowedNames, view]);
  useEffect(() => {
    if (!allowedNames.includes(view)) return;
    updateMarketingUrl(view, selectedId);
    try { window.localStorage.setItem(MARKETING_VIEW_KEY, view); } catch { /* Persistence is optional. */ }
    if (previousViewRef.current !== view) {
      const heading = document.querySelector(".bx-pagetitle");
      if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
      previousViewRef.current = view;
    }
  }, [allowedNames, selectedId, view]);
  useEffect(() => {
    try { window.localStorage.setItem(MARKETING_STAGE_KEY, mobileStage); } catch { /* Persistence is optional. */ }
  }, [mobileStage]);
  useEffect(() => {
    const restoreRoute = () => {
      const params = new URLSearchParams(window.location.search);
      const routeView = params.get("view");
      if (allowedNames.includes(routeView)) setView(routeView);
      setSelectedId(params.get("opportunity"));
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [allowedNames]);
  useEffect(() => {
    const applySettings = event => setWorkspace(current => current ? {
      ...current,
      stalledAfterDays: event.detail?.stalledAfterDays ?? current.stalledAfterDays,
    } : current);
    window.addEventListener("beacon:marketing-settings", applySettings);
    return () => window.removeEventListener("beacon:marketing-settings", applySettings);
  }, []);

  if (status === "loading") return <div className="marketing-state" role="status" aria-live="polite"><Icon name="spinner" className="animate-spin"/> Loading Sales…</div>;
  if (status === "error") return <Alert tone="danger" title="Sales could not load" icon={<Icon name="warn"/>}><p>{error?.message || "Please try again."}</p><Button size="sm" variant="default" onClick={() => setReloadKey(key => key + 1)}><Icon name="refresh"/> Retry</Button></Alert>;

  const opportunities = workspace?.opportunities || [];
  const allOpportunities = [...opportunities, ...(workspace?.archivedOpportunities || [])];
  const filtered = filterMarketingOpportunities(allOpportunities, {
    ...filters,
    archived: filters.archiveMode === "archived" ? true : filters.archiveMode === "all" ? "all" : false,
  }, { tasks: workspace?.tasks || [], stalledAfterDays: workspace?.stalledAfterDays });
  const selected = [...opportunities, ...(workspace?.archivedOpportunities || [])].find(row => row.id === selectedId) || null;
  const clientsById = Object.fromEntries(clients.map(client => [client.id, client]));
  const usersById = Object.fromEntries(users.map(user => [user.id, user]));
  const insights = buildMarketingInsights(filtered, workspace?.tasks || [], workspace?.activities || [], {
    stalledAfterDays: workspace?.stalledAfterDays,
    history: workspace?.history || [],
    usersById,
    clientsById,
  });
  const openOpportunity = (row, event) => {
    launchControlRef.current = event?.currentTarget || document.activeElement;
    setSelectedId(row.id);
  };
  const closeOpportunity = () => {
    setSelectedId(null);
    const origin = launchControlRef.current;
    window.requestAnimationFrame(() => {
      if (origin?.isConnected) origin.focus();
      else document.querySelector(".bx-pagetitle")?.focus({ preventScroll: true });
    });
  };

  const confirmMove = async transition => {
    setMoveSaving(true); setMoveError("");
    try {
      const returned = await runMarketingTransition({ opportunity: moveIntent.opportunity, transition });
      setWorkspace(current => reconcileMarketingWorkspace(current, returned));
      // Keep the sheet open if it already was; a board move shouldn't pop it open.
      setSelectedId(current => current ? returned.id : current);
      setMoveIntent(null);
    } catch (transitionError) {
      if (transitionError?.code === "MARKETING_CONFLICT") {
        // Someone else saved this opportunity first. Pull the latest row so the
        // next confirm carries the current version instead of failing again.
        try {
          const latest = await loadMarketingOpportunityFresh(moveIntent.opportunity.id);
          setWorkspace(current => reconcileMarketingWorkspace(current, latest));
          setMoveIntent(current => current ? { ...current, opportunity: latest } : current);
          setMoveError("Someone else updated this opportunity. The latest version is loaded — confirm the move again.");
        } catch {
          setMoveError("Someone else updated this opportunity. Reload the page and try the move again.");
        }
      } else {
        setMoveError(transitionError.message || "The stage move could not be saved.");
      }
    }
    finally { setMoveSaving(false); }
  };

  return (
    <section className="marketing-page" aria-label="Sales workspace" data-current-user={currentUser?.id || undefined}>
      {notice && <Alert tone="warning" title="Opportunity created with one follow-up needed"><p>{notice}</p><Button size="sm" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></Alert>}
      <div className="marketing-page-bar">{visibleViews.length > 1 && <Tabs value={view} onValueChange={setView}><TabsList variant="underline" className="bx-page-tabs" aria-label="Sales views">{visibleViews.map(node => <TabsTrigger key={node.key} value={node.view}>{VIEW_LABELS[node.view] || node.label}</TabsTrigger>)}</TabsList></Tabs>}</div>
      <MarketingKpis insights={insights}/>
      <MarketingToolbar filters={filters} setFilters={setFilters} users={users} clients={clients} onCreate={() => setCreateOpen(true)}/>
      {!allOpportunities.length ? (
        <EmptyState iconName="marketing" title="Build your first Sales opportunity" description="Track the relationship from introduction through a signed or lost contract." action={<Button variant="primary" onClick={() => setCreateOpen(true)}>New opportunity</Button>}/>
      ) : !filtered.length ? (
        <EmptyState iconName="search" title="No opportunities match these filters" description="Clear the current filters to return to the full Sales pipeline." action={<Button variant="default" onClick={() => setFilters({ ...DEFAULT_MARKETING_FILTERS, archiveMode: opportunities.length ? "active" : "all" })}>Clear filters</Button>}/>
      ) : view === "pipeline" ? (
        <MarketingBoard opportunities={filtered} tasks={workspace.tasks} stalledAfterDays={workspace.stalledAfterDays} clientsById={clientsById} usersById={usersById} selectedMobileStage={mobileStage} onSelectedMobileStage={setMobileStage} terminalOutcome={terminalOutcome} onTerminalOutcomeChange={setTerminalOutcome} onOpen={openOpportunity} onMoveIntent={(opportunity, toStage) => { setMoveError(""); setMoveIntent({ opportunity, toStage }); }}/>
      ) : view === "list" ? (
        <MarketingList rows={filtered} tasks={workspace.tasks} usersById={usersById} clientsById={clientsById} stalledAfterDays={workspace.stalledAfterDays} onOpen={openOpportunity}/>
      ) : (
        <MarketingInsights insights={insights} onOpen={openOpportunity}/>
      )}
      {selected && <MarketingOpportunitySheet
        opportunity={selected}
        contacts={selected.contacts || workspace.contacts.filter(item => item.opportunityId === selected.id)}
        activities={selected.activities || workspace.activities.filter(item => item.opportunityId === selected.id)}
        tasks={selected.tasks || workspace.tasks.filter(item => item.opportunityId === selected.id)}
        documents={selected.documents || workspace.documents.filter(item => item.opportunityId === selected.id)}
        history={selected.history || workspace.history.filter(item => item.opportunityId === selected.id)}
        lookups={{ users, clients, usersById, clientsById }}
        onClose={closeOpportunity}
        onSaved={row => setWorkspace(current => reconcileMarketingWorkspace(current, row))}
        onArchived={row => { setWorkspace(current => reconcileMarketingWorkspace(current, row)); closeOpportunity(); }}
        onRestored={row => setWorkspace(current => reconcileMarketingWorkspace(current, row))}
        onDirectoryRefresh={onDirectoryRefresh}
      />}
      <MarketingCreateDialog open={createOpen} clients={clients} users={users} currentUser={currentUser} onCancel={() => setCreateOpen(false)} onCreated={row => { if (row.setupWarning) setNotice(row.setupWarning); setWorkspace(current => reconcileMarketingWorkspace(current, row)); setCreateOpen(false); setSelectedId(row.id); }}/>
      {moveIntent && <MarketingTransitionDialog opportunity={moveIntent.opportunity} toStage={moveIntent.toStage} saving={moveSaving} error={moveError} onCancel={() => { if (!moveSaving) setMoveIntent(null); }} onConfirm={confirmMove}/>}
    </section>
  );
}

export default MarketingPage;
