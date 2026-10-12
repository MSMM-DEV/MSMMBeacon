import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, EmptyState, Field, Input, InputGroup,
  Tabs, TabsList, TabsTrigger, Textarea,
} from "@/ui";
import { Icon } from "./icons.jsx";
import {
  addMarketingContact,
  createMarketingOpportunity,
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

const VIEW_LABELS = { pipeline: "Pipeline", list: "Opportunity list", insights: "Insights" };
const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));

export function applyAuthoritativeOpportunity(rows, returned) {
  if (!returned?.id) return [...(rows || [])];
  const found = (rows || []).some(row => row.id === returned.id);
  return found ? rows.map(row => row.id === returned.id ? returned : row) : [returned, ...(rows || [])];
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
        stage: MARKETING_STAGE_NAMES[0],
        probability: 5,
      });
      if (!form.newOrganization && form.primaryContactId) {
        const linked = await addMarketingContact({ opportunityId: row.id, contactId: form.primaryContactId, role: "Champion", isPrimary: true });
        row = { ...row, contacts: [...(row.contacts || []), linked] };
      }
      onCreated(row);
      setForm(emptyCreateForm(currentUser));
    } catch (saveError) {
      setError(saveError.message || "The opportunity could not be created.");
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !saving) onCancel(); }}>
      <DialogContent size="lg" aria-describedby="marketing-create-description">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New Marketing opportunity</DialogTitle>
            <DialogDescription id="marketing-create-description">Start with the essentials. Qualification details can be completed as the relationship develops.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error && <div ref={errorRef} tabIndex={-1}><Alert role="alert" tone="danger" title="Check the opportunity">{error}</Alert></div>}
            <div className="marketing-form-grid">
              <Field label="Opportunity name" htmlFor="marketing-title" required><Input id="marketing-title" autoFocus required value={form.title} onChange={event => set("title", event.target.value)}/></Field>
              <Field label="Organization" htmlFor="marketing-client" required>
                {!form.newOrganization ? (
                  <select id="marketing-client" className="select" required value={form.clientId} onChange={event => { set("clientId", event.target.value); set("primaryContactId", ""); }}>
                    <option value="">Choose from Directory</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
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
              <Field label="Products" htmlFor="marketing-products" hint="Separate products with commas" className="marketing-field-wide"><Input id="marketing-products" value={form.productTags} onChange={event => set("productTags", event.target.value)} placeholder="AI assistant, SaaS platform"/></Field>
            </div>
          </DialogBody>
          <DialogFooter><Button type="button" variant="default" onClick={onCancel} disabled={saving}>Cancel</Button><Button type="submit" variant="primary" disabled={saving} loading={saving}>{saving ? "Creating…" : "Create opportunity"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MarketingToolbar({ filters, setFilters, opportunities, users, clients, onCreate }) {
  const products = [...new Set(opportunities.flatMap(row => row.productTags || []))].sort();
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  return (
    <div className="marketing-toolbar" aria-label="Marketing filters">
      <InputGroup type="search" aria-label="Search opportunities" placeholder="Search opportunities…" value={filters.search} onChange={event => update("search", event.target.value)} leading={<Icon name="search"/>}/>
      <select aria-label="Filter by owner" value={filters.ownerId} onChange={event => update("ownerId", event.target.value)}><option value="all">All owners</option>{users.map(user => <option key={user.id} value={user.id}>{user.name || user.display_name}</option>)}</select>
      <select aria-label="Filter by organization" value={filters.clientId} onChange={event => update("clientId", event.target.value)}><option value="all">All organizations</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
      <select aria-label="Filter by stage" value={filters.stage} onChange={event => update("stage", event.target.value)}><option value="all">All stages</option>{MARKETING_STAGE_NAMES.map(stage => <option key={stage} value={stage}>{stage}</option>)}</select>
      <select aria-label="Filter by product" value={filters.product} onChange={event => update("product", event.target.value)}><option value="all">All products</option>{products.map(product => <option key={product} value={product}>{product}</option>)}</select>
      <select aria-label="Filter by health" value={filters.health} onChange={event => update("health", event.target.value)}><option value="all">All health</option><option value="on_track">On track</option><option value="attention">Needs attention</option><option value="stalled">Stalled</option></select>
      <select aria-label="Filter by close period" value={filters.closePeriod} onChange={event => update("closePeriod", event.target.value)}><option value="all">Any close date</option><option value="overdue">Overdue</option><option value="month">This month</option><option value="quarter">This quarter</option></select>
      <select aria-label="Filter by outcome" value={filters.outcome} onChange={event => update("outcome", event.target.value)}><option value="all">All outcomes</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select>
      <Button variant="primary" onClick={onCreate}><Icon name="plus"/>New opportunity</Button>
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
  return <section className="marketing-kpis" aria-label="Marketing summary">{cards.map(([label, value, note]) => <article key={label}><p>{label}</p><strong>{value}</strong><span>{note}</span></article>)}</section>;
}

export function MarketingPage({ access, users = [], clients = [], currentUser = null, initialView = "pipeline", initialOpportunityId = null }) {
  const visibleViews = useMemo(() => access.visibleChildren("page.marketing").filter(node => node.view), [access]);
  const allowedNames = useMemo(() => visibleViews.map(node => node.view), [visibleViews]);
  const [view, setView] = useState(allowedNames.includes(initialView) ? initialView : (allowedNames[0] || "pipeline"));
  const [workspace, setWorkspace] = useState(null);
  const [selectedId, setSelectedId] = useState(initialOpportunityId);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [moveIntent, setMoveIntent] = useState(null);
  const [moveSaving, setMoveSaving] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [mobileStage, setMobileStage] = useState(MARKETING_STAGE_NAMES[0]);
  const [filters, setFilters] = useState({ search: "", ownerId: "all", clientId: "all", stage: "all", product: "all", health: "all", closePeriod: "all", outcome: "all" });

  const load = useCallback(async () => {
    setStatus("loading"); setError(null);
    try { setWorkspace(await loadMarketingWorkspace()); setStatus("ready"); }
    catch (loadError) { setError(loadError); setStatus("error"); }
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);
  useEffect(() => { if (allowedNames.length && !allowedNames.includes(view)) setView(allowedNames[0]); }, [allowedNames, view]);
  useEffect(() => { if (allowedNames.includes(view)) updateMarketingUrl(view, selectedId); }, [allowedNames, selectedId, view]);

  if (status === "loading") return <div className="marketing-state" role="status" aria-live="polite"><Icon name="spinner" className="animate-spin"/> Loading Marketing…</div>;
  if (status === "error") return <Alert tone="danger" title="Marketing could not load" icon={<Icon name="warn"/>}><p>{error?.message || "Please try again."}</p><Button size="sm" variant="default" onClick={() => setReloadKey(key => key + 1)}><Icon name="refresh"/> Retry</Button></Alert>;

  const opportunities = workspace?.opportunities || [];
  const filtered = filterMarketingOpportunities(opportunities, filters, { tasks: workspace?.tasks || [], stalledAfterDays: workspace?.stalledAfterDays });
  const insights = buildMarketingInsights(filtered, workspace?.tasks || [], workspace?.activities || [], { stalledAfterDays: workspace?.stalledAfterDays });
  const selected = [...opportunities, ...(workspace?.archivedOpportunities || [])].find(row => row.id === selectedId) || null;
  const clientsById = Object.fromEntries(clients.map(client => [client.id, client]));
  const usersById = Object.fromEntries(users.map(user => [user.id, user]));

  const confirmMove = async transition => {
    setMoveSaving(true); setMoveError("");
    try {
      const returned = await runMarketingTransition({ opportunity: moveIntent.opportunity, transition });
      setWorkspace(current => ({ ...current, opportunities: applyAuthoritativeOpportunity(current.opportunities, returned) }));
      setSelectedId(returned.id);
      setMoveIntent(null);
    } catch (transitionError) { setMoveError(transitionError.message || "The stage move could not be saved."); }
    finally { setMoveSaving(false); }
  };

  return (
    <section className="marketing-page" aria-label="Marketing workspace" data-current-user={currentUser?.id || undefined}>
      <div className="marketing-page-bar">{visibleViews.length > 1 && <Tabs value={view} onValueChange={setView}><TabsList variant="underline" className="bx-page-tabs" aria-label="Marketing views">{visibleViews.map(node => <TabsTrigger key={node.key} value={node.view}>{VIEW_LABELS[node.view] || node.label}</TabsTrigger>)}</TabsList></Tabs>}</div>
      <MarketingKpis insights={insights}/>
      <MarketingToolbar filters={filters} setFilters={setFilters} opportunities={opportunities} users={users} clients={clients} onCreate={() => setCreateOpen(true)}/>
      {!opportunities.length ? (
        <EmptyState iconName="marketing" title="Build your first Marketing opportunity" hint="Track the relationship from introduction through a signed or lost contract." action={<Button variant="primary" onClick={() => setCreateOpen(true)}>New opportunity</Button>}/>
      ) : view === "pipeline" ? (
        <MarketingBoard opportunities={filtered} tasks={workspace.tasks} clientsById={clientsById} usersById={usersById} selectedMobileStage={mobileStage} onSelectedMobileStage={setMobileStage} onOpen={row => setSelectedId(row.id)} onMoveIntent={(opportunity, toStage) => { setMoveError(""); setMoveIntent({ opportunity, toStage }); }}/>
      ) : view === "list" ? (
        <div className="marketing-list-preview">{filtered.map(row => <button key={row.id} type="button" onClick={() => setSelectedId(row.id)}><strong>{row.title}</strong><span>{row.stage}</span><Badge>{row.probability}%</Badge></button>)}</div>
      ) : (
        <div className="marketing-insights-preview"><h2>Pipeline by stage</h2>{insights.stages.map(stage => <div key={stage.stage}><span>{stage.stage}</span><strong>{stage.count}</strong><span>{money(stage.weightedValue)}</span></div>)}</div>
      )}
      {selected && <Alert tone="info" title={selected.title}>Selected opportunity · {selected.stage}</Alert>}
      <MarketingCreateDialog open={createOpen} clients={clients} users={users} currentUser={currentUser} onCancel={() => setCreateOpen(false)} onCreated={row => { setWorkspace(current => ({ ...current, opportunities: applyAuthoritativeOpportunity(current.opportunities, row) })); setCreateOpen(false); setSelectedId(row.id); }}/>
      {moveIntent && <MarketingTransitionDialog opportunity={moveIntent.opportunity} toStage={moveIntent.toStage} saving={moveSaving} error={moveError} onCancel={() => { if (!moveSaving) setMoveIntent(null); }} onConfirm={confirmMove}/>}
    </section>
  );
}

export default MarketingPage;
