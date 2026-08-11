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
//   • Per-user checkboxes (avatar + name + presence flag)
//   • Footer: "X of Y selected" + Done
//
// The overlay is Radix (via the kit's Popover) so focus trapping, Escape and
// outside-click dismissal are handled for us rather than hand-rolled.

import React, { useId, useMemo, useState } from "react";
import { Icon } from "@/icons";
import {
  Badge, Button, Checkbox, InputGroup, Popover, PopoverContent, PopoverTrigger, Separator,
} from "@/ui";
import { getUsers } from "../data";

export function PeopleFilter({
  visibleUsers,           // "all" | string[]
  onChange,               // (next: "all" | string[]) => void
  signals = {},           // { activeToday: Set<string>, currentlyIn: Set<string> }
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState("");
  const baseId = useId();

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="default"
          size="md"
          className={`tka-people-trigger ${!isAll ? "border-[var(--accent-line)] bg-[var(--accent-softer)] text-[var(--accent-ink)]" : ""}`}
          aria-label={isAll ? "Filter people, all people visible" : `Filter people, ${visibleCount} of ${totalCount} visible`}
        >
          <Icon name="users" size={14}/>
          <span className="tka-people-triggerlabel">
            {isAll ? "All people" : <span className="num">{visibleCount} of {totalCount}</span>}
          </span>
          <Icon name="chevronDown" size={12}/>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="tka-people-pop w-[min(320px,calc(100vw-24px))] p-0">
        <div className="tka-people-search">
          <InputGroup
            type="text"
            autoFocus
            placeholder="Search people"
            aria-label="Search people"
            value={search}
            onChange={e => setSearch(e.target.value)}
            leading={<Icon name="search" size={14}/>}
            trailing={search ? (
              <button
                type="button"
                className="tka-search-clear"
                onClick={() => setSearch("")}
                aria-label="Clear people search"
              >
                <Icon name="x" size={12}/>
              </button>
            ) : null}
          />
        </div>

        <div className="tka-people-quick" role="group" aria-label="Quick selections">
          <Button variant={isAll ? "subtle" : "ghost"} size="xs" onClick={pickAll}>All</Button>
          <Button variant="ghost" size="xs" onClick={pickNone}>None</Button>
          {signals.activeToday && (
            <Button variant="ghost" size="xs" onClick={() => pickPreset(signals.activeToday)}>
              Active today
              <Badge tone="neutral" size="sm" className="num">{signals.activeToday.size}</Badge>
            </Button>
          )}
          {signals.currentlyIn && signals.currentlyIn.size > 0 && (
            <Button variant="ghost" size="xs" onClick={() => pickPreset(signals.currentlyIn)}>
              <span className="tka-livedot" aria-hidden="true"/>
              Currently in
              <Badge tone="neutral" size="sm" className="num">{signals.currentlyIn.size}</Badge>
            </Button>
          )}
        </div>

        <Separator/>

        <ul className="tka-people-list">
          {roster.map(u => {
            const checked  = visibleSet.has(u.id);
            const isIn     = signals.currentlyIn?.has(u.id);
            const isActive = signals.activeToday?.has(u.id);
            return (
              <li key={u.id} className={`tka-people-row ${checked ? "is-on" : ""}`}>
                <Checkbox
                  id={`${baseId}-${u.id}`}
                  checked={checked}
                  onCheckedChange={() => togglePerson(u.id)}
                  aria-label={u.name}
                />
                {/* Mouse convenience: the whole row toggles. The checkbox above
                    stays the single keyboard stop and carries the name. */}
                <span
                  className="tka-people-rowbody"
                  role="presentation"
                  onClick={() => togglePerson(u.id)}
                >
                  <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                  <span className="tka-people-name">{u.name}</span>
                  {isIn && (
                    <Badge tone="brand" size="sm">
                      <span className="tka-livedot" aria-hidden="true"/> in
                    </Badge>
                  )}
                  {!isIn && isActive && <Badge tone="neutral" size="sm">active</Badge>}
                </span>
              </li>
            );
          })}
          {roster.length === 0 && (
            <li className="tka-people-empty">
              No one matches that search. Clear it to see the full roster.
            </li>
          )}
        </ul>

        <footer className="tka-people-foot">
          <span className="tka-people-count">
            {isAll
              ? `All ${totalCount} people visible`
              : `${visibleCount} of ${totalCount} visible`}
          </span>
          <Button variant="primary" size="sm" onClick={() => setOpen(false)}>Done</Button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}
