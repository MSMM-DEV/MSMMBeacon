// ==========================================================================
// DIRECTORY CONTACTS — many people per client / company.
//
// Backed by beacon_v2.contacts (migration 20260914120000). Three surfaces:
//   • <ContactsSection>      persisted editor inside the Directory DetailDrawer
//                            (add / edit / delete / make primary → data.js CRUD,
//                            optimistic with revert, then `onChanged(rowId, list)`
//                            so App.jsx re-derives the row's summary trio).
//   • <DraftContactsField>   the same card list without persistence, for the
//                            New Client / New Company modal — the drafts are
//                            inserted in one go after the parent row lands.
//   • <ContactStack>         the compact read-only rendering the Directory
//                            table cells use (names / emails / phones stacked
//                            so the three columns line up person-by-person).
// ==========================================================================
import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import {
  addContact, updateContact, deleteContact, setPrimaryContact, reloadContactsFor,
  sortContacts, displayContacts,
} from "./data.js";
import { Badge, Button } from "@/ui";

const EMPTY_DRAFT = { name: "", title: "", email: "", phone: "", notes: "" };

export const contactInitials = (name) =>
  String(name || "")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join("") || "?";

// ---- Form -------------------------------------------------------------------
// One person's fields. Controlled; the parent owns the draft so a Cancel can
// throw it away. Enter submits, Escape cancels.
function ContactForm({ draft, onChange, onSubmit, onCancel, busy = false, submitLabel = "Save", autoFocus = true, compact = false }) {
  const uid = useId();
  const set = (k) => (e) => onChange({ ...draft, [k]: e.target.value });
  const canSave = !!draft.name.trim() && !busy;
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      if (canSave) onSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  };
  return (
    <div
      className="bcn-contact-form flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--accent-line)] bg-[var(--accent-softer)] p-3"
      onKeyDown={onKey}
      role="group"
      aria-label={submitLabel === "Save" ? "Edit contact" : "New contact"}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input id={`${uid}-name`} className="input" placeholder="Name *" aria-label="Name"
               autoComplete="name" autoFocus={autoFocus} disabled={busy}
               value={draft.name} onChange={set("name")}/>
        <input className="input" placeholder="Title / role" aria-label="Title or role"
               autoComplete="organization-title" disabled={busy}
               value={draft.title} onChange={set("title")}/>
        <input className="input" type="email" inputMode="email" placeholder="Email" aria-label="Email"
               autoComplete="email" disabled={busy}
               value={draft.email} onChange={set("email")}/>
        <input className="input num" type="tel" inputMode="tel" placeholder="Phone" aria-label="Phone"
               autoComplete="tel" disabled={busy}
               value={draft.phone} onChange={set("phone")}/>
      </div>
      {!compact && (
        <textarea className="textarea" rows={2} placeholder="Notes (optional)" aria-label="Notes"
                  disabled={busy} value={draft.notes} onChange={set("notes")}/>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[length:var(--fs-2xs)] text-[var(--text-soft)]">Enter to save · Esc to cancel</span>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        )}
        <Button type="button" size="sm" variant="primary" onClick={onSubmit} disabled={!canSave}>
          {busy ? <Icon name="spinner" size={13}/> : <Icon name="check" size={13}/>}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ---- Card -------------------------------------------------------------------
function ContactCard({ c, onEdit, onDelete, onMakePrimary, busy = false, readOnly = false }) {
  const label = c.name || "Unnamed contact";
  return (
    <li
      className={
        "bcn-contact-card group relative flex min-w-0 gap-3 rounded-[var(--radius-md)] border p-3 transition-colors " +
        (c.isPrimary
          ? "border-[var(--accent-line)] bg-[var(--surface)]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]")
      }
      data-primary={c.isPrimary ? "true" : undefined}
    >
      <span
        className={
          "bcn-contact-avatar flex size-9 shrink-0 select-none items-center justify-center rounded-full text-[length:var(--fs-xs)] font-semibold " +
          (c.isPrimary
            ? "bg-[var(--accent-soft)] text-[var(--accent-ink)]"
            : "bg-[var(--surface-3)] text-[var(--text-muted)]")
        }
        aria-hidden="true"
      >
        {contactInitials(c.name)}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-[length:var(--fs-sm)] font-semibold text-[var(--text)]">{label}</span>
          {c.isPrimary && (
            <Badge tone="brand" size="sm" title="Primary contact — shown first in the Directory table and exports">
              <Icon name="star" size={10}/> Primary
            </Badge>
          )}
        </div>
        {c.title && (
          <span className="min-w-0 break-words text-[length:var(--fs-xs)] text-[var(--text-muted)]">{c.title}</span>
        )}
        <div className="mt-1 flex min-w-0 flex-col gap-0.5 text-[length:var(--fs-xs)]">
          {c.email ? (
            <a className="bcn-contact-channel inline-flex min-w-0 items-center gap-1.5 break-all text-[var(--text)] no-underline hover:underline"
               href={`mailto:${c.email}`}>
              <Icon name="mail" size={12} aria-hidden="true"/><span className="min-w-0">{c.email}</span>
            </a>
          ) : null}
          {c.phone ? (
            <a className="bcn-contact-channel num inline-flex min-w-0 items-center gap-1.5 text-[var(--text)] no-underline hover:underline"
               href={`tel:${c.phone}`}>
              <PhoneGlyph/><span className="min-w-0">{c.phone}</span>
            </a>
          ) : null}
          {!c.email && !c.phone && (
            <span className="text-[var(--text-soft)]">No email or phone yet</span>
          )}
        </div>
        {c.notes && (
          <p className="m-0 mt-1 min-w-0 whitespace-pre-wrap break-words text-[length:var(--fs-xs)] leading-[var(--lh-snug)] text-[var(--text-muted)]">{c.notes}</p>
        )}
      </div>

      {!readOnly && <div className="bcn-contact-actions flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-start">
        {!c.isPrimary && onMakePrimary && (
          <Button type="button" size="icon-sm" variant="ghost" disabled={busy}
                  title="Make primary contact" aria-label={`Make ${label} the primary contact`}
                  onClick={() => onMakePrimary(c)}>
            <Icon name="star" size={13}/>
          </Button>
        )}
        <Button type="button" size="icon-sm" variant="ghost" disabled={busy}
                title="Edit contact" aria-label={`Edit ${label}`}
                onClick={() => onEdit(c)}>
          <Icon name="edit" size={13}/>
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" disabled={busy}
                className="text-[var(--rose)] hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]"
                title="Remove contact" aria-label={`Remove ${label}`}
                onClick={() => onDelete(c)}>
          <Icon name="trash" size={13}/>
        </Button>
      </div>}
    </li>
  );
}

// The icon set has no handset glyph; a tiny inline one keeps the email / phone
// rows visually parallel without widening icons.jsx for a single use.
function PhoneGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.9 2z"/>
    </svg>
  );
}

// ---- Persisted section (DetailDrawer) ------------------------------------------
// `row` is the adapted Directory row (type "Client" or a company). `onChanged`
// receives the fresh sorted list so App.jsx can fold it back into state.
export function ContactsSection({ row, onChanged, onToast }) {
  const isClient = row?.type === "Client";
  const parent = isClient ? { clientId: row.id } : { companyId: row.id };
  const [list, setList] = useState(() => sortContacts(row?.contacts));
  // No contact rows but legacy scalars on the parent → the contacts table
  // isn't applied yet (or the backfill hasn't run). Show what we have,
  // read-only, so the drawer never looks emptier than the table.
  const legacy = list.length === 0 ? displayContacts(row).filter(c => c.legacy) : [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const rowIdRef = useRef(row?.id);

  // Reset local state when the drawer is pointed at a different record, and
  // refetch on open so a colleague's additions show up without a reload.
  useEffect(() => {
    rowIdRef.current = row?.id;
    setList(sortContacts(row?.contacts));
    setAdding(false); setEditingId(null); setConfirmId(null);
    let alive = true;
    reloadContactsFor(parent)
      .then(fresh => {
        if (!alive || rowIdRef.current !== row?.id) return;
        setList(fresh);
        onChanged?.(row.id, fresh);
      })
      .catch(() => { /* un-migrated DB: keep what the row carried */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  const commit = (next) => {
    const sorted = sortContacts(next);
    setList(sorted);
    onChanged?.(row.id, sorted);
  };
  const fail = (e, revert) => {
    if (revert) setList(revert);
    onToast?.(e?.message || String(e), "x");
  };

  const submitAdd = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    const before = list;
    try {
      const created = await addContact({ ...parent, ...draft, isPrimary: list.length === 0 });
      commit([...before, created]);
      setDraft(EMPTY_DRAFT);
      setAdding(false);
    } catch (e) { fail(e, before); }
    finally { setBusy(false); }
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditDraft({ name: c.name || "", title: c.title || "", email: c.email || "", phone: c.phone || "", notes: c.notes || "" });
    setAdding(false);
  };
  const submitEdit = async () => {
    if (!editingId || !editDraft.name.trim()) return;
    setBusy(true);
    const before = list;
    const optimistic = before.map(c => c.id === editingId ? { ...c, ...editDraft } : c);
    commit(optimistic);
    try {
      const saved = await updateContact(editingId, editDraft);
      if (saved) commit(optimistic.map(c => c.id === saved.id ? { ...c, ...saved } : c));
      setEditingId(null);
    } catch (e) { fail(e, before); onChanged?.(row.id, before); }
    finally { setBusy(false); }
  };

  const remove = async (c) => {
    setBusy(true);
    const before = list;
    const remaining = before.filter(x => x.id !== c.id);
    commit(remaining);
    setConfirmId(null);
    try {
      await deleteContact(c.id);
      // If the primary went away, promote the next person so the summary
      // trio (table cell / exports) keeps a name.
      if (c.isPrimary && remaining.length > 0) {
        const next = sortContacts(remaining)[0];
        await setPrimaryContact(next.id);
        commit(remaining.map(x => ({ ...x, isPrimary: x.id === next.id })));
      }
    } catch (e) { fail(e, before); onChanged?.(row.id, before); }
    finally { setBusy(false); }
  };

  const makePrimary = async (c) => {
    setBusy(true);
    const before = list;
    commit(before.map(x => ({ ...x, isPrimary: x.id === c.id })));
    try { await setPrimaryContact(c.id); }
    catch (e) { fail(e, before); onChanged?.(row.id, before); }
    finally { setBusy(false); }
  };

  const orgLabel = row?.baseName || row?.name || "this record";

  return (
    <section className="record-section min-w-0" aria-label="Contacts">
      <div className="record-section-head mb-2 flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="m-0 flex min-w-0 items-center gap-1.5 text-[length:var(--fs-sm)] font-semibold text-[var(--text)]">
          <Icon name="users" size={12}/>
          <span>Contacts</span>
          {list.length > 0 && (
            <span className="num rounded-[var(--radius-full)] bg-[var(--surface-3)] px-1.5 py-px text-[length:var(--fs-2xs)] font-semibold text-[var(--text-muted)]">
              {list.length}
            </span>
          )}
        </h3>
        <span className="ml-auto">
          <Button type="button" size="sm" variant={adding ? "subtle" : "default"} disabled={busy}
                  aria-expanded={adding}
                  onClick={() => { setAdding(a => !a); setEditingId(null); setDraft(EMPTY_DRAFT); }}>
            <Icon name={adding ? "x" : "userPlus"} size={13}/>
            {adding ? "Close" : "Add contact"}
          </Button>
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {adding && (
          <ContactForm draft={draft} onChange={setDraft} onSubmit={submitAdd}
                       onCancel={() => { setAdding(false); setDraft(EMPTY_DRAFT); }}
                       busy={busy} submitLabel="Add"/>
        )}

        {list.length === 0 && legacy.length > 0 && !adding ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {legacy.map(c => <ContactCard key={c.id} c={c} readOnly/>)}
            <li className="text-[length:var(--fs-2xs)] text-[var(--text-soft)]">
              Legacy contact carried on the record. Apply the <code>contacts</code> migration to manage multiple people here.
            </li>
          </ul>
        ) : list.length === 0 && !adding ? (
          <button
            type="button"
            className="flex w-full flex-col items-center gap-1 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-5 text-center text-[length:var(--fs-sm)] text-[var(--text-muted)] hover:border-[var(--accent-line)] hover:bg-[var(--accent-softer)]"
            onClick={() => setAdding(true)}
          >
            <Icon name="userPlus" size={16}/>
            <span className="font-semibold text-[var(--text)]">No contacts for {orgLabel} yet</span>
            <span className="text-[length:var(--fs-xs)] text-[var(--text-soft)]">Add the people you deal with — PM, accounts payable, principal…</span>
          </button>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {list.map(c => editingId === c.id ? (
              <li key={c.id}>
                <ContactForm draft={editDraft} onChange={setEditDraft} onSubmit={submitEdit}
                             onCancel={() => setEditingId(null)} busy={busy} submitLabel="Save"/>
              </li>
            ) : confirmId === c.id ? (
              <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--rose-line)] bg-[var(--rose-soft)] p-3 text-[length:var(--fs-sm)] text-[var(--rose-ink)]">
                <Icon name="warn" size={14}/>
                <span className="min-w-0 flex-1">Remove <strong>{c.name}</strong> from {orgLabel}?</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmId(null)} disabled={busy}>Keep</Button>
                <Button type="button" size="sm" variant="destructive" onClick={() => remove(c)} disabled={busy}>Remove</Button>
              </li>
            ) : (
              <ContactCard key={c.id} c={c} busy={busy}
                           onEdit={startEdit}
                           onDelete={(x) => setConfirmId(x.id)}
                           onMakePrimary={makePrimary}/>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---- Draft list (CreateModal) ---------------------------------------------------
// Local-only. `value` is an array of drafts ({ name, title, email, phone,
// notes, isPrimary }); the first added draft is primary unless changed.
export function DraftContactsField({ value = [], onChange }) {
  const [adding, setAdding] = useState(value.length === 0);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingIdx, setEditingIdx] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_DRAFT);

  const withKeys = value.map((c, i) => ({ ...c, id: c._key || `draft-${i}` }));

  const add = () => {
    if (!draft.name.trim()) return;
    const next = [...value, { ...draft, _key: `k${Date.now()}`, isPrimary: value.length === 0 }];
    onChange(next);
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  };
  const saveEdit = () => {
    if (editingIdx == null || !editDraft.name.trim()) return;
    onChange(value.map((c, i) => i === editingIdx ? { ...c, ...editDraft } : c));
    setEditingIdx(null);
  };
  const remove = (idx) => {
    const next = value.filter((_, i) => i !== idx);
    if (next.length && !next.some(c => c.isPrimary)) next[0] = { ...next[0], isPrimary: true };
    onChange(next);
    if (next.length === 0) setAdding(true);
  };
  const makePrimary = (idx) => onChange(value.map((c, i) => ({ ...c, isPrimary: i === idx })));

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {withKeys.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {withKeys.map((c, i) => editingIdx === i ? (
            <li key={c.id}>
              <ContactForm draft={editDraft} onChange={setEditDraft} onSubmit={saveEdit}
                           onCancel={() => setEditingIdx(null)} submitLabel="Save" compact/>
            </li>
          ) : (
            <ContactCard key={c.id} c={c}
                         onEdit={() => { setEditingIdx(i); setEditDraft({ ...EMPTY_DRAFT, ...c }); setAdding(false); }}
                         onDelete={() => remove(i)}
                         onMakePrimary={() => makePrimary(i)}/>
          ))}
        </ul>
      )}
      {adding ? (
        <ContactForm draft={draft} onChange={setDraft} onSubmit={add}
                     onCancel={value.length > 0 ? () => { setAdding(false); setDraft(EMPTY_DRAFT); } : undefined}
                     submitLabel="Add" autoFocus={false} compact/>
      ) : (
        <Button type="button" size="sm" variant="default" className="self-start"
                onClick={() => { setAdding(true); setEditingIdx(null); }}>
          <Icon name="userPlus" size={13}/> Add another contact
        </Button>
      )}
      <p className="m-0 text-[length:var(--fs-2xs)] text-[var(--text-soft)]">
        Contacts are optional. You can add more later from the record's details.
      </p>
    </div>
  );
}

// ---- Compact table rendering -------------------------------------------------------
// The Directory table shows each person on its own line in the Contact /
// Email / Phone columns, in the same order, so a row reads across. `field`
// picks which attribute this column shows. Capped with a "+N more" tail that
// hands off to the drawer (the table isn't the place to scroll a roster).
export const CONTACT_STACK_MAX = 3;

export function ContactStack({ contacts, row, field, onMore, emptyText = "–" }) {
  const list = row ? displayContacts(row) : sortContacts(contacts);
  if (list.length === 0) return <span className="empty-cell">{emptyText}</span>;
  const shown = list.slice(0, CONTACT_STACK_MAX);
  const extra = list.length - shown.length;
  return (
    <span className="bcn-contact-stack flex min-w-0 flex-col gap-0.5">
      {shown.map(c => {
        const v = c[field];
        const key = c.id;
        if (field === "name") {
          return (
            <span key={key} className="bcn-contact-stack-line flex min-w-0 items-center gap-1.5" title={c.title ? `${c.name} · ${c.title}` : c.name}>
              {c.isPrimary && list.length > 1 && <Icon name="star" size={10} className="shrink-0 text-[var(--accent)]" aria-label="Primary"/>}
              <span className="bcn-directory-contact-name min-w-0 truncate">{c.name || <span className="empty-cell">Unnamed</span>}</span>
              {c.title && <span className="bcn-contact-stack-title min-w-0 truncate text-[length:var(--fs-2xs)] text-[var(--text-soft)]">{c.title}</span>}
            </span>
          );
        }
        if (!v) return <span key={key} className="bcn-contact-stack-line empty-cell">–</span>;
        const href = field === "email" ? `mailto:${v}` : `tel:${v}`;
        return (
          <a key={key} className={"bcn-directory-channel bcn-contact-stack-line min-w-0 truncate" + (field === "phone" ? " num" : "")}
             href={href} onClick={e => e.stopPropagation()} title={v}>{v}</a>
        );
      })}
      {extra > 0 && (
        field === "name" ? (
          <button type="button" className="bcn-contact-stack-more self-start text-[length:var(--fs-2xs)] font-semibold text-[var(--accent)] hover:underline"
                  onClick={(e) => { e.stopPropagation(); onMore?.(); }}>
            +{extra} more
          </button>
        ) : <span className="bcn-contact-stack-line" aria-hidden="true">&nbsp;</span>
      )}
    </span>
  );
}

// Phone layout of the Directory "Contacts" view: the three columns collapse
// into one, so stacking names / emails / phones separately would read as three
// unrelated lists. This renders one compact block per person instead; CSS
// shows it (and hides the per-column stacks) below the phone breakpoint.
export function ContactCards({ contacts, row, onMore }) {
  const list = row ? displayContacts(row) : sortContacts(contacts);
  if (list.length === 0) return null;
  const shown = list.slice(0, CONTACT_STACK_MAX);
  const extra = list.length - shown.length;
  return (
    <ul className="bcn-contact-cards m-0 list-none p-0">
      {shown.map(c => (
        <li key={c.id} className="bcn-contact-cards-item">
          <span className="bcn-directory-contact-name">
            {c.isPrimary && list.length > 1 && <Icon name="star" size={10} className="text-[var(--accent)]" aria-label="Primary"/>}
            {c.name}{c.title ? <span className="bcn-contact-stack-title"> · {c.title}</span> : null}
          </span>
          {c.email && <a className="bcn-directory-channel" href={`mailto:${c.email}`} onClick={e => e.stopPropagation()}>{c.email}</a>}
          {c.phone && <a className="bcn-directory-channel num" href={`tel:${c.phone}`} onClick={e => e.stopPropagation()}>{c.phone}</a>}
        </li>
      ))}
      {extra > 0 && (
        <li>
          <button type="button" className="bcn-contact-stack-more text-[length:var(--fs-2xs)] font-semibold text-[var(--accent)]"
                  onClick={(e) => { e.stopPropagation(); onMore?.(); }}>+{extra} more</button>
        </li>
      )}
    </ul>
  );
}
