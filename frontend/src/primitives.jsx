import React, { useState, useEffect, useRef } from "react";
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
