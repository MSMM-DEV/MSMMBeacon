import React, { useState, useEffect, useMemo, useRef, useId } from "react";
import { Icon } from "./icons.jsx";
import { supabase, THIS_YEAR, MONTHS, fmtMoney, BID_SERVICE_OPTIONS, uploadOpenBidPdf, dedupeSubsByCompanyKind,
  createProjectItem, addProjectItemSub, validateProjectItemContract,
  CONTRACT_TYPE_OPTIONS, PROJECT_ITEM_TYPE_OPTIONS, PROJECT_ITEM_STATUS_OPTIONS } from "./data.js";
import { SearchableSelect, StarRating } from "./primitives.jsx";
import { HOT_LEAD_STAR_MAX } from "./star-rating.js";
import { INVOICE_TYPE_OPTIONS } from "./invoice-perspectives.js";
import { cn } from "@/lib/utils";
import {
  Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Field, Input, InputGroup, RadioGroup, RadioGroupItem,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, inputBase,
} from "@/ui";

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
//
// Presentation (ui-v2.0): the shell is the shared Radix `Dialog` from @/ui —
// a bottom sheet on phones, a centred dialog from `sm` up, with a pinned
// header/footer and a single scrolling body. Fields are grouped into titled
// sections laid out two-up from `md`. None of that touches the data path:
// every field name, default, coercion and write below is unchanged.

// In v2, Potential, Awaiting, and Awarded all INSERT into the same
// `projects` table — they differ only in the `status` column (set in
// onSubmit). Hot Leads is the renamed `leads` table.
const DB_TABLES = {
  potential: "projects",
  awaiting:  "projects",
  awarded:   "projects",
  events:    "events",
  hotleads:  "leads",
  clients:   "clients",
  companies: "companies",
  invoice:   "anticipated_invoice",
  openbids:  "open_bids",
  // Projects (tree work breakdown). The whole insert is custom (text PK +
  // routed client + subs/PMs) — handled at the top of onSubmit, not via the
  // generic buildPayload/insert path — but DB_TABLES must be non-empty so the
  // modal renders (the `if (!dbTable) return null` guard).
  projects:  "project_items",
};

const TITLES = {
  potential: { title: "New potential project",  icon: "briefcase" },
  awaiting:  { title: "New proposal",           icon: "clock"     },
  awarded:   { title: "New awarded project",    icon: "check"     },
  events:    { title: "New event",               icon: "calendar"  },
  hotleads:  { title: "New hot lead",            icon: "trend"     },
  clients:   { title: "New client",              icon: "users"     },
  companies: { title: "New company",             icon: "briefcase" },
  invoice:   { title: "New invoice row",         icon: "trend"     },
  openbids:  { title: "New open bid",            icon: "flag"      },
  projects:  { title: "New project",             icon: "briefcase" },
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
  // Direct-create awarded — backfills historical rows or projects that
  // skipped the proposal stage. stage_id is resolved from `stage` (a name
  // string in the form) at insert time via a lookup against awarded_stages.
  awarded: [
    "project_name", "year", "client_id",
    "date_submitted", "client_contract_number", "msmm_contract_number",
    "msmm_used", "msmm_remaining",
    "details", "pool", "contract_expiry_date",
    "notes", "project_number",
  ],
  events: [
    "title", "status", "type", "event_datetime", "notes", "stars",
  ],
  hotleads: [
    "title", "type", "client_id", "date_time", "anticipated_amount", "notes", "stars",
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
    // msmm_amount is omitted here; linked HZ pair creation materializes it and
    // users edit it from the expanded MSMM sub row.
    "contract_amount", "msmm_remaining_to_bill_year_start",
  ],
  // beacon_v2.open_bids — pre-Awaiting tracker. PDF upload is NOT a DB column;
  // it's a storage write that happens after the row insert, see onSubmit.
  // Approval columns are NOT in the create form — every new bid starts as
  // approval_status='pending' (the DB default) and an admin promotes it later.
  openbids: [
    "rfq_rfp_number", "client_id", "service_description",
    "due_at", "web_link", "anticipated_amount", "notes",
  ],
};

