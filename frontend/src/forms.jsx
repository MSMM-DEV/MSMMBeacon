import React, { useState, useEffect, useMemo, useRef } from "react";
import { Icon } from "./icons.jsx";
import { supabase, THIS_YEAR, MONTHS, fmtMoney } from "./data.js";
import { SearchableSelect } from "./primitives.jsx";

// ============ CREATE MODAL ============
// "New X" flow for potential / events / clients / companies.
//
// Flow:
//   1. Insert the main row into the primary DB table → get new id.
//   2. Insert related rows (PM join for potential, subs for potential,
//      attendees for events) keyed on the new id.
//   3. Call onCreated(dbRow, extras). App.jsx's adaptInsertedRow uses
//      `extras.pmIds`, `extras.subs`, `extras.attendees` to build the UI row
//      so the freshly-created entry shows its relations immediately.
//
// Errors after step 1 are reported inline; the main row stays in the DB.

// In v2, both Potential and Awaiting INSERT into the same `projects` table —
// they differ only in the `status` column (set in onSubmit). Hot Leads is
// the renamed `leads` table.
const DB_TABLES = {
  potential: "projects",
  awaiting:  "projects",
  events:    "events",
  hotleads:  "leads",
  clients:   "clients",
  companies: "companies",
  invoice:   "anticipated_invoice",
};

const TITLES = {
  potential: { title: "New potential project",  icon: "briefcase" },
  awaiting:  { title: "New awaiting verdict",   icon: "clock"     },
  events:    { title: "New event",               icon: "calendar"  },
  hotleads:  { title: "New hot lead",            icon: "trend"     },
  clients:   { title: "New client",              icon: "users"     },
  companies: { title: "New company",             icon: "briefcase" },
  invoice:   { title: "New invoice row",         icon: "trend"     },
};

// Columns that the DB accepts directly. Anything NOT in this list is
// treated as an "extra" (PM / subs / attendees) and inserted via a second
// write against the child/join table.
//
// Keyed by the UI `table` parameter (not the DB table name) because v2
// collapsed the project pipeline tables into one — Potential and Awaiting
// both target `projects` but with different valid column subsets.
const DB_COLUMNS = {
  potential: [
    "project_name", "year", "role", "client_id",
    "total_contract_amount", "msmm_amount", "probability",
    "notes", "next_action_note", "next_action_date", "project_number",
    "anticipated_invoice_start_month",
  ],
  awaiting: [
    "project_name", "year", "client_id",
    "date_submitted", "anticipated_result_date",
    "client_contract_number", "msmm_contract_number",
    "msmm_used", "msmm_remaining",
    "notes", "project_number",
  ],
  events: [
    "title", "status", "type", "event_datetime", "notes",
  ],
  hotleads: [
    "title", "status", "client_id", "date_time", "notes",
  ],
  clients: [
    "name", "district", "org_type",
    "contact_person", "email", "phone", "address", "notes",
  ],
  companies: [
    "name", "contact_person", "email", "phone", "address", "notes",
  ],
  // anticipated_invoice — manual entry. source_project_id stays null on
  // this path; Move Forward handles linked-invoice creation. Standalone
  // rows just track project_name + year + amounts; PMs go through the
  // anticipated_invoice_pms join in the second insert step.
  invoice: [
    "project_name", "year", "project_number", "type",
    "contract_amount", "msmm_remaining_to_bill_year_start",
  ],
};

const NUMERIC_COLS = new Set([
  "year", "total_contract_amount", "msmm_amount", "anticipated_invoice_start_month",
  "msmm_used", "msmm_remaining",
  "contract_amount", "msmm_remaining_to_bill_year_start",
]);

