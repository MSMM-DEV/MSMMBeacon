import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import { companyById, userById, fmtMoney } from "./data.js";

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

// User avatar / tag
export const UserTag = ({ userId, size = "xs", nameOnly = false }) => {
  const u = userById(userId);
  if (!u) return null;
  if (nameOnly) return <span>{u.name}</span>;
  return (
    <span className="user-tag">
      <span className={`avatar ${size} ${u.color}`}>{u.initials}</span>
      <span>{u.name}</span>
    </span>
  );
};

export const UserStack = ({ ids, max = 3 }) => {
  const shown = ids.slice(0, max);
  const extra = ids.length - shown.length;
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      {shown.map((id, i) => {
        const u = userById(id);
        if (!u) return null;
        return (
          <span key={id} className={`avatar sm ${u.color}`}
                title={u.name}
                style={{ marginLeft: i === 0 ? 0 : -7, border: "2px solid var(--surface)" }}>
            {u.initials}
          </span>
        );
      })}
      {extra > 0 && (
        <span className="avatar sm" style={{
          marginLeft: -7, background: "var(--surface-2)", color: "var(--text-muted)",
          border: "2px solid var(--surface)"
        }}>+{extra}</span>
      )}
    </span>
  );
};

export const RoleChip = ({ role }) => {
  if (!role) return <span className="empty-cell">—</span>;
  return (
    <span className={`chip ${role === "Prime" ? "sage" : "blue"}`}>
      <span className="chip-dot"/>{role}
    </span>
  );
};

export const StatusChip = ({ status }) => {
  const map = {
    "Potential":        { cls: "muted",   dot: "awaiting" },
    "Awaiting Verdict": { cls: "accent",  dot: "awaiting" },
    "Awarded":          { cls: "sage",    dot: "awarded" },
    "Closed Out":       { cls: "rose",    dot: "closed" },
    "Happened":         { cls: "muted",   dot: "happened" },
    "Booked":           { cls: "blue",    dot: "booked" },
  };
  const s = map[status] || map["Potential"];
  return <span className={`chip ${s.cls}`}><span className={`status-dot ${s.dot}`}/>{status}</span>;
};

export const Money = ({ value, muted, cents }) => (
  <span className={"td-money" + (muted ? " subtle" : "")}>
    {value == null || value === "" ? <span className="empty-cell">—</span> : fmtMoney(value, cents)}
  </span>
);

