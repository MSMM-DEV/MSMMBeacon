import React, { useState, useEffect, useMemo, useRef, useId } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import { companyById, userById, fmtMoney } from "./data.js";
import { DEFAULT_STAR_MAX, starLabel, starOptions } from "./star-rating.js";
import { Avatar, AvatarFallback, Badge, Button, Tooltip, TooltipProvider } from "@/ui";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------
// Module-level single-cell edit debounce.
//
// EditableCell enters edit mode on single-click, but only AFTER a short
// delay so a double-click (used to open the row's detail drawer) has a
// chance to cancel it. Only one cell's debounce can be pending at a time;
// clicking a different cell cancels whatever was pending.
// ----------------------------------------------------------------------
let _pendingEditTimer = null;
const scheduleEdit = (fn) => {
  if (_pendingEditTimer) clearTimeout(_pendingEditTimer);
  _pendingEditTimer = setTimeout(() => { fn(); _pendingEditTimer = null; }, 220);
};
const cancelPendingEdit = () => {
  if (_pendingEditTimer) {
    clearTimeout(_pendingEditTimer);
    _pendingEditTimer = null;
  }
};

// ----------------------------------------------------------------------
// Shared placeholder for "this cell has no value". An EN dash, per the
// design contract — never an em dash.
// ----------------------------------------------------------------------
const EN_DASH = "–";

// `.empty-cell` is also written by hand at ~100 call sites in tables.jsx,
// so the class stays: it is the single hook that keeps every empty cell in
// the product rendering identically.
const EmptyCell = ({ label }) => (
  <span className="empty-cell select-none">{label || EN_DASH}</span>
);

// ----------------------------------------------------------------------
// Avatar tone ramp.
//
// The historic colour keys (sage / blue / rose / amber, stored per user in
// data.js) are preserved one-for-one; only the swatches move onto palette
// tokens. Each gradient runs from the 600 to the 700 step of its ramp so
// white initials clear 4.5:1 on the lightest end, in both themes.
// ----------------------------------------------------------------------
const AVATAR_TONE = {
  sage:  "bg-[linear-gradient(140deg,var(--sg-600),var(--sg-700))]",
  blue:  "bg-[linear-gradient(140deg,var(--bl-600),var(--bl-700))]",
  rose:  "bg-[linear-gradient(140deg,var(--cl-600),var(--cl-700))]",
  amber: "bg-[linear-gradient(140deg,var(--oc-600),var(--oc-700))]",
};
const avatarTone = (color) =>
  AVATAR_TONE[color] || "bg-[linear-gradient(140deg,var(--n-600),var(--n-800))]";

// UserTag/UserStack historically accepted "xs" | "sm" (plus an unnamed
// 30px default). Those map onto the kit's Avatar sizes.
const AVATAR_SIZE = { xs: "xs", sm: "sm", md: "md", lg: "lg" };

const UserAvatar = ({ user, size = "xs", className }) => (
  <Avatar
    size={AVATAR_SIZE[size] || "sm"}
    className={cn("shadow-[var(--shadow-xs)]", className)}
  >
    <AvatarFallback className={cn("text-white", avatarTone(user.color))}>
      {user.initials}
    </AvatarFallback>
  </Avatar>
);

// User avatar / tag
export const UserTag = ({ userId, size = "xs", nameOnly = false }) => {
  const u = userById(userId);
  if (!u) return null;
  if (nameOnly) return <span>{u.name}</span>;
  return (
    <span
      className={cn(
        "user-tag inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle",
        "rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--surface-2)]",
        "py-[2px] pl-[2px] pr-2",
        "text-[length:var(--fs-sm)] font-medium leading-[var(--lh-tight)] text-[var(--text)]"
      )}
    >
      <UserAvatar user={u} size={size} />
      <span className="min-w-0 truncate">{u.name}</span>
    </span>
  );
};

// Renders a row of users as avatars. The avatar already carries the person's
// initials inside the circle, so the chip does NOT repeat them as text beside
// it — printing "RP" twice per person said nothing extra and cost roughly half
// the column's width, which matters in a nine-column table. The full name is
// on hover. Wraps to extra lines when the cell is narrow; overflowing users
// collapse to "+N".
export const UserStack = ({ ids, max = 3 }) => {
  const shown = (ids || []).slice(0, max);
  const extra = (ids || []).length - shown.length;
  return (
    <span className="user-chip-stack inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1 gap-y-1 align-middle">
      {shown.map((id) => {
        const u = userById(id);
        if (!u) return null;
        return (
          <span
            key={id}
            className="user-chip inline-flex shrink-0 items-center leading-none"
            title={u.name}
          >
            <UserAvatar user={u} size="xs" />
          </span>
        );
      })}
      {extra > 0 && (
        <span
          className={cn(
            "user-chip-more num inline-flex h-5 shrink-0 items-center whitespace-nowrap px-2",
            "rounded-[var(--radius-full)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]",
            "text-[length:var(--fs-2xs)] font-semibold text-[var(--text-muted)]"
          )}
          title={`${extra} more`}
        >
          +{extra}
        </span>
      )}
    </span>
  );
};