const INITIAL = {
  potential: {
    project_name: "",
    year: THIS_YEAR,
    role: "",
    client_id: "",
    total_contract_amount: "",
    msmm_amount: "",
    probability: "High",
    pm_user_ids: [],
    subs: [],
    notes: "",
    next_action_note: "",
    next_action_date: "",
    project_number: "",
    anticipated_invoice_start_month: "",
  },
  awaiting: {
    project_name: "",
    year: THIS_YEAR,
    client_id: "",
    date_submitted: "",
    anticipated_result_date: "",
    client_contract_number: "",
    msmm_contract_number: "",
    msmm_used: "",
    msmm_remaining: "",
    notes: "",
    project_number: "",
    pm_user_ids: [],
    subs: [],
  },
  events: {
    title: "",
    status: "Booked",
    type: "",
    event_datetime: "",
    attendees: [],
    notes: "",
  },
  hotleads: {
    title: "",
    status: "Scheduled",
    client_id: "",
    date_time: "",
    notes: "",
    attendees: [],
  },
  clients: {
    name: "",
    district: "",
    org_type: "",
    contact_person: "",
    email: "",
    phone: "",
    address: "",
    notes: "",
  },
  companies: {
    name: "",
    contact_person: "",
    email: "",
    phone: "",
    address: "",
    notes: "",
  },
  invoice: {
    project_name: "",
    year: THIS_YEAR,
    project_number: "",
    type: "ENG",
    contract_amount: "",
    msmm_remaining_to_bill_year_start: "",
    pm_user_ids: [],
  },
};

const REQUIRED = {
  potential: ["project_name"],
  awaiting:  ["project_name"],
  events:    ["title"],
  hotleads:  ["title"],
  clients:   ["name"],
  companies: ["name"],
  invoice:   ["project_name", "year"],
};

// --------------------- shared sub-editor ---------------------
// Same pattern the DetailDrawer uses. Companies dropdown excludes Client-type.
function SubsEditor({ value, companies, onChange }) {
  const subs = value || [];
  const subOptions = useMemo(() => (companies || [])
    .filter(c => c.type !== "Client")
    .map(c => ({ value: c.id, label: c.name })),
  [companies]);
  const update = (i, patch) => onChange(subs.map((s, j) => j === i ? { ...s, ...patch } : s));
  const remove = (i) => onChange(subs.filter((_, j) => j !== i));
  const add = () => onChange([...subs, { cId: null, desc: "", amt: 0 }]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {subs.length === 0 && (
        <div style={{
          fontSize: 12.5, color: "var(--text-soft)", fontStyle: "italic",
          padding: "6px 10px", background: "var(--surface-2)",
          border: "1px dashed var(--border)", borderRadius: 8,
        }}>
          No subs yet — click "Add sub" below to add one.
        </div>
      )}
      {subs.map((s, i) => (
        <div key={i} className="subrow"
             style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr) 110px 30px" }}>
          <SearchableSelect
            value={s.cId || ""}
            options={subOptions}
            placeholder="Search companies…"
            onChange={v => update(i, { cId: v || null })}
          />
          <input className="input" placeholder="Discipline (e.g. Survey)"
                 value={s.desc || ""} onChange={e => update(i, { desc: e.target.value })}/>
          <input className="input mono" type="number" placeholder="$" min="0"
                 value={s.amt ?? ""}
                 onChange={e => update(i, { amt: e.target.value === "" ? 0 : Number(e.target.value) })}
                 style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}/>
          <button type="button" className="row-btn" title="Remove sub"
                  onClick={() => remove(i)} style={{ color: "var(--rose)" }}>
            <Icon name="trash" size={12}/>
          </button>
        </div>
      ))}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginTop: subs.length ? 4 : 2,
      }}>
        <button type="button" className="tool-chip" onClick={add}
                style={{ borderStyle: "solid", borderColor: "var(--accent-soft)",
                         color: "var(--accent-ink)", background: "var(--accent-softer)" }}>
          <Icon name="plus" size={12}/>Add sub
        </button>
        {subs.length > 0 && (
          <span className="mono" style={{ fontSize: 11, color: "var(--text-soft)" }}>
            Total: {fmtMoney(subs.reduce((a, s) => a + (Number(s.amt) || 0), 0))}
          </span>
        )}
      </div>
    </div>
  );
}

