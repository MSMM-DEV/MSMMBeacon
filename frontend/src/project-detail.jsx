import React, { useState, useEffect, useMemo, useRef } from "react";
import { Icon } from "./icons.jsx";
import { SearchableSelect, EditableCell } from "./primitives.jsx";
import { InvoiceTable } from "./tables.jsx";
import { noteStamp, noteTimeAgo } from "./invoice-notes-thread.jsx";
import {
  Alert, Badge, Button, Checkbox,
  Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
  EmptyState, Field, Input, Kbd, Separator, Skeleton,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Tooltip, TooltipProvider,
} from "@/ui";
import {
  getCurrentBeaconUser, isAdmin, userById, companyById, getUsers, getCompanies,
  fmtMoney, fmtDate,
  projectItemTypeLabel, projectItemStatusLabel, contractTypeLabel,
  PROJECT_ITEM_TYPE_OPTIONS, PROJECT_ITEM_STATUS_OPTIONS, CONTRACT_TYPE_OPTIONS,
  TODO_PRIORITY_OPTIONS, todoPriorityLabel, todoPriorityRank,
  NOTE_CATEGORY_OPTIONS, noteCategoryLabel,
  loadProjectTodos, createTodo, updateTodo, deleteTodo,
  loadProjectNotes, createProjectNote, editProjectNote, deleteProjectNote,
  uploadProjectNoteFile, deleteProjectNoteFile, projectFileUrl,
} from "./data.js";

const TABS = [
  { key: "overview",  label: "Overview",  icon: "alignLeft" },
  { key: "structure", label: "Structure", icon: "columns" },
  { key: "invoices",  label: "Invoices",  icon: "trend" },
  { key: "documents", label: "Documents", icon: "copy" },
  { key: "todos",     label: "To-Dos",    icon: "check" },
  { key: "notes",     label: "Notes",     icon: "note" },
  { key: "settings",  label: "Settings",  icon: "settings" },
];

// The empty-cell placeholder for the whole page (en dash, never an em dash).
const DASH = "–";

// Radix Select can't carry an empty-string item value, so the "no selection"
// option travels under a sentinel and is mapped straight back to "" before it
// reaches any handler. The stored value is unchanged.
const NONE = "__none__";

// `EmptyState` takes an icon COMPONENT; the Beacon registry is keyed by name.
// These adapters keep pages away from a direct lucide-react import.
const glyph = (name) => function BeaconGlyph(props) { return <Icon name={name} {...props} />; };
const GLYPH_OVERVIEW  = glyph("alignLeft");
const GLYPH_DOCUMENTS = glyph("files");
const GLYPH_TODOS     = glyph("checklist");
const GLYPH_NOTES     = glyph("note");
const GLYPH_SELECT    = glyph("columns");

// Semantic status mapping, fixed product-wide: sage = on track, steel =
// paused / in between, clay = closed out. Never signalled by colour alone —
// every badge carries its label and a glyph.
const STATUS_TONE = { active: "success", between: "info", closed_out: "danger" };
const STATUS_ICON = { active: "play",    between: "pause", closed_out: "ban" };

function StatusBadge({ value, size }) {
  const key = value || "active";
  return (
    <Badge tone={STATUS_TONE[key] || "neutral"} size={size}>
      <Icon name={STATUS_ICON[key] || "dot"} size={11}/>
      {projectItemStatusLabel(value)}
    </Badge>
  );
}

function TypeBadge({ value, size }) {
  const isMain = value === "main";
  return (
    <Badge tone="neutral" size={size}>
      <Icon name={isMain ? "blocks" : "square"} size={11}/>
      {projectItemTypeLabel(value)}
    </Badge>
  );
}

const PRIORITY_TONE = { urgent: "danger", high: "brand", medium: "neutral", low: "outline" };

function PriorityBadge({ value }) {
  return (
    <Badge tone={PRIORITY_TONE[value] || "neutral"} size="sm">
      <Icon name="flag" size={10}/>
      {todoPriorityLabel(value)}
    </Badge>
  );
}

