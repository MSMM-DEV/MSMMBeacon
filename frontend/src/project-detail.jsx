import React, { useState, useEffect, useMemo, useRef } from "react";
import { Icon } from "./icons.jsx";
import { SearchableSelect, EditableCell } from "./primitives.jsx";
import { InvoiceTable } from "./tables.jsx";
import { noteStamp, noteTimeAgo } from "./invoice-notes-thread.jsx";
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
const clientPrimeName = (id) => (id ? (companyById(id)?.name || "—") : "—");

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
    () => subtree.map(n => ({ value: n.id, label: `${"— ".repeat(n._depth)}${n.localId} · ${n.name}` })),
    [subtree]);

  return (
    <div className="pd">
      {/* Header */}
      <div className="pd-head">
        <button className="pd-back" onClick={onClose}>
          <Icon name="back" size={14}/> Projects
        </button>
        <div className="pd-head-main">
          <div className="pd-eyebrow">
            <Icon name="briefcase" size={12}/> Project {project.localId}
            <span className={"pd-type-badge " + (project.itemType === "main" ? "is-main" : "is-standard")}>
              {projectItemTypeLabel(project.itemType)}
            </span>
            <span className={"pd-status-badge st-" + (project.status || "active")}>
              {projectItemStatusLabel(project.status)}
            </span>
          </div>
          <h1 className="pd-title">{project.name}</h1>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="pd-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
            className={"pd-tab" + (tab === t.key ? " active" : "")}
            onClick={() => setTab(t.key)}>
            <Icon name={t.icon} size={13}/> {t.label}
          </button>
        ))}
      </div>

      <div className="pd-body">
        {tab === "overview"  && <OverviewTab project={project} subtree={subtree}/>}
        {tab === "structure" && <StructureTab subtree={subtree} project={project} updateItem={updateItem} onAddChild={onAddChild}/>}
        {tab === "invoices"  && <InvoicesTab project={project} invoiceTableProps={invoiceTableProps}/>}
        {tab === "documents" && <DocumentsTab/>}
        {tab === "todos"     && <TodosTab subtreeIds={subtreeIds} nodeOptions={nodeOptions} rootId={project.id}/>}
        {tab === "notes"     && <NotesTab subtreeIds={subtreeIds} nodeOptions={nodeOptions} rootId={project.id}/>}
        {tab === "settings"  && (
          <SettingsTab subtree={subtree} items={items} updateItem={updateItem}
            onAddItemSub={onAddItemSub} onUpdateItemSub={onUpdateItemSub} onRemoveItemSub={onRemoveItemSub}
            onDeleteItem={onDeleteItem} onAddChild={onAddChild}/>
        )}
      </div>
    </div>
  );
}

// ── Overview (placeholder + a light at-a-glance summary) ────────────────────
function OverviewTab({ project, subtree }) {
  const phases = subtree.length - 1;
  return (
    <div className="pd-pane">
      <div className="pd-empty">
        <Icon name="alignLeft" size={26}/>
        <h3>Overview coming soon</h3>
        <p>This space will hold the project summary, key metrics, and important details.</p>
      </div>
      <div className="pd-overview-facts">
        <div className="pd-fact"><span>Project ID</span><strong>{project.localId}</strong></div>
        <div className="pd-fact"><span>Client / Prime</span><strong>{clientPrimeName(project.clientId)}</strong></div>
        <div className="pd-fact"><span>Manager</span><strong>{userById(project.managerId)?.name || "—"}</strong></div>
        <div className="pd-fact"><span>Contract</span><strong>{project.contractAmount != null ? fmtMoney(project.contractAmount, false) : "—"}</strong></div>
        <div className="pd-fact"><span>Sub-items</span><strong>{phases}</strong></div>
        <div className="pd-fact"><span>Status</span><strong>{projectItemStatusLabel(project.status)}</strong></div>
      </div>
    </div>
  );
}