export const RoleChip = ({ role }) => {
  if (!role) return <EmptyCell />;
  // Prime carries the "we hold the contract" signal (sage); every other
  // role is informational (steel).
  return (
    <Badge tone={role === "Prime" ? "success" : "info"} dot className="max-w-full">
      <span className="min-w-0 truncate">{role}</span>
    </Badge>
  );
};

// Product-wide semantics (see design/README §2):
//   sage    awarded / approved            clay  closed out
//   brand   awaiting a verdict, proposal  steel paused / in-between / booked
//   neutral potential, nothing has happened yet
const STATUS_TONE = {
  "Potential":        "neutral",
  "Proposal":         "brand",
  // Legacy label — rows shaped before the Proposals rename still carry it.
  "Awaiting Verdict": "brand",
  "Awarded":          "sage",
  "Closed Out":       "clay",
  "Happened":         "neutral",
  "Booked":           "steel",
  "Scheduled":        "brand",
};
// Beacon's semantic names → the kit's Badge tone names.
const BADGE_TONE = {
  neutral: "neutral",
  brand:   "brand",
  sage:    "success",
  clay:    "danger",
  steel:   "info",
};

export const StatusChip = ({ status }) => {
  const tone = STATUS_TONE[status] || STATUS_TONE["Potential"];
  return (
    <Badge tone={BADGE_TONE[tone]} dot className="max-w-full">
      <span className="min-w-0 truncate">{status || EN_DASH}</span>
    </Badge>
  );
};

export const Money = ({ value, muted, cents }) => (
  <span
    className={cn(
      // `.num` is the product-wide hook for tabular figures.
      "td-money num block w-full min-w-0 text-right tabular-nums",
      muted ? "subtle text-[var(--text-muted)]" : "text-[var(--text)]"
    )}
  >
    {value == null || value === "" ? <EmptyCell /> : fmtMoney(value, cents)}
  </span>
);

// Star glyph sizes, keyed on the historic `size` prop.
const STAR_PX = { sm: 12, md: 15, lg: 18 };

// Star rating: hover previews, click commits, click the active star to clear.
// `value` is 1-max or null. `onChange` receives a number 1-max or null.
// Read-only mode (no onChange) renders just the glyphs.
//
// The `stars` / `stars-set-N` / `star-btn` class names are load-bearing:
// styles.css owns the 1–5 colour ramp and the hot-lead 3-star guard keyed
// off them, so the markup contract is preserved and only the glyph and the
// interaction chrome are rebuilt.
export const StarRating = ({ value, onChange, size = "md", title, max = DEFAULT_STAR_MAX }) => {
  const [hover, setHover] = useState(null);
  const editable = typeof onChange === "function";
  const active = hover != null ? hover : (value || 0);
  const stars = starOptions(max);
  const px = STAR_PX[size] || STAR_PX.md;
  const click = (n) => {
    if (!editable) return;
    onChange(n === value ? null : n);
  };
  return (
    <span
      className={cn(
        `stars stars-${size}${editable ? " stars-editable" : ""}${value ? ` stars-set stars-set-${value}` : " stars-unset"}`,
        "inline-flex items-center gap-px align-middle leading-none"
      )}
      // Editable ratings are a single-choice control; read-only ratings are
      // one image whose label already carries "N of M stars", so the
      // per-glyph buttons are hidden from the accessibility tree.
      role={editable ? "radiogroup" : "img"}
      aria-label={title || starLabel(value, max)}
      onMouseLeave={editable ? () => setHover(null) : undefined}
      onClick={editable ? (e) => e.stopPropagation() : undefined}
    >
      {stars.map(n => (
        <button
          key={n}
          type="button"
          className={cn(
            "star-btn inline-grid place-items-center rounded-[var(--radius-xs)] p-[2px] leading-none",
            "transition-[color,background-color] duration-[var(--dur-instant)] ease-[var(--ease-out)]",
            "disabled:pointer-events-none",
            // NOTE: the "on" colour is intentionally left to styles.css so
            // the per-rating ramp (--stars-1 … --stars-5) keeps applying.
            n <= active ? "on" : "text-[var(--border-strong)] focus-visible:text-[var(--accent)]",
            editable && "hover:bg-[color-mix(in_oklab,currentColor_10%,transparent)]"
          )}
          onMouseEnter={editable ? () => setHover(n) : undefined}
          onFocus={editable ? () => setHover(n) : undefined}
          onClick={editable ? () => click(n) : undefined}
          tabIndex={editable ? 0 : -1}
          role={editable ? "radio" : undefined}
          aria-checked={editable ? value === n : undefined}
          aria-label={editable ? starLabel(n, max) : undefined}
          aria-hidden={editable ? undefined : "true"}
          disabled={!editable}
        >
          <Icon name="star" size={px} stroke={1.6} fill={n <= active ? "currentColor" : "none"} />
        </button>
      ))}
      {editable && value != null && (
        <button
          type="button"
          className={cn(
            "stars-clear ml-1 inline-grid size-4 shrink-0 place-items-center",
            "rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--surface-2)]",
            "text-[var(--text-soft)]",
            "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
            "hover:border-[var(--rose-line)] hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]",
            "focus-visible:opacity-100 active:translate-y-px"
          )}
          onClick={() => onChange(null)}
          title="Clear rating"
          aria-label="Clear rating"
        >
          <Icon name="x" size={10} stroke={2.25} />
        </button>
      )}
    </span>
  );
};