// --------------------- multi-user picker ---------------------
function UserMultiPicker({ value, users, onChange, placeholder = "Pick users…" }) {
  const ids = value || [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const pool = users || [];
  const available = pool.filter(u => !ids.includes(u.id) && (!q || u.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="tag-input" onClick={() => setOpen(true)} style={{ position: "relative" }}>
      {ids.map(uid => {
        const u = pool.find(x => x.id === uid);
        if (!u) return null;
        return (
          <span key={uid} className="tag">
            <span className={`avatar xs ${u.color}`}>{u.initials}</span>{u.name}
            <button type="button" onClick={(e) => {
              e.stopPropagation();
              onChange(ids.filter(x => x !== uid));
            }}>
              <Icon name="x" size={10}/>
            </button>
          </span>
        );
      })}
      <input placeholder={ids.length ? "Add another…" : placeholder}
             value={q}
             onChange={e => { setQ(e.target.value); setOpen(true); }}
             onFocus={() => setOpen(true)}
             onBlur={() => setTimeout(() => setOpen(false), 150)}/>
      {open && available.length > 0 && (
        <div className="menu" style={{ left: 0, right: 0, top: "calc(100% + 4px)", position: "absolute", margin: 4 }}>
          {available.slice(0, 6).map(u => (
            <button key={u.id} type="button" className="menu-item"
                    onMouseDown={() => { onChange([...ids, u.id]); setQ(""); }}>
              <span className={`avatar xs ${u.color}`}>{u.initials}</span>
              <span>{u.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------- main component ---------------------
export const CreateModal = ({ table, seed = null, clients, companies, users, onClose, onCreated }) => {
  const dbTable = DB_TABLES[table];
  const titleCfg = TITLES[table];
  const required = REQUIRED[table] || [];

  // The `clients` prop is passed as-adapted UI rows — `c.name` is already
  // the merged "${base} — ${district}" display form (see adaptClient). The
  // combobox option label just uses it verbatim; no extra concatenation.
  const clientOptions = useMemo(() =>
    (clients || []).map(c => ({ value: c.id, label: c.name })),
  [clients]);
  // Merged Client+Firm list for Sub-role rows. Companies get a " · Firm"
  // suffix so the two pools are visually distinguishable.
  const clientOrFirmOptions = useMemo(() => ([
    ...(clients || []).map(c => ({ value: c.id, label: c.name })),
    ...(companies || []).filter(c => c.type !== "Client")
                        .map(c => ({ value: c.id, label: `${c.name} · Firm` })),
  ]), [clients, companies]);
  // Set of real-client ids for payload routing (see onSubmit below).
  const clientIdSet = useMemo(() => new Set((clients || []).map(c => c.id)), [clients]);

  const [form, setForm] = useState(() => ({ ...(INITIAL[table] || {}), ...(seed || {}) }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!dbTable || !titleCfg) return null;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isEmpty = (v) => v === undefined || v === null || v === "";
  const requiredOk = required.every(k => !isEmpty(form[k]));

  // Build the payload by picking only real DB columns. Omit empty values
  // so default/NULL-able columns stay untouched. Coerce numerics.
  const buildPayload = () => {
    const cols = DB_COLUMNS[table] || [];
    const payload = {};
    for (const k of cols) {
      const v = form[k];
      if (isEmpty(v)) continue;
      if (NUMERIC_COLS.has(k)) {
        const n = Number(v);
        if (!Number.isNaN(n)) payload[k] = n;
      } else {
        payload[k] = v;
      }
    }
    return payload;
  };

  const onSubmit = async () => {
    if (!requiredOk || pending) return;
    setError("");
    setPending(true);

    // Step 1 — insert the main row.
    const payload = buildPayload();
    // Route the unified client_id field for project tables. The Client
    // picker for Sub-role rows includes both clients AND companies; if the
    // user picked a company, send it to prime_company_id instead (and
    // blank client_id) to avoid the client_id_fkey violation on insert.
    const projectTables = new Set(["projects", "leads"]);
    if (projectTables.has(dbTable) && payload.client_id && !clientIdSet.has(payload.client_id)) {
      payload.prime_company_id = payload.client_id;
      delete payload.client_id;
    }
    // v2: the projects table is keyed on a `status` column. Inject the
    // appropriate status for the UI tab.
    if (table === "potential") payload.status = "potential";
    if (table === "awaiting")  payload.status = "awaiting";
    const { data: row, error: err } = await supabase
      .from(dbTable).insert(payload).select().single();
    if (err) {
      setError(err.message);
      setPending(false);
      return;
    }

    // Step 2 — insert related rows keyed on the new id.
    const extras = {};
    try {
      if (table === "potential") {
        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: e1 } = await supabase
            .from("project_pms")
            .insert(pmIds.map(uid => ({ project_id: row.id, user_id: uid })));
          if (e1) throw e1;
          extras.pmIds = pmIds;
        }
        const subs = (form.subs || []).filter(s => s.cId || s.desc || s.amt);
        if (subs.length > 0) {
          const subsPayload = subs.map((s, i) => ({
            project_id: row.id,
            ord: i + 1,
            company_id: s.cId || null,
            discipline: s.desc || null,
            amount: s.amt != null && s.amt !== "" ? Number(s.amt) : null,
          }));
          const { error: e2 } = await supabase
            .from("project_subs").insert(subsPayload);
          if (e2) throw e2;
          extras.subs = subs;
        }
        // Orange → auto-create a linked anticipated_invoice row so the
        // pre-awarded project shows up on the Invoice tab immediately.
        // v2 collapsed source_awarded_id + source_potential_id into one
        // source_project_id FK; we point it at this potential row's id.
        if (form.probability === "Orange") {
          const invPayload = {
            source_project_id: row.id,
            project_name: row.project_name,
            year: row.year,
            project_number: row.project_number || null,
            contract_amount: row.total_contract_amount ?? null,
          };
          const { data: invRow, error: e4 } = await supabase
            .from("anticipated_invoice").insert(invPayload).select().single();
          if (e4) throw e4;
          extras.invoiceRow = invRow;
        }
      } else if (table === "awaiting") {
        // Direct entry into Awaiting Verdict: same project_pms/project_subs
        // join tables as Potential — only the parent row's `status` differs.
        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: eAP } = await supabase
            .from("project_pms")
            .insert(pmIds.map(uid => ({ project_id: row.id, user_id: uid })));
          if (eAP) throw eAP;
          extras.pmIds = pmIds;
        }
        const subs = (form.subs || []).filter(s => s.cId);
        if (subs.length > 0) {
          const { error: eAS } = await supabase
            .from("project_subs")
            .insert(subs.map(s => ({ project_id: row.id, company_id: s.cId })));
          if (eAS) throw eAS;
          extras.subs = subs;
        }
      } else if (table === "events") {
        const att = form.attendees || [];
        if (att.length > 0) {
          const { error: e3 } = await supabase
            .from("event_attendees")
            .insert(att.map(uid => ({ event_id: row.id, user_id: uid })));
          if (e3) throw e3;
          extras.attendees = att;
        }
      } else if (table === "hotleads") {
        const att = form.attendees || [];
        if (att.length > 0) {
          const { error: eH } = await supabase
            .from("lead_attendees")
            .insert(att.map(uid => ({ lead_id: row.id, user_id: uid })));
          if (eH) throw eH;
          extras.attendees = att;
        }
      } else if (table === "invoice") {
        // PMs land in anticipated_invoice_pms (composite PK on
        // (anticipated_invoice_id, user_id) — same shape as v1).
        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: eIP } = await supabase
            .from("anticipated_invoice_pms")
            .insert(pmIds.map(uid => ({ anticipated_invoice_id: row.id, user_id: uid })));
          if (eIP) throw eIP;
          extras.pmIds = pmIds;
        }
      }
    } catch (e) {
      // Main row already exists; just surface the partial-save warning.
      setError(`Main row saved; related rows failed: ${e.message || e}`);
      setPending(false);
      // Still let App.jsx know so the main row appears in the UI.
      onCreated(row, extras);
      return;
    }

    onCreated(row, extras);
    onClose();
  };

  const renderFields = () => {
    if (table === "potential") {
      return (
        <>
          <Field label="Project Name *">
            <input className="input" autoFocus value={form.project_name}
                   onChange={e => set("project_name", e.target.value)}/>
          </Field>
          <Field label="Year">
            <input className="input" type="number" value={form.year}
                   onChange={e => set("year", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Role">
            <select className="select" value={form.role} onChange={e => set("role", e.target.value)}>
              <option value="">—</option>
              <option value="Prime">Prime</option>
              <option value="Sub">Sub</option>
            </select>
          </Field>
          <Field label="Client">
            <SearchableSelect
              value={form.client_id || ""}
              options={form.role === "Sub" ? clientOrFirmOptions : clientOptions}
              placeholder={form.role === "Sub" ? "Search clients or firms…" : "Search clients…"}
              onChange={v => set("client_id", v || "")}
            />
          </Field>
          <Field label="Total Contract Amount">
            <input className="input" type="number" value={form.total_contract_amount}
                   onChange={e => set("total_contract_amount", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }} placeholder="0"/>
          </Field>
          <Field label="MSMM Amount">
            <input className="input" type="number" value={form.msmm_amount}
                   onChange={e => set("msmm_amount", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }} placeholder="0"/>
          </Field>
          <Field label="Subs" multiline>
            <SubsEditor value={form.subs} companies={companies}
                        onChange={next => set("subs", next)}/>
          </Field>
          <Field label="PMs" multiline>
            <UserMultiPicker value={form.pm_user_ids} users={users}
                             onChange={next => set("pm_user_ids", next)}
                             placeholder="Pick MSMM users…"/>
          </Field>
          <Field label="Probability">
            <select className="select" value={form.probability}
                    onChange={e => set("probability", e.target.value)}>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
              <option value="Orange">Orange (pre-awarded)</option>
            </select>
          </Field>
          {form.probability === "Orange" && (
            <Field label="Anticipated Invoice Start Month">
              <select className="select" value={form.anticipated_invoice_start_month}
                      onChange={e => set("anticipated_invoice_start_month", e.target.value)}>
                <option value="">—</option>
                {MONTHS.map((m, i) => (
                  <option key={i + 1} value={i + 1}>{m}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
          </Field>
          <Field label="Dates and Comments">
            <input className="input" value={form.next_action_note}
                   onChange={e => set("next_action_note", e.target.value)}
                   placeholder="e.g. decision expected 4/2/26"/>
          </Field>
          <Field label="Next Action Date">
            <input className="input" type="date" value={form.next_action_date}
                   onChange={e => set("next_action_date", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Project Number">
            <input className="input" value={form.project_number}
                   onChange={e => set("project_number", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
        </>
      );
    }

    if (table === "awaiting") {
      return (
        <>
          <Field label="Project Name *">
            <input className="input" autoFocus value={form.project_name}
                   onChange={e => set("project_name", e.target.value)}/>
          </Field>
          <Field label="Year">
            <input className="input" type="number" value={form.year}
                   onChange={e => set("year", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Client">
            <SearchableSelect
              value={form.client_id || ""}
              options={form.role === "Sub" ? clientOrFirmOptions : clientOptions}
              placeholder={form.role === "Sub" ? "Search clients or firms…" : "Search clients…"}
              onChange={v => set("client_id", v || "")}
            />
          </Field>
          <Field label="Subs" multiline>
            <SubsEditor value={form.subs} companies={companies}
                        onChange={next => set("subs", next)}/>
          </Field>
          <Field label="PMs" multiline>
            <UserMultiPicker value={form.pm_user_ids} users={users}
                             onChange={next => set("pm_user_ids", next)}
                             placeholder="Pick MSMM users…"/>
          </Field>
          <Field label="Date Submitted">
            <input className="input" type="date" value={form.date_submitted}
                   onChange={e => set("date_submitted", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Anticipated Result Date">
            <input className="input" type="date" value={form.anticipated_result_date}
                   onChange={e => set("anticipated_result_date", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Client Contract #">
            <input className="input" value={form.client_contract_number}
                   onChange={e => set("client_contract_number", e.target.value)}
                   placeholder="e.g. POSL-2026-045"
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
          <Field label="MSMM Contract #">
            <input className="input" value={form.msmm_contract_number}
                   onChange={e => set("msmm_contract_number", e.target.value)}
                   placeholder="e.g. MSMM-2026-045"
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
          <Field label="MSMM Used">
            <input className="input" type="number" value={form.msmm_used}
                   onChange={e => set("msmm_used", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }} placeholder="0"/>
          </Field>
          <Field label="MSMM Remaining">
            <input className="input" type="number" value={form.msmm_remaining}
                   onChange={e => set("msmm_remaining", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }} placeholder="0"/>
          </Field>
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
          </Field>
          <Field label="Project Number">
            <input className="input" value={form.project_number}
                   onChange={e => set("project_number", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
        </>
      );
    }

    if (table === "events") {
      return (
        <>
          <Field label="Title *">
            <input className="input" autoFocus value={form.title}
                   onChange={e => set("title", e.target.value)}/>
          </Field>
          <Field label="Status">
            <select className="select" value={form.status}
                    onChange={e => set("status", e.target.value)}>
              <option value="Booked">Booked</option>
              <option value="Happened">Happened</option>
            </select>
          </Field>
          <Field label="Type">
            <select className="select" value={form.type}
                    onChange={e => set("type", e.target.value)}>
              <option value="">—</option>
              <option value="Partner">Partner</option>
              <option value="AI">AI</option>
              <option value="Project">Project</option>
              <option value="Meetings">Meetings</option>
              <option value="Board Meetings">Board Meetings</option>
              <option value="Event">Event</option>
            </select>
          </Field>
          <Field label="Date & Time">
            <input className="input" type="datetime-local" value={form.event_datetime}
                   onChange={e => set("event_datetime", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Attendees" multiline>
            <UserMultiPicker value={form.attendees} users={users}
                             onChange={next => set("attendees", next)}
                             placeholder="Pick MSMM users…"/>
          </Field>
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
          </Field>
        </>
      );
    }

    if (table === "hotleads") {
      return (
        <>
          <Field label="Title *">
            <input className="input" autoFocus value={form.title}
                   onChange={e => set("title", e.target.value)}/>
          </Field>
          <Field label="Status">
            <select className="input" value={form.status || "Scheduled"}
                    onChange={e => set("status", e.target.value)}>
              <option value="Scheduled">Scheduled</option>
              <option value="Happened">Happened</option>
            </select>
          </Field>
          <Field label="Client / Firm">
            <SearchableSelect
              value={form.client_id || ""}
              options={clientOrFirmOptions}
              placeholder="Search clients or firms…"
              onChange={v => set("client_id", v || "")}
            />
          </Field>
          <Field label="Date & Time">
            <input className="input" type="datetime-local" value={form.date_time}
                   onChange={e => set("date_time", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Attendees" multiline>
            <UserMultiPicker value={form.attendees} users={users}
                             onChange={next => set("attendees", next)}
                             placeholder="Pick MSMM users…"/>
          </Field>
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
          </Field>
        </>
      );
    }

    if (table === "clients") {
      return (
        <>
          <Field label="Name *">
            <input className="input" autoFocus value={form.name}
                   onChange={e => set("name", e.target.value)}/>
          </Field>
          <Field label="District / State">
            <input className="input" value={form.district}
                   onChange={e => set("district", e.target.value)}
                   placeholder="e.g. MVN-New Orleans District"/>
          </Field>
          <Field label="Org Type">
            <select className="select" value={form.org_type}
                    onChange={e => set("org_type", e.target.value)}>
              <option value="">—</option>
              <option value="City">City</option>
              <option value="State">State</option>
              <option value="Federal">Federal</option>
              <option value="Local">Local</option>
              <option value="Parish">Parish</option>
              <option value="Regional">Regional</option>
              <option value="Other">Other</option>
            </select>
          </Field>
          <Field label="Contact Person">
            <input className="input" value={form.contact_person}
                   onChange={e => set("contact_person", e.target.value)}/>
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email}
                   onChange={e => set("email", e.target.value)}/>
          </Field>
          <Field label="Phone">
            <input className="input" type="tel" value={form.phone}
                   onChange={e => set("phone", e.target.value)}/>
          </Field>
          <Field label="Address">
            <input className="input" value={form.address}
                   onChange={e => set("address", e.target.value)}/>
          </Field>
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
          </Field>
        </>
      );
    }

    if (table === "companies") {
      return (
        <>
          <Field label="Name *">
            <input className="input" autoFocus value={form.name}
                   onChange={e => set("name", e.target.value)}/>
          </Field>
          <Field label="Contact Person">
            <input className="input" value={form.contact_person}
                   onChange={e => set("contact_person", e.target.value)}/>
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email}
                   onChange={e => set("email", e.target.value)}/>
          </Field>
          <Field label="Phone">
            <input className="input" type="tel" value={form.phone}
                   onChange={e => set("phone", e.target.value)}/>
          </Field>
          <Field label="Address">
            <input className="input" value={form.address}
                   onChange={e => set("address", e.target.value)}/>
          </Field>
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
          </Field>
        </>
      );
    }

    if (table === "invoice") {
      return (
        <>
          <Field label="Project Name *">
            <input className="input" autoFocus value={form.project_name}
                   onChange={e => set("project_name", e.target.value)}/>
          </Field>
          <Field label="Year *">
            <input className="input" type="number" value={form.year}
                   onChange={e => set("year", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Project #">
            <input className="input" value={form.project_number}
                   onChange={e => set("project_number", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}
                   placeholder="e.g. 24-101"/>
          </Field>
          <Field label="Type">
            <div className="seg" style={{ maxWidth: 220 }}>
              <button type="button"
                      className={"seg-btn" + (form.type === "ENG" ? " active" : "")}
                      onClick={() => set("type", "ENG")}>
                ENG
              </button>
              <button type="button"
                      className={"seg-btn" + (form.type === "PM" ? " active" : "")}
                      onClick={() => set("type", "PM")}>
                PM
              </button>
            </div>
          </Field>
          <Field label="Contract Amount">
            <input className="input" type="number" value={form.contract_amount}
                   onChange={e => set("contract_amount", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}
                   placeholder="0"/>
          </Field>
          <Field label="MSMM Remaining (year start)">
            <input className="input" type="number"
                   value={form.msmm_remaining_to_bill_year_start}
                   onChange={e => set("msmm_remaining_to_bill_year_start", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}
                   placeholder="0"/>
          </Field>
          <Field label="PMs">
            <UserMultiPicker
              value={form.pm_user_ids}
              users={users}
              onChange={(ids) => set("pm_user_ids", ids)}
              placeholder="Pick PMs…"/>
          </Field>
        </>
      );
    }

    return null;
  };

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal" style={{ width: 560, maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name={titleCfg.icon} size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>Create</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>{titleCfg.title}</h3>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body" style={{ overflowY: "auto", flex: 1 }}>
          {renderFields()}
          {error && (
            <div style={{ color: "var(--rose)", fontSize: 12, marginTop: 10 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)" }}>* required</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn primary sm"
                    onClick={onSubmit}
                    disabled={!requiredOk || pending}>
              <Icon name="check" size={13}/>
              {pending ? "Saving…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

// Small helper to keep the field markup tight.
const Field = ({ label, multiline, children }) => (
  <div className="field">
    <div className="field-label">{label}</div>
    <div className={"field-value" + (multiline ? " multiline" : "")}>{children}</div>
  </div>
);