// ── Structure (grouped, inline-editable financial grid for one project) ─────
// A spreadsheet-style breakdown: root + phases + subphases, every money/percent
// cell click-to-edit (persists via updateItem → the same roll-up validation).
// Columns mirror the imported accounting figures (contract, billed, cost).
const STRUCT_COLS = [
  { key: "tree",      label: "Project / Phase", group: "",         w: "minmax(240px, 1.6fr)" },
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
  const gridCols = STRUCT_COLS.map(c => c.w).join(" ");

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

  const pctText = (v) => (v == null ? "—" : `${v.toFixed(1)}%`);
  const pctOfProject = (n) => (rootContract && n.contractAmount != null ? Number(n.contractAmount) / rootContract * 100 : null);
  const billedPct = (n) => { const c = Number(n.contractAmount || 0); return c && n.totalBilled != null ? Number(n.totalBilled) / c * 100 : null; };

  // Inline-editable money cell → persists via updateItem (roll-up validated).
  const money = (n, key) => (
    <div className="pds-cell right mono">
      <EditableCell value={n[key]} type="number" align="right"
        render={(v) => (v == null || v === "") ? <span className="empty-cell">—</span> : fmtMoney(v, false)}
        onChange={(v) => updateItem(n.id, { [key]: v })}/>
    </div>
  );
  const calc = (txt) => <div className="pds-cell right mono soft">{txt}</div>;

  return (
    <div className="pd-pane pd-pane-flush">
      <div className="pds-toolbar">
        <div className="pds-avail">
          <strong>{fmtMoney(available, false)}</strong> available of{" "}
          <strong>{fmtMoney(rootContract, false)}</strong> main project contract
          {available < -0.005 && <span className="pds-over"> · over-allocated</span>}
        </div>
        <button className="btn sm" onClick={() => onAddChild?.(project.id)}>
          <Icon name="plus" size={12}/> Add phase
        </button>
      </div>

      <div className="pds-scroll">
        <div className="pds-grid" style={{ minWidth: "max-content" }}>
          {/* Group header row */}
          <div className="pds-grouprow" style={{ gridTemplateColumns: gridCols }}>
            {STRUCT_GROUPS.map((g, i) => (
              <div key={i} className={"pds-gcell" + (g.label ? "" : " empty")} style={{ gridColumn: `span ${g.span}` }}>
                {g.label}
              </div>
            ))}
          </div>
          {/* Column header row */}
          <div className="pds-labelrow" style={{ gridTemplateColumns: gridCols }}>
            {STRUCT_COLS.map(c => (
              <div key={c.key} className={"pds-lcell" + (c.key === "tree" ? "" : " right")}>{c.label}</div>
            ))}
          </div>
          {/* Body */}
          {rows.map(n => {
            const hasKids = parentIds.has(n.id);
            const isRoot = n._depth === 0;
            return (
              <div key={n.id} className={"pds-row" + (isRoot ? " is-root" : "")} style={{ gridTemplateColumns: gridCols }}>
                <div className="pds-cell pds-tree" style={{ paddingLeft: 8 + n._depth * 20 }}>
                  {hasKids ? (
                    <button className="pds-toggle" onClick={() => toggle(n.id)} title={collapsed.has(n.id) ? "Expand" : "Collapse"}>
                      <Icon name={collapsed.has(n.id) ? "chevronRight" : "chevronDown"} size={12}/>
                    </button>
                  ) : <span className="pds-toggle-spacer"/>}
                  <span className={"pd-tree-dot " + (n.itemType === "main" ? "main" : "standard")}/>
                  <span className="pds-tree-id">{n.localId}</span>
                  <span className="pds-tree-name" title={n.name}>{n.name}</span>
                  <button className="pds-addkid" title="Add subphase" onClick={() => onAddChild?.(n.id)}>
                    <Icon name="plus" size={11}/>
                  </button>
                </div>
                <div className="pds-cell">
                  <EditableCell value={n.itemType} type="select" options={PROJECT_ITEM_TYPE_OPTIONS}
                    render={(v) => <span className={"pd-type-badge sm " + (v === "main" ? "is-main" : "is-standard")}>{projectItemTypeLabel(v)}</span>}
                    onChange={(v) => updateItem(n.id, { itemType: v })}/>
                </div>
                <div className="pds-cell">
                  <EditableCell value={n.status} type="select" options={PROJECT_ITEM_STATUS_OPTIONS}
                    render={(v) => <span className={"pd-status-badge sm st-" + (v || "active")}>{projectItemStatusLabel(v)}</span>}
                    onChange={(v) => updateItem(n.id, { status: v })}/>
                </div>
                <div className="pds-cell right mono">
                  <EditableCell value={n.percentComplete} type="number" align="right"
                    render={(v) => (v == null || v === "") ? <span className="empty-cell">—</span> : `${v}%`}
                    onChange={(v) => updateItem(n.id, { percentComplete: v })}/>
                </div>
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
                  ? "—" : fmtMoney(Number(n.laborCost || 0) + Number(n.expenseCost || 0), false))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Invoices (the existing InvoiceTable, filtered to this project) ───────────
function InvoicesTab({ project, invoiceTableProps }) {
  const rows = invoiceTableProps?.rows || [];
  return (
    <div className="pd-pane pd-pane-flush">
      {rows.length === 0 && (
        <div className="pd-inv-note">
          <Icon name="warn" size={13}/>
          No invoice records match project number <strong>{project.localId}</strong> yet.
          Invoice rows link by project number — create one on the Invoice page (or set the
          project's ID to match its invoice number) and it will appear here.
        </div>
      )}
      <InvoiceTable {...invoiceTableProps} tab="invoice"/>
    </div>
  );
}

// ── Documents (placeholder) ─────────────────────────────────────────────────
function DocumentsTab() {
  return (
    <div className="pd-pane">
      <div className="pd-empty">
        <Icon name="copy" size={26}/>
        <h3>Documents coming soon</h3>
        <p>Project-related documents will live here.</p>
      </div>
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

  const nodeLabel = (id) => nodeOptions.find(o => o.value === id)?.label?.replace(/^(— )+/, "") || "";

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

  return (
    <div className="pd-pane">
      <div className="pd-pane-head">
        <h3>To-Dos {todos.length ? <span className="pd-count">{todos.filter(t => !t.done).length} open</span> : null}</h3>
        {!showForm && (
          <button className="btn primary sm" onClick={() => { setEditing(null); setShowForm(true); }}>
            <Icon name="plus" size={12}/> New to-do
          </button>
        )}
      </div>

      {error && <div className="pd-error"><Icon name="warn" size={12}/> {error}</div>}

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
        <div className="pd-loading">Loading…</div>
      ) : sorted.length === 0 && !showForm ? (
        <div className="pd-empty sm">
          <Icon name="check" size={22}/>
          <span>No to-dos yet</span>
          <small>Create a task to track work on this project.</small>
        </div>
      ) : (
        <div className="pd-todo-list">
          {sorted.map(t => (
            <div key={t.id} className={"pd-todo" + (t.done ? " is-done" : "")}>
              <button className={"pd-check" + (t.done ? " on" : "")} onClick={() => toggleDone(t)}
                title={t.done ? "Mark not done" : "Mark done"}>
                {t.done && <Icon name="check" size={12}/>}
              </button>
              <div className="pd-todo-main">
                <div className="pd-todo-top">
                  <span className={"pd-prio pd-prio-" + t.priority}>
                    <Icon name="flag" size={10}/> {todoPriorityLabel(t.priority)}
                  </span>
                  <span className="pd-todo-desc">{t.description}</span>
                </div>
                <div className="pd-todo-meta">
                  {(t.startDate || t.endDate) && (
                    <span><Icon name="calendar" size={11}/> {fmtDate(t.startDate) || "—"} → {fmtDate(t.endDate) || "—"}</span>
                  )}
                  {t.assignedTo && (
                    <span title="Assigned to">
                      <span className={`avatar xs ${userById(t.assignedTo)?.color || ""}`}>{userById(t.assignedTo)?.initials || "··"}</span>
                      {userById(t.assignedTo)?.name || "—"}
                    </span>
                  )}
                  {t.assignedBy && <span className="pd-muted">by {userById(t.assignedBy)?.name || "—"}</span>}
                  <span className="pd-muted">· {nodeLabel(t.itemId)}</span>
                </div>
              </div>
              <div className="pd-todo-actions">
                <button title="Edit" onClick={() => { setEditing(t); setShowForm(true); }}><Icon name="edit" size={13}/></button>
                <button title="Delete" onClick={() => remove(t)}><Icon name="trash" size={13}/></button>
              </div>
            </div>
          ))}
        </div>
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
    <div className="pd-form">
      <div className="pd-form-row">
        <label className="pd-field full">
          <span>Description</span>
          <textarea className="input" rows={2} value={f.description}
            autoFocus placeholder="What needs to be done?"
            onChange={e => set("description", e.target.value)}/>
        </label>
      </div>
      <div className="pd-form-row">
        <label className="pd-field"><span>Start date</span>
          <input type="date" className="input" value={f.startDate} onChange={e => set("startDate", e.target.value)}/></label>
        <label className="pd-field"><span>End date</span>
          <input type="date" className="input" value={f.endDate} onChange={e => set("endDate", e.target.value)}/></label>
        <label className="pd-field"><span>Priority</span>
          <select className="input" value={f.priority} onChange={e => set("priority", e.target.value)}>
            {TODO_PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>
      </div>
      <div className="pd-form-row">
        <label className="pd-field"><span>Assigned to</span>
          <select className="input" value={f.assignedTo} onChange={e => set("assignedTo", e.target.value)}>
            <option value="">— Unassigned —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label className="pd-field"><span>Assigned by</span>
          <input className="input" disabled value={userById(me?.id)?.name || "You"}/></label>
        <label className="pd-field"><span>Attach to</span>
          <select className="input" value={f.itemId} onChange={e => set("itemId", e.target.value)}>
            {nodeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>
      </div>
      <div className="pd-form-foot">
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn primary sm" onClick={submit} disabled={!f.description.trim() || busy}>
          {busy ? "Saving…" : isEdit ? "Save changes" : "Add to-do"}
        </button>
      </div>
    </div>
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

  const nodeLabel = (id) => nodeOptions.find(o => o.value === id)?.label?.replace(/^(— )+/, "") || "";
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
    <div className="pd-pane">
      {/* Composer */}
      <div className="pd-note-composer">
        <span className={`avatar sm ${meUser?.color || ""}`}>{meUser?.initials || "··"}</span>
        <div className="pd-note-composer-main">
          <textarea className="input" rows={2} value={draft}
            placeholder="Add a note — billing status, client update, contract change…"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); } }}/>
          <div className="pd-note-composer-controls">
            <select className="input sm" value={category} onChange={e => setCategory(e.target.value)}>
              {NOTE_CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="input sm" value={attachTo} onChange={e => setAttachTo(e.target.value)} title="Attach to">
              {nodeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input ref={fileInput} type="file" multiple hidden
              onChange={e => { setFiles(Array.from(e.target.files || [])); e.target.value = ""; }}/>
            <button className="btn ghost sm" onClick={() => fileInput.current?.click()}>
              <Icon name="link" size={12}/> Attach
            </button>
            <span className="pd-note-flex"/>
            <button className="btn primary sm" onClick={post} disabled={!draft.trim() || busy}>
              <Icon name="forward" size={12}/> {busy ? "Posting…" : "Post note"}
            </button>
          </div>
          {files.length > 0 && (
            <div className="pd-note-files staged">
              {files.map((f, i) => (
                <span key={i} className="pd-file-chip">
                  <Icon name="link" size={10}/> {f.name}
                  <button onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} title="Remove"><Icon name="x" size={10}/></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="pd-error"><Icon name="warn" size={12}/> {error}</div>}

      {/* Feed */}
      {loading ? (
        <div className="pd-loading">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="pd-empty sm">
          <Icon name="note" size={22}/>
          <span>No notes yet</span>
          <small>Be the first to add a note for this project.</small>
        </div>
      ) : (
        <div className="pd-note-list">
          {notes.map(n => {
            const u = userById(n.authorId);
            return (
              <div key={n.id} className="pd-note">
                <span className={`avatar xs ${u?.color || ""}`} title={u?.name || "Unknown"}>{u?.initials || "··"}</span>
                <div className="pd-note-main">
                  <div className="pd-note-head">
                    <span className="pd-note-author">{u?.name || "Unknown"}</span>
                    <span className={"pd-cat-badge cat-" + n.category}>{noteCategoryLabel(n.category)}</span>
                    <span className="pd-note-time" title={noteStamp(n.createdAt)}>
                      {noteStamp(n.createdAt)}<span className="pd-muted"> · {noteTimeAgo(n.createdAt)}</span>
                    </span>
                    {n.editedAt && <span className="pd-note-edited">edited</span>}
                    <span className="pd-muted pd-note-node">· {nodeLabel(n.itemId)}</span>
                    {canModify(n) && editingId !== n.id && (
                      <span className="pd-note-actions">
                        <button title="Edit" onClick={() => setEditingId(n.id)}><Icon name="edit" size={12}/></button>
                        <button title="Delete" onClick={() => remove(n)}><Icon name="trash" size={12}/></button>
                      </span>
                    )}
                  </div>

                  {editingId === n.id ? (
                    <NoteEdit note={n} onCancel={() => setEditingId(null)} onSave={(patch) => saveEdit(n.id, patch)}/>
                  ) : (
                    <>
                      <div className="pd-note-body">{n.body}</div>
                      {(n.files.length > 0 || canModify(n)) && (
                        <div className="pd-note-files">
                          {n.files.map(f => (
                            <span key={f.id} className="pd-file-chip">
                              <button className="pd-file-open" onClick={() => openFile(f)}><Icon name="link" size={10}/> {f.name}</button>
                              {canModify(n) && <button onClick={() => removeFile(n, f)} title="Remove"><Icon name="x" size={10}/></button>}
                            </span>
                          ))}
                          {canModify(n) && <NoteAddFile onPick={(file) => addFileToNote(n, file)}/>}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
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
    <div className="pd-note-edit">
      <textarea className="input" autoFocus rows={2} value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}/>
      <div className="pd-note-edit-foot">
        <select className="input sm" value={cat} onChange={e => setCat(e.target.value)}>
          {NOTE_CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="pd-note-flex"/>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn primary sm" disabled={!body.trim()}
          onClick={() => onSave({ body: body.trim(), category: cat })}>Save</button>
      </div>
    </div>
  );
}

function NoteAddFile({ onPick }) {
  const ref = useRef();
  return (
    <>
      <input ref={ref} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }}/>
      <button className="pd-file-add" onClick={() => ref.current?.click()} title="Attach a file">
        <Icon name="plus" size={10}/> Attach
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
    <div className="pd-settings">
      <div className="pd-settings-list">
        {subtree.map(n => (
          <button key={n.id}
            className={"pd-settings-item depth-" + Math.min(n._depth, 5) + (sel?.id === n.id ? " active" : "")}
            style={{ "--pd-depth": n._depth }}
            onClick={() => setSelId(n.id)}>
            <span className="pd-settings-id">{n.localId}</span>
            <span className="pd-settings-name">{n.name}</span>
          </button>
        ))}
      </div>
      <div className="pd-settings-editor">
        {sel ? (
          <ItemEditor key={sel.id} item={sel} items={items} updateItem={updateItem}
            onAddItemSub={onAddItemSub} onUpdateItemSub={onUpdateItemSub} onRemoveItemSub={onRemoveItemSub}
            onDeleteItem={onDeleteItem} onAddChild={onAddChild}/>
        ) : <div className="pd-empty sm"><span>Select an item to edit.</span></div>}
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
    <label className="pd-field" key={k}>
      <span>{label}</span>
      <input className="input" type={type}
        value={val(k)} onChange={e => setLocal(k, e.target.value)} onBlur={() => commit(k)}/>
    </label>
  );

  // Subs management (companies) wired to App's item-sub handlers.
  const [addSubId, setAddSubId] = useState("");
  const subCompanyOptions = getCompanies()
    .filter(c => c.type !== "Client" && !(item.subs || []).some(s => s.cId === c.id))
    .map(c => ({ value: c.id, label: c.name }));

  return (
    <div className="pd-editor">
      <div className="pd-editor-head">
        <h3>{item.localId} · {item.name}</h3>
        <div className="pd-editor-head-actions">
          <button className="btn ghost sm" onClick={() => onAddChild(item.id)}><Icon name="plus" size={12}/> Add child</button>
          <button className="btn danger sm" onClick={() => onDeleteItem(item.id)}><Icon name="trash" size={12}/> Delete</button>
        </div>
      </div>

      <div className="pd-editor-grid">
        {field(idLabel, "localId")}
        {field("Name", "name")}

        <label className="pd-field"><span>Type</span>
          <select className="input" value={item.itemType || "standard"} onChange={e => save("itemType", e.target.value)}>
            {PROJECT_ITEM_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <em className="pd-field-hint">{item.itemType === "main" ? "Container — no time/expense logging." : "Work item — time/expense can be logged."}</em>
        </label>
        <label className="pd-field"><span>Status</span>
          <select className="input" value={item.status || "active"} onChange={e => save("status", e.target.value)}>
            {PROJECT_ITEM_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <label className="pd-field"><span>Client / Prime</span>
          <SearchableSelect value={item.clientId || ""} options={dirOptions}
            onChange={v => save("clientId", v)} allowClear placeholder="Search clients / companies…"/>
        </label>
        <label className="pd-field"><span>Parent</span>
          {isRoot
            ? <input className="input" disabled value="Root (no parent)"/>
            : <SearchableSelect value={item.parentId || ""} options={parentOptions}
                onChange={v => save("parentId", v)} allowClear placeholder="Search items…"/>}
        </label>

        <label className="pd-field"><span>Contract Type</span>
          <select className="input" value={item.contractType || ""} onChange={e => save("contractType", e.target.value)}>
            <option value="">— None —</option>
            {CONTRACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {field("Contract Amount", "contractAmount", "number")}

        {field("Start Date", "startDate", "date")}
        {field("Due Date", "dueDate", "date")}

        {field("Percent Complete", "percentComplete", "number")}
        <label className="pd-field"><span>Manager</span>
          <select className="input" value={item.managerId || ""} onChange={e => save("managerId", e.target.value)}>
            <option value="">— None —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>

        {field("Address Line 1", "addressLine1")}
        {field("Address Line 2", "addressLine2")}
        {field("City", "city")}
        {field("State", "state")}
        {field("PIN Code", "pinCode")}
      </div>

      {/* Additional PMs */}
      <div className="pd-editor-sub">
        <div className="pd-editor-sub-head"><span>Additional Project Managers</span></div>
        <div className="pd-chip-row">
          {(item.pmIds || []).map(id => (
            <span key={id} className="pd-user-chip">
              <span className={`avatar xs ${userById(id)?.color || ""}`}>{userById(id)?.initials || "··"}</span>
              {userById(id)?.name || "—"}
              <button onClick={() => save("pmIds", (item.pmIds || []).filter(x => x !== id))} title="Remove"><Icon name="x" size={10}/></button>
            </span>
          ))}
          <select className="input sm" value="" onChange={e => { if (e.target.value) save("pmIds", [...(item.pmIds || []), e.target.value]); }}>
            <option value="">+ Add PM…</option>
            {users.filter(u => !(item.pmIds || []).includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      </div>

      {/* Subs */}
      <div className="pd-editor-sub">
        <div className="pd-editor-sub-head"><span>Subs</span></div>
        <div className="pd-sub-list">
          {(item.subs || []).map(s => (
            <div key={s.cId} className="pd-sub-row">
              <span className="pd-sub-name">{companyById(s.cId)?.name || "—"}</span>
              <input className="input sm" placeholder="Discipline" defaultValue={s.desc || ""}
                onBlur={e => { if (e.target.value !== (s.desc || "")) onUpdateItemSub(item.id, s.cId, { desc: e.target.value }); }}/>
              <input className="input sm" type="number" placeholder="Amount" defaultValue={s.amt ?? ""}
                onBlur={e => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (v !== (s.amt ?? 0)) onUpdateItemSub(item.id, s.cId, { amt: v }); }}/>
              <button className="pd-sub-rm" onClick={() => onRemoveItemSub(item.id, s.cId)} title="Remove sub"><Icon name="x" size={11}/></button>
            </div>
          ))}
          <select className="input sm" value={addSubId}
            onChange={e => { const v = e.target.value; setAddSubId(""); if (v) onAddItemSub(item.id, v); }}>
            <option value="">+ Add sub company…</option>
            {subCompanyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