export const SubsCell = ({ subs, wrap = false }) => {
  if (!subs || subs.length === 0) return <EmptyCell />;
  return (
    <span
      className={cn(
        "chip-stack flex min-w-0 max-w-full items-center gap-1",
        wrap ? "flex-wrap" : "trunc flex-nowrap overflow-hidden"
      )}
    >
      {subs.map((s, i) => {
        const co = companyById(s.cId);
        const label = co?.name?.split(" ")[0] || s.desc || "Sub";
        const amount = s.amt ? fmtMoney(s.amt, false) : "";
        // Full detail lives in the tooltip so the chip itself can shrink to
        // nothing at 360px without ever pushing the cell wider.
        const tip = [co?.name || s.desc || "Sub", s.desc, amount]
          .filter(Boolean)
          .join(" · ");
        return (
          <Badge
            key={i}
            tone="neutral"
            dot
            className="min-w-0 shrink basis-auto"
            title={tip}
          >
            <span className="min-w-0 truncate">{label}</span>
            {amount && (
              <span className="num shrink-0 font-normal opacity-70">{amount}</span>
            )}
          </Badge>
        );
      })}
    </span>
  );
};

// ----------------------------------------------------------------------
// Normalize a single entry of the `options` prop for select-type edit.
//   - strings   → { value: s, label: s }
//   - object    → passthrough (expects at minimum { value, label })
// ----------------------------------------------------------------------
const normOption = (o) =>
  (typeof o === "string") ? { value: o, label: o } : o;

// ----------------------------------------------------------------------
// Editable-cell chrome.
//
// The problem this solves: in a forty-column table an editable cell and a
// read-only one look identical until you click. So an editable cell now
// carries a dashed hairline that only materialises when the pointer is
// over its ROW (the ambient hint), firms up under the pointer itself, and
// becomes a real inset field on hover. Nothing is drawn at rest, so a
// dense grid still reads as a grid.
//
// `-mx-1 px-1 / -my-[3px] py-[3px]` keeps the glyphs exactly where they
// were: the hit/paint box grows outward, the text does not move.
// ----------------------------------------------------------------------
const CELL_DISPLAY_BASE = cn(
  "block w-full min-w-0",
  "-mx-1 -my-[3px] px-1 py-[3px]",
  "rounded-[var(--radius-xs)] border border-dashed border-transparent",
  "transition-[background-color,border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]"
);

const CELL_DISPLAY_EDITABLE = cn(
  "cursor-text",
  // Ambient hint: the whole row's editable cells outline together on row
  // hover, in both the div-grid tables (.trow) and the invoice <table>.
  "[.trow:hover_&]:border-[var(--border)]",
  "[tr:hover_&]:border-[var(--border)]",
  "hover:border-[var(--border-strong)] hover:bg-[var(--surface)] hover:shadow-[var(--shadow-xs)]",
  "active:bg-[var(--surface-2)] active:shadow-none"
);

const CELL_DISPLAY_BLOCKED = "cursor-not-allowed hover:border-[var(--border)]";
const CELL_DISPLAY_READONLY = "cursor-default";

// Edit-mode field. `.cell-edit` is kept because styles.css still supplies
// `font: inherit` (so the field adopts whatever type size the column set)
// and because admin.jsx reuses the class for its own in-row combobox.
const CELL_EDIT = cn(
  "cell-edit block w-full min-w-0 -mx-1 px-1 py-[3px] h-auto",
  "min-h-[calc(var(--row-h)_-_2_*_var(--row-pad-y))]",
  "rounded-[var(--radius-xs)] border-0 bg-[var(--surface)] text-[var(--text)]",
  "outline-none",
  "shadow-[0_0_0_1px_var(--accent-solid),0_0_0_3px_color-mix(in_oklab,var(--accent-solid)_20%,transparent)]",
  "placeholder:text-[var(--text-soft)]",
  // Real invalid state, driven by the browser's own constraint validation
  // (a half-typed number, an impossible date) rather than a second copy of
  // the value in React state.
  "user-invalid:shadow-[0_0_0_1px_var(--destructive),0_0_0_3px_color-mix(in_oklab,var(--destructive)_20%,transparent)]",
  "disabled:cursor-not-allowed disabled:opacity-45"
);