export const SubsCell = ({ subs }) => {
  if (!subs || subs.length === 0) return <span className="empty-cell">—</span>;
  return (
    <span className="chip-stack trunc">
      {subs.map((s, i) => {
        const co = companyById(s.cId);
        const label = co?.name?.split(" ")[0] || s.desc || "Sub";
        return (
          <span key={i} className="chip" title={`${co?.name || s.desc} — ${s.desc || ""}: ${fmtMoney(s.amt)}`}>
            <span className="chip-dot" style={{ background: "var(--text-soft)" }}/>
            {label}{s.amt ? ` · ${fmtMoney(s.amt)}` : ""}
          </span>
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
// EditableCell — single-click to edit, supports text/number/date/
// datetime-local/textarea/select. Commits on blur or Enter (Cmd+Enter
// for textarea). Escape cancels. Select commits on change and closes.
//
// Display-mode `render(value)` > `format(value)` > raw value > "—".
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
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef();

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      // For text/number inputs, a select-all on focus is nicer for quick
      // overwrites; guard because not every element type supports it.
      if (typeof ref.current.select === "function" && (type === "text" || type === "number")) {
        try { ref.current.select(); } catch (_) { /* ignore */ }
      }
    }
  }, [editing, type]);

  useEffect(() => { setDraft(value); }, [value]);

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
    if (out !== value) {
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
      return <span className="empty-cell">{emptyLabel || placeholder || "—"}</span>;
    }
    return value;
  };

  if (!editing || disabled) {
    // Not editing (or explicitly disabled): show a display span. Single click
    // schedules an edit after a 220ms debounce — a double click cancels it
    // (and bubbles to the row for drawer open).
    return (
      <span
        onClick={(e) => {
          if (disabled) return;
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
        style={{
          cursor: disabled ? "default" : "text",
          display: "block",
          width: "100%",
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
    const finalOpts = hasEmpty ? merged : [{ value: "", label: "—" }, ...merged];

    return (
      <select
        ref={ref}
        className="cell-edit"
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
            {o.label ?? String(o.value ?? "—")}
          </option>
        ))}
      </select>
    );
  }

  if (type === "textarea") {
    return (
      <textarea
        ref={ref}
        className="cell-edit"
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
        className="cell-edit"
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
      className="cell-edit"
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
// Behavior:
//   • Input field doubles as the current-selection display (placeholder
//     shows the selected label) and a type-to-filter search box.
//   • Dropdown opens on focus / click / ArrowDown; closes on click-outside,
//     ESC, or a successful pick.
//   • ArrowUp/Down move the highlight; Enter commits the highlighted row.
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
// ----------------------------------------------------------------------
export const SearchableSelect = ({
  value,
  options,
  onChange,
  onDismiss,
  autoFocus = false,
  allowClear = true,
  placeholder = "Search…",
  inputClassName = "input",
}) => {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [menuPos, setMenuPos] = useState(null);
  const containerRef = useRef();
  const inputRef = useRef();
  const menuRef = useRef();

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
    // If near the bottom of the viewport and the preferred 260px wouldn't
    // fit, flip upward so the menu doesn't get clipped below the fold.
    const below = window.innerHeight - rect.bottom;
    const flipUp = below < 200 && rect.top > below;
    setMenuPos({
      top:  flipUp ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
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
    const onScroll = () => dismiss();
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

  const pick = (v) => {
    setQ("");
    setOpen(false);
    onChange?.(v);
  };

  const handleKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQ("");
      onDismiss?.();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted(h => Math.min(h + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) pick(filtered[highlighted].value);
    }
  };

  // Rendered menu — lives in document.body so it escapes the table's
  // overflow: hidden / stacking contexts. Position is viewport-fixed.
  const menu = open && menuPos ? createPortal(
    <div
      ref={menuRef}
      className="searchable-menu"
      style={{
        position: "fixed",
        top: menuPos.flipUp ? "auto" : menuPos.top,
        bottom: menuPos.flipUp ? (window.innerHeight - menuPos.top) : "auto",
        left: menuPos.left,
        width: menuPos.width,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {allowClear && selected && (
        <button type="button" className="searchable-item searchable-clear"
                onMouseDown={(e) => { e.preventDefault(); pick(""); }}>
          <Icon name="x" size={11}/><span>Clear selection</span>
        </button>
      )}
      {filtered.length === 0 ? (
        <div className="searchable-empty">No matches</div>
      ) : (
        filtered.slice(0, 200).map((o, i) => {
          const isSel = String(o.value) === String(value ?? "");
          const isHi  = i === highlighted;
          return (
            <button
              key={String(o.value) + ":" + i}
              type="button"
              className={
                "searchable-item"
                + (isHi  ? " searchable-hi" : "")
                + (isSel ? " searchable-sel" : "")
              }
              onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
              onMouseEnter={() => setHighlighted(i)}
            >
              {isSel && <Icon name="check" size={11}/>}
              <span className="searchable-label">{o.label}</span>
            </button>
          );
        })
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div ref={containerRef} className="searchable-select">
      <input
        ref={inputRef}
        type="text"
        className={inputClassName}
        value={q}
        placeholder={selected?.label || placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={handleKey}
        onClick={() => setOpen(true)}
        onMouseDown={(e) => e.stopPropagation()}
      />
      {menu}
    </div>
  );
};

export const Sparkline = ({ values, width = 80, height = 26 }) => {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - ((v - min) / range) * (height - 3) - 1.5]);
  const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = d + ` L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} className="stat-sparkline">
      <path d={area} className="spark-fill"/>
      <path d={d} className="spark"/>
    </svg>
  );
};

export const RowActions = ({ onForward, onAlert, forwardTitle = "Move forward" }) => (
  <div className="row-actions" onClick={e => e.stopPropagation()}>
    {onForward && (
      <button className="row-btn forward" title={forwardTitle} onClick={onForward}>
        <Icon name="forward" size={14}/>
      </button>
    )}
    <button className="row-btn alert" title="Set alert" onClick={onAlert}>
      <Icon name="bell" size={14}/>
    </button>
    <button className="row-btn" title="More">
      <Icon name="more" size={14}/>
    </button>
  </div>
);
