import React, { useState, useEffect, useRef } from "react";
import { Icon } from "./icons.jsx";
import { supabase, THIS_YEAR, MONTHS, fmtMoney } from "./data.js";

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

const DB_TABLES = {
  potential: "potential_projects",
  awaiting:  "awaiting_verdict",
  soq:       "soq",
  events:    "events",
  clients:   "clients",
  companies: "companies",
};

const TITLES = {
  potential: { title: "New potential project",  icon: "briefcase" },
  awaiting:  { title: "New awaiting verdict",   icon: "clock"     },
  soq:       { title: "New SOQ",                 icon: "briefcase" },
  events:    { title: "New event",               icon: "calendar"  },
  clients:   { title: "New client",              icon: "users"     },
  companies: { title: "New company",             icon: "briefcase" },
};

// Columns that the DB accepts directly. Anything NOT in this list is
// treated as an "extra" (PM / subs / attendees) and inserted via a second
// write against the child/join table.
const DB_COLUMNS = {
  potential_projects: [
    "project_name", "year", "role", "client_id",
    "total_contract_amount", "msmm_amount", "probability",
    "notes", "next_action_note", "next_action_date", "project_number",
    "anticipated_invoice_start_month",
  ],
  awaiting_verdict: [
    "project_name", "year", "client_id",
    "date_submitted", "anticipated_result_date",
    "client_contract_number", "msmm_contract_number",
    "msmm_used", "msmm_remaining",
    "notes", "project_number",
  ],
  soq: [
    "project_name", "year", "client_id",
    "project_number", "pool", "details", "notes",
    "date_submitted", "start_date", "contract_expiry_date",
    "recurring", "msmm_used", "msmm_remaining",
    "client_contract_number", "msmm_contract_number",
  ],
  events: [
    "title", "status", "type", "event_date", "event_datetime", "notes",
  ],
  clients: [
    "name", "district", "org_type",
    "contact_person", "email", "phone", "address", "notes",
  ],
  companies: [
    "name", "contact_person", "email", "phone", "address", "notes",
  ],
};

const NUMERIC_COLS = new Set([
  "year", "total_contract_amount", "msmm_amount", "anticipated_invoice_start_month",
  "msmm_used", "msmm_remaining",
]);

const INITIAL = {
  soq: {
    project_name: "",
    year: THIS_YEAR,
    client_id: "",
    project_number: "",
    pool: "",
    details: "",
    notes: "",
    date_submitted: "",
    start_date: "",
    contract_expiry_date: "",
    recurring: "",
    msmm_used: "",
    msmm_remaining: "",
    client_contract_number: "",
    msmm_contract_number: "",
    pm_user_ids: [],
    subs: [],
  },
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
    event_date: "",
    event_datetime: "",
    attendees: [],
    notes: "",
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
};

const REQUIRED = {
  potential: ["project_name"],
  awaiting:  ["project_name"],
  soq:       ["project_name"],
  events:    ["title"],
  clients:   ["name"],
  companies: ["name"],
};