// ----------------------------------------------------------------------
// EditableCell — single-click to edit, supports text/number/date/
// datetime-local/textarea/select. Commits on blur or Enter (Cmd+Enter
// for textarea). Escape cancels. Select commits on change and closes.
//
// Display-mode `render(value)` > `format(value)` > raw value > en dash.
// ----------------------------------------------------------------------
export const EditableCell = ({
  value,
  onChange,
  type = "text",
  options,
  align = "left",
  format,
  render,
  placeholder,
  disabled = false,
  emptyLabel,
  onBlocked,   // when disabled: called on click (e.g. a toast) instead of silently ignoring
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [userQuery, setUserQuery] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const ref = useRef();
  const userListId = useId();

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      // For text/number inputs, a select-all on focus is nicer for quick
      // overwrites; guard because not every element type supports it.
      if (typeof ref.current.select === "function" && (type === "text" || type === "number")) {
        try { ref.current.select(); } catch (_) { /* ignore */ }
      }
    }
    if (editing && type === "users") {
      setUserQuery("");
      setUserMenuOpen(true);
    }
  }, [editing, type]);

  useEffect(() => { setDraft(value); }, [value]);

  const sameValue = (a, b) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      const aa = Array.isArray(a) ? a : [];
      const bb = Array.isArray(b) ? b : [];
      return aa.length === bb.length && aa.every((x, i) => x === bb[i]);
    }
    return a === b;
  };

  const closeNoChange = () => {
    setDraft(value);
    setEditing(false);
  };

  const commitValue = (v) => {
    setEditing(false);
    // Normalize empty/blank values: treat "" as null for non-text-ish cells.
    let out;
    if (type === "number") {
      out = (v === "" || v == null) ? null : Number(v);
    } else if (type === "select") {
      out = (v === "" || v == null) ? null : v;
    } else {
      out = v;
    }
    if (!sameValue(out, value)) {
      if (typeof onChange === "function") onChange(out);
    }
  };

  const commitFromDraft = () => commitValue(draft);

  // ------------------------------------------------------------------
  // Display mode
  // ------------------------------------------------------------------
  const renderDisplay = () => {
    if (render) return render(value);
    if (format) return format(value);
    if (value == null || value === "") {
      return <EmptyCell label={emptyLabel || placeholder} />;
    }
    return value;
  };

  if (!editing || disabled) {
    // Not editing (or explicitly disabled): show a display span. Single click
    // schedules an edit after a 220ms debounce — a double click cancels it
    // (and bubbles to the row for drawer open).
    return (
      <span
        className={cn(
          CELL_DISPLAY_BASE,
          disabled
            ? (onBlocked ? CELL_DISPLAY_BLOCKED : CELL_DISPLAY_READONLY)
            : CELL_DISPLAY_EDITABLE
        )}
        data-editable={disabled ? undefined : "true"}
        onClick={(e) => {
          if (disabled) {
            // A blocked (read-only) cell can still explain why — e.g. a toast —
            // rather than silently doing nothing on click.
            if (onBlocked) { e.stopPropagation(); onBlocked(); }
            return;
          }
          // Do NOT stopPropagation here — but dblclick isn't affected by
          // stopPropagation on click, and the row uses onDoubleClick.
          e.stopPropagation();
          scheduleEdit(() => setEditing(true));
        }}
        onDoubleClick={() => {
          // Cancel the pending click-edit so the row's dblclick handler
          // opens the drawer instead. Intentionally NO stopPropagation.
          cancelPendingEdit();
        }}
      >
        {renderDisplay()}
      </span>
    );
  }

  // ------------------------------------------------------------------
  // Edit mode
  // ------------------------------------------------------------------
  const stopRowEvents = {
    onClick: (e) => e.stopPropagation(),
    onMouseDown: (e) => e.stopPropagation(),
    onDoubleClick: (e) => e.stopPropagation(),
  };

  if (type === "users") {
    const raw = Array.isArray(options) ? options.map(normOption) : [];
    const ids = Array.isArray(draft) ? draft : [];
    const selected = ids
      .map(id => raw.find(o => o.value === id) || { value: id, label: userById(id)?.name || id })
      .filter(Boolean);
    const available = raw.filter(o =>
      !ids.includes(o.value) &&
      (!userQuery || String(o.label || "").toLowerCase().includes(userQuery.toLowerCase()))
    );
    const commitUsers = (nextIds) => {
      setDraft(nextIds);
      if (!sameValue(nextIds, value) && typeof onChange === "function") onChange(nextIds);
    };
    const closeUsers = () => {
      window.setTimeout(() => {
        setUserMenuOpen(false);
        setEditing(false);
      }, 140);
    };
    const addUser = (uid) => {
      if (!uid || ids.includes(uid)) return;
      commitUsers([...ids, uid]);
      setUserQuery("");
      setUserMenuOpen(true);
    };

    return (
      <div
        className={cn(
          "tag-input cell-user-edit relative flex w-full min-w-0 flex-wrap items-center gap-1 p-1",
          "rounded-[var(--radius-xs)] border-0 bg-[var(--surface)]",
          "min-h-[calc(var(--row-h)_-_2_*_var(--row-pad-y))]",
          "shadow-[0_0_0_1px_var(--accent-solid),0_0_0_3px_color-mix(in_oklab,var(--accent-solid)_20%,transparent)]"
        )}
        {...stopRowEvents}
      >
        {selected.map(o => {
          const u = userById(o.value);
          const label = u?.shortName || o.label;
          return (
            <span
              key={o.value}
              className={cn(
                "tag inline-flex min-w-0 items-center gap-1 py-[2px] pl-[2px] pr-[2px]",
                "rounded-[var(--radius-full)] border border-[var(--accent-line)] bg-[var(--accent-softer)]",
                "text-[length:var(--fs-xs)] font-medium leading-none text-[var(--accent-ink)]"
              )}
            >
              {u && <UserAvatar user={u} size="xs" />}
              <span className="min-w-0 truncate">{label}</span>
              <button
                type="button"
                className={cn(
                  "inline-grid size-4 shrink-0 place-items-center rounded-[var(--radius-full)]",
                  "text-[var(--accent-ink)] opacity-60",
                  "transition-[background-color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                  "hover:bg-[var(--accent-soft)] hover:opacity-100 focus-visible:opacity-100"
                )}
                aria-label={`Remove ${label}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  commitUsers(ids.filter(x => x !== o.value));
                }}
              >
                <Icon name="x" size={10} stroke={2.25}/>
              </button>
            </span>
          );
        })}
        <input
          ref={ref}
          className={cn(
            "min-w-[64px] flex-1 border-0 bg-transparent px-1 py-[2px] outline-none",
            "text-[length:var(--fs-sm)] text-[var(--text)] placeholder:text-[var(--text-soft)]"
          )}
          value={userQuery}
          placeholder={ids.length ? "Add…" : (placeholder || "Pick users…")}
          role="combobox"
          aria-expanded={userMenuOpen && available.length > 0}
          aria-controls={userMenuOpen && available.length > 0 ? userListId : undefined}
          aria-autocomplete="list"
          aria-label={placeholder || "Pick users"}
          onChange={(e) => { setUserQuery(e.target.value); setUserMenuOpen(true); }}
          onFocus={() => setUserMenuOpen(true)}
          onBlur={closeUsers}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setUserMenuOpen(false);
              setEditing(false);
            } else if (e.key === "Enter" && available[0]) {
              e.preventDefault();
              addUser(available[0].value);
            }
          }}
        />
        {userMenuOpen && available.length > 0 && (
          <div
            id={userListId}
            role="listbox"
            aria-label="Matching users"
            className={cn(
              "menu cell-user-menu absolute left-0 top-[calc(100%+4px)] z-[70] m-0 max-h-[230px] min-w-[200px] overflow-y-auto overscroll-contain",
              "rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-1",
              "shadow-[var(--shadow-lg)]"
            )}
          >
            {available.slice(0, 8).map(o => {
              const u = userById(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected="false"
                  tabIndex={-1}
                  className={cn(
                    "menu-item flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-left",
                    "text-[length:var(--fs-sm)] text-[var(--text)]",
                    "transition-colors duration-[var(--dur-instant)] ease-[var(--ease-out)]",
                    "hover:bg-[var(--surface-2)]"
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addUser(o.value);
                  }}
                >
                  {u && <UserAvatar user={u} size="xs" />}
                  <span className="min-w-0 truncate">{o.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (type === "combobox") {
    // Searchable single-select. onChange fires on pick (commits + exits
    // edit mode); onDismiss (ESC / click-outside) restores display mode
    // without change. The combobox autoFocuses its internal input.
    const raw = Array.isArray(options) ? options.map(normOption) : [];
    return (
      <div onMouseDown={(e) => e.stopPropagation()}
           onClick={(e) => e.stopPropagation()}
           style={{ width: "100%" }}>
        <SearchableSelect
          value={draft ?? ""}
          options={raw}
          autoFocus
          inputClassName="cell-edit"
          onChange={(v) => commitValue(v)}
          onDismiss={closeNoChange}
        />
      </div>
    );
  }

  if (type === "select") {
    const raw = Array.isArray(options) ? options.map(normOption) : [];
    // Ensure the current value is represented so React doesn't warn about
    // uncontrolled → controlled flips or a missing <option>.
    const hasCurrent = raw.some(o => String(o.value) === String(draft ?? ""));
    const merged = (draft != null && draft !== "" && !hasCurrent)
      ? [{ value: draft, label: String(draft) }, ...raw]
      : raw;
    // Auto-prepend an empty option (unless one is already declared with
    // value === "" or value == null).
    const hasEmpty = merged.some(o => o.value === "" || o.value == null);
    const finalOpts = hasEmpty ? merged : [{ value: "", label: EN_DASH }, ...merged];

    return (
      <select
        ref={ref}
        className={cn(CELL_EDIT, "cursor-pointer")}
        value={draft ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          commitValue(v);
        }}
        onBlur={commitFromDraft}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); closeNoChange(); }
        }}
        style={{ textAlign: align }}
        {...stopRowEvents}
      >
        {finalOpts.map((o, i) => (
          <option key={String(o.value) + ":" + i} value={o.value ?? ""}>
            {o.label ?? String(o.value ?? EN_DASH)}
          </option>
        ))}
      </select>
    );
  }

  if (type === "textarea") {
    return (
      <textarea
        ref={ref}
        className={cn(CELL_EDIT, "leading-[var(--lh-snug)]")}
        defaultValue={value || ""}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitFromDraft}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter commits; plain Enter inserts a newline.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commitFromDraft();
          } else if (e.key === "Escape") {
            e.preventDefault();
            closeNoChange();
          }
        }}
        style={{ textAlign: align, resize: "vertical" }}
        {...stopRowEvents}
      />
    );
  }

  if (type === "date" || type === "datetime-local") {
    return (
      <input
        ref={ref}
        type={type}
        className={CELL_EDIT}
        defaultValue={value || ""}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitFromDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commitFromDraft(); }
          else if (e.key === "Escape") { e.preventDefault(); closeNoChange(); }
        }}
        style={{ textAlign: align, fontFamily: "var(--font-mono)" }}
        {...stopRowEvents}
      />
    );
  }

  // text / number (default)
  return (
    <input
      ref={ref}
      type={type}
      className={cn(CELL_EDIT, type === "number" && "num tabular-nums")}
      defaultValue={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitFromDraft}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commitFromDraft(); }
        else if (e.key === "Escape") { e.preventDefault(); closeNoChange(); }
      }}
      style={{ textAlign: align }}
      {...stopRowEvents}
    />
  );
};

// ----------------------------------------------------------------------
// SearchableSelect — single-select combobox with typeahead.
//
// Replaces the native <select> in two places:
//   • Client cells on every project table (via EditableCell type="combobox")
//   • Any clientId / sub-company picker in drawers and create forms
// Native selects become unwieldy past ~15 options and give zero search —
// typing a letter only cycles through first-letter matches.
//
// Why this still hand-rolls its portal instead of using <Popover> from
// @/ui: the text input is the persistent focus owner and lives OUTSIDE the
// popup, so Radix's DismissableLayer would have to be told to ignore both
// focus-outside and pointer-down-on-the-anchor, and its
// reposition-on-scroll would replace the capture-phase scroll dismissal
// that EditableCell depends on to leave edit mode. Either change would
// alter when `onDismiss` fires, which is part of this component's
// contract. The portal is kept; the chrome, the ARIA and the collision
// handling are what got rebuilt.
//
// Behavior:
//   • Input field doubles as the current-selection display (placeholder
//     shows the selected label) and a type-to-filter search box.
//   • Dropdown opens on focus / click / ArrowDown; closes on click-outside,
//     ESC, or a successful pick.
//   • ArrowUp/Down move the highlight (Home/End jump to the ends); Enter
//     commits the highlighted row.
//   • The currently-selected value is marked in the list so users never
//     wonder "is this still the selected client?".
//   • Option list renders the first 200 matches — keeps the DOM light on
//     roster-sized lists without ever hiding "a few" visible matches.
//
// Props:
//   value       : current id (string) or null
//   options     : [{ value, label }, …]
//   onChange(v) : called on pick; v="" means "cleared"
//   onDismiss   : optional — called when the user closes without picking
//                 (ESC / click-outside). EditableCell uses this to exit
//                 edit mode when the user backs out.
//   autoFocus   : focus the input on mount
//   allowClear  : show a "Clear selection" row when a value is selected
//   placeholder : shown when no value is selected
//   inputClassName : override "input" for styling inside a table cell
//   onCreate(q) : optional — when provided, the menu shows a "+ Create …"
//                 action row (passing the current query) so callers can offer
//                 inline creation of a missing option. Purely additive: with no
//                 onCreate prop the combobox behaves exactly as before.
//   createLabel : label for the create row when the query is empty
// ----------------------------------------------------------------------
const SEARCHABLE_ITEM = cn(
  "searchable-item flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-[6px]",
  "bg-transparent text-left text-[length:var(--fs-sm)] leading-[var(--lh-snug)]",
  "cursor-pointer transition-colors duration-[var(--dur-instant)] ease-[var(--ease-out)]"
);

export const SearchableSelect = ({
  value,
  options,
  onChange,
  onDismiss,
  autoFocus = false,
  allowClear = true,
  placeholder = "Search…",
  inputClassName = "input",
  onCreate = null,
  createLabel = "Create new",
}) => {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [menuPos, setMenuPos] = useState(null);
  const containerRef = useRef();
  const inputRef = useRef();
  const menuRef = useRef();
  const listId = useId();

  const opts = Array.isArray(options) ? options : [];
  const selected = opts.find(o => String(o.value) === String(value ?? ""));

  const filtered = useMemo(() => {
    if (!q) return opts;
    const needle = q.toLowerCase();
    return opts.filter(o => (o.label || "").toLowerCase().includes(needle));
  }, [q, opts]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      setOpen(true);
    }
  }, [autoFocus]);

  // Recompute menu position whenever it opens. The menu lives in a portal
  // (document.body), so it needs an absolute top/left in viewport space.
  // Snapshotting on open is good enough for a transient dropdown — scroll
  // listeners below close it rather than chase the input, so position
  // never drifts during its lifetime.
  useEffect(() => {
    if (!open || !inputRef.current) { setMenuPos(null); return; }
    const rect = inputRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // If near the bottom of the viewport and the preferred 260px wouldn't
    // fit, flip upward so the menu doesn't get clipped below the fold.
    const below = vh - rect.bottom;
    const flipUp = below < 200 && rect.top > below;
    // A client cell can be 90px wide; the menu is allowed to grow past it
    // (and is then clamped back inside the viewport) so long names stay
    // readable at 360px.
    const minWidth = Math.min(260, Math.max(160, vw - 16));
    const effective = Math.max(rect.width, minWidth);
    const left = Math.max(8, Math.min(rect.left, vw - effective - 8));
    const maxHeight = Math.max(140, (flipUp ? rect.top : below) - 12);
    setMenuPos({
      top:  flipUp ? rect.top - 4 : rect.bottom + 4,
      left,
      width: rect.width,
      minWidth,
      maxHeight,
      flipUp,
    });
  }, [open]);

  // Dismiss on: (a) click outside both the input container AND the menu,
  // (b) any scroll in an ancestor (use capture-phase to catch .table-scroll,
  // the page itself, etc.), (c) window resize.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setQ("");
      onDismiss?.();
    };
    const onDoc = (e) => {
      if (containerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      dismiss();
    };
    // An ANCESTOR scrolling has to dismiss: the menu is position:fixed, so the
    // anchor slides out from under it and the two visibly come apart. The
    // menu's OWN scroll moves nothing and must not dismiss, or the list closes
    // the instant the user reaches for an option below the fold — with 163
    // clients in a 323px menu, that is most of them. Scroll events do not
    // bubble, but they do reach a capture-phase listener on window, so the
    // menu's own scroll lands here and has to be filtered out explicitly.
    const onScroll = (e) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      dismiss();
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, onDismiss]);

  useEffect(() => { setHighlighted(0); }, [filtered.length]);

  // Keep the keyboard highlight inside the scroll viewport. Purely visual —
  // it never changes which option Enter would commit.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const el = menuRef.current.querySelector('[data-hi="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted, filtered.length]);

  const pick = (v) => {
    setQ("");
    setOpen(false);
    onChange?.(v);
  };

  const lastIndex = Math.max(0, filtered.length - 1);

  const handleKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQ("");
      onDismiss?.();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted(h => Math.min(h + 1, lastIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setOpen(true);
      setHighlighted(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setOpen(true);
      setHighlighted(lastIndex);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) pick(filtered[highlighted].value);
    }
  };

  const shownItems = filtered.slice(0, 200);
  const activeId = open && shownItems[highlighted] ? `${listId}-opt-${highlighted}` : undefined;

  // Rendered menu — lives in document.body so it escapes the table's
  // overflow: hidden / stacking contexts. Position is viewport-fixed.
  const menu = open && menuPos ? createPortal(
    <div
      ref={menuRef}
      id={listId}
      role="listbox"
      className={cn(
        "searchable-menu overflow-y-auto overscroll-contain p-1",
        "rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]",
        "shadow-[var(--shadow-lg)]"
      )}
      style={{
        position: "fixed",
        top: menuPos.flipUp ? "auto" : menuPos.top,
        bottom: menuPos.flipUp ? (window.innerHeight - menuPos.top) : "auto",
        left: menuPos.left,
        width: menuPos.width,
        minWidth: menuPos.minWidth,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: menuPos.maxHeight,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {allowClear && selected && (
        <button type="button"
                tabIndex={-1}
                className={cn(
                  SEARCHABLE_ITEM,
                  "searchable-clear mb-1 rounded-b-none border-b border-dashed border-[var(--border)]",
                  "text-[var(--text-soft)] hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]"
                )}
                onMouseDown={(e) => { e.preventDefault(); pick(""); }}>
          <span className="grid w-3.5 shrink-0 place-items-center"><Icon name="x" size={12}/></span>
          <span className="searchable-label min-w-0 flex-1 truncate">Clear selection</span>
        </button>
      )}
      {shownItems.length === 0 && !onCreate ? (
        <div className="searchable-empty px-3 py-2.5 text-center text-[length:var(--fs-sm)] italic text-[var(--text-soft)]">
          No matches
        </div>
      ) : (
        shownItems.map((o, i) => {
          const isSel = String(o.value) === String(value ?? "");
          const isHi  = i === highlighted;
          return (
            <button
              key={String(o.value) + ":" + i}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={isSel}
              data-hi={isHi ? "true" : undefined}
              tabIndex={-1}
              type="button"
              className={cn(
                SEARCHABLE_ITEM,
                isSel ? "searchable-sel font-semibold text-[var(--accent-ink)]" : "text-[var(--text)]",
                isSel
                  ? (isHi ? "bg-[var(--accent-soft)]" : "bg-[var(--accent-softer)]")
                  : (isHi ? "bg-[var(--surface-2)]" : "bg-transparent"),
                isHi && "searchable-hi",
                !isSel && "hover:bg-[var(--surface-2)]"
              )}
              onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
              onMouseEnter={() => setHighlighted(i)}
            >
              <span className="grid w-3.5 shrink-0 place-items-center text-[var(--accent)]">
                {isSel ? <Icon name="check" size={12}/> : null}
              </span>
              <span className="searchable-label min-w-0 flex-1 truncate">{o.label}</span>
            </button>
          );
        })
      )}
      {onCreate && (
        <button
          type="button"
          tabIndex={-1}
          className={cn(
            SEARCHABLE_ITEM,
            "searchable-create font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-softer)]",
            shownItems.length && "has-divider mt-1 rounded-t-none border-t border-dashed border-[var(--border)]"
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            const term = q.trim();
            setQ(""); setOpen(false);
            onCreate(term);
          }}
        >
          <span className="grid w-3.5 shrink-0 place-items-center text-[var(--accent)]">
            <Icon name="plus" size={12}/>
          </span>
          <span className="searchable-label min-w-0 flex-1 truncate">
            {q.trim() ? `Create “${q.trim()}”` : createLabel}
          </span>
        </button>
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div ref={containerRef} className="searchable-select relative w-full">
      <input
        ref={inputRef}
        type="text"
        className={cn(
          // `cell-edit` is the in-table variant; it gets the same field
          // chrome an EditableCell input would have, so a combobox cell and
          // a text cell look identical while being edited.
          inputClassName === "cell-edit" ? CELL_EDIT : inputClassName,
          "w-full min-w-0 pr-6",
          // When something IS selected the label sits in the placeholder
          // slot, so it has to read as a committed value, not a hint.
          selected
            ? "placeholder:font-medium placeholder:text-[var(--text)] placeholder:opacity-100"
            : "placeholder:text-[var(--text-soft)]"
        )}
        value={q}
        placeholder={selected?.label || placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={handleKey}
        onClick={() => setOpen(true)}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--text-soft)]",
          "transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          open && "rotate-180"
        )}
      >
        <Icon name="chevronDown" size={13}/>
      </span>
      {menu}
    </div>
  );
};

export const Sparkline = ({ values, width = 80, height = 26 }) => {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - ((v - min) / range) * (height - 3) - 1.5]);
  const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = d + ` L${width},${height} L0,${height} Z`;
  const tip = pts[pts.length - 1];
  const label = `Trend sparkline, ${values.length} points`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="stat-sparkline"
      role="img"
      aria-label={label}
      focusable="false"
    >
      <title>{label}</title>
      <defs>
        {/* Token-driven so the wash reads correctly on warm paper and on
            warm charcoal without a second definition. */}
        <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.26"/>
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} className="spark-fill" style={{ fill: `url(#spark-${gid})`, opacity: 1 }}/>
      <path
        d={d}
        className="spark"
        style={{
          fill: "none",
          stroke: "var(--accent)",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
      {tip && Number.isFinite(tip[0]) && Number.isFinite(tip[1]) && (
        <circle
          cx={Math.min(tip[0], width - 2)}
          cy={tip[1]}
          r={2}
          style={{ fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 1 }}
        />
      )}
    </svg>
  );
};

// ----------------------------------------------------------------------
// RowActions — the hover-revealed action cluster at the end of a table row.
// `.row-actions` is kept because styles.css owns the reveal (opacity 0 →
// 1 on `.trow:hover`, always-on for coarse pointers) and the total-row
// suppression. Focus-within is added here so a keyboard user does not tab
// into invisible controls.
// ----------------------------------------------------------------------
const ROW_ACTION_TOUCH = "pointer-coarse:size-9";

const RowActionButton = ({ label, onClick, className, children }) => (
  <Tooltip label={label}>
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={onClick}
      className={cn(ROW_ACTION_TOUCH, "rounded-[var(--radius-sm)]", className)}
    >
      {children}
    </Button>
  </Tooltip>
);

export const RowActions = ({ onForward, onAlert, forwardTitle = "Move forward" }) => (
  <TooltipProvider delayDuration={300} skipDelayDuration={200}>
    <div
      className="row-actions flex items-center justify-end gap-0.5 focus-within:opacity-100"
      onClick={e => e.stopPropagation()}
    >
      {onForward && (
        <RowActionButton
          label={forwardTitle}
          onClick={onForward}
          className="hover:bg-[var(--accent-soft)] hover:text-[var(--accent-ink)]"
        >
          <Icon name="forward" size={14}/>
        </RowActionButton>
      )}
      <RowActionButton
        label="Set alert"
        onClick={onAlert}
        className="hover:bg-[var(--blue-soft)] hover:text-[var(--blue-ink)]"
      >
        <Icon name="bell" size={14}/>
      </RowActionButton>
      <RowActionButton label="More">
        <Icon name="more" size={14}/>
      </RowActionButton>
    </div>
  </TooltipProvider>
);
