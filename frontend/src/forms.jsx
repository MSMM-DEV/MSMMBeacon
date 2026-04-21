import React, { useState, useEffect } from "react";
import { Icon } from "./icons.jsx";
import { supabase, THIS_YEAR } from "./data.js";

// ============ CREATE MODAL (new row for potential / events / clients / companies) ============
export const CreateModal = ({ table, clients, companies, users, onClose, onCreated }) => {
  const CFG = {
    potential: {
      title: "New potential project",
      icon: "briefcase",
      dbTable: "potential_projects",
      initial: {
        project_name: "",
        year: THIS_YEAR,
        role: "",
        client_id: "",
        total_contract_amount: "",
        msmm_amount: "",
        probability: "High",
        notes: "",
        project_number: "",
      },
      required: ["project_name"],
    },
    events: {
      title: "New event",
      icon: "calendar",
      dbTable: "events",
      initial: {
        title: "",
        status: "Booked",
        type: "",
        event_date: "",
        event_datetime: "",
        notes: "",
      },
      required: ["title"],
    },
    clients: {
      title: "New client",
      icon: "users",
      dbTable: "clients",
      initial: {
        name: "",
        district: "",
        org_type: "",
        contact_person: "",
        email: "",
        phone: "",
        address: "",
        notes: "",
      },
      required: ["name"],
    },
    companies: {
      title: "New company",
      icon: "briefcase",
      dbTable: "companies",
      initial: {
        name: "",
        contact_person: "",
        email: "",
        phone: "",
        address: "",
        notes: "",
      },
      required: ["name"],
    },
  }[table];

  const [form, setForm] = useState(() => ({ ...(CFG?.initial || {}) }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!CFG) return null;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // A field is "empty" if undefined, null, or "".
  const isEmpty = (v) => v === undefined || v === null || v === "";
  const requiredOk = CFG.required.every(k => !isEmpty(form[k]));

  // Build the payload — strip empty fields so DB defaults/NULL-able columns behave right.
  const buildPayload = () => {
    const payload = {};
    const numericKeys = new Set(["year", "total_contract_amount", "msmm_amount"]);
    Object.entries(form).forEach(([k, v]) => {
      if (isEmpty(v)) return;
      // For potential table: never send prime_company_id (DB check constraint: Prime rows require it NULL).
      if (table === "potential" && k === "prime_company_id") return;
      if (numericKeys.has(k)) {
        const n = Number(v);
        if (!Number.isNaN(n)) payload[k] = n;
      } else {
        payload[k] = v;
      }
    });
    return payload;
  };

  const onSubmit = async () => {
    if (!requiredOk || pending) return;
    setError("");
    setPending(true);
    const payload = buildPayload();
    const { data, error: err } = await supabase
      .from(CFG.dbTable)
      .insert(payload)
      .select()
      .single();
    if (err) {
      setError(err.message);
      setPending(false);
      return;
    }
    onCreated(data);
    onClose();
  };

  const renderFields = () => {
    if (table === "potential") {
      return (
        <>
          <div className="field">
            <div className="field-label">Project Name *</div>
            <div className="field-value">
              <input className="input" autoFocus value={form.project_name}
                onChange={e => set("project_name", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Year</div>
            <div className="field-value">
              <input className="input" type="number" value={form.year}
                onChange={e => set("year", e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Role</div>
            <div className="field-value">
              <select className="select" value={form.role} onChange={e => set("role", e.target.value)}>
                <option value="">—</option>
                <option value="Prime">Prime</option>
                <option value="Sub">Sub</option>
              </select>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Client</div>
            <div className="field-value">
              <select className="select" value={form.client_id} onChange={e => set("client_id", e.target.value)}>
                <option value="">—</option>
                {(clients || []).map(c => (
                  <option key={c.id} value={c.id}>
                    {c.district ? `${c.name} — ${c.district}` : c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Total Contract Amount</div>
            <div className="field-value">
              <input className="input" type="number" value={form.total_contract_amount}
                onChange={e => set("total_contract_amount", e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }} placeholder="0" />
            </div>
          </div>
          <div className="field">
            <div className="field-label">MSMM Amount</div>
            <div className="field-value">
              <input className="input" type="number" value={form.msmm_amount}
                onChange={e => set("msmm_amount", e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }} placeholder="0" />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Probability</div>
            <div className="field-value">
              <select className="select" value={form.probability}
                onChange={e => set("probability", e.target.value)}>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Notes</div>
            <div className="field-value multiline">
              <textarea className="textarea" value={form.notes}
                onChange={e => set("notes", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Project Number</div>
            <div className="field-value">
              <input className="input" value={form.project_number}
                onChange={e => set("project_number", e.target.value)}
                style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
            </div>
          </div>
        </>
      );
    }

    if (table === "events") {
      return (
        <>
          <div className="field">
            <div className="field-label">Title *</div>
            <div className="field-value">
              <input className="input" autoFocus value={form.title}
                onChange={e => set("title", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Status</div>
            <div className="field-value">
              <select className="select" value={form.status}
                onChange={e => set("status", e.target.value)}>
                <option value="Booked">Booked</option>
                <option value="Happened">Happened</option>
              </select>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Type</div>
            <div className="field-value">
              <select className="select" value={form.type}
                onChange={e => set("type", e.target.value)}>
                <option value="">—</option>
                <option value="Partner">Partner</option>
                <option value="AI">AI</option>
                <option value="Project">Project</option>
                <option value="Meetings">Meetings</option>
                <option value="Event">Event</option>
              </select>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Event Date</div>
            <div className="field-value">
              <input className="input" type="date" value={form.event_date}
                onChange={e => set("event_date", e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Date & Time</div>
            <div className="field-value">
              <input className="input" type="datetime-local" value={form.event_datetime}
                onChange={e => set("event_datetime", e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Notes</div>
            <div className="field-value multiline">
              <textarea className="textarea" value={form.notes}
                onChange={e => set("notes", e.target.value)} />
            </div>
          </div>
        </>
      );
    }

    if (table === "clients") {
      return (
        <>
          <div className="field">
            <div className="field-label">Name *</div>
            <div className="field-value">
              <input className="input" autoFocus value={form.name}
                onChange={e => set("name", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">District</div>
            <div className="field-value">
              <input className="input" value={form.district}
                onChange={e => set("district", e.target.value)}
                placeholder="e.g. MVN-New Orleans District" />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Org Type</div>
            <div className="field-value">
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
            </div>
          </div>
          <div className="field">
            <div className="field-label">Contact Person</div>
            <div className="field-value">
              <input className="input" value={form.contact_person}
                onChange={e => set("contact_person", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Email</div>
            <div className="field-value">
              <input className="input" type="email" value={form.email}
                onChange={e => set("email", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Phone</div>
            <div className="field-value">
              <input className="input" type="tel" value={form.phone}
                onChange={e => set("phone", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Address</div>
            <div className="field-value">
              <input className="input" value={form.address}
                onChange={e => set("address", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Notes</div>
            <div className="field-value multiline">
              <textarea className="textarea" value={form.notes}
                onChange={e => set("notes", e.target.value)} />
            </div>
          </div>
        </>
      );
    }

    if (table === "companies") {
      return (
        <>
          <div className="field">
            <div className="field-label">Name *</div>
            <div className="field-value">
              <input className="input" autoFocus value={form.name}
                onChange={e => set("name", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Contact Person</div>
            <div className="field-value">
              <input className="input" value={form.contact_person}
                onChange={e => set("contact_person", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Email</div>
            <div className="field-value">
              <input className="input" type="email" value={form.email}
                onChange={e => set("email", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Phone</div>
            <div className="field-value">
              <input className="input" type="tel" value={form.phone}
                onChange={e => set("phone", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Address</div>
            <div className="field-value">
              <input className="input" value={form.address}
                onChange={e => set("address", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Notes</div>
            <div className="field-value multiline">
              <textarea className="textarea" value={form.notes}
                onChange={e => set("notes", e.target.value)} />
            </div>
          </div>
        </>
      );
    }

    return null;
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="modal">
        <div className="modal-head">
          <div className="icon-badge"><Icon name={CFG.icon} size={16} /></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>Create</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>{CFG.title}</h3>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">
          {renderFields()}
          {error && (
            <div style={{ color: "var(--rose)", fontSize: 12, marginTop: 10 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)" }}>
            * required
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn primary sm"
              onClick={onSubmit}
              disabled={!requiredOk || pending}>
              <Icon name="check" size={13} />
              {pending ? "Saving…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
