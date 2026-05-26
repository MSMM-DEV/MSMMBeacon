// PeopleFilter — toolbar chip + popover that lets the admin pick which
// users are visible in the Team views. Persisted via useAdminTimePrefs so
// the choice survives reload.
//
// Selection model:
//   visibleUsers === "all"   → everyone visible, chip shows "All people"
//   visibleUsers === []      → no one visible (rare, but legal)
//   visibleUsers === [...]   → explicit allowlist, chip shows count
//
// Popover affordances:
//   • Search field
//   • Quick chips: All · None · Active today · Currently in
//   • Per-user checkboxes (sticky avatar + name)
//   • Footer: "X of Y selected" + Done

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { getUsers } from "../data";

export function PeopleFilter({
  visibleUsers,           // "all" | string[]
  onChange,               // (next: "all" | string[]) => void
  signals = {},           // { activeToday: Set<string>, currentlyIn: Set<string> }
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState("");
  const btnRef  = useRef(null);
  const popRef  = useRef(null);

  // Resolve the full roster once per open. Filter to enabled users + apply
  // the search term. Always alpha-sorted.
  const roster = useMemo(() => {
    const all = getUsers().slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter(u => u.name.toLowerCase().includes(q) || (u.initials || "").toLowerCase().includes(q));
  }, [search, open]);

  const allIds = useMemo(() => getUsers().map(u => u.id), [open]);
  const visibleSet = useMemo(
    () => visibleUsers === "all" ? new Set(allIds) : new Set(visibleUsers || []),
    [visibleUsers, allIds],
  );

  const visibleCount = visibleUsers === "all" ? allIds.length : (visibleUsers || []).length;
  const totalCount   = allIds.length;
  const isAll        = visibleUsers === "all" || visibleCount === totalCount;

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const togglePerson = (id) => {
    const cur = visibleUsers === "all" ? new Set(allIds) : new Set(visibleUsers || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    // If the result is everyone, normalize to "all" so future roster additions
    // are auto-visible.
    if (cur.size === allIds.length && allIds.every(x => cur.has(x))) onChange("all");
    else onChange(Array.from(cur));
  };

  const pickAll      = () => onChange("all");
  const pickNone     = () => onChange([]);
  const pickPreset   = (set) => onChange(Array.from(set));

  return (
    <div className="tk-people-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`tk-people-chip ${!isAll ? "is-filtered" : ""} ${open ? "is-open" : ""}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="users" size={13}/>
        <span className="tk-people-chip-label">
          {isAll ? "All people" : `${visibleCount} of ${totalCount}`}
        </span>
        <Icon name="chevronDown" size={11}/>
      </button>

      {open && (
        <div ref={popRef} className="tk-people-pop" role="dialog" aria-label="Visible people">
          <div className="tk-people-pop-head">
            <Icon name="search" size={13}/>
            <input
              autoFocus
              type="text"
              className="tk-people-search"
              placeholder="Search people…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" className="tk-people-clear" onClick={() => setSearch("")} aria-label="Clear search">
                <Icon name="x" size={11}/>
              </button>
            )}
          </div>

          <div className="tk-people-quick">
            <button type="button" className={`tk-people-quick-btn ${isAll ? "is-active" : ""}`} onClick={pickAll}>
              All
            </button>
            <button type="button" className="tk-people-quick-btn" onClick={pickNone}>
              None
            </button>
            {signals.activeToday && (
              <button type="button" className="tk-people-quick-btn"
                onClick={() => pickPreset(signals.activeToday)}>
                Active today
                <span className="tk-people-quick-count">{signals.activeToday.size}</span>
              </button>
            )}
            {signals.currentlyIn && signals.currentlyIn.size > 0 && (
              <button type="button" className="tk-people-quick-btn"
                onClick={() => pickPreset(signals.currentlyIn)}>
                <span className="tk-pulse-dot"/>
                Currently in
                <span className="tk-people-quick-count">{signals.currentlyIn.size}</span>
              </button>
            )}
          </div>

          <ul className="tk-people-list" role="listbox">
            {roster.map(u => {
              const checked = visibleSet.has(u.id);
              const isIn    = signals.currentlyIn?.has(u.id);
              const isActive = signals.activeToday?.has(u.id);
              return (
                <li key={u.id}>
                  <label className={`tk-people-row ${checked ? "is-on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePerson(u.id)}
                      className="tk-people-check"
                    />
                    <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                    <span className="tk-people-name">{u.name}</span>
                    {isIn && <span className="tk-people-flag tk-people-flag-in"><span className="tk-pulse-dot"/>in</span>}
                    {!isIn && isActive && <span className="tk-people-flag tk-people-flag-active">active</span>}
                  </label>
                </li>
              );
            })}
            {roster.length === 0 && (
              <li className="tk-people-empty">No matches</li>
            )}
          </ul>

          <footer className="tk-people-foot">
            <span className="tk-people-foot-meta">
              {isAll
                ? `All ${totalCount} people visible`
                : `${visibleCount} of ${totalCount} visible`}
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>
              Done
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