// Loading placeholder for the To-Do / Note feeds.
function RowsSkeleton({ rows = 4, lead = "check" }) {
  return (
    <div className="pdx-skel">
      <p className="sr-only" role="status">Loading…</p>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="pdx-skel-row" aria-hidden="true">
          <Skeleton className={lead === "check" ? "size-[18px] rounded-[var(--radius-xs)]" : "size-[22px] rounded-full"}/>
          <div className="pdx-skel-lines">
            <Skeleton className="h-3.5" style={{ width: `${64 - i * 7}%` }}/>
            <Skeleton className="h-2.5" style={{ width: `${34 - i * 4}%` }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

// A page section: heading, a hairline rule that eats the remaining width, and
// an optional trailing action. Sections sit on the page canvas, not in cards.
function SectionHead({ title, count, children, id, as: Heading = "h2" }) {
  return (
    <div className="pdx-sectionhead">
      <Heading id={id}>{title}</Heading>
      {count != null ? <span className="pdx-count num">{count}</span> : null}
      <span className="pdx-rule" aria-hidden="true"/>
      {children}
    </div>
  );
}

// Depth-first walk of one root + its whole subtree → flat [{...item, _depth}].
// Children sort by sort_ord then numeric-aware local_id (mirrors ProjectsTable).
function buildSubtree(items, rootId) {
  const byParent = new Map();
  for (const it of (items || [])) {
    const pid = it.parentId || null;
    (byParent.get(pid) || byParent.set(pid, []).get(pid)).push(it);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) =>
      (a.sortOrd ?? 1e9) - (b.sortOrd ?? 1e9) ||
      String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
  }
  const root = (items || []).find(it => it.id === rootId);
  if (!root) return [];
  const out = [];
  const walk = (node, depth) => {
    out.push({ ...node, _depth: depth });
    for (const c of (byParent.get(node.id) || [])) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

// Resolve the merged Client/Prime display name (the picker spans clients +
// companies; companyById searches the merged directory list).
const clientPrimeName = (id) => (id ? (companyById(id)?.name || DASH) : DASH);

// ============================================================================
// ProjectDetailPage — the per-project detail surface. Replaces the table area
// (top bar + nav rail stay). Seven sub-tabs; Overview + Documents are
// intentionally placeholders for now.
// ============================================================================
export function ProjectDetailPage({
  project, items = [], onClose,
  invoiceTableProps,                                   // spread onto <InvoiceTable>; rows already filtered
  updateItem,                                          // (id, patch) => void   (App's updateProjectItemRow)
  onAddItemSub, onUpdateItemSub, onRemoveItemSub,      // sub handlers keyed on item id
  onDeleteItem, onAddChild,                            // (id) => void / (parentId) => void
}) {
  const [tab, setTab] = useState("overview");
  const subtree = useMemo(() => buildSubtree(items, project.id), [items, project.id]);
  const subtreeIds = useMemo(() => subtree.map(n => n.id), [subtree]);
  const nodeOptions = useMemo(
    () => subtree.map(n => ({ value: n.id, label: `${"– ".repeat(n._depth)}${n.localId} · ${n.name}` })),
    [subtree]);

  return (
    <TooltipProvider>
      <div className="pdx bx-enter">
        {/* Record header — identity first, figures second. */}
        <header className="pdx-head">
          <Button variant="ghost" size="sm" className="pdx-back" onClick={onClose}>
            <Icon name="back" size={15}/>
            Back to projects
          </Button>

          <div className="pdx-head-body">
            <div className="pdx-head-identity">
              <p className="pdx-eyebrow">
                <Icon name="briefcase" size={13}/>
                <span>Project</span>
                <span className="pdx-eyebrow-id num">{project.localId}</span>
              </p>
              <h1 className="pdx-title">{project.name}</h1>
              <div className="pdx-badges">
                <TypeBadge value={project.itemType}/>
                <StatusBadge value={project.status}/>
              </div>
            </div>

            <dl className="pdx-facts">
              <div className="pdx-fact">
                <dt>Client / Prime</dt>
                <dd>{clientPrimeName(project.clientId)}</dd>
              </div>
              <div className="pdx-fact">
                <dt>Project manager</dt>
                <dd>{userById(project.managerId)?.name || DASH}</dd>
              </div>
              <div className="pdx-fact">
                <dt>Contract</dt>
                <dd className="num">
                  {project.contractAmount != null ? fmtMoney(project.contractAmount, false) : DASH}
                </dd>
              </div>
            </dl>
          </div>
        </header>

        <Tabs value={tab} onValueChange={setTab} className="pdx-tabs">
          <TabsList variant="underline" aria-label="Project sections">
            {TABS.map(t => (
              <TabsTrigger key={t.key} value={t.key}>
                <Icon name={t.icon} size={14}/>
                <span>{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="pdx-body">
            <TabsContent value="overview">
              <OverviewTab project={project} subtree={subtree}/>
            </TabsContent>
            <TabsContent value="structure">
              <StructureTab subtree={subtree} project={project} updateItem={updateItem} onAddChild={onAddChild}/>
            </TabsContent>
            <TabsContent value="invoices">
              <InvoicesTab project={project} invoiceTableProps={invoiceTableProps}/>
            </TabsContent>
            <TabsContent value="documents">
              <DocumentsTab/>
            </TabsContent>
            <TabsContent value="todos">
              <TodosTab subtreeIds={subtreeIds} nodeOptions={nodeOptions} rootId={project.id}/>
            </TabsContent>
            <TabsContent value="notes">
              <NotesTab subtreeIds={subtreeIds} nodeOptions={nodeOptions} rootId={project.id}/>
            </TabsContent>
            <TabsContent value="settings">
              <SettingsTab subtree={subtree} items={items} updateItem={updateItem}
                onAddItemSub={onAddItemSub} onUpdateItemSub={onUpdateItemSub} onRemoveItemSub={onRemoveItemSub}
                onDeleteItem={onDeleteItem} onAddChild={onAddChild}/>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

// ── Overview (placeholder + a light at-a-glance summary) ────────────────────
function OverviewTab({ project, subtree }) {
  const phases = subtree.length - 1;
  return (
    <div className="pdx-pane">
      <section className="pdx-section" aria-labelledby="pdx-overview-record">
        <SectionHead title="Record" id="pdx-overview-record"/>
        <dl className="pdx-deflist">
          <div className="pdx-def">
            <dt>Project ID</dt>
            <dd className="num">{project.localId}</dd>
          </div>
          <div className="pdx-def">
            <dt>Client / Prime</dt>
            <dd>{clientPrimeName(project.clientId)}</dd>
          </div>
          <div className="pdx-def">
            <dt>Manager</dt>
            <dd>{userById(project.managerId)?.name || DASH}</dd>
          </div>
          <div className="pdx-def">
            <dt>Contract</dt>
            <dd className="num">{project.contractAmount != null ? fmtMoney(project.contractAmount, false) : DASH}</dd>
          </div>
          <div className="pdx-def">
            <dt>Sub-items</dt>
            <dd className="num">{phases}</dd>
          </div>
          <div className="pdx-def">
            <dt>Status</dt>
            <dd><StatusBadge value={project.status}/></dd>
          </div>
        </dl>
      </section>

      <EmptyState
        icon={GLYPH_OVERVIEW}
        title="Overview is not built yet"
        description="This section will carry the written project summary, the key dates and the rolled-up figures for the whole tree. Until then, the Structure tab holds the financial breakdown."
      />
    </div>
  );
}

// ── Structure (grouped, inline-editable financial grid for one project) ─────
// A spreadsheet-style breakdown: root + phases + subphases, every money/percent
// cell click-to-edit (persists via updateItem → the same roll-up validation).
// Columns mirror the imported accounting figures (contract, billed, cost).
// `w` is the column's minimum width; the tree column absorbs the slack.
const STRUCT_COLS = [
  { key: "tree",      label: "Project / Phase", group: "",         w: "260px" },
  { key: "type",      label: "Contract Type",   group: "Project",  w: "128px" },
  { key: "status",    label: "Status",          group: "Project",  w: "118px" },
  { key: "pct",       label: "% Complete",      group: "Project",  w: "104px" },
  { key: "amount",    label: "Amount",          group: "Contract", w: "124px" },
  { key: "pctproj",   label: "% of Project",    group: "Contract", w: "100px" },
  { key: "billed",    label: "Billed",          group: "Contract", w: "124px" },
  { key: "billedpct", label: "Billed %",        group: "Contract", w: "92px" },
  { key: "svc",       label: "Services",        group: "Billed",   w: "116px" },
  { key: "exp",       label: "Expenses",        group: "Billed",   w: "116px" },
  { key: "tax",       label: "Taxes",           group: "Billed",   w: "104px" },
  { key: "labor",     label: "Labor",           group: "Cost",     w: "116px" },
  { key: "expcost",   label: "Expense",         group: "Cost",     w: "116px" },
  { key: "totalcost", label: "Total Cost",      group: "Cost",     w: "120px" },
];
const STRUCT_GROUPS = [
  { label: "", span: 1 },
  { label: "Project", span: 3 },
  { label: "Contract", span: 4 },
  { label: "Billed", span: 3 },
  { label: "Cost", span: 3 },
];

function StructureTab({ subtree, project, updateItem, onAddChild }) {
  const [collapsed, setCollapsed] = useState(() => new Set());

  const parentIds = useMemo(
    () => new Set(subtree.filter(n => n.parentId).map(n => n.parentId)), [subtree]);

  // Depth-first list honoring collapse (subtree is already depth-ordered).
  const rows = useMemo(() => {
    const out = []; let skipDepth = null;
    for (const n of subtree) {
      if (skipDepth != null) { if (n._depth > skipDepth) continue; skipDepth = null; }
      out.push(n);
      if (collapsed.has(n.id)) skipDepth = n._depth;
    }
    return out;
  }, [subtree, collapsed]);

  const toggle = (id) => setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const rootContract = Number(project.contractAmount || 0);
  const allocated = subtree.filter(n => n.parentId === project.id)
    .reduce((a, n) => a + Number(n.contractAmount || 0), 0);
  const available = rootContract - allocated;

  const pctText = (v) => (v == null ? DASH : `${v.toFixed(1)}%`);
  const pctOfProject = (n) => (rootContract && n.contractAmount != null ? Number(n.contractAmount) / rootContract * 100 : null);
  const billedPct = (n) => { const c = Number(n.contractAmount || 0); return c && n.totalBilled != null ? Number(n.totalBilled) / c * 100 : null; };

  // Inline-editable money cell → persists via updateItem (roll-up validated).
  const money = (n, key) => (
    <td className="pdx-c pdx-c-num num">
      <EditableCell value={n[key]} type="number" align="right"
        render={(v) => (v == null || v === "") ? <span className="empty-cell">{DASH}</span> : fmtMoney(v, false)}
        onChange={(v) => updateItem(n.id, { [key]: v })}/>
    </td>
  );
  const calc = (txt) => <td className="pdx-c pdx-c-num pdx-c-calc num">{txt}</td>;

  return (
    <div className="pdx-pane">
      <div className="pdx-alloc">
        <div className="pdx-alloc-figs">
          <div className="pdx-alloc-fig">
            <span className="pdx-alloc-label">Available</span>
            <strong className={"num" + (available < -0.005 ? " is-over" : "")}>{fmtMoney(available, false)}</strong>
          </div>
          <Separator orientation="vertical" className="pdx-alloc-sep h-[30px] self-center"/>
          <div className="pdx-alloc-fig">
            <span className="pdx-alloc-label">Main project contract</span>
            <strong className="num">{fmtMoney(rootContract, false)}</strong>
          </div>
          {available < -0.005 && (
            <Badge tone="danger">
              <Icon name="warn" size={11}/>
              Over-allocated
            </Badge>
          )}
        </div>
        <Button size="sm" onClick={() => onAddChild?.(project.id)}>
          <Icon name="plus" size={14}/>
          Add phase
        </Button>
      </div>

      <div className="bx-scroll-x pdx-structwrap">
        <table className="pdx-struct">
          <caption className="sr-only">
            Contract, billed and cost figures for this project and each of its phases. Money and
            percent cells can be edited in place.
          </caption>
          <thead>
            <tr className="pdx-struct-grouprow">
              {STRUCT_GROUPS.map((g, i) => (
                <th key={i} colSpan={g.span} scope="colgroup"
                  className={"pdx-gcell" + (g.label ? "" : " is-empty")}>
                  {g.label || <span className="sr-only">Project or phase</span>}
                </th>
              ))}
            </tr>
            <tr className="pdx-struct-labelrow">
              {STRUCT_COLS.map(c => (
                <th key={c.key} scope="col" style={{ "--pdx-colw": c.w }}
                  className={c.key === "tree" ? "pdx-lcell pdx-c-tree" : "pdx-lcell pdx-c-num"}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(n => {
              const hasKids = parentIds.has(n.id);
              const isRoot = n._depth === 0;
              const isCollapsed = collapsed.has(n.id);
              return (
                <tr key={n.id} className={"pdx-row" + (isRoot ? " is-root" : "")}>
                  <th scope="row" className="pdx-c pdx-c-tree">
                    <div className="pdx-tree" style={{ paddingLeft: n._depth * 18 }}>
                      {hasKids ? (
                        <button type="button" className="pdx-toggle"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${n.name}`}
                          onClick={() => toggle(n.id)}>
                          <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={13}/>
                        </button>
                      ) : <span className="pdx-toggle-spacer" aria-hidden="true"/>}
                      <span className={"pdx-dot " + (n.itemType === "main" ? "is-main" : "is-standard")} aria-hidden="true"/>
                      <span className="pdx-tree-id num">{n.localId}</span>
                      <span className="pdx-tree-name" title={n.name}>{n.name}</span>
                      <Tooltip label="Add subphase">
                        <button type="button" className="pdx-addkid"
                          aria-label={`Add a subphase under ${n.name}`}
                          onClick={() => onAddChild?.(n.id)}>
                          <Icon name="plus" size={13}/>
                        </button>
                      </Tooltip>
                    </div>
                  </th>
                  <td className="pdx-c pdx-c-sel">
                    <EditableCell value={n.itemType} type="select" options={PROJECT_ITEM_TYPE_OPTIONS}
                      render={(v) => <TypeBadge value={v} size="sm"/>}
                      onChange={(v) => updateItem(n.id, { itemType: v })}/>
                  </td>
                  <td className="pdx-c pdx-c-sel">
                    <EditableCell value={n.status} type="select" options={PROJECT_ITEM_STATUS_OPTIONS}
                      render={(v) => <StatusBadge value={v} size="sm"/>}
                      onChange={(v) => updateItem(n.id, { status: v })}/>
                  </td>
                  <td className="pdx-c pdx-c-num num">
                    <EditableCell value={n.percentComplete} type="number" align="right"
                      render={(v) => (v == null || v === "") ? <span className="empty-cell">{DASH}</span> : `${v}%`}
                      onChange={(v) => updateItem(n.id, { percentComplete: v })}/>
                  </td>
                  {money(n, "contractAmount")}
                  {calc(pctText(pctOfProject(n)))}
                  {money(n, "totalBilled")}
                  {calc(pctText(billedPct(n)))}
                  {money(n, "billedServices")}
                  {money(n, "billedExpenses")}
                  {money(n, "billedTaxes")}
                  {money(n, "laborCost")}
                  {money(n, "expenseCost")}
                  {calc((n.laborCost == null && n.expenseCost == null)
                    ? DASH : fmtMoney(Number(n.laborCost || 0) + Number(n.expenseCost || 0), false))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Invoices (the existing InvoiceTable, filtered to this project) ───────────
function InvoicesTab({ project, invoiceTableProps }) {
  const rows = invoiceTableProps?.rows || [];
  return (
    <div className="pdx-pane pdx-pane-flush">
      {rows.length === 0 && (
        <Alert tone="warning" title="No invoice records match this project yet">
          Invoice rows link by project number. Create one for{" "}
          <strong className="num">{project.localId}</strong> on the Invoice page, or set this
          project's ID to match its invoice number, and it will appear here.
        </Alert>
      )}
      <InvoiceTable {...invoiceTableProps} tab="invoice"/>
    </div>
  );
}

// ── Documents (placeholder) ─────────────────────────────────────────────────
function DocumentsTab() {
  return (
    <div className="pdx-pane">
      <EmptyState
        icon={GLYPH_DOCUMENTS}
        title="No documents yet"
        description="Contracts, drawings, submittals and correspondence filed against this project will be listed here. Until this section ships, attach files to a project note instead."
      />
    </div>
  );
}

// ── To-Dos ──────────────────────────────────────────────────────────────────
function TodosTab({ subtreeIds, nodeOptions, rootId }) {
  const me = getCurrentBeaconUser();
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadProjectTodos(subtreeIds)
      .then(list => { if (alive) setTodos(list); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Key on the id VALUES, not the array ref — so an unrelated projectItems
    // edit (which makes a new subtreeIds array) doesn't refetch + wipe state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtreeIds.join(",")]);

  const nodeLabel = (id) => nodeOptions.find(o => o.value === id)?.label?.replace(/^(– )+/, "") || "";

  const sorted = useMemo(() => {
    return [...todos].sort((a, b) =>
      (a.done === b.done ? 0 : a.done ? 1 : -1) ||
      (todoPriorityRank(a.priority) - todoPriorityRank(b.priority)) ||
      String(a.endDate || "9999").localeCompare(String(b.endDate || "9999")));
  }, [todos]);

  const toggleDone = async (t) => {
    const before = todos;
    setTodos(rs => rs.map(r => r.id === t.id ? { ...r, done: !r.done } : r));
    try { await updateTodo(t.id, { done: !t.done }); }
    catch (e) { setTodos(before); setError(e.message || "Couldn't update."); }
  };
  const remove = async (t) => {
    const before = todos;
    setTodos(rs => rs.filter(r => r.id !== t.id));
    try { await deleteTodo(t.id); }
    catch (e) { setTodos(before); setError(e.message || "Couldn't delete."); }
  };
  const onSaved = (saved, isEdit) => {
    setTodos(rs => isEdit ? rs.map(r => r.id === saved.id ? saved : r) : [saved, ...rs]);
    setShowForm(false); setEditing(null);
  };
  const openNew = () => { setEditing(null); setShowForm(true); };

  return (
    <div className="pdx-pane">
      <SectionHead title="To-Dos" count={todos.length ? `${todos.filter(t => !t.done).length} open` : null}>
        {!showForm && (
          <Button variant="primary" size="sm" onClick={openNew}>
            <Icon name="plus" size={14}/>
            New to-do
          </Button>
        )}
      </SectionHead>

      {error && <Alert tone="danger">{error}</Alert>}

      {showForm && (
        <TodoForm
          initial={editing}
          nodeOptions={nodeOptions}
          rootId={rootId}
          me={me}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSaved={onSaved}
          onError={setError}
        />
      )}

      {loading ? (
        <RowsSkeleton rows={4} lead="check"/>
      ) : sorted.length === 0 && !showForm ? (
        <EmptyState
          icon={GLYPH_TODOS}
          title="No to-dos on this project"
          description="Add a to-do to track a piece of work against this project or any of its phases. Each one carries a priority, a date range and an assignee."
          action={<Button variant="primary" size="sm" onClick={openNew}><Icon name="plus" size={14}/> New to-do</Button>}
        />
      ) : (
        <ul className="pdx-todo-list">
          {sorted.map(t => (
            <li key={t.id} className={"pdx-todo" + (t.done ? " is-done" : "")}>
              <Checkbox
                className="pdx-todo-check"
                checked={!!t.done}
                onCheckedChange={() => toggleDone(t)}
                aria-label={t.done ? `Mark "${t.description}" not done` : `Mark "${t.description}" done`}
              />
              <div className="pdx-todo-main">
                <p className="pdx-todo-desc">{t.description}</p>
                <div className="pdx-todo-meta">
                  <PriorityBadge value={t.priority}/>
                  {(t.startDate || t.endDate) && (
                    <span className="pdx-meta">
                      <Icon name="calendar" size={12}/>
                      <span className="num">{fmtDate(t.startDate) || DASH}</span>
                      <Icon name="forward" size={11}/>
                      <span className="num">{fmtDate(t.endDate) || DASH}</span>
                    </span>
                  )}
                  {t.assignedTo && (
                    <span className="pdx-meta">
                      <span className={`avatar xs ${userById(t.assignedTo)?.color || ""}`} aria-hidden="true">
                        {userById(t.assignedTo)?.initials || "··"}
                      </span>
                      <span className="pdx-truncate">{userById(t.assignedTo)?.name || DASH}</span>
                    </span>
                  )}
                  {t.assignedBy && <span className="pdx-meta pdx-soft">by {userById(t.assignedBy)?.name || DASH}</span>}
                  <span className="pdx-meta pdx-soft pdx-truncate">{nodeLabel(t.itemId)}</span>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for to-do: ${t.description}`}>
                    <Icon name="more" size={16}/>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => { setEditing(t); setShowForm(true); }}>
                    <Icon name="edit" size={14}/>
                    Edit to-do
                  </DropdownMenuItem>
                  <DropdownMenuSeparator/>
                  <DropdownMenuItem destructive onSelect={() => remove(t)}>
                    <Icon name="trash" size={14}/>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoForm({ initial, nodeOptions, rootId, me, onCancel, onSaved, onError }) {
  const isEdit = !!initial;
  const [f, setF] = useState(() => ({
    description: initial?.description || "",
    startDate:   initial?.startDate || "",
    endDate:     initial?.endDate || "",
    priority:    initial?.priority || "medium",
    assignedTo:  initial?.assignedTo || "",
    itemId:      initial?.itemId || rootId,
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const users = getUsers();

  const submit = async () => {
    if (!f.description.trim() || busy) return;
    setBusy(true); onError("");
    try {
      const saved = isEdit
        ? await updateTodo(initial.id, f)
        : await createTodo({ ...f, assignedTo: f.assignedTo || null });
      onSaved(saved, isEdit);
    } catch (e) { onError(e.message || "Couldn't save the to-do."); setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit to-do" : "New to-do"}</DialogTitle>
          <DialogDescription>
            Track a piece of work against this project or one of its phases.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="pdx-form">
          <Field label="Description" htmlFor="pdx-todo-desc">
            <Textarea id="pdx-todo-desc" rows={3} value={f.description}
              autoFocus placeholder="What needs to be done?"
              onChange={e => set("description", e.target.value)}/>
          </Field>

          <div className="pdx-formgrid">
            <Field label="Start date" htmlFor="pdx-todo-start">
              <Input id="pdx-todo-start" type="date" value={f.startDate}
                onChange={e => set("startDate", e.target.value)}/>
            </Field>
            <Field label="End date" htmlFor="pdx-todo-end">
              <Input id="pdx-todo-end" type="date" value={f.endDate}
                onChange={e => set("endDate", e.target.value)}/>
            </Field>
            <Field label="Priority" htmlFor="pdx-todo-priority">
              <Select value={f.priority} onValueChange={v => set("priority", v)}>
                <SelectTrigger id="pdx-todo-priority"><SelectValue/></SelectTrigger>
                <SelectContent>
                  {TODO_PRIORITY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="pdx-formgrid">
            <Field label="Assigned to" htmlFor="pdx-todo-assignee">
              <Select value={f.assignedTo || NONE}
                onValueChange={v => set("assignedTo", v === NONE ? "" : v)}>
                <SelectTrigger id="pdx-todo-assignee"><SelectValue/></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {users.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Assigned by" htmlFor="pdx-todo-assigner">
              <Input id="pdx-todo-assigner" disabled value={userById(me?.id)?.name || "You"}/>
            </Field>
            <Field label="Attach to" htmlFor="pdx-todo-node">
              <Select value={f.itemId} onValueChange={v => set("itemId", v)}>
                <SelectTrigger id="pdx-todo-node"><SelectValue/></SelectTrigger>
                <SelectContent>
                  {nodeOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!f.description.trim() || busy}>
            {busy ? "Saving…" : isEdit ? "Save changes" : "Add to-do"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Notes (threaded, multi-author, with attachments) ────────────────────────
function NotesTab({ subtreeIds, nodeOptions, rootId }) {
  const me = getCurrentBeaconUser();
  const meUser = userById(me?.id);
  const admin = isAdmin();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState("general");
  const [attachTo, setAttachTo] = useState(rootId);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const fileInput = useRef();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadProjectNotes(subtreeIds)
      .then(list => { if (alive) setNotes(list); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Key on id VALUES (see TodosTab) so unrelated edits don't refetch/wipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtreeIds.join(",")]);

  const nodeLabel = (id) => nodeOptions.find(o => o.value === id)?.label?.replace(/^(– )+/, "") || "";
  const canModify = (n) => admin || (n.authorId && me?.id === n.authorId);

  const post = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError("");
    try {
      const saved = await createProjectNote({ itemId: attachTo, category, body: text });
      // Upload any attachments, then attach them to the new note.
      const uploaded = [];
      for (const file of files) {
        try { uploaded.push(await uploadProjectNoteFile(attachTo, saved.id, file)); }
        catch (e) { setError(`Uploaded note, but "${file.name}" failed: ${e.message || e}`); }
      }
      setNotes(rs => [{ ...saved, files: uploaded }, ...rs]);
      setDraft(""); setFiles([]); setCategory("general"); setAttachTo(rootId);
    } catch (e) { setError(e.message || "Couldn't post the note."); }
    finally { setBusy(false); }
  };

  const saveEdit = async (id, patch) => {
    const before = notes;
    setNotes(rs => rs.map(n => n.id === id ? { ...n, ...patch, editedAt: new Date().toISOString() } : n));
    setEditingId(null);
    try { const saved = await editProjectNote(id, patch); setNotes(rs => rs.map(n => n.id === id ? saved : n)); }
    catch (e) { setNotes(before); setError(e.message || "Couldn't save the edit."); }
  };
  const remove = async (n) => {
    const before = notes;
    setNotes(rs => rs.filter(x => x.id !== n.id));
    try { await deleteProjectNote(n.id); }
    catch (e) { setNotes(before); setError(e.message || "Couldn't delete the note."); }
  };
  const addFileToNote = async (n, file) => {
    try {
      const f = await uploadProjectNoteFile(n.itemId, n.id, file);
      setNotes(rs => rs.map(x => x.id === n.id ? { ...x, files: [...x.files, f] } : x));
    } catch (e) { setError(e.message || "Upload failed."); }
  };
  const removeFile = async (n, f) => {
    const before = notes;
    setNotes(rs => rs.map(x => x.id === n.id ? { ...x, files: x.files.filter(y => y.id !== f.id) } : x));
    try { await deleteProjectNoteFile(f); }
    catch (e) { setNotes(before); setError(e.message || "Couldn't remove file."); }
  };
  const openFile = async (f) => {
    try { const url = await projectFileUrl(f.path); if (url) window.open(url, "_blank", "noopener"); }
    catch (e) { setError(e.message || "Couldn't open file."); }
  };

  return (
    <div className="pdx-pane">
      {/* Composer */}
      <section className="pdx-composer" aria-label="Add a note">
        <span className={`avatar sm ${meUser?.color || ""}`} aria-hidden="true">{meUser?.initials || "··"}</span>
        <div className="pdx-composer-main">
          <Textarea rows={3} value={draft} aria-label="Note text"
            placeholder="Add a note: billing status, client update, contract change…"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }}/>
          <div className="pdx-composer-controls">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger size="sm" aria-label="Note category" className="pdx-composer-select w-auto">
                <SelectValue/>
              </SelectTrigger>
              <SelectContent>
                {NOTE_CATEGORY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={attachTo} onValueChange={setAttachTo}>
              <SelectTrigger size="sm" aria-label="Attach note to" className="pdx-composer-select w-auto">
                <SelectValue/>
              </SelectTrigger>
              <SelectContent>
                {nodeOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <input ref={fileInput} type="file" multiple hidden
              onChange={e => { setFiles(Array.from(e.target.files || [])); e.target.value = ""; }}/>
            <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>
              <Icon name="attachment" size={14}/>
              Attach
            </Button>
            <span className="pdx-flex" aria-hidden="true"/>
            <span className="pdx-kbdhint">
              <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> to post
            </span>
            <Button variant="primary" size="sm" onClick={post} loading={busy} disabled={!draft.trim() || busy}>
              {busy ? "Posting…" : "Post note"}
            </Button>
          </div>
          {files.length > 0 && (
            <ul className="pdx-chips">
              {files.map((f, i) => (
                <li key={i} className="pdx-chip">
                  <span className="pdx-chip-face">
                    <Icon name="attachment" size={11}/>
                    <span className="pdx-chip-name">{f.name}</span>
                  </span>
                  <button type="button" className="pdx-chip-rm"
                    aria-label={`Remove ${f.name} from this note`}
                    onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}>
                    <Icon name="x" size={11}/>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {error && <Alert tone="danger">{error}</Alert>}

      {/* Feed */}
      {loading ? (
        <RowsSkeleton rows={3} lead="avatar"/>
      ) : notes.length === 0 ? (
        <EmptyState
          icon={GLYPH_NOTES}
          title="No notes on this project"
          description="Post a note above to record a billing status, a client update or a contract change. Notes are visible to everyone on the project and can carry file attachments."
        />
      ) : (
        <div className="pdx-note-list">
          {notes.map(n => {
            const u = userById(n.authorId);
            return (
              <article key={n.id} className="pdx-note">
                <span className={`avatar xs ${u?.color || ""}`} title={u?.name || "Unknown"} aria-hidden="true">
                  {u?.initials || "··"}
                </span>
                <div className="pdx-note-main">
                  <header className="pdx-note-head">
                    <span className="pdx-note-author">{u?.name || "Unknown"}</span>
                    <Badge tone="neutral" size="sm">{noteCategoryLabel(n.category)}</Badge>
                    <time className="pdx-note-time num" dateTime={n.createdAt || undefined} title={noteStamp(n.createdAt)}>
                      {noteStamp(n.createdAt)}
                    </time>
                    <span className="pdx-soft">{noteTimeAgo(n.createdAt)}</span>
                    {n.editedAt && <span className="pdx-note-edited">edited</span>}
                    <span className="pdx-soft pdx-truncate">{nodeLabel(n.itemId)}</span>
                    <span className="pdx-flex" aria-hidden="true"/>
                    {canModify(n) && editingId !== n.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm"
                            aria-label={`Actions for note by ${u?.name || "Unknown"}`}>
                            <Icon name="more" size={16}/>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditingId(n.id)}>
                            <Icon name="edit" size={14}/>
                            Edit note
                          </DropdownMenuItem>
                          <DropdownMenuSeparator/>
                          <DropdownMenuItem destructive onSelect={() => remove(n)}>
                            <Icon name="trash" size={14}/>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </header>

                  {editingId === n.id ? (
                    <NoteEdit note={n} onCancel={() => setEditingId(null)} onSave={(patch) => saveEdit(n.id, patch)}/>
                  ) : (
                    <>
                      <div className="pdx-note-body">{n.body}</div>
                      {(n.files.length > 0 || canModify(n)) && (
                        <ul className="pdx-chips">
                          {n.files.map(f => (
                            <li key={f.id} className="pdx-chip">
                              <button type="button" className="pdx-chip-face pdx-chip-open"
                                onClick={() => openFile(f)}>
                                <Icon name="attachment" size={11}/>
                                <span className="pdx-chip-name">{f.name}</span>
                              </button>
                              {canModify(n) && (
                                <button type="button" className="pdx-chip-rm"
                                  aria-label={`Remove attachment ${f.name}`}
                                  onClick={() => removeFile(n, f)}>
                                  <Icon name="x" size={11}/>
                                </button>
                              )}
                            </li>
                          ))}
                          {canModify(n) && (
                            <li><NoteAddFile onPick={(file) => addFileToNote(n, file)}/></li>
                          )}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NoteEdit({ note, onCancel, onSave }) {
  const [body, setBody] = useState(note.body);
  const [cat, setCat] = useState(note.category);
  return (
    <div className="pdx-note-edit">
      <Textarea autoFocus rows={3} value={body} aria-label="Edit note text"
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}/>
      <div className="pdx-note-edit-foot">
        <Select value={cat} onValueChange={setCat}>
          <SelectTrigger size="sm" aria-label="Note category" className="pdx-composer-select w-auto">
            <SelectValue/>
          </SelectTrigger>
          <SelectContent>
            {NOTE_CATEGORY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="pdx-flex" aria-hidden="true"/>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={!body.trim()}
          onClick={() => onSave({ body: body.trim(), category: cat })}>Save</Button>
      </div>
    </div>
  );
}

function NoteAddFile({ onPick }) {
  const ref = useRef();
  return (
    <>
      <input ref={ref} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }}/>
      <button type="button" className="pdx-chip-add" onClick={() => ref.current?.click()}>
        <Icon name="plus" size={11}/>
        Attach a file
      </button>
    </>
  );
}

// ── Settings (list every tree item; select one → edit its fields) ───────────
function SettingsTab({ subtree, items, updateItem, onAddItemSub, onUpdateItemSub, onRemoveItemSub, onDeleteItem, onAddChild }) {
  const [selId, setSelId] = useState(subtree[0]?.id || null);
  // Always read the live row from items so edits reflect immediately.
  const sel = items.find(it => it.id === selId) || subtree[0] || null;

  return (
    <div className="pdx-settings">
      <nav className="pdx-settings-list" aria-label="Project items">
        {subtree.map(n => (
          <button key={n.id} type="button"
            className={"pdx-settings-item" + (sel?.id === n.id ? " is-active" : "")}
            style={{ "--pdx-depth": Math.min(n._depth, 5) }}
            aria-current={sel?.id === n.id ? "true" : undefined}
            onClick={() => setSelId(n.id)}>
            <span className="pdx-settings-id num">{n.localId}</span>
            <span className="pdx-settings-name">{n.name}</span>
          </button>
        ))}
      </nav>
      <div className="pdx-settings-editor">
        {sel ? (
          <ItemEditor key={sel.id} item={sel} items={items} updateItem={updateItem}
            onAddItemSub={onAddItemSub} onUpdateItemSub={onUpdateItemSub} onRemoveItemSub={onRemoveItemSub}
            onDeleteItem={onDeleteItem} onAddChild={onAddChild}/>
        ) : (
          <EmptyState
            icon={GLYPH_SELECT}
            title="Nothing selected"
            description="Pick a project, phase or subphase from the list to edit its details, managers and subs."
            compact
          />
        )}
      </div>
    </div>
  );
}

function ItemEditor({ item, items, updateItem, onAddItemSub, onUpdateItemSub, onRemoveItemSub, onDeleteItem, onAddChild }) {
  const isRoot = !item.parentId;
  const idLabel = isRoot ? "Project ID" : "Phase / Subphase ID";
  // Parent options: every other item except self + descendants (no cycles).
  const descendants = useMemo(() => {
    const out = new Set(); const stack = [item.id];
    while (stack.length) { const p = stack.pop(); for (const it of items) if (it.parentId === p) { out.add(it.id); stack.push(it.id); } }
    return out;
  }, [items, item.id]);
  const parentOptions = items.filter(it => it.id !== item.id && !descendants.has(it.id))
    .map(it => ({ value: it.id, label: `${it.localId} · ${it.name}` }));
  const dirOptions = getCompanies().map(c => ({ value: c.id, label: c.name }));
  const users = getUsers();

  // Local draft for free-text fields (commit on blur to avoid a write per
  // keystroke); selects/dates commit immediately.
  const [draft, setDraft] = useState({});
  const val = (k) => (k in draft ? draft[k] : (item[k] ?? ""));
  const setLocal = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const commit = (k) => {
    if (!(k in draft)) return;
    const v = draft[k];
    setDraft(d => { const n = { ...d }; delete n[k]; return n; });
    if (String(v) !== String(item[k] ?? "")) updateItem(item.id, { [k]: v });
  };
  const save = (k, v) => updateItem(item.id, { [k]: v });

  // A render FUNCTION (not a nested component) so the input keeps focus across
  // re-renders — a nested component type would remount on every keystroke.
  const field = (label, k, type = "text") => (
    <Field key={k} label={label} htmlFor={`pdx-f-${k}`}>
      <Input id={`pdx-f-${k}`} type={type}
        value={val(k)} onChange={e => setLocal(k, e.target.value)} onBlur={() => commit(k)}/>
    </Field>
  );

  // Subs management (companies) wired to App's item-sub handlers.
  const [addSubId, setAddSubId] = useState("");
  const subCompanyOptions = getCompanies()
    .filter(c => c.type !== "Client" && !(item.subs || []).some(s => s.cId === c.id))
    .map(c => ({ value: c.id, label: c.name }));
  // Same commit path the old picker used: clear the pending id, then hand the
  // company to App's handler.
  const pickSub = (v) => { setAddSubId(""); if (v) onAddItemSub(item.id, v); };
  const availablePms = users.filter(u => !(item.pmIds || []).includes(u.id));

  return (
    <div className="pdx-editor">
      <div className="pdx-editor-head">
        <div className="pdx-editor-title">
          <span className="pdx-editor-id num">{item.localId}</span>
          <h3>{item.name}</h3>
        </div>
        <div className="pdx-editor-actions">
          <Button variant="subtle" size="sm" onClick={() => onAddChild(item.id)}>
            <Icon name="plus" size={14}/>
            Add child
          </Button>
          <Button variant="destructive-soft" size="sm" onClick={() => onDeleteItem(item.id)}>
            <Icon name="trash" size={14}/>
            Delete
          </Button>
        </div>
      </div>

      <div className="pdx-editor-grid">
        {field(idLabel, "localId")}
        {field("Name", "name")}

        <Field label="Type" htmlFor="pdx-f-itemType"
          hint={item.itemType === "main"
            ? "Container: no time or expense logging."
            : "Work item: time and expense can be logged."}>
          <Select value={item.itemType || "standard"} onValueChange={v => save("itemType", v)}>
            <SelectTrigger id="pdx-f-itemType"><SelectValue/></SelectTrigger>
            <SelectContent>
              {PROJECT_ITEM_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Status" htmlFor="pdx-f-status">
          <Select value={item.status || "active"} onValueChange={v => save("status", v)}>
            <SelectTrigger id="pdx-f-status"><SelectValue/></SelectTrigger>
            <SelectContent>
              {PROJECT_ITEM_STATUS_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Client / Prime">
          <SearchableSelect value={item.clientId || ""} options={dirOptions}
            onChange={v => save("clientId", v)} allowClear placeholder="Search clients / companies…"/>
        </Field>
        <Field label="Parent" hint={isRoot ? "The top of this project tree." : undefined}>
          {isRoot
            ? <Input disabled value="Root (no parent)"/>
            : <SearchableSelect value={item.parentId || ""} options={parentOptions}
                onChange={v => save("parentId", v)} allowClear placeholder="Search items…"/>}
        </Field>

        <Field label="Contract Type" htmlFor="pdx-f-contractType"
          hint={item.contractType ? `Billed as ${contractTypeLabel(item.contractType).toLowerCase()}.` : "No contract structure set."}>
          <Select value={item.contractType || NONE}
            onValueChange={v => save("contractType", v === NONE ? "" : v)}>
            <SelectTrigger id="pdx-f-contractType"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {CONTRACT_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {field("Contract Amount", "contractAmount", "number")}

        {field("Start Date", "startDate", "date")}
        {field("Due Date", "dueDate", "date")}

        {field("Percent Complete", "percentComplete", "number")}
        <Field label="Manager" htmlFor="pdx-f-managerId">
          <Select value={item.managerId || NONE}
            onValueChange={v => save("managerId", v === NONE ? "" : v)}>
            <SelectTrigger id="pdx-f-managerId"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {users.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>

        {field("Address Line 1", "addressLine1")}
        {field("Address Line 2", "addressLine2")}
        {field("City", "city")}
        {field("State", "state")}
        {field("PIN Code", "pinCode")}
      </div>

      {/* Additional PMs */}
      <section className="pdx-editor-sub">
        <SectionHead as="h4" title="Additional project managers"/>
        {(item.pmIds || []).length === 0 && (
          <p className="pdx-subempty">No additional managers. Add one to give them the same visibility as the primary manager.</p>
        )}
        <div className="pdx-chiprow">
          {(item.pmIds || []).map(id => (
            <span key={id} className="pdx-chip">
              <span className="pdx-chip-face">
                <span className={`avatar xs ${userById(id)?.color || ""}`} aria-hidden="true">
                  {userById(id)?.initials || "··"}
                </span>
                <span className="pdx-chip-name">{userById(id)?.name || DASH}</span>
              </span>
              <button type="button" className="pdx-chip-rm"
                aria-label={`Remove ${userById(id)?.name || "manager"}`}
                onClick={() => save("pmIds", (item.pmIds || []).filter(x => x !== id))}>
                <Icon name="x" size={11}/>
              </button>
            </span>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="subtle" size="sm" disabled={availablePms.length === 0}>
                <Icon name="userPlus" size={14}/>
                Add manager
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Add project manager</DropdownMenuLabel>
              {availablePms.map(u => (
                <DropdownMenuItem key={u.id} onSelect={() => save("pmIds", [...(item.pmIds || []), u.id])}>
                  {u.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>

      {/* Subs */}
      <section className="pdx-editor-sub">
        <SectionHead as="h4" title="Subs"/>
        {(item.subs || []).length === 0 && (
          <p className="pdx-subempty">No subconsultants on this item. Add a company to track its discipline and contracted amount.</p>
        )}
        <div className="pdx-sub-list">
          {(item.subs || []).map(s => (
            <div key={s.cId} className="pdx-sub-row">
              <span className="pdx-sub-name" title={companyById(s.cId)?.name || DASH}>
                {companyById(s.cId)?.name || DASH}
              </span>
              <Input className="h-[var(--control-h-sm)]" placeholder="Discipline"
                aria-label={`Discipline for ${companyById(s.cId)?.name || "sub"}`}
                defaultValue={s.desc || ""}
                onBlur={e => { if (e.target.value !== (s.desc || "")) onUpdateItemSub(item.id, s.cId, { desc: e.target.value }); }}/>
              <Input className="h-[var(--control-h-sm)] num text-right" type="number" placeholder="Amount"
                aria-label={`Amount for ${companyById(s.cId)?.name || "sub"}`}
                defaultValue={s.amt ?? ""}
                onBlur={e => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (s.amt ?? 0)) onUpdateItemSub(item.id, s.cId, { amt: v }); }}/>
              <button type="button" className="pdx-sub-rm"
                aria-label={`Remove ${companyById(s.cId)?.name || "sub"}`}
                onClick={() => onRemoveItemSub(item.id, s.cId)}>
                <Icon name="x" size={13}/>
              </button>
            </div>
          ))}
          <div className="pdx-chiprow">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="subtle" size="sm" disabled={subCompanyOptions.length === 0}>
                  <Icon name="plus" size={14}/>
                  Add sub company
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Add sub company</DropdownMenuLabel>
                {subCompanyOptions.map(o => (
                  <DropdownMenuItem key={o.value} onSelect={() => pickSub(o.value)}>
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </section>
    </div>
  );
}