// --------------------- shared sub-editor ---------------------
// Same pattern the DetailDrawer uses. Companies dropdown excludes Client-type.
function SubsEditor({ value, companies, onChange }) {
  const subs = value || [];
  const subCompanies = (companies || []).filter(c => c.type !== "Client");
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
          <select className="input" value={s.cId || ""}
                  onChange={e => update(i, { cId: e.target.value || null })}
                  style={{ minWidth: 0 }}>
            <option value="">— Company —</option>
            {subCompanies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
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
export const CreateModal = ({ table, clients, companies, users, onClose, onCreated }) => {
  const dbTable = DB_TABLES[table];
  const titleCfg = TITLES[table];
  const required = REQUIRED[table] || [];

  const [form, setForm] = useState(() => ({ ...(INITIAL[table] || {}) }));
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
    const cols = DB_COLUMNS[dbTable] || [];
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
            .from("potential_project_pms")
            .insert(pmIds.map(uid => ({ potential_project_id: row.id, user_id: uid })));
          if (e1) throw e1;
          extras.pmIds = pmIds;
        }
        const subs = (form.subs || []).filter(s => s.cId || s.desc || s.amt);
        if (subs.length > 0) {
          const subsPayload = subs.map((s, i) => ({
            potential_project_id: row.id,
            ord: i + 1,
            company_id: s.cId || null,
            discipline: s.desc || null,
            amount: s.amt != null && s.amt !== "" ? Number(s.amt) : null,
          }));
          const { error: e2 } = await supabase
            .from("potential_project_subs").insert(subsPayload);
          if (e2) throw e2;
          extras.subs = subs;
        }
        // Orange → auto-create a linked anticipated_invoice row so the
        // pre-awarded project shows up on the Invoice tab immediately.
        // anticipated_invoice is intentionally minimal — only the columns
        // listed below exist on it. Don't send role/client_id/msmm_amount/
        // notes here; they live on the potential row and are looked up via
        // source_potential_id when needed.
        if (form.probability === "Orange") {
          const invPayload = {
            source_potential_id: row.id,
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
      } else if (table === "soq") {
        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: eSP } = await supabase
            .from("soq_pms")
            .insert(pmIds.map(uid => ({ soq_id: row.id, user_id: uid })));
          if (eSP) throw eSP;
          extras.pmIds = pmIds;
        }
        const subs = (form.subs || []).filter(s => s.cId);
        if (subs.length > 0) {
          const { error: eSS } = await supabase
            .from("soq_subs")
            .insert(subs.map(s => ({ soq_id: row.id, company_id: s.cId })));
          if (eSS) throw eSS;
          extras.subs = subs;
        }
      } else if (table === "awaiting") {
        // Direct entry into Awaiting Verdict: insert PM join rows + sub rows
        // against the awaiting_verdict_pms / _subs tables, same pattern as
        // potential.
        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: eAP } = await supabase
            .from("awaiting_verdict_pms")
            .insert(pmIds.map(uid => ({ awaiting_verdict_id: row.id, user_id: uid })));
          if (eAP) throw eAP;
          extras.pmIds = pmIds;
        }
        const subs = (form.subs || []).filter(s => s.cId);
        if (subs.length > 0) {
          const { error: eAS } = await supabase
            .from("awaiting_verdict_subs")
            .insert(subs.map(s => ({ awaiting_verdict_id: row.id, company_id: s.cId })));
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
            <select className="select" value={form.client_id}
                    onChange={e => set("client_id", e.target.value)}>
              <option value="">—</option>
              {(clients || []).map(c => (
                <option key={c.id} value={c.id}>
                  {c.district ? `${c.name} — ${c.district}` : c.name}
                </option>
              ))}
            </select>
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
            <select className="select" value={form.client_id}
                    onChange={e => set("client_id", e.target.value)}>
              <option value="">—</option>
              {(clients || []).map(c => (
                <option key={c.id} value={c.id}>
                  {c.district ? `${c.name} — ${c.district}` : c.name}
                </option>
              ))}
            </select>
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

    if (table === "soq") {
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
            <select className="select" value={form.client_id}
                    onChange={e => set("client_id", e.target.value)}>
              <option value="">—</option>
              {(clients || []).map(c => (
                <option key={c.id} value={c.id}>
                  {c.district ? `${c.name} — ${c.district}` : c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start Date">
            <input className="input" type="date" value={form.start_date}
                   onChange={e => set("start_date", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Expiration Date">
            <input className="input" type="date" value={form.contract_expiry_date}
                   onChange={e => set("contract_expiry_date", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Recurring">
            <select className="select" value={form.recurring}
                    onChange={e => set("recurring", e.target.value)}>
              <option value="">—</option>
              <option value="Yes">Yes</option>
              <option value="In Talks">In Talks</option>
              <option value="Maybe">Maybe</option>
              <option value="No">No</option>
            </select>
          </Field>
          <Field label="PMs" multiline>
            <UserMultiPicker value={form.pm_user_ids} users={users}
                             onChange={next => set("pm_user_ids", next)}
                             placeholder="Pick MSMM users…"/>
          </Field>
          <Field label="Subs" multiline>
            <SubsEditor value={form.subs} companies={companies}
                        onChange={next => set("subs", next)}/>
          </Field>
          <Field label="Pool">
            <input className="input" value={form.pool}
                   onChange={e => set("pool", e.target.value)}
                   placeholder="e.g. IDIQ Pool C"/>
          </Field>
          <Field label="Details" multiline>
            <textarea className="textarea" value={form.details}
                      onChange={e => set("details", e.target.value)}/>
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
          <Field label="Date Submitted">
            <input className="input" type="date" value={form.date_submitted}
                   onChange={e => set("date_submitted", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
          </Field>
          <Field label="Client Contract #">
            <input className="input" value={form.client_contract_number}
                   onChange={e => set("client_contract_number", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
          <Field label="MSMM Contract #">
            <input className="input" value={form.msmm_contract_number}
                   onChange={e => set("msmm_contract_number", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
          <Field label="Project Number">
            <input className="input" value={form.project_number}
                   onChange={e => set("project_number", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
          </Field>
          <Field label="Notes" multiline>
            <textarea className="textarea" value={form.notes}
                      onChange={e => set("notes", e.target.value)}/>
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
          <Field label="Event Date">
            <input className="input" type="date" value={form.event_date}
                   onChange={e => set("event_date", e.target.value)}
                   style={{ fontFamily: "var(--font-mono)" }}/>
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