const NUMERIC_COLS = new Set([
  "year", "total_contract_amount", "msmm_amount", "anticipated_invoice_start_month",
  "msmm_used", "msmm_remaining",
  "contract_amount", "msmm_remaining_to_bill_year_start",
  "stars", "anticipated_amount",
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
  awarded: {
    project_name: "",
    year: THIS_YEAR,
    role: "Prime",
    client_id: "",
    prime_id: "",         // companies/clients merged-pool pick — routed at insert
    stage: "",            // resolved → stage_id at insert via awarded_stages lookup
    pool: "",
    contract_expiry_date: "",
    details: "",
    date_submitted: "",
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
    stars: "",
  },
  hotleads: {
    title: "",
    type: "",
    client_id: "",
    date_time: "",
    anticipated_amount: "",
    notes: "",
    attendees: [],
    stars: "",
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
  openbids: {
    rfq_rfp_number: "",
    client_id: "",
    service_description: "",
    due_at: "",
    web_link: "",
    anticipated_amount: "",
    notes: "",
    _pdf_file: null,        // staged File object; uploaded after row insert
  },
  // Projects (tree item). Keys are the form-local names; the projects submit
  // branch maps them to the createProjectItem payload (camelCase). parent_id
  // holds the PARENT'S uuid (seeded when "Add child").
  projects: {
    local_id: "",             // scoped ID (root = global, phase = within project)
    name: "",
    parent_id: "",            // parent uuid — seeded when "Add child"
    client_id: "",            // merged Client/Prime pick — routed at insert
    item_type: "standard",
    address_line1: "",
    address_line2: "",
    city: "",
    state: "",
    pin_code: "",
    contract_type: "",
    contract_amount: "",
    start_date: "",
    due_date: "",
    percent_complete: "",
    manager_user_id: "",
    status: "active",
    notes: "",
    pm_user_ids: [],
    subs: [],
  },
};

const REQUIRED = {
  potential: ["project_name"],
  awaiting:  ["project_name"],
  awarded:   ["project_name"],
  events:    ["title"],
  hotleads:  ["title"],
  clients:   ["name"],
  companies: ["name"],
  invoice:   ["project_name", "year"],
  openbids:  ["rfq_rfp_number"],
  projects:  ["local_id", "name"],
};

// Human names for the required fields, used only by the submit-time
// summary. Purely presentational — REQUIRED above is still the rule.
const REQUIRED_LABELS = {
  project_name:   "Project name",
  title:          "Title",
  name:           "Name",
  year:           "Year",
  local_id:       "Project ID",
  rfq_rfp_number: "RFQ/RFP number",
};

// Radix Select refuses an empty-string item value, but several of these
// fields legitimately store "" for "not set". This sentinel stands in for
// that row in the listbox and is mapped straight back to "" on pick, so the
// form state and the insert payload are byte-identical to the old <select>.
const NO_VALUE = "__none__";

// The @/ui input styling, reused for controls the kit does not own
// (the SearchableSelect combobox renders its own <input>).
const CONTROL_CLASS = cn(inputBase, "h-[var(--control-h)]");

// --------------------- field scaffolding ---------------------
// Wraps the kit `Field` with the id / aria-describedby / aria-invalid wiring
// every control in this modal needs.
//
//   default    control owns `id`; the label points at it with htmlFor.
//   group      control is a composite (combobox, star rating, sub editor);
//              it is wrapped in a labelled role="group" instead.
//   labelledBy control names itself from the label (RadioGroup).
//
// The render prop receives two arguments:
//   (a) DOM-safe props to spread straight onto a control, and
//   (b) the same information unpacked, for composites that need it by name.
function FormRow({ id, label, required, hint, error, wide, group, labelledBy, children }) {
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const hintId  = `${id}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  const domProps = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  };
  const meta = { id, labelId, describedBy, invalid: !!error };

  const control = typeof children === "function"
    ? children(domProps, meta)
    : children;

  return (
    <Field
      className={cn("cm-field", wide && "cm-wide")}
      label={<span id={labelId}>{label}</span>}
      htmlFor={group || labelledBy ? undefined : id}
      required={required}
      error={error ? <span id={errorId}>{error}</span> : null}
      hint={hint ? <span id={hintId}>{hint}</span> : null}
    >
      {group ? (
        <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} className="min-w-0">
          {control}
        </div>
      ) : control}
    </Field>
  );
}

function Section({ title, children }) {
  return (
    <section className="cm-section">
      {/* DialogTitle is the h2; sections are the next level down. */}
      <h3 className="cm-section-title">{title}</h3>
      <div className="cm-grid">{children}</div>
    </section>
  );
}

/** Currency field: leading $, right-aligned tabular figures, decimal keypad. */
function MoneyInput({ className, ...props }) {
  return (
    <InputGroup
      type="number"
      inputMode="decimal"
      leading={<span className="text-[length:var(--fs-sm)] font-medium">$</span>}
      className={className}
      inputClassName="num text-right"
      {...props}
    />
  );
}

/**
 * Radix Select bound to a plain string form value.
 *
 * `emptyLabel` adds the "not set" row; picking it writes "" back to the form,
 * which is exactly what the old `<option value="">` did.
 */
function FormSelect({ id, labelId, describedBy, invalid, value, onValueChange, options, emptyLabel, placeholder }) {
  const empty = value === "" || value == null;
  return (
    <Select
      value={empty ? (emptyLabel ? NO_VALUE : undefined) : String(value)}
      onValueChange={(v) => onValueChange(v === NO_VALUE ? "" : v)}
    >
      <SelectTrigger
        id={id}
        aria-labelledby={labelId ? `${labelId} ${id}` : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel ? <SelectItem value={NO_VALUE}>{emptyLabel}</SelectItem> : null}
        {options.map(o => (
          <SelectItem key={String(o.value)} value={String(o.value)}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Segmented single-choice row. Values are written through untouched. */
function FormRadios({ labelId, describedBy, value, onValueChange, options }) {
  const base = labelId || "radios";
  return (
    <RadioGroup
      className="flex flex-wrap items-center gap-4 min-h-[var(--control-h)] cm-radios"
      value={value}
      onValueChange={onValueChange}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
    >
      {options.map(o => {
        const itemId = `${base}-${String(o.value).replace(/\W+/g, "_")}`;
        return (
          <div key={String(o.value)} className="cm-radio">
            <RadioGroupItem value={String(o.value)} id={itemId} />
            <label htmlFor={itemId}>{o.label}</label>
          </div>
        );
      })}
    </RadioGroup>
  );
}

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
    <div className="cm-subs">
      {subs.length === 0 && (
        <p className="cm-empty">No subs yet. Add one below.</p>
      )}
      {subs.map((s, i) => (
        <div key={i} className="cm-subrow">
          <SearchableSelect
            value={s.cId || ""}
            options={subOptions}
            placeholder="Search companies…"
            inputClassName={CONTROL_CLASS}
            onChange={v => update(i, { cId: v || null })}
          />
          <Input placeholder="Discipline (e.g. Survey)"
                 aria-label={`Sub ${i + 1} discipline`}
                 value={s.desc || ""}
                 onChange={e => update(i, { desc: e.target.value })}/>
          <Input type="number" inputMode="decimal" placeholder="$" min="0"
                 aria-label={`Sub ${i + 1} amount`}
                 className="num text-right"
                 value={s.amt ?? ""}
                 onChange={e => update(i, { amt: e.target.value === "" ? 0 : Number(e.target.value) })}/>
          <Button type="button" variant="ghost" size="icon-sm"
                  className="cm-subrm"
                  aria-label={`Remove sub ${i + 1}`}
                  onClick={() => remove(i)}>
            <Icon name="trash" size={13}/>
          </Button>
        </div>
      ))}
      <div className="cm-subfoot">
        <Button type="button" variant="subtle" size="xs" onClick={add}>
          <Icon name="plus" size={12}/>Add sub
        </Button>
        {subs.length > 0 && (
          <span className="cm-subtotal num">
            Total: {fmtMoney(subs.reduce((a, s) => a + (Number(s.amt) || 0), 0))}
          </span>
        )}
      </div>
    </div>
  );
}

// --------------------- multi-user picker ---------------------
function UserMultiPicker({ value, users, onChange, placeholder = "Pick users…", id, describedBy }) {
  const ids = value || [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const pool = users || [];
  const available = pool.filter(u => !ids.includes(u.id) && (!q || u.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="cm-tagbox" onClick={() => setOpen(true)}>
      {ids.map(uid => {
        const u = pool.find(x => x.id === uid);
        if (!u) return null;
        return (
          <span key={uid} className="cm-tag">
            <span className={`avatar xs ${u.color}`}>{u.initials}</span>
            <span className="cm-tag-name">{u.name}</span>
            <button type="button" aria-label={`Remove ${u.name}`} onClick={(e) => {
              e.stopPropagation();
              onChange(ids.filter(x => x !== uid));
            }}>
              <Icon name="x" size={10}/>
            </button>
          </span>
        );
      })}
      <input id={id}
             aria-describedby={describedBy}
             placeholder={ids.length ? "Add another…" : placeholder}
             value={q}
             onChange={e => { setQ(e.target.value); setOpen(true); }}
             onFocus={() => setOpen(true)}
             onBlur={() => setTimeout(() => setOpen(false), 150)}/>
      {open && available.length > 0 && (
        <div className="cm-usermenu">
          {available.slice(0, 6).map(u => (
            <button key={u.id} type="button"
                    onMouseDown={() => { onChange([...ids, u.id]); setQ(""); }}>
              <span className={`avatar xs ${u.color}`}>{u.initials}</span>
              <span className="cm-tag-name">{u.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------- main component ---------------------
export const CreateModal = ({ table, seed = null, clients, companies, users, projectItems = [], onClose, onCreated }) => {
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
  // Presentation-only: which fields the user has left, and whether a submit
  // has been attempted. Neither participates in the submit rule below.
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const uid = useId();
  const summaryRef = useRef(null);

  useEffect(() => {
    if (error) summaryRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  if (!dbTable || !titleCfg) return null;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isEmpty = (v) => v === undefined || v === null || v === "";
  const requiredOk = required.every(k => !isEmpty(form[k]));

  const fid = (k) => `${uid}-${k}`;
  const touch = (k) => setTouched(t => (t[k] ? t : { ...t, [k]: true }));
  // A required field is flagged only once the user has left it (or tried to
  // submit). The rule itself is unchanged: REQUIRED[table] must be non-empty.
  const missing = (k) => required.includes(k) && isEmpty(form[k])
    && (submitted || touched[k]) ? "Required." : undefined;
  // Bind a plain text/number/date control to a form key.
  const bind = (k) => ({
    value: form[k],
    onChange: (e) => set(k, e.target.value),
    onBlur: () => touch(k),
  });

  const idLabel = form.parent_id ? "Phase / Subphase ID" : "Project ID";
  const requiredLabel = (k) => (
    table === "projects" && k === "local_id" ? idLabel
      : table === "projects" && k === "name" ? "Project name"
      : REQUIRED_LABELS[k] || k
  );
  const missingRequired = required.filter(k => isEmpty(form[k]));

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
    setSubmitted(true);
    if (!requiredOk || pending) return;
    setError("");
    setPending(true);

    // Projects (tree item) — fully custom path. createProjectItem handles the
    // text PK, the merged Client/Prime routing, and the roll-up validation
    // trigger; subs + additional PMs are written after. dbRow returned to
    // handleCreated is ALREADY the adapted UI row.
    if (table === "projects") {
      try {
        // Client-side roll-up check for instant feedback (the DB trigger is
        // the backstop). itemId is undefined (new row) so the floor check is a
        // no-op; the cap check runs against the chosen parent.
        const v = validateProjectItemContract(projectItems, {
          itemId: undefined,
          parentId: form.parent_id || null,
          amount: form.contract_amount,
        });
        if (!v.ok) { setError(v.message); setPending(false); return; }

        const adapted = await createProjectItem({
          localId:         form.local_id,
          name:            form.name,
          parentId:        form.parent_id || null,
          clientId:        form.client_id || "",
          itemType:        form.item_type || "standard",
          addressLine1:    form.address_line1,
          addressLine2:    form.address_line2,
          city:            form.city,
          state:           form.state,
          pinCode:         form.pin_code,
          contractType:    form.contract_type || "",
          contractAmount:  form.contract_amount === "" ? null : form.contract_amount,
          startDate:       form.start_date || "",
          dueDate:         form.due_date || "",
          percentComplete: form.percent_complete === "" ? null : form.percent_complete,
          managerId:       form.manager_user_id || null,
          status:          form.status || "active",
          notes:           form.notes,
        });

        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: ePm } = await supabase.from("project_item_pms")
            .insert(pmIds.map(uid => ({ item_id: adapted.id, user_id: uid })));
          if (ePm) throw ePm;
          adapted.pmIds = pmIds;
        }

        const subs = (form.subs || []).filter(s => s.cId);
        const savedSubs = [];
        for (const [i, s] of subs.entries()) {
          await addProjectItemSub({
            itemId: adapted.id, companyId: s.cId,
            discipline: s.desc, amount: s.amt, ord: i + 1,
          });
          savedSubs.push({ cId: s.cId, desc: s.desc || "", amt: Number(s.amt) || 0 });
        }
        adapted.subs = savedSubs;

        onCreated(adapted, { _projectItem: true });
        onClose();
      } catch (e) {
        setError(e.message || String(e));
        setPending(false);
      }
      return;
    }

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
    if (table === "awarded") {
      payload.status = "awarded";
      // Awarded carries a `role` column independent of prime_company_id /
      // prime_client_id since the v1→v2 migration relaxed that constraint.
      if (form.role) payload.role = form.role;
      // Prime field is merged-pool: clients table OR companies table. The
      // form field `prime_id` carries either UUID; route to the right
      // column based on which pool it belongs to. (Mirrors routePrimePick
      // in data.js — duplicated inline because forms.jsx imports the
      // bare clients/companies arrays already.)
      if (form.prime_id) {
        if (clientIdSet.has(form.prime_id)) payload.prime_client_id = form.prime_id;
        else                                payload.prime_company_id = form.prime_id;
      }
      // Stage is a name in the form; the DB stores stage_id. Look it up
      // against awarded_stages — fail-soft (skip) if no match so the row
      // still inserts and the user can fix via the drawer.
      if (form.stage) {
        const { data: stageRow } = await supabase
          .from("awarded_stages").select("id").eq("name", form.stage).maybeSingle();
        if (stageRow?.id) payload.stage_id = stageRow.id;
      }
    }
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
        const subs = dedupeSubsByCompanyKind(
          (form.subs || []).filter(s => s.cId || s.desc || s.amt));
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
            // Total Contract Value = potential.total_contract_amount.
            // MSMM Portion is never stored — the Invoice tab always shows the
            // derived value (= total − Σ subs).
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
        const subs = dedupeSubsByCompanyKind((form.subs || []).filter(s => s.cId));
        if (subs.length > 0) {
          const { error: eAS } = await supabase
            .from("project_subs")
            .insert(subs.map(s => ({ project_id: row.id, company_id: s.cId })));
          if (eAS) throw eAS;
          extras.subs = subs;
        }
      } else if (table === "awarded") {
        // Direct entry into Awarded: same project_pms/project_subs joins as
        // any other status. Subs carry their `amount` (per-sub contract)
        // for downstream Invoice expand-row math.
        if (form.stage) extras.stageName = form.stage;
        const pmIds = (form.pm_user_ids || []).filter(Boolean);
        if (pmIds.length > 0) {
          const { error: eAwP } = await supabase
            .from("project_pms")
            .insert(pmIds.map(uid => ({ project_id: row.id, user_id: uid })));
          if (eAwP) throw eAwP;
          extras.pmIds = pmIds;
        }
        const subs = dedupeSubsByCompanyKind(
          (form.subs || []).filter(s => s.cId || s.desc || s.amt));
        if (subs.length > 0) {
          const subsPayload = subs.map((s, i) => ({
            project_id: row.id,
            ord: i + 1,
            company_id: s.cId || null,
            discipline: s.desc || null,
            amount: s.amt != null && s.amt !== "" ? Number(s.amt) : null,
          }));
          const { error: eAwS } = await supabase
            .from("project_subs").insert(subsPayload);
          if (eAwS) throw eAwS;
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
      } else if (table === "openbids") {
        // PDF upload is a separate write to storage + an update on the bid
        // row. The bid row already exists, so a failed PDF upload only
        // surfaces a partial-save warning; the row still appears in the UI.
        const stagedFile = form._pdf_file;
        if (stagedFile) {
          const updated = await uploadOpenBidPdf({ bidId: row.id, file: stagedFile });
          // Mirror the fresh pdf_* columns back onto the inserted dbRow
          // so adaptInsertedRow picks them up.
          row.pdf_file_path = updated.pdfPath;
          row.pdf_file_name = updated.pdfName;
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

  // ---- reusable field fragments -------------------------------------
  const notesRow = (key = "notes", label = "Notes", placeholder) => (
    <FormRow id={fid(key)} label={label} wide>
      {(p) => <Textarea {...p} rows={3} placeholder={placeholder} {...bind(key)}/>}
    </FormRow>
  );

  const subsRow = () => (
    <FormRow id={fid("subs")} label="Subs" wide group>
      <SubsEditor value={form.subs} companies={companies}
                  onChange={next => set("subs", next)}/>
    </FormRow>
  );

  const peopleRow = (key, label, placeholder = "Pick MSMM users…") => (
    <FormRow id={fid(key)} label={label} wide>
      {(p, m) => (
        <UserMultiPicker value={form[key]} users={users}
                         id={m.id} describedBy={m.describedBy}
                         onChange={next => set(key, next)}
                         placeholder={placeholder}/>
      )}
    </FormRow>
  );

  const clientRow = (label, options, placeholder) => (
    <FormRow id={fid("client_id")} label={label} group>
      <SearchableSelect
        value={form.client_id || ""}
        options={options}
        placeholder={placeholder}
        inputClassName={CONTROL_CLASS}
        onChange={v => set("client_id", v || "")}
      />
    </FormRow>
  );

  const yearRow = (isRequired = false) => (
    <FormRow id={fid("year")} label="Year" required={isRequired} error={missing("year")}>
      {(p) => <Input {...p} type="number" inputMode="numeric" className="num" {...bind("year")}/>}
    </FormRow>
  );

  const projectNumberRow = (label = "Project number", placeholder) => (
    <FormRow id={fid("project_number")} label={label}>
      {(p) => (
        <Input {...p} className="font-mono num" placeholder={placeholder}
               {...bind("project_number")}/>
      )}
    </FormRow>
  );

  const contractNumberRows = () => (
    <>
      <FormRow id={fid("client_contract_number")} label="Client contract #">
        {(p) => (
          <Input {...p} className="font-mono num" placeholder="e.g. POSL-2026-045"
                 {...bind("client_contract_number")}/>
        )}
      </FormRow>
      <FormRow id={fid("msmm_contract_number")} label="MSMM contract #">
        {(p) => (
          <Input {...p} className="font-mono num" placeholder="e.g. MSMM-2026-045"
                 {...bind("msmm_contract_number")}/>
        )}
      </FormRow>
    </>
  );

  const msmmUsageRows = () => (
    <>
      <FormRow id={fid("msmm_used")} label="MSMM used">
        {(p) => <MoneyInput {...p} placeholder="0" {...bind("msmm_used")}/>}
      </FormRow>
      <FormRow id={fid("msmm_remaining")} label="MSMM remaining">
        {(p) => <MoneyInput {...p} placeholder="0" {...bind("msmm_remaining")}/>}
      </FormRow>
    </>
  );

  const dateRow = (key, label, hint) => (
    <FormRow id={fid(key)} label={label} hint={hint}>
      {(p) => <Input {...p} type="date" className="num" {...bind(key)}/>}
    </FormRow>
  );

  const renderFields = () => {
    if (table === "projects") {
      const parentOptions = (projectItems || [])
        .map(it => ({ value: it.id, label: `${it.localId} · ${it.name}` }));
      const userOptions = (users || []).map(u => ({ value: u.id, label: u.name }));
      const parentItem = (projectItems || []).find(it => it.id === form.parent_id);
      return (
        <>
          <Section title="Identification">
            <FormRow id={fid("local_id")} label={idLabel} required
                     error={missing("local_id")}
                     hint={form.parent_id
                       ? "Unique within its parent only. Another project can reuse the same phase ID."
                       : "Unique across all projects."}>
              {(p) => (
                <Input {...p} autoFocus className="font-mono num"
                       placeholder={form.parent_id ? "e.g. 1, 2, 2.1, 0" : "e.g. 202311"}
                       {...bind("local_id")}/>
              )}
            </FormRow>
            <FormRow id={fid("name")} label="Project name" required error={missing("name")}>
              {(p) => <Input {...p} {...bind("name")}/>}
            </FormRow>
            <FormRow id={fid("parent_id")} label="Parent project" wide group
                     hint={parentItem && parentItem.contractAmount != null
                       ? `Parent contract: ${fmtMoney(parentItem.contractAmount, false)}. Children cannot exceed this in total.`
                       : undefined}>
              <SearchableSelect
                value={form.parent_id || ""}
                options={parentOptions}
                placeholder="No parent (top-level project)"
                inputClassName={CONTROL_CLASS}
                onChange={v => set("parent_id", v || "")}
              />
            </FormRow>
            <FormRow id={fid("item_type")} label="Type"
                     hint={form.item_type === "main"
                       ? "Main: a container. Time and expenses cannot be logged against it."
                       : "Standard: an active work item. Time and expenses can be logged here."}>
              {(p, m) => (
                <FormSelect {...m} value={form.item_type} options={PROJECT_ITEM_TYPE_OPTIONS}
                            onValueChange={v => set("item_type", v)}/>
              )}
            </FormRow>
            <FormRow id={fid("status")} label="Status">
              {(p, m) => (
                <FormSelect {...m} value={form.status} options={PROJECT_ITEM_STATUS_OPTIONS}
                            onValueChange={v => set("status", v)}/>
              )}
            </FormRow>
          </Section>

          <Section title="Client and team">
            <FormRow id={fid("client_id")} label="Client / Prime" group>
              <SearchableSelect
                value={form.client_id || ""}
                options={clientOrFirmOptions}
                placeholder="Search clients or firms…"
                inputClassName={CONTROL_CLASS}
                onChange={v => set("client_id", v || "")}
              />
            </FormRow>
            <FormRow id={fid("manager_user_id")} label="Manager" group>
              <SearchableSelect
                value={form.manager_user_id || ""}
                options={userOptions}
                placeholder="Pick a manager…"
                inputClassName={CONTROL_CLASS}
                onChange={v => set("manager_user_id", v || "")}
              />
            </FormRow>
            {subsRow()}
            {peopleRow("pm_user_ids", "Additional project managers")}
          </Section>

          <Section title="Contract">
            <FormRow id={fid("contract_type")} label="Contract type">
              {(p, m) => (
                <FormSelect {...m} value={form.contract_type} options={CONTRACT_TYPE_OPTIONS}
                            emptyLabel="None" placeholder="None"
                            onValueChange={v => set("contract_type", v)}/>
              )}
            </FormRow>
            <FormRow id={fid("contract_amount")} label="Contract amount">
              {(p) => <MoneyInput {...p} placeholder="0" {...bind("contract_amount")}/>}
            </FormRow>
            {dateRow("start_date", "Start date")}
            {dateRow("due_date", "Due date")}
            <FormRow id={fid("percent_complete")} label="Percent complete">
              {(p) => (
                <Input {...p} type="number" inputMode="numeric" min="0" max="100" placeholder="0"
                       className="num text-right" {...bind("percent_complete")}/>
              )}
            </FormRow>
          </Section>

          <Section title="Location">
            <FormRow id={fid("address_line1")} label="Address line 1" wide>
              {(p) => <Input {...p} autoComplete="address-line1" {...bind("address_line1")}/>}
            </FormRow>
            <FormRow id={fid("address_line2")} label="Address line 2" wide>
              {(p) => <Input {...p} autoComplete="address-line2" {...bind("address_line2")}/>}
            </FormRow>
            <FormRow id={fid("city")} label="City">
              {(p) => <Input {...p} autoComplete="address-level2" {...bind("city")}/>}
            </FormRow>
            <FormRow id={fid("state")} label="State">
              {(p) => <Input {...p} autoComplete="address-level1" {...bind("state")}/>}
            </FormRow>
            <FormRow id={fid("pin_code")} label="PIN code">
              {(p) => <Input {...p} inputMode="numeric" className="num" {...bind("pin_code")}/>}
            </FormRow>
          </Section>

          <Section title="Notes">
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "potential") {
      return (
        <>
          <Section title="Project details">
            <FormRow id={fid("project_name")} label="Project name" required wide
                     error={missing("project_name")}>
              {(p) => <Input {...p} autoFocus {...bind("project_name")}/>}
            </FormRow>
            {projectNumberRow()}
            {yearRow()}
            <FormRow id={fid("role")} label="Role">
              {(p, m) => (
                <FormSelect {...m} value={form.role} emptyLabel="None" placeholder="None"
                            options={[{ value: "Prime", label: "Prime" }, { value: "Sub", label: "Sub" }]}
                            onValueChange={v => set("role", v)}/>
              )}
            </FormRow>
            {clientRow(
              "Client",
              form.role === "Sub" ? clientOrFirmOptions : clientOptions,
              form.role === "Sub" ? "Search clients or firms…" : "Search clients…"
            )}
          </Section>

          <Section title="Contract value">
            <FormRow id={fid("total_contract_amount")} label="Total contract amount">
              {(p) => <MoneyInput {...p} placeholder="0" {...bind("total_contract_amount")}/>}
            </FormRow>
            <FormRow id={fid("msmm_amount")} label="MSMM amount">
              {(p) => <MoneyInput {...p} placeholder="0" {...bind("msmm_amount")}/>}
            </FormRow>
            {subsRow()}
          </Section>

          <Section title="Team">
            {peopleRow("pm_user_ids", "PMs")}
          </Section>

          <Section title="Pipeline">
            <FormRow id={fid("probability")} label="Probability">
              {(p, m) => (
                <FormSelect {...m} value={form.probability}
                            options={[
                              { value: "High", label: "High" },
                              { value: "Medium", label: "Medium" },
                              { value: "Low", label: "Low" },
                              { value: "Orange", label: "Orange (pre-awarded)" },
                            ]}
                            onValueChange={v => set("probability", v)}/>
              )}
            </FormRow>
            {form.probability === "Orange" && (
              <FormRow id={fid("anticipated_invoice_start_month")} label="Anticipated invoice start month">
                {(p, meta) => (
                  <FormSelect {...meta} value={form.anticipated_invoice_start_month}
                              emptyLabel="None" placeholder="None"
                              options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
                              onValueChange={v => set("anticipated_invoice_start_month", v)}/>
                )}
              </FormRow>
            )}
          </Section>

          <Section title="Follow up">
            <FormRow id={fid("next_action_note")} label="Dates and comments">
              {(p) => (
                <Input {...p} placeholder="e.g. decision expected 4/2/26"
                       {...bind("next_action_note")}/>
              )}
            </FormRow>
            {dateRow("next_action_date", "Next action date")}
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "awaiting") {
      return (
        <>
          <Section title="Project details">
            <FormRow id={fid("project_name")} label="Project name" required wide
                     error={missing("project_name")}>
              {(p) => <Input {...p} autoFocus {...bind("project_name")}/>}
            </FormRow>
            {projectNumberRow()}
            {yearRow()}
            {clientRow(
              "Client",
              form.role === "Sub" ? clientOrFirmOptions : clientOptions,
              form.role === "Sub" ? "Search clients or firms…" : "Search clients…"
            )}
          </Section>

          <Section title="Team">
            {subsRow()}
            {peopleRow("pm_user_ids", "PMs")}
          </Section>

          <Section title="Submission">
            {dateRow("date_submitted", "Date submitted")}
            {dateRow("anticipated_result_date", "Anticipated result date")}
          </Section>

          <Section title="Contract">
            {contractNumberRows()}
            {msmmUsageRows()}
          </Section>

          <Section title="Notes">
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "awarded") {
      return (
        <>
          <Section title="Project details">
            <FormRow id={fid("project_name")} label="Project name" required wide
                     error={missing("project_name")}>
              {(p) => <Input {...p} autoFocus {...bind("project_name")}/>}
            </FormRow>
            {projectNumberRow()}
            {yearRow()}
            <FormRow id={fid("role")} label="Role" labelledBy>
              {(p, m) => (
                <FormRadios {...m} value={form.role}
                            options={[{ value: "Prime", label: "Prime" }, { value: "Sub", label: "Sub" }]}
                            onValueChange={v => set("role", v)}/>
              )}
            </FormRow>
            {clientRow("Client", clientOptions, "Search clients…")}
            <FormRow id={fid("prime_id")} label="Prime" group>
              <SearchableSelect
                value={form.prime_id || ""}
                options={clientOrFirmOptions}
                placeholder="Search clients or firms…"
                inputClassName={CONTROL_CLASS}
                onChange={v => set("prime_id", v || "")}
              />
            </FormRow>
          </Section>

          <Section title="Award">
            <FormRow id={fid("stage")} label="Stage">
              {(p, m) => (
                <FormSelect {...m} value={form.stage} emptyLabel="None" placeholder="None"
                            options={[
                              { value: "Multi-Use Contract", label: "Multi-Use Contract" },
                              { value: "Single Use Contract (Project)", label: "Single Use Contract (Project)" },
                              { value: "AE Selected List", label: "AE Selected List" },
                            ]}
                            onValueChange={v => set("stage", v)}/>
              )}
            </FormRow>
            <FormRow id={fid("pool")} label="Pool">
              {(p) => <Input {...p} placeholder="e.g. Pool A" {...bind("pool")}/>}
            </FormRow>
            {dateRow("contract_expiry_date", "Contract expiry date")}
            {dateRow("date_submitted", "Date submitted")}
          </Section>

          <Section title="Team">
            {subsRow()}
            {peopleRow("pm_user_ids", "PMs")}
          </Section>

          <Section title="Contract">
            {contractNumberRows()}
            {msmmUsageRows()}
          </Section>

          <Section title="Notes">
            {notesRow("details", "Details")}
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "events") {
      return (
        <>
          <Section title="Event">
            <FormRow id={fid("title")} label="Title" required wide error={missing("title")}>
              {(p) => <Input {...p} autoFocus {...bind("title")}/>}
            </FormRow>
            <FormRow id={fid("status")} label="Status">
              {(p, m) => (
                <FormSelect {...m} value={form.status}
                            options={[
                              { value: "Booked", label: "Booked" },
                              { value: "Happened", label: "Happened" },
                            ]}
                            onValueChange={v => set("status", v)}/>
              )}
            </FormRow>
            <FormRow id={fid("type")} label="Type">
              {(p, m) => (
                <FormSelect {...m} value={form.type} emptyLabel="None" placeholder="None"
                            options={["Partner", "AI", "Project", "Meetings", "Board Meetings", "Event"]
                              .map(v => ({ value: v, label: v }))}
                            onValueChange={v => set("type", v)}/>
              )}
            </FormRow>
            <FormRow id={fid("event_datetime")} label="Date and time">
              {(p) => (
                <Input {...p} type="datetime-local" className="num" {...bind("event_datetime")}/>
              )}
            </FormRow>
            <FormRow id={fid("stars")} label="Rating" group>
              <StarRating
                value={form.stars === "" || form.stars == null ? null : Number(form.stars)}
                onChange={v => set("stars", v == null ? "" : v)}
              />
            </FormRow>
          </Section>

          <Section title="People">
            {peopleRow("attendees", "Attendees")}
          </Section>

          <Section title="Notes">
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "hotleads") {
      return (
        <>
          <Section title="Lead">
            <FormRow id={fid("title")} label="Title" required wide error={missing("title")}>
              {(p) => <Input {...p} autoFocus {...bind("title")}/>}
            </FormRow>
            <FormRow id={fid("type")} label="Type">
              {(p, m) => (
                <FormSelect {...m} value={form.type || ""} emptyLabel="None" placeholder="None"
                            options={[
                              { value: "Engineering", label: "Engineering" },
                              { value: "AI", label: "AI" },
                            ]}
                            onValueChange={v => set("type", v)}/>
              )}
            </FormRow>
            {clientRow("Client / Firm", clientOrFirmOptions, "Search clients or firms…")}
            <FormRow id={fid("date_time")} label="Date and time">
              {(p) => (
                <Input {...p} type="datetime-local" className="num" {...bind("date_time")}/>
              )}
            </FormRow>
            <FormRow id={fid("anticipated_amount")} label="Anticipated amount">
              {(p) => (
                <MoneyInput {...p} placeholder="Expected contract value" {...bind("anticipated_amount")}/>
              )}
            </FormRow>
            <FormRow id={fid("stars")} label="Rating" group>
              <StarRating
                value={form.stars === "" || form.stars == null ? null : Number(form.stars)}
                max={HOT_LEAD_STAR_MAX}
                onChange={v => set("stars", v == null ? "" : v)}
              />
            </FormRow>
          </Section>

          <Section title="People">
            {peopleRow("attendees", "Attendees")}
          </Section>

          <Section title="Notes">
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "clients") {
      return (
        <>
          <Section title="Organization">
            <FormRow id={fid("name")} label="Name" required wide error={missing("name")}>
              {(p) => <Input {...p} autoFocus {...bind("name")}/>}
            </FormRow>
            <FormRow id={fid("district")} label="District / State">
              {(p) => <Input {...p} placeholder="e.g. MVN-New Orleans District" {...bind("district")}/>}
            </FormRow>
            <FormRow id={fid("org_type")} label="Org type">
              {(p, m) => (
                <FormSelect {...m} value={form.org_type} emptyLabel="None" placeholder="None"
                            options={["City", "State", "Federal", "Local", "Parish", "Regional", "Other"]
                              .map(v => ({ value: v, label: v }))}
                            onValueChange={v => set("org_type", v)}/>
              )}
            </FormRow>
          </Section>

          <Section title="Contact">
            <FormRow id={fid("contact_person")} label="Contact person">
              {(p) => <Input {...p} autoComplete="name" {...bind("contact_person")}/>}
            </FormRow>
            <FormRow id={fid("email")} label="Email">
              {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" {...bind("email")}/>}
            </FormRow>
            <FormRow id={fid("phone")} label="Phone">
              {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="tel" className="num" {...bind("phone")}/>}
            </FormRow>
            <FormRow id={fid("address")} label="Address">
              {(p) => <Input {...p} {...bind("address")}/>}
            </FormRow>
          </Section>

          <Section title="Notes">
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "companies") {
      return (
        <>
          <Section title="Company">
            <FormRow id={fid("name")} label="Name" required wide error={missing("name")}>
              {(p) => <Input {...p} autoFocus {...bind("name")}/>}
            </FormRow>
          </Section>

          <Section title="Contact">
            <FormRow id={fid("contact_person")} label="Contact person">
              {(p) => <Input {...p} autoComplete="name" {...bind("contact_person")}/>}
            </FormRow>
            <FormRow id={fid("email")} label="Email">
              {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" {...bind("email")}/>}
            </FormRow>
            <FormRow id={fid("phone")} label="Phone">
              {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="tel" className="num" {...bind("phone")}/>}
            </FormRow>
            <FormRow id={fid("address")} label="Address">
              {(p) => <Input {...p} {...bind("address")}/>}
            </FormRow>
          </Section>

          <Section title="Notes">
            {notesRow()}
          </Section>
        </>
      );
    }

    if (table === "invoice") {
      return (
        <>
          <Section title="Project">
            <FormRow id={fid("project_name")} label="Project name" required wide
                     error={missing("project_name")}>
              {(p) => <Input {...p} autoFocus {...bind("project_name")}/>}
            </FormRow>
            {projectNumberRow("Project #", "e.g. 24-101")}
            {yearRow(true)}
            <FormRow id={fid("type")} label="Type" wide labelledBy>
              {(p, m) => (
                <FormRadios {...m} value={form.type}
                            options={INVOICE_TYPE_OPTIONS.map(t => ({ value: t, label: t }))}
                            onValueChange={v => set("type", v)}/>
              )}
            </FormRow>
          </Section>

          <Section title="Amounts">
            <FormRow id={fid("contract_amount")} label="Total contract value">
              {(p) => <MoneyInput {...p} placeholder="0" {...bind("contract_amount")}/>}
            </FormRow>
            {/* Linked-pair MSMM is initialized when the HZ sibling is created and
                edited from its expanded sub row — no create-time field here. */}
            <FormRow id={fid("msmm_remaining_to_bill_year_start")}
                     label="MSMM rollforward (carry-in from 2025)">
              {(p) => (
                <MoneyInput {...p} placeholder="0" {...bind("msmm_remaining_to_bill_year_start")}/>
              )}
            </FormRow>
          </Section>

          <Section title="Team">
            {peopleRow("pm_user_ids", "PMs", "Pick PMs…")}
          </Section>
        </>
      );
    }

    if (table === "openbids") {
      const stagedFile = form._pdf_file;
      // Due Date is stored as a single ISO string in `form.due_at`, but we
      // surface it as two separate native inputs (date + time) so neither
      // depends on the browser's datetime-local picker chrome — that one
      // doesn't have a "Done" button on several mobile/desktop variants
      // and confused users. Either field can be left blank.
      const dueDate = form.due_at ? String(form.due_at).slice(0, 10) : "";
      const dueTime = form.due_at ? String(form.due_at).slice(11, 16) : "";
      const setDuePart = (part, value) => {
        const nextDate = part === "date" ? value : dueDate;
        const nextTime = part === "time" ? value : dueTime;
        if (!nextDate && !nextTime) { set("due_at", ""); return; }
        // Time-only with no date is meaningless — drop it.
        if (!nextDate) { set("due_at", ""); return; }
        // Date-only is fine; default time to 23:59 so "due Friday" reads
        // as "anytime before midnight Friday" instead of midnight-into-Friday.
        const t = nextTime || "23:59";
        const combined = new Date(`${nextDate}T${t}`);
        if (Number.isNaN(combined.getTime())) { set("due_at", ""); return; }
        set("due_at", combined.toISOString());
      };
      return (
        <>
          <Section title="Bid">
            <FormRow id={fid("rfq_rfp_number")} label="RFQ/RFP number" required wide
                     error={missing("rfq_rfp_number")}>
              {(p) => (
                <Input {...p} autoFocus className="font-mono num"
                       placeholder="e.g. RFQ-2026-014 or 0x4F2"
                       {...bind("rfq_rfp_number")}/>
              )}
            </FormRow>
            {clientRow("Client / Parish", clientOptions, "Search clients…")}
            <FormRow id={fid("service_description")} label="Description of service">
              {(p, m) => (
                <FormSelect {...m} value={form.service_description}
                            emptyLabel="None" placeholder="None"
                            options={BID_SERVICE_OPTIONS.map(s => ({ value: s, label: s }))}
                            onValueChange={v => set("service_description", v)}/>
              )}
            </FormRow>
            <FormRow id={fid("anticipated_amount")} label="Anticipated amount">
              {(p) => (
                <MoneyInput {...p} placeholder="Expected contract value" {...bind("anticipated_amount")}/>
              )}
            </FormRow>
          </Section>

          <Section title="Due date">
            <FormRow id={fid("due_date_part")} label="Date">
              {(p) => (
                <Input {...p} type="date" className="num" value={dueDate}
                       onChange={e => setDuePart("date", e.target.value)}/>
              )}
            </FormRow>
            <FormRow id={fid("due_time_part")} label="Time"
                     hint={dueDate ? "Leave blank for 23:59." : "Pick a date first."}>
              {(p) => (
                <Input {...p} type="time" className="num" value={dueTime}
                       disabled={!dueDate}
                       onChange={e => setDuePart("time", e.target.value)}/>
              )}
            </FormRow>
            {form.due_at && (
              <div className="cm-wide">
                <Button type="button" variant="ghost" size="sm"
                        onClick={() => set("due_at", "")}>
                  <Icon name="x" size={12}/>Clear due date
                </Button>
              </div>
            )}
          </Section>

          <Section title="Attachment and links">
            <FormRow id={fid("_pdf_file")} label="RFQ PDF file" wide
                     hint="Uploads after the bid is created. You can also attach a PDF later from the row or drawer.">
              {(p) => (
                <div className="cm-file">
                  <Input {...p}
                         key={stagedFile ? "picked" : "empty"}
                         type="file" accept="application/pdf,.pdf"
                         className="h-auto py-1.5"
                         onChange={e => set("_pdf_file", e.target.files?.[0] || null)}/>
                  {stagedFile && (
                    <div className="cm-fileinfo">
                      <Icon name="attachment" size={12}/>
                      <span className="cm-filename" title={stagedFile.name}>{stagedFile.name}</span>
                      <Button type="button" variant="ghost" size="icon-sm"
                              aria-label="Remove staged PDF"
                              onClick={() => set("_pdf_file", null)}>
                        <Icon name="x" size={12}/>
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </FormRow>
            <FormRow id={fid("web_link")} label="Web link" wide>
              {/* type="text" not "url" so the browser doesn't refuse a value
                  like "google.com". We don't validate the format at the DB
                  level either — the field is a free-text hyperlink hint. */}
              {(p) => (
                <Input {...p} type="text" inputMode="url" placeholder="https://…" {...bind("web_link")}/>
              )}
            </FormRow>
          </Section>

          <Section title="Notes">
            {notesRow("notes", "Notes", "Anything to flag for the approver…")}
            <div className="cm-wide">
              <Alert tone="neutral" icon={null}>
                <span className="cm-note">
                  <Icon name="lock" size={12}/>
                  <span>New bids start as <strong>Pending</strong>. An Admin approves the bid
                  before it can move forward to Proposals.</span>
                </span>
              </Alert>
            </div>
          </Section>
        </>
      );
    }

    return null;
  };

  // Keep the dialog open when the pointer lands in the SearchableSelect menu:
  // that menu is portalled to document.body, so Radix would otherwise read it
  // as an outside interaction and dismiss.
  const isComboboxSurface = (e) => {
    const target = e?.detail?.originalEvent?.target ?? e?.target;
    return target instanceof Element && !!target.closest(".searchable-menu");
  };
  const keepOpenOverCombobox = (e) => { if (isComboboxSurface(e)) e.preventDefault(); };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        size="lg"
        aria-busy={pending || undefined}
        onPointerDownOutside={keepOpenOverCombobox}
        onInteractOutside={keepOpenOverCombobox}
        onFocusOutside={keepOpenOverCombobox}
      >
        <DialogHeader>
          <div className="cm-headrow">
            <span className="cm-badge" aria-hidden="true">
              <Icon name={titleCfg.icon} size={16}/>
            </span>
            <div className="min-w-0">
              <p className="cm-eyebrow">Create</p>
              <DialogTitle>{titleCfg.title}</DialogTitle>
              <DialogDescription>Fields marked with an asterisk are required.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="cm-body">
          {error ? (
            <div ref={summaryRef}>
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : submitted && !requiredOk ? (
            <div ref={summaryRef}>
              <Alert tone="danger" title="Missing required fields">
                Fill in {missingRequired.map(requiredLabel).join(", ")} to continue.
              </Alert>
            </div>
          ) : null}
          {renderFields()}
        </DialogBody>

        <DialogFooter>
          <Button variant="default" className="min-h-11 sm:min-h-0"
                  onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" className="min-h-11 sm:min-h-0"
                  onClick={onSubmit}
                  loading={pending}
                  disabled={!requiredOk || pending}>
            {!pending && <Icon name="check" size={14}/>}
            {pending ? "Saving…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
