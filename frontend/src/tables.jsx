import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import {
  EditableCell, RoleChip, StatusChip, UserTag, UserStack, SubsCell, RowActions,
  StarRating,
} from "./primitives.jsx";
import {
  getCompanies, getClientsOnly, getCompaniesOnly, getUsers,
  buildClientOrCompanyOptions,
  companyById, userById,
  fmtMoney, fmtDate, fmtDateTime,
  MONTHS, TODAY_MONTH, THIS_YEAR, isActualInvoiceMonth, ATTACH_ONLY_ON_ACTUAL,
  linkedProjectsFor,
  BID_SERVICE_OPTIONS,
} from "./data.js";
import { LinkedProjectsSection } from "./panels.jsx";
import { setCurrentTableSnapshot } from "./table-state.js";

// 1 → "1st", 2 → "2nd", 5 → "5th", 22 → "22nd". Used by the Invoice tab's
// Actual/Projection legend to phrase the configurable cutover day.
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

// ---------- Shared empty state ----------
export const EmptyState = ({ title, hint, iconName }) => (
  <div style={{
    minHeight: 280,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "32px 24px",
    textAlign: "center",
  }}>
    {iconName && (
      <div style={{
        width: 48, height: 48,
        borderRadius: "50%",
        background: "var(--surface-2)",
        display: "grid",
        placeItems: "center",
        color: "var(--text-muted)",
        marginBottom: 4,
      }}>
        <Icon name={iconName} size={22}/>
      </div>
    )}
    <div style={{ fontWeight: 500, fontSize: 14, color: "var(--text)" }}>{title}</div>
    {hint && <div style={{ fontSize: 12.5, color: "var(--text-soft)", maxWidth: 420 }}>{hint}</div>}
  </div>
);

// ---------- Sort helpers ----------
const cmp = (a, b) => {
  const aNil = a == null || a === "";
  const bNil = b == null || b === "";
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // Try date parse for ISO-ish strings
  if (typeof a === "string" && typeof b === "string") {
    const ad = Date.parse(a), bd = Date.parse(b);
    if (!isNaN(ad) && !isNaN(bd) && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) {
      return ad - bd;
    }
    return a.localeCompare(b);
  }
  return String(a).localeCompare(String(b));
};

const sortRows = (rows, sort, columns) => {
  if (!sort?.key || !sort?.dir) return rows;
  const col = columns.find(c => c.sortKey === sort.key);
  if (!col) return rows;
  const getter = col.sortValue || (r => r[sort.key]);
  const sorted = rows.slice().sort((a, b) => cmp(getter(a), getter(b)));
  return sort.dir === "desc" ? sorted.reverse() : sorted;
};

// Build a composite list of { key, dir } entries that combines the table's
// fixed `primarySort` (if any) with the user's active sort:
//   - Primary entries render in their declared order, each keeping its declared
//     direction — UNLESS the user's sort key matches a primary entry, in which
//     case that entry uses the user's direction.
//   - If the user's sort key is NOT in the primary list, the user's sort is
//     inserted at position 1 (immediately after the first primary entry) so
//     that the user's choice acts as a secondary tie-breaker within the first
//     primary bucket.
//   - If there's no primary and no user sort, the result is an empty list and
//     callers should leave the row order untouched.
const buildEffectiveSort = (primary, user) => {
  const userActive = !!(user?.key && user?.dir);
  const primList = Array.isArray(primary) ? primary : [];
  const userInPrimary = userActive && primList.some(p => p.key === user.key);
  const result = [];
  for (let i = 0; i < primList.length; i++) {
    const p = primList[i];
    if (userActive && user.key === p.key) {
      result.push({ key: p.key, dir: user.dir });
    } else {
      result.push({ key: p.key, dir: p.dir });
    }
    if (i === 0 && userActive && !userInPrimary) {
      result.push({ key: user.key, dir: user.dir });
    }
  }
  if (primList.length === 0 && userActive) {
    result.push({ key: user.key, dir: user.dir });
  }
  return result;
};

// Build a comparator from a list of effective sort entries. Walks entries in
// order and returns the first non-zero comparison. Honors per-column
// `sortValue` getters, same as single-column sortRows().
const compositeComparator = (entries, columns) => (a, b) => {
  for (const s of entries) {
    if (!s.key || !s.dir) continue;
    const col = columns.find(c => c.sortKey === s.key);
    if (!col) continue;
    const getter = col.sortValue || (r => r[s.key]);
    const diff = cmp(getter(a), getter(b));
    if (diff !== 0) return s.dir === "desc" ? -diff : diff;
  }
  return 0;
};

const nextSortDir = (cur, key, newKey) => {
  if (cur.key !== newKey) return { key: newKey, dir: "asc" };
  if (cur.dir === "asc") return { key: newKey, dir: "desc" };
  if (cur.dir === "desc") return { key: null, dir: null };
  return { key: newKey, dir: "asc" };
};

// Short helper for truncated text cells
const truncCell = (text, max = 80) => {
  if (!text) return <span className="empty-cell">—</span>;
  const s = String(text);
  return (
    <span
      title={s}
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        width: "100%",
      }}
    >
      {s.length > max ? s.slice(0, max) + "…" : s}
    </span>
  );
};

// Probability chip mapping — matches row-stripe colors. Orange rides with the
// traffic-light set; auto-creates an Invoice row (handled in forms.jsx).
const probChipClass = (p) => {
  const key = String(p || "").toLowerCase();
  if (key === "high")   return "prob-high";
  if (key === "medium") return "prob-medium";
  if (key === "low")    return "prob-low";
  if (key === "orange") return "prob-orange";
  return "muted";
};
const PROB_RANK = { High: 1, Medium: 2, Low: 3, Orange: 4 };
const probRank = (p) => PROB_RANK[p] ?? 5;

// Stars sort key: 5★ first, 1★ last, NULL/Unrated last of all. Pure-int
// comparison maps to the desired display order with one expression.
const starsRank = (s) => (s == null ? 99 : 6 - Number(s));

// Events grouping rank — Board Meetings first (highest-value stakeholder
// touchpoint), then partner-facing, then internal.
const EVENT_TYPE_RANK = { "Board Meetings": 1, "Partner": 2, "Meetings": 3, "Project": 4, "AI": 5, "Event": 6 };
const eventTypeRank = (t) => EVENT_TYPE_RANK[t] ?? 99;


// Internal-only column labels (leading checkbox, trailing actions) start with
// this prefix. They participate in grid layout but must not appear in the
// Sort / Columns popovers and render no visible text in the header.
const isInternalLabel = (label) => typeof label === "string" && label.startsWith("__");

// ---------- Shared no-op for optional `updateRow` props ----------
//
// Parent callers (App.jsx) don't currently pass an `updateRow` into a few of
// the tables (ClosedTable, EventsTable, ClientsTable, CompaniesTable). Those
// tables still render EditableCell now, so we default to a harmless no-op.
const _noopUpdate = () => {};

// ---------- Popover (menu) ----------
const Popover = ({ anchorRef, onClose, children, align = "left" }) => {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) &&
          anchorRef?.current && !anchorRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  // Position relative to anchor. useLayoutEffect runs before paint so the
  // menu never flashes at (0,0). `ready` guards the first frame so we don't
  // render the menu at a stale position before the rect is measured.
  const [pos, setPos] = useState({ top: 0, left: 0, ready: false });
  useLayoutEffect(() => {
    if (!anchorRef?.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({
      top: r.bottom + 4 + window.scrollY,
      left: align === "right" ? r.right + window.scrollX : r.left + window.scrollX,
      ready: true,
    });
  }, [anchorRef, align]);

  // Portal to <body> so the menu is not affected by any ancestor's
  // overflow/clip/transform/contain — the toolbar lives inside .tablewrap
  // which sets `overflow: clip`, and earlier non-portaled placement would
  // get visually clipped on some viewport widths even though the menu is
  // position:absolute.
  return createPortal(
    <div ref={ref} className="menu" style={{
      top: pos.top,
      left: align === "right" ? undefined : pos.left,
      right: align === "right" ? (window.innerWidth - pos.left) : undefined,
      visibility: pos.ready ? "visible" : "hidden",
    }}>
      {children}
    </div>,
    document.body
  );
};

// Resolve each column's effective grid-column width: user-resized px wins over default.
const resolveGridCols = (cols, columnWidths) =>
  cols.map(c => {
    const px = columnWidths?.[c.label];
    return (px != null) ? `${px}px` : c.w;
  }).join(" ");

// ---------- Header row (sortable + draggable + resizable) ----------
const HeaderRow = ({
  columns, gridCols, sort, onSortToggle, hiddenCols,
  onReorder, columnWidths, setColumnWidths,
}) => {
  const visible = columns.filter(c => !hiddenCols.has(c.label) || c.locked);
  const grid = gridCols || resolveGridCols(visible, columnWidths);

  const [dragLabel, setDragLabel] = useState(null);
  const [overLabel, setOverLabel] = useState(null);

  // Resize state kept in a ref to avoid re-binding mouse listeners each drag.
  const resizeRef = useRef(null);

  const startResize = (e, label, th) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = th.getBoundingClientRect();
    resizeRef.current = {
      label,
      startX: e.clientX,
      startW: rect.width,
    };
    const onMove = (ev) => {
      const s = resizeRef.current;
      if (!s) return;
      const dx = ev.clientX - s.startX;
      const next = Math.max(40, s.startW + dx);
      setColumnWidths(w => ({ ...w, [s.label]: next }));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div className="thead" style={{ gridTemplateColumns: grid }}>
      {visible.map((c, i) => {
        const sortable = !!c.sortKey;
        const active = sortable && sort.key === c.sortKey;
        const canDrag = !c.locked && !!onReorder;
        const isDragging = dragLabel === c.label;
        const isOver = overLabel === c.label && dragLabel && dragLabel !== c.label && canDrag;
        const displayLabel = isInternalLabel(c.label) ? "" : c.label;

        const dragProps = canDrag ? {
          draggable: true,
          onDragStart: (e) => {
            e.dataTransfer.setData("text/plain", c.label);
            e.dataTransfer.effectAllowed = "move";
            setDragLabel(c.label);
          },
          onDragEnter: (e) => {
            if (!dragLabel || dragLabel === c.label) return;
            e.preventDefault();
            setOverLabel(c.label);
          },
          onDragOver: (e) => {
            if (!dragLabel || dragLabel === c.label) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          },
          onDragLeave: () => {
            // intentionally no-op: onDragEnter on next cell will replace overLabel.
          },
          onDrop: (e) => {
            e.preventDefault();
            const src = e.dataTransfer.getData("text/plain") || dragLabel;
            if (src && src !== c.label && onReorder) {
              onReorder(src, c.label);
            }
            setDragLabel(null);
            setOverLabel(null);
          },
          onDragEnd: () => {
            setDragLabel(null);
            setOverLabel(null);
          },
        } : {};

        const classes = [
          "th",
          active ? "sorted" : "",
          c.className || "",
          isDragging ? "col-dragging" : "",
          isOver ? "col-dragover" : "",
        ].filter(Boolean).join(" ");

        return (
          <div key={c.label + ":" + i}
               className={classes}
               onClick={sortable ? () => onSortToggle(c.sortKey) : undefined}
               style={{
                 cursor: sortable ? "pointer" : "default",
                 position: "relative",
               }}
               {...dragProps}>
            {displayLabel}
            {sortable && (
              <span className="sort-arrow"
                    style={{
                      opacity: active ? 1 : 0,
                      color: "var(--accent)",
                      fontSize: 10,
                      display: "inline-block",
                      transform: active && sort.dir === "asc" ? "rotate(180deg)" : "none",
                      transition: "transform .15s",
                    }}>
                ▼
              </span>
            )}
            {!c.locked && setColumnWidths && (
              <div
                className="col-resize-handle"
                onMouseDown={(e) => startResize(e, c.label, e.currentTarget.parentElement)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---------- Columns/Sort/Filter/Year toolbar hook ----------
//
// Second arg is an options bag (optional). `primarySort` is a fixed sort
// specification — an array of { key, dir } entries — that the consumer wants
// applied on top of / blended with the user's interactive sort. The hook just
// forwards it back out; callers (TableView) use it to build an effective
// composite sort when sorting rows.
const useTableChrome = (columns, { primarySort = [] } = {}) => {
  const [sort, setSort] = useState({ key: null, dir: null });
  const [hiddenCols, setHiddenCols] = useState(() =>
    new Set((columns || []).filter(c => c.defaultHidden).map(c => c.label))
  );
  // 'columns' | 'sort' | 'filter' | 'year' | null
  const [openMenu, setOpenMenu] = useState(null);
  const [search, setSearch] = useState("");

  // Column order by label (starts as the definition order).
  const [columnOrder, setColumnOrder] = useState(() => (columns || []).map(c => c.label));

  // User-resized widths in px (label -> px). Defaults come from the column `w`.
  const [columnWidths, setColumnWidths] = useState({});

  const sortBtnRef = useRef(null);
  const colsBtnRef = useRef(null);
  const filterBtnRef = useRef(null);
  const yearBtnRef = useRef(null);
  const searchInputRef = useRef(null);

  const onSortToggle = (key) => setSort(s => nextSortDir(s, s.key, key));

  const toggleHidden = (label) => {
    setHiddenCols(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  // If the columns prop changes (labels added/removed), reconcile the order.
  useEffect(() => {
    setColumnOrder(prev => {
      const labels = (columns || []).map(c => c.label);
      // Drop labels that disappeared; append any new ones at the end.
      const kept = prev.filter(l => labels.includes(l));
      const added = labels.filter(l => !kept.includes(l));
      const next = [...kept, ...added];
      // Avoid needless state change if identical
      if (next.length === prev.length && next.every((l, i) => l === prev[i])) return prev;
      return next;
    });
  }, [columns]);

  const orderedColumns = useMemo(() => {
    const byLabel = new Map((columns || []).map(c => [c.label, c]));
    return columnOrder
      .map(l => byLabel.get(l))
      .filter(Boolean);
  }, [columns, columnOrder]);

  const visibleColumns = useMemo(
    () => orderedColumns.filter(c => !hiddenCols.has(c.label) || c.locked),
    [orderedColumns, hiddenCols]
  );

  const onReorder = (from, to) => {
    setColumnOrder(order => {
      if (!order.includes(from) || !order.includes(to) || from === to) return order;
      const next = order.filter(l => l !== from);
      const i = next.indexOf(to);
      next.splice(i, 0, from);
      return next;
    });
  };

  return {
    sort, setSort,
    hiddenCols, setHiddenCols, toggleHidden,
    openMenu, setOpenMenu,
    sortBtnRef, colsBtnRef, filterBtnRef, yearBtnRef, searchInputRef,
    onSortToggle,
    orderedColumns,
    visibleColumns,
    columnOrder, setColumnOrder, onReorder,
    columnWidths, setColumnWidths,
    search, setSearch,
    primarySort,
  };
};

// ---------- Chrome Toolbar with live Columns + Sort + Filter + Year popovers ----------
const ChromeToolbar = ({
  filters, right, onNew, newLabel = "New",
  columns, sort, onSortToggle, hiddenCols, toggleHidden,
  openMenu, setOpenMenu,
  sortBtnRef, colsBtnRef, filterBtnRef, yearBtnRef, searchInputRef,
  search, setSearch,
  yearOptions, yearValue, onYearChange,
}) => {
  // Only surface sortable, user-facing columns in the Sort popover; hide internal (__*) columns.
  const sortableCols = columns.filter(c => c.sortKey && !isInternalLabel(c.label));
  const hasSearch = !!search.trim();

  const hasYear = Array.isArray(yearOptions) && yearOptions.length > 0;

  return (
    <div className="toolbar">
      {/* Search input — primary affordance, leftmost in the chrome */}
      <div className={"chrome-search" + (hasSearch ? " active" : "")}>
        <Icon name="search" size={13}/>
        <input
          ref={searchInputRef}
          className="chrome-search-input"
          placeholder="Search rows…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {hasSearch && (
          <button
            type="button"
            className="chrome-search-clear"
            title="Clear search"
            onClick={() => setSearch("")}
            aria-label="Clear search">
            <Icon name="x" size={11}/>
          </button>
        )}
      </div>

      {filters?.map((f, i) => (
        <button key={i} className={"tool-chip" + (f.active ? " on" : "")} onClick={f.onClick}>
          {f.icon && <Icon name={f.icon} size={13}/>}
          {f.label}
          {f.count != null && <span style={{ opacity: .6, marginLeft: 2 }}>· {f.count}</span>}
        </button>
      ))}

      {hasYear && (
        <button
          ref={yearBtnRef}
          className={"tool-chip" + (yearValue != null ? " on" : "")}
          onClick={() => setOpenMenu(openMenu === "year" ? null : "year")}
        >
          <Icon name="calendar" size={13}/>
          Year: {yearValue ?? "All"}
        </button>
      )}

      <div className="tool-sep"/>

      <button
        ref={sortBtnRef}
        className={"tool-chip" + (sort.key ? " on" : "")}
        onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
      >
        <Icon name="sort" size={13}/>
        Sort{sort.key ? ` · ${(columns.find(c => c.sortKey === sort.key)?.label || sort.key)} ${sort.dir === "asc" ? "↑" : "↓"}` : ""}
      </button>

      <button
        ref={colsBtnRef}
        className={"tool-chip" + (hiddenCols.size > 0 ? " on" : "")}
        onClick={() => setOpenMenu(openMenu === "columns" ? null : "columns")}
      >
        <Icon name="columns" size={13}/>
        Columns{hiddenCols.size > 0 ? ` · ${hiddenCols.size} hidden` : ""}
      </button>

      <div className="ml-auto" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {right}
        {onNew && (
          <button className="btn primary sm" onClick={onNew}>
            <Icon name="plus" size={13}/>{newLabel}
          </button>
        )}
      </div>

      {openMenu === "year" && hasYear && (
        <Popover anchorRef={yearBtnRef} onClose={() => setOpenMenu(null)} align="left">
          <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
            Select year
          </div>
          <button
            className="menu-item"
            onClick={() => { onYearChange?.(null); setOpenMenu(null); }}
            style={yearValue == null ? { color: "var(--accent-ink)" } : undefined}
          >
            <Icon name="calendar" size={13}/>
            <span style={{ flex: 1 }}>All years</span>
            {yearValue == null && (
              <span style={{ fontSize: 11, color: "var(--accent)" }}>✓</span>
            )}
          </button>
          <div className="menu-sep"/>
          {yearOptions.map((y) => {
            const active = yearValue === y;
            return (
              <button
                key={y}
                className="menu-item"
                onClick={() => { onYearChange?.(y); setOpenMenu(null); }}
                style={active ? { color: "var(--accent-ink)" } : undefined}
              >
                <Icon name="calendar" size={13}/>
                <span style={{ flex: 1 }}>{y}</span>
                {active && (
                  <span style={{ fontSize: 11, color: "var(--accent)" }}>✓</span>
                )}
              </button>
            );
          })}
        </Popover>
      )}

      {openMenu === "sort" && (
        <Popover anchorRef={sortBtnRef} onClose={() => setOpenMenu(null)}>
          <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
            Sort by
          </div>
          {sortableCols.length === 0 && (
            <div className="menu-item" style={{ color: "var(--text-soft)", cursor: "default" }}>
              No sortable columns
            </div>
          )}
          {sortableCols.map((c, i) => {
            const active = sort.key === c.sortKey;
            return (
              <button
                key={i}
                className="menu-item"
                onClick={() => {
                  onSortToggle(c.sortKey);
                  // If toggling turns it off, keep menu open so user can pick another
                }}
                style={active ? { color: "var(--accent-ink)" } : undefined}
              >
                <Icon name="sort" size={13}/>
                <span style={{ flex: 1 }}>{c.label}</span>
                {active && (
                  <span style={{ fontSize: 11, color: "var(--accent)" }}>
                    {sort.dir === "asc" ? "↑ asc" : sort.dir === "desc" ? "↓ desc" : ""}
                  </span>
                )}
              </button>
            );
          })}
          {sort.key && (
            <>
              <div className="menu-sep"/>
              <button className="menu-item" onClick={() => { /* clear */ setOpenMenu(null); }}
                      style={{ color: "var(--text-muted)" }}>
                <Icon name="x" size={13}/>
                <span style={{ flex: 1 }} onClick={(e) => { e.stopPropagation(); }}>Clear sort</span>
              </button>
            </>
          )}
        </Popover>
      )}

      {openMenu === "columns" && (
        <Popover anchorRef={colsBtnRef} onClose={() => setOpenMenu(null)} align="right">
          <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
            Show columns
          </div>
          {columns.map((c, i) => {
            if (c.locked) return null; // can't hide checkbox or actions
            if (isInternalLabel(c.label)) return null; // defensive: never expose __* columns
            const visible = !hiddenCols.has(c.label);
            return (
              <label key={i} className="menu-item" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => toggleHidden(c.label)}
                  style={{ accentColor: "var(--accent)", marginRight: 2 }}
                />
                <span style={{ flex: 1 }}>{c.label || <span style={{ color: "var(--text-soft)" }}>(unnamed)</span>}</span>
              </label>
            );
          })}
        </Popover>
      )}
    </div>
  );
};

// ---------- Shared table chrome (renders chrome toolbar + thead + rows + empty state) ----------
//
// Optional props added on top of the existing contract:
//   primarySort: [{ key, dir }, ...]
//       Fixed sort spec that blends with the user's sort — see
//       buildEffectiveSort() for the exact rules.
//   postProcess: (rows) => rows
//       Called AFTER search + sort to produce the final row list. Useful for
//       injecting synthetic rows (e.g., group totals). Table snapshots see the
//       post-processed rows, so exports include any injected rows.
const TableView = ({
  tab,
  filters, right, onNew, newLabel,
  columns, rows, renderRow,
  emptyTitle, emptyHint, emptyIcon,
  yearOptions, yearValue, onYearChange,
  primarySort,
  postProcess,
}) => {
  const chrome = useTableChrome(columns, { primarySort });
  const {
    sort, hiddenCols, orderedColumns, visibleColumns,
    onSortToggle, toggleHidden,
    openMenu, setOpenMenu,
    sortBtnRef, colsBtnRef, filterBtnRef, yearBtnRef, searchInputRef,
    search, setSearch,
    columnOrder, onReorder,
    columnWidths, setColumnWidths,
  } = chrome;

  // Column-walking search predicate. For each non-locked column we extract a
  // searchable string via the column's `sortValue` (which usually resolves
  // FKs to readable names — e.g., "USACE" rather than a uuid) or its
  // `sortKey` (a direct row field). This matches what the user sees in the
  // table, not raw JSON noise (uuids, internal flags, timestamps).
  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => {
      for (const col of (columns || [])) {
        if (col.locked) continue;
        let val;
        try {
          if (typeof col.sortValue === "function") val = col.sortValue(r);
          else if (col.sortKey) val = r[col.sortKey];
          else continue;
        } catch { continue; }
        if (val == null) continue;
        if (String(val).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [rows, search, columns]);

  // Composite sort: combine the table's fixed primarySort with the user's
  // active column sort. Falls back to the original untouched order when there
  // is no effective sort (preserves data-in order for consumers that care).
  const sortedRows = useMemo(() => {
    const effective = buildEffectiveSort(primarySort, sort);
    if (effective.length === 0) return filteredRows;
    return filteredRows.slice().sort(compositeComparator(effective, orderedColumns));
  }, [filteredRows, sort, orderedColumns, primarySort]);

  // Optional post-processing (e.g., injecting group-total rows). When absent,
  // processedRows === sortedRows, so behavior is identical for callers that
  // don't opt in.
  const processedRows = useMemo(
    () => (typeof postProcess === "function" ? postProcess(sortedRows) : sortedRows),
    [sortedRows, postProcess]
  );

  const gridCols = resolveGridCols(visibleColumns, columnWidths);

  const showNoMatches = search.trim() && filteredRows.length === 0 && rows.length > 0;

  // --- Mirrored top scrollbar -------------------------------------------------
  // Wide tables already get a bottom scrollbar from .table-scroll's overflow-x.
  // Long lists make it unreachable until the user scrolls to the bottom — so
  // we mirror it as a thin scrollbar fixed at the TOP of the table. Same
  // pattern InvoiceTable uses (.invoice-top-scroll), implemented inline here
  // so all TableView consumers (Potential / Awaiting / Awarded / Closed /
  // Events / Hot Leads / Directory) get it for free.
  const tableScrollRef     = useRef(null);
  const tableScrollBodyRef = useRef(null);
  const tableTopScrollRef  = useRef(null);
  const [tableTopWidth, setTableTopWidth] = useState(0);
  const [tableHasOverflow, setTableHasOverflow] = useState(false);

  useEffect(() => {
    const scroll = tableScrollRef.current;
    const body   = tableScrollBodyRef.current;
    if (!scroll || !body) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // .table-scroll-body uses min-width: min-content so its scrollWidth
        // collapses to the sum of grid track minimums — exactly what the
        // bottom scrollbar lays out. We mirror that.
        const w = Math.max(body.scrollWidth, body.offsetWidth, scroll.clientWidth);
        setTableTopWidth(prev => prev === w ? prev : w);
        setTableHasOverflow(w - scroll.clientWidth > 1);
        // Sync only when the top bar is in the DOM (it always is now, but the
        // ref might briefly be null mid-mount on edge cases).
        const top = tableTopScrollRef.current;
        if (top && top.scrollLeft !== scroll.scrollLeft) top.scrollLeft = scroll.scrollLeft;
      });
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(scroll);
    ro?.observe(body);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [processedRows.length, visibleColumns.length, gridCols]);

  // When overflow flips from false → true the top bar un-hides; snap its
  // scrollLeft to match the body so the thumb starts in the right spot.
  useEffect(() => {
    if (!tableHasOverflow) return;
    const top = tableTopScrollRef.current;
    const scroll = tableScrollRef.current;
    if (top && scroll) top.scrollLeft = scroll.scrollLeft;
  }, [tableHasOverflow]);

  // Two-way sync: scrolling either bar drives the other. The `> 1` guard
  // prevents the feedback loop where each onScroll re-fires the partner
  // setter and rounds-trips a sub-pixel drift forever.
  const syncTableScroll = (source) => {
    const scroll = tableScrollRef.current;
    const top    = tableTopScrollRef.current;
    if (!scroll || !top) return;
    const from = source === "top" ? top : scroll;
    const to   = source === "top" ? scroll : top;
    if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) {
      to.scrollLeft = from.scrollLeft;
    }
  };
  const onTableTopScroll  = () => syncTableScroll("top");
  const onTableBodyScroll = () => syncTableScroll("body");

  // Publish current table state for external consumers (e.g., Export). Export
  // should see the SAME rows the user sees — including any synthetic totals
  // rows injected by postProcess — so we publish processedRows here.
  useEffect(() => {
    setCurrentTableSnapshot({
      tab,
      columns: orderedColumns,
      visibleColumns,
      hiddenCols,
      columnOrder,
      columnWidths,
      sort,
      search,
      year: yearValue ?? null,
      processedRows,
    });
    // Don't clear on unmount: the next table will overwrite so Export right
    // after a tab switch still sees a snapshot.
  }, [
    tab, orderedColumns, visibleColumns, hiddenCols, columnOrder, columnWidths,
    sort, search, yearValue, processedRows,
  ]);

  return (
    <div className="tablewrap">
      <ChromeToolbar
        filters={filters} right={right} onNew={onNew} newLabel={newLabel}
        columns={orderedColumns} sort={sort} onSortToggle={onSortToggle}
        hiddenCols={hiddenCols} toggleHidden={toggleHidden}
        openMenu={openMenu} setOpenMenu={setOpenMenu}
        sortBtnRef={sortBtnRef} colsBtnRef={colsBtnRef}
        filterBtnRef={filterBtnRef} yearBtnRef={yearBtnRef}
        searchInputRef={searchInputRef}
        search={search} setSearch={setSearch}
        yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      />
      {search.trim() && (
        <div className="chrome-search-summary">
          {filteredRows.length === 0
            ? <>No rows match <span className="mono">"{search}"</span>.</>
            : <><strong>{filteredRows.length}</strong> of <strong>{rows.length}</strong> match <span className="mono">"{search}"</span></>
          }
        </div>
      )}
      {/* Mirrored top scrollbar — always rendered so its ref is stable for
          the measurement effect; hidden via .is-hidden when the table doesn't
          actually overflow (narrow tables don't grow an empty 14px strip).
          aria-hidden + tabIndex={-1} keep the synthetic bar out of keyboard /
          SR focus — the real .table-scroll below is the authoritative target. */}
      <div
        className={"table-top-scroll" + (tableHasOverflow ? "" : " is-hidden")}
        ref={tableTopScrollRef}
        onScroll={onTableTopScroll}
        aria-hidden="true"
        tabIndex={-1}
      >
        <div className="table-top-scroll-spacer" style={{ width: tableTopWidth }}/>
      </div>
      {/* Table-only horizontal scroll container. Keeps the toolbar fixed-width
          while the header row + data rows scroll together when total column
          width exceeds viewport. The PAGE never gets a horizontal scrollbar.
          .table-scroll-body wraps header + rows so they share a single width
          (max of all children's intrinsic widths). Without the wrapper, each
          .trow would size to its own content and rows would drift out of
          alignment at narrow viewports. */}
      <div className="table-scroll" ref={tableScrollRef} onScroll={onTableBodyScroll}>
        <div className="table-scroll-body" ref={tableScrollBodyRef}>
          <HeaderRow
            columns={orderedColumns} gridCols={gridCols} sort={sort}
            onSortToggle={onSortToggle} hiddenCols={hiddenCols}
            onReorder={onReorder}
            columnWidths={columnWidths} setColumnWidths={setColumnWidths}
          />
          {sortedRows.length === 0 ? (
            showNoMatches ? (
              <EmptyState
                title="No matches"
                hint={`Nothing matches "${search}".`}
                iconName="search"
              />
            ) : (
              <EmptyState title={emptyTitle} hint={emptyHint} iconName={emptyIcon}/>
            )
          ) : (
            processedRows.map((r, i) => renderRow(r, i, gridCols, visibleColumns, hiddenCols))
          )}
        </div>
      </div>
    </div>
  );
};

// ---------- Standalone Toolbar (kept for any external caller) ----------
export const Toolbar = ({ filters, right, onNew, newLabel = "New" }) => (
  <div className="toolbar">
    {filters?.map((f, i) => (
      <button key={i} className={"tool-chip" + (f.active ? " on" : "")} onClick={f.onClick}>
        {f.icon && <Icon name={f.icon} size={13}/>}
        {f.label}
        {f.count != null && <span style={{ opacity: .6, marginLeft: 2 }}>· {f.count}</span>}
      </button>
    ))}
    <div className="tool-sep"/>
    <button className="tool-chip"><Icon name="filter" size={13}/>Add filter</button>
    <button className="tool-chip"><Icon name="sort" size={13}/>Sort</button>
    <button className="tool-chip"><Icon name="columns" size={13}/>Columns</button>
    <div className="ml-auto" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {right}
      {onNew && (
        <button className="btn primary sm" onClick={onNew}>
          <Icon name="plus" size={13}/>{newLabel}
        </button>
      )}
    </div>
  </div>
);

// ---------- Helper: render ordered cells keyed by column label ----------
//
// Every renderRow builds a `cells` map keyed by column `label`, then this
// helper walks `visibleColumns` (which is reordered via drag) and emits
// children in header order so grid slots line up with their headers.
const renderOrderedCells = (visibleColumns, cells) =>
  visibleColumns.map((col) => (
    <React.Fragment key={col.label}>
      {cells[col.label] ?? null}
    </React.Fragment>
  ));

// ---------- Shared dropdown options (stable per-render) ----------
//
// Built at the top of each table body. We rebuild per-render so newly added
// users/companies show up — the lookup arrays are cheap (<~200 items).
const buildOptions = () => {
  // clientOptions (clients only) is the default for Prime-role rows —
  // matches the client_id → beacon.clients FK so picks can't violate it.
  // Sub-role rows get a merged Client-or-Firm list (see clientOptionsForRow
  // below) because their "Client" cell can carry either a client or a
  // prime firm, and updatePotential/etc. route the pick to either
  // client_id or prime_company_id accordingly.
  const clientOptions     = getClientsOnly().map(c => ({ value: c.id, label: c.name }));
  const clientsOnlyOpts   = getClientsOnly().map(c => ({ value: c.id, label: c.name }));
  const companiesOnlyOpts = getCompaniesOnly().map(c => ({ value: c.id, label: c.name }));
  // Combined list used when the current row is role='Sub'. Companies get
  // a " · Firm" suffix so users can tell the two pools apart visually.
  const clientOrFirmOpts  = buildClientOrCompanyOptions();
  const userOptions       = getUsers().map(u => ({ value: u.id, label: u.name }));
  return {
    clientOptions,
    clientsOnlyOpts,
    companiesOnlyOpts,
    clientOrFirmOpts,
    userOptions,
    orgTypeOptions:      ["City", "State", "Federal", "Local", "Parish", "Regional", "Other"],
    probOptions:         ["High", "Medium", "Low", "Orange"],
    roleOptions:         ["Prime", "Sub"],
    eventStatusOptions:  ["Booked", "Happened"],
    eventTypeOptions:    ["Partner", "AI", "Project", "Meetings", "Board Meetings", "Event"],
    hotLeadStatusOptions:["Scheduled", "Happened"],
    hotLeadTypeOptions:  ["Engineering", "AI"],
    invoiceTypeOptions:  ["ENG", "PM"],
    companyTypeOptions:  ["Prime", "Sub", "Multiple"],
    stageOptions:        ["Multi-Use Contract", "Single Use Contract (Project)", "AE Selected List"],
  };
};

// ---------- Potential Projects ----------
export const PotentialTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onForward, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Year", w: "64px", sortKey: "year" },
    { label: "Project", w: "minmax(240px, 2fr)", sortKey: "name" },
    { label: "Role", w: "100px", sortKey: "role",
      sortValue: r => r.role === "Prime" ? 1 : r.role === "Sub" ? 2 : 3 },
    { label: "Client", w: "minmax(160px, 1.2fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Contract", w: "120px", sortKey: "amount" },
    { label: "MSMM", w: "110px", sortKey: "msmm" },
    { label: "Subs", w: "minmax(180px, 1.5fr)" },
    { label: "PM", w: "140px", sortKey: "pm",
      sortValue: r => (r.pmIds || []).map(id => userById(id)?.name || "").join(", ") },
    { label: "Proj #", w: "100px", sortKey: "projectNumber" },
    { label: "Probability", w: "120px", sortKey: "probability",
      sortValue: r => probRank(r.probability) },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Dates & Comments", w: "minmax(180px, 1.4fr)", defaultHidden: true },
    { label: "__actions", w: "110px", locked: true },
  ];

  const { clientOptions, clientOrFirmOpts, userOptions, roleOptions, probOptions } = buildOptions();

  // Potential rows are always grouped primarily by probability (High → Medium
  // → Low → unset) and secondarily by role (Prime → Sub → other). The user's
  // interactive sort blends in on top — see buildEffectiveSort() for rules.
  const primarySort = [
    { key: "probability", dir: "asc" },
    { key: "role",        dir: "asc" },
  ];

  // Inject per-probability group totals and a grand-total row AFTER sorting.
  // Works because primarySort guarantees rows are grouped by probability;
  // we just walk and flush whenever the probability key changes.
  const injectTotals = (rows) => {
    if (!rows || rows.length === 0) return rows;
    const out = [];
    let groupRows = [];
    let lastProb;
    let allC = 0, allM = 0, allS = 0, allN = 0;

    const flush = (prob) => {
      if (!groupRows.length) return;
      const contract = groupRows.reduce((a, r) => a + (r.amount || 0), 0);
      const msmm     = groupRows.reduce((a, r) => a + (r.msmm || 0), 0);
      const subs     = groupRows.reduce((a, r) => a + (r.subs || []).reduce((x, s) => x + (s.amt || 0), 0), 0);
      allC += contract; allM += msmm; allS += subs; allN += groupRows.length;
      out.push({
        id: `_total_${prob}`,
        _total: prob,
        _count: groupRows.length,
        probability: prob,
        amount: contract,
        msmm,
        subsTotal: subs,
      });
      groupRows = [];
    };

    for (const r of rows) {
      const p = r.probability || "—";
      if (lastProb !== undefined && p !== lastProb) flush(lastProb);
      out.push(r);
      groupRows.push(r);
      lastProb = p;
    }
    if (lastProb !== undefined) flush(lastProb);

    if (allN > 0) {
      out.push({
        id: "_total_all",
        _total: "All",
        _count: allN,
        amount: allC,
        msmm: allM,
        subsTotal: allS,
      });
    }
    return out;
  };

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      primarySort={primarySort}
      postProcess={injectTotals}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No potential projects"
      emptyHint="Projects you add here are leads not yet submitted. Use the New button above to create one."
      emptyIcon="briefcase"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        // Synthetic totals row (injected by postProcess). Renders with the same
        // column ordering as data rows so drag-reorder / resize still line up,
        // but it's static — no click handler, no edit affordances, no actions.
        if (r._total) {
          const isGrand = r._total === "All";
          const countNoun = r._count === 1 ? "project" : "projects";
          const label = isGrand
            ? `Grand total · ${r._count} ${countNoun}`
            : `${r._total} · ${r._count} ${countNoun}`;
          const cells = {
            "__select": <div className="td"/>,
            "Year": <div className="td"/>,
            "Project": (
              <div className="td" style={{ fontWeight: 600 }}>
                {label}
              </div>
            ),
            "Role": <div className="td"/>,
            "Client": <div className="td"/>,
            "Contract": (
              <div className="td mono" style={{ fontWeight: 600 }}>
                {fmtMoney(r.amount, false)}
              </div>
            ),
            "MSMM": (
              <div className="td mono" style={{ fontWeight: 600, color: "var(--accent-ink)" }}>
                {fmtMoney(r.msmm, false)}
              </div>
            ),
            "Subs": (
              <div className="td mono" style={{ fontWeight: 600 }}>
                {fmtMoney(r.subsTotal, false)}
              </div>
            ),
            "PM": <div className="td"/>,
            "Proj #": <div className="td"/>,
            "Probability": <div className="td"/>,
            "Notes": <div className="td"/>,
            "Dates & Comments": <div className="td"/>,
            "__actions": <div className="td"/>,
          };
          return (
            <div key={r.id}
                 className={"trow total-row" + (isGrand ? " grand-total" : "")}
                 data-prob={isGrand ? "all" : String(r._total).toLowerCase()}
                 style={{ gridTemplateColumns: gridCols }}>
              {renderOrderedCells(visibleColumns, cells)}
            </div>
          );
        }

        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Year": (
            <div className="td mono subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td" style={{ fontWeight: 500 }}>
              <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
            </div>
          ),
          "Role": (
            <div className="td">
              <EditableCell value={r.role} type="select" options={roleOptions}
                onChange={v => updateRow(r.id, { role: v })}
                render={v => <RoleChip role={v}/>}/>
            </div>
          ),
          "Client": (
            <div className="td subtle" style={{ overflow: "hidden" }}>
              <EditableCell value={r.clientId} type="combobox" options={r.role === "Sub" ? clientOrFirmOpts : clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Contract": (
            <div className="td mono">
              <EditableCell value={r.amount} type="number"
                onChange={v => updateRow(r.id, { amount: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "MSMM": (
            <div className="td mono" style={{ color: "var(--accent-ink)" }}>
              <EditableCell value={r.msmm} type="number"
                onChange={v => updateRow(r.id, { msmm: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "Subs": <div className="td"><SubsCell subs={r.subs}/></div>,
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">—</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono subtle">
              <EditableCell value={r.projectNumber}
                onChange={v => updateRow(r.id, { projectNumber: v })}/>
            </div>
          ),
          "Probability": (
            <div className="td">
              <EditableCell value={r.probability} type="select" options={probOptions}
                onChange={v => updateRow(r.id, { probability: v })}
                render={v => v
                  ? <span className={`chip ${probChipClass(v)}`}>{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "Dates & Comments": (
            <div className="td subtle" style={{ fontSize: 12.5, flexDirection: "column", alignItems: "flex-start", gap: 2, whiteSpace: "normal" }}>
              {r.nextActionDate && (
                <span className="mono" style={{ fontSize: 11, color: "var(--accent-ink)" }}>
                  {fmtDate(r.nextActionDate)}
                </span>
              )}
              <EditableCell value={r.dates}
                onChange={v => updateRow(r.id, { dates: v })}
                format={v => v
                  ? truncCell(v)
                  : (!r.nextActionDate ? <span className="empty-cell">—</span> : null)}/>
            </div>
          ),
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end" }}>
              <RowActions
                onForward={() => onForward(r)}
                onAlert={() => onAlert(r)}
                forwardTitle="Move → Invoice"
              />
            </div>
          ),
        };
        return (
          <div key={r.id}
               className={"trow" + (flashId === r.id ? " flash" : "")}
               data-prob={(r.probability || "").toLowerCase() || undefined}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};

// ---------- Awaiting Verdict ----------
// Org-type ordering used as the primary sort for Awaiting Verdict AND Awarded.
// Matches the customer's xlsx grouping convention in both sheets:
//   Federal → State → Regional → Parish → City → Local → Other → unassigned
// (In the source files, rows were hand-ordered Federal first, City last with
// purple highlight; this rank preserves that positioning.)
const ORG_RANK = { Federal: 1, State: 2, Regional: 3, Parish: 4, City: 5, Local: 6, Other: 7 };
const orgRank = (clientId) => ORG_RANK[companyById(clientId)?.orgType] ?? 99;

// Builds the {ORG_TYPE} section-header rows that separate groups.
// Safe to reuse across tables that are primary-sorted by org type.
const injectOrgHeaders = (unitLabel = "row") => (sortedRows) => {
  if (!sortedRows || sortedRows.length === 0) return sortedRows;
  const counts = {};
  for (const r of sortedRows) {
    const o = companyById(r.clientId)?.orgType || "—";
    counts[o] = (counts[o] || 0) + 1;
  }
  const plural = (n) => n === 1 ? unitLabel : (unitLabel + "s");
  const out = [];
  let lastOrg;
  for (const r of sortedRows) {
    const o = companyById(r.clientId)?.orgType || "—";
    if (o !== lastOrg) {
      out.push({
        id: `_orgheader_${o}`,
        _orgHeader: o,
        _count: counts[o],
        _unit: plural(counts[o]),
      });
      lastOrg = o;
    }
    out.push(r);
  }
  return out;
};

// Same shape as injectOrgHeaders, but groups rows by entity *kind* —
// "Clients" first (rows where r.type === "Client"), then "Companies"
// (everything else). Used by the combined DirectoryTable.
const injectKindHeaders = (sortedRows) => {
  if (!sortedRows || sortedRows.length === 0) return sortedRows;
  const clients   = sortedRows.filter(r => r.type === "Client");
  const companies = sortedRows.filter(r => r.type !== "Client");
  const out = [];
  if (clients.length > 0) {
    out.push({
      id: "_kindheader_clients",
      _kindHeader: "Clients",
      _count: clients.length,
      _unit:  clients.length === 1 ? "client" : "clients",
    });
    for (const r of clients) out.push(r);
  }
  if (companies.length > 0) {
    out.push({
      id: "_kindheader_companies",
      _kindHeader: "Companies",
      _count: companies.length,
      _unit:  companies.length === 1 ? "company" : "companies",
    });
    for (const r of companies) out.push(r);
  }
  return out;
};

export const AwaitingTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onForward, onAlert, onCloseOut, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Year", w: "64px", sortKey: "year" },
    { label: "Project", w: "minmax(240px, 2fr)", sortKey: "name" },
    { label: "Client", w: "minmax(160px, 1.2fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Org Type", w: "110px", sortKey: "orgType", defaultHidden: true,
      sortValue: r => orgRank(r.clientId) },
    { label: "Role", w: "100px", sortKey: "role" },
    { label: "Submitted", w: "120px", sortKey: "dateSubmitted" },
    { label: "Anticipated Result", w: "140px", sortKey: "anticipatedResultDate" },
    { label: "Client Contract", w: "150px", sortKey: "clientContract" },
    { label: "MSMM Contract", w: "150px", sortKey: "msmmContract" },
    { label: "MSMM Remaining", w: "140px", sortKey: "msmmRemaining" },
    { label: "PM", w: "140px", sortKey: "pm",
      sortValue: r => (r.pmIds || []).map(id => userById(id)?.name || "").join(", ") },
    { label: "Proj #", w: "110px", sortKey: "projectNumber" },
    { label: "Subs", w: "minmax(180px, 1.5fr)", defaultHidden: true },
    { label: "Status", w: "150px", sortKey: "status", defaultHidden: true },
    { label: "MSMM Used", w: "120px", sortKey: "msmmUsed", defaultHidden: true },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "__actions", w: "140px", locked: true },
  ];

  const { clientOptions, clientOrFirmOpts, userOptions, roleOptions } = buildOptions();

  // Primary sort by org-type keeps rows grouped (user sort slots in as secondary).
  const primarySort = [{ key: "orgType", dir: "asc" }];

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      primarySort={primarySort}
      postProcess={injectOrgHeaders("submittal")}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No projects awaiting verdict"
      emptyHint="Projects you submit move here until awarded or closed out."
      emptyIcon="clock"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        if (r._orgHeader) {
          const raw = r._orgHeader;
          const orgKey = raw === "—" ? "unknown" : raw.toLowerCase();
          return (
            <div key={r.id} className="trow org-header"
                 data-org={orgKey}
                 style={{ gridTemplateColumns: gridCols }}>
              <div className="td" style={{ color: "var(--text)" }}>
                Org Type : {raw === "—" ? "(unassigned)" : raw} · {r._count} {r._unit}
              </div>
            </div>
          );
        }
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Year": (
            <div className="td mono subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td" style={{ fontWeight: 500 }}>
              <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
              {r.projectNumber && <span className="chip muted" style={{ marginLeft: 8, fontSize: 11 }}>{r.projectNumber}</span>}
            </div>
          ),
          "Client": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={r.role === "Sub" ? clientOrFirmOpts : clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Org Type": (
            <div className="td subtle">
              {(() => {
                const o = companyById(r.clientId)?.orgType;
                return o ? <span className="chip muted">{o}</span> : <span className="empty-cell">—</span>;
              })()}
            </div>
          ),
          "Role": (
            <div className="td">
              <EditableCell value={r.role} type="select" options={roleOptions}
                onChange={v => updateRow(r.id, { role: v })}
                render={v => <RoleChip role={v}/>}/>
            </div>
          ),
          "Submitted": (
            <div className="td mono subtle">
              <EditableCell value={r.dateSubmitted} type="date"
                onChange={v => updateRow(r.id, { dateSubmitted: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Anticipated Result": (
            <div className="td mono" style={{ color: "var(--accent-ink)" }}>
              <EditableCell value={r.anticipatedResultDate} type="date"
                onChange={v => updateRow(r.id, { anticipatedResultDate: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Client Contract": (
            <div className="td mono" style={{ fontSize: 12 }}>
              <EditableCell value={r.clientContract}
                onChange={v => updateRow(r.id, { clientContract: v })}/>
            </div>
          ),
          "MSMM Contract": (
            <div className="td mono" style={{ fontSize: 12 }}>
              <EditableCell value={r.msmmContract}
                onChange={v => updateRow(r.id, { msmmContract: v })}/>
            </div>
          ),
          "MSMM Remaining": (
            <div className="td mono" style={{ color: "var(--accent-ink)" }}>
              <EditableCell value={r.msmmRemaining} type="number"
                onChange={v => updateRow(r.id, { msmmRemaining: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">—</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono subtle">
              <EditableCell value={r.projectNumber}
                onChange={v => updateRow(r.id, { projectNumber: v })}/>
            </div>
          ),
          "Subs": <div className="td"><SubsCell subs={r.subs}/></div>,
          "Status": <div className="td"><span className="chip accent">Awaiting Verdict</span></div>,
          "MSMM Used": (
            <div className="td mono subtle">
              <EditableCell value={r.msmmUsed} type="number"
                onChange={v => updateRow(r.id, { msmmUsed: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end", gap: 4 }}>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                <button className="row-btn forward" title="Award → move to Awarded" onClick={() => onForward(r, "Awarded")}>
                  <Icon name="check" size={14}/>
                </button>
                <button className="row-btn" title="Close Out" onClick={() => onCloseOut(r)} style={{ color: "var(--rose)" }}>
                  <Icon name="x" size={14}/>
                </button>
                <button className="row-btn alert" title="Set alert" onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
            </div>
          ),
        };
        const orgKey = (companyById(r.clientId)?.orgType || "").toLowerCase() || undefined;
        return (
          <div key={r.id} className={"trow" + (flashId === r.id ? " flash" : "")}
               data-org={orgKey}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};

// ---------- Awarded Projects ----------
export const AwardedTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onForward, onMoveToPotential, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  // Column order mirrors Scott's Proposals workbook header row:
  // Proposal Year · Title · Client Name · Prime · Sub · Status · Stage · Details ·
  // Pool · Submitted Date · Client Contract No · MSMM Contract No · Contract Exp Date ·
  // MSMM Capacity · MSMM Used · MSMM Remaining.
  // UI-only columns (Org Type, PM, Proj #, Role) trail the spreadsheet block.
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Year", w: "64px", sortKey: "year" },
    { label: "Project", w: "minmax(220px, 2fr)", sortKey: "name" },
    { label: "Client", w: "minmax(150px, 1.2fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Prime", w: "minmax(150px, 1.2fr)", sortKey: "primeName",
      sortValue: r => companyById(r.primeId)?.name || "" },
    { label: "Subs", w: "minmax(180px, 1.5fr)" },
    { label: "Role", w: "100px", sortKey: "role" },
    { label: "Status", w: "120px", sortKey: "status" },
    { label: "Stage", w: "150px", sortKey: "stage" },
    { label: "Details", w: "minmax(200px, 1.5fr)", sortKey: "details" },
    { label: "Pool", w: "130px", sortKey: "pools" },
    { label: "Submitted", w: "120px", sortKey: "dateSubmitted" },
    { label: "Client Contract", w: "150px", sortKey: "clientContract" },
    { label: "MSMM Contract", w: "150px", sortKey: "msmmContract" },
    { label: "Expiry", w: "110px", sortKey: "contractExpiry" },
    { label: "Contract", w: "120px", sortKey: "contract",
      sortValue: r => (r.msmmUsed || 0) + (r.msmmRemaining || 0) },
    { label: "MSMM Used", w: "120px", sortKey: "msmmUsed" },
    { label: "Remaining", w: "120px", sortKey: "msmmRemaining" },
    { label: "Org Type", w: "110px", sortKey: "orgType",
      sortValue: r => orgRank(r.clientId) },
    { label: "PM", w: "130px", sortKey: "pm",
      sortValue: r => (r.pmIds || []).map(id => userById(id)?.name || "").join(", ") },
    { label: "Proj #", w: "110px", sortKey: "projectNumber" },
    { label: "__actions", w: "90px", locked: true },
  ];
  const stageColor = s => s?.includes("Construction") ? "sage" : s?.includes("60") ? "accent" : s?.includes("Draft") ? "blue" : "muted";

  const { clientOptions, clientOrFirmOpts, userOptions, roleOptions, stageOptions } = buildOptions();

  // Primary sort by org-type keeps rows grouped (user sort slots in as secondary).
  const primarySort = [{ key: "orgType", dir: "asc" }];

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      primarySort={primarySort}
      postProcess={injectOrgHeaders("project")}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No awarded projects"
      emptyHint="When an awaiting project is awarded, it moves here for tracking."
      emptyIcon="check"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        if (r._orgHeader) {
          const raw = r._orgHeader;
          const orgKey = raw === "—" ? "unknown" : raw.toLowerCase();
          return (
            <div key={r.id} className="trow org-header"
                 data-org={orgKey}
                 style={{ gridTemplateColumns: gridCols }}>
              <div className="td" style={{ color: "var(--text)" }}>
                Org Type : {raw === "—" ? "(unassigned)" : raw} · {r._count} {r._unit}
              </div>
            </div>
          );
        }
        const total = (r.msmmUsed || 0) + (r.msmmRemaining || 0);
        const pct = total ? Math.round(((r.msmmUsed || 0) / total) * 100) : 0;
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Year": (
            <div className="td mono subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, whiteSpace: "normal" }}>
              <span style={{ fontWeight: 500, width: "100%" }}>
                <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
              </span>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-soft)" }}>{r.projectNumber}</span>
            </div>
          ),
          "Client": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Prime": (
            <div className="td subtle">
              <EditableCell value={r.primeId} type="combobox" options={clientOrFirmOpts}
                onChange={v => updateRow(r.id, { primeId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Org Type": (
            <div className="td subtle">
              {(() => {
                const o = companyById(r.clientId)?.orgType;
                return o ? <span className="chip muted">{o}</span> : <span className="empty-cell">—</span>;
              })()}
            </div>
          ),
          "Stage": (
            <div className="td">
              <EditableCell value={r.stage} type="select" options={stageOptions}
                onChange={v => updateRow(r.id, { stage: v })}
                render={v => v
                  ? <span className={`chip ${stageColor(v)}`}>{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Pool": (
            <div className="td subtle" style={{ fontSize: 12 }}>
              <EditableCell value={r.pools}
                onChange={v => updateRow(r.id, { pools: v })}/>
            </div>
          ),
          "Contract": <div className="td mono">{fmtMoney(total || null, false)}</div>,
          "MSMM Used": (
            <div className="td mono subtle">
              <EditableCell value={r.msmmUsed} type="number"
                onChange={v => updateRow(r.id, { msmmUsed: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "Remaining": (
            <div className="td mono" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ color: "var(--accent-ink)", width: "100%" }}>
                <EditableCell value={r.msmmRemaining} type="number"
                  onChange={v => updateRow(r.id, { msmmRemaining: v })}
                  format={v => fmtMoney(v, false)}/>
              </span>
              <div style={{ width: "100%", height: 3, background: "var(--surface-2)", borderRadius: 2 }}>
                <div style={{ width: pct + "%", height: "100%", background: "var(--accent)", borderRadius: 2 }}/>
              </div>
            </div>
          ),
          "Expiry": (
            <div className="td mono subtle">
              <EditableCell value={r.contractExpiry} type="date"
                onChange={v => updateRow(r.id, { contractExpiry: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">—</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono subtle">
              <EditableCell value={r.projectNumber}
                onChange={v => updateRow(r.id, { projectNumber: v })}/>
            </div>
          ),
          "Role": (
            <div className="td">
              <EditableCell value={r.role} type="select" options={roleOptions}
                onChange={v => updateRow(r.id, { role: v })}
                render={v => <RoleChip role={v}/>}/>
            </div>
          ),
          "Subs": (
            <div className="td" style={{ overflow: "visible", whiteSpace: "normal", flexWrap: "wrap", padding: "6px 12px" }}>
              <SubsCell subs={r.subs} wrap/>
            </div>
          ),
          "Submitted": (
            <div className="td mono subtle">
              <EditableCell value={r.dateSubmitted} type="date"
                onChange={v => updateRow(r.id, { dateSubmitted: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Client Contract": (
            <div className="td mono" style={{ fontSize: 12 }}>
              <EditableCell value={r.clientContract}
                onChange={v => updateRow(r.id, { clientContract: v })}/>
            </div>
          ),
          "MSMM Contract": (
            <div className="td mono" style={{ fontSize: 12 }}>
              <EditableCell value={r.msmmContract}
                onChange={v => updateRow(r.id, { msmmContract: v })}/>
            </div>
          ),
          "Status": <div className="td"><span className="chip sage">Awarded</span></div>,
          "Details": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.details} type="textarea"
                onChange={v => updateRow(r.id, { details: v })}
                format={v => truncCell(v, 100)}/>
            </div>
          ),
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end" }}>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                {onMoveToPotential && (
                  <button className="row-btn" title="Move → Potential (billing candidate)"
                          onClick={() => onMoveToPotential(r)}>
                    <Icon name="briefcase" size={14}/>
                  </button>
                )}
                {onForward && (
                  <button className="row-btn forward" title="Move → Invoice"
                          onClick={() => onForward(r)}>
                    <Icon name="forward" size={14}/>
                  </button>
                )}
                <button className="row-btn alert" title="Set alert" onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
            </div>
          ),
        };
        const orgKey = (companyById(r.clientId)?.orgType || "").toLowerCase() || undefined;
        return (
          <div key={r.id} className={"trow" + (flashId === r.id ? " flash" : "")}
               data-org={orgKey}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};


// ---------- Closed Out ----------
export const ClosedTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Year", w: "64px", sortKey: "year" },
    { label: "Project", w: "minmax(240px, 2fr)", sortKey: "name" },
    { label: "Client", w: "minmax(160px, 1fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Submitted", w: "110px", sortKey: "dateSubmitted" },
    { label: "Closed", w: "110px", sortKey: "dateClosed" },
    { label: "Contract", w: "120px", sortKey: "amount" },
    { label: "Reason", w: "minmax(220px, 2fr)", sortKey: "reason" },
    { label: "PM", w: "130px", sortKey: "pm",
      sortValue: r => (r.pmIds || []).map(id => userById(id)?.name || "").join(", ") },
    { label: "Proj #", w: "110px", sortKey: "projectNumber" },
    { label: "Role", w: "100px", sortKey: "role", defaultHidden: true },
    { label: "Subs", w: "minmax(180px, 1.5fr)", defaultHidden: true },
    { label: "Client Contract", w: "150px", sortKey: "clientContract", defaultHidden: true },
    { label: "MSMM Contract", w: "150px", sortKey: "msmmContract", defaultHidden: true },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Status", w: "120px", sortKey: "status", defaultHidden: true },
    { label: "__actions", w: "80px", locked: true },
  ];

  const { clientOptions, clientOrFirmOpts, userOptions, roleOptions } = buildOptions();

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No closed-out projects yet"
      emptyHint="Rows appear here when an Awaiting Verdict project is marked Closed Out."
      emptyIcon="x"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Year": (
            <div className="td mono subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td" style={{ fontWeight: 500 }}>
              <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
              {r.projectNumber && <span className="chip muted" style={{ marginLeft: 8, fontSize: 11 }}>{r.projectNumber}</span>}
            </div>
          ),
          "Client": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={r.role === "Sub" ? clientOrFirmOpts : clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Submitted": (
            <div className="td mono subtle">
              <EditableCell value={r.dateSubmitted} type="date"
                onChange={v => updateRow(r.id, { dateSubmitted: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Closed": (
            <div className="td mono">
              <EditableCell value={r.dateClosed} type="date"
                onChange={v => updateRow(r.id, { dateClosed: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Contract": (
            <div className="td mono subtle">
              <EditableCell value={r.amount} type="number"
                onChange={v => updateRow(r.id, { amount: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "Reason": (
            <div className="td subtle" style={{ whiteSpace: "normal", fontSize: 12.5 }}>
              <EditableCell value={r.reason} type="textarea"
                onChange={v => updateRow(r.id, { reason: v })}/>
            </div>
          ),
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">—</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono subtle">
              <EditableCell value={r.projectNumber}
                onChange={v => updateRow(r.id, { projectNumber: v })}/>
            </div>
          ),
          "Role": (
            <div className="td">
              <EditableCell value={r.role} type="select" options={roleOptions}
                onChange={v => updateRow(r.id, { role: v })}
                render={v => <RoleChip role={v}/>}/>
            </div>
          ),
          "Subs": <div className="td"><SubsCell subs={r.subs}/></div>,
          "Client Contract": (
            <div className="td mono" style={{ fontSize: 12 }}>
              <EditableCell value={r.clientContract}
                onChange={v => updateRow(r.id, { clientContract: v })}/>
            </div>
          ),
          "MSMM Contract": (
            <div className="td mono" style={{ fontSize: 12 }}>
              <EditableCell value={r.msmmContract}
                onChange={v => updateRow(r.id, { msmmContract: v })}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "Status": <div className="td"><span className="chip rose">Closed Out</span></div>,
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end" }}>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                <button className="row-btn alert" title="Set alert" onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
            </div>
          ),
        };
        return (
          <div key={r.id} className={"trow" + (flashId === r.id ? " flash" : "")}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};

// ---------- Invoice Spreadsheet ----------
//
// NOTE: InvoiceTable renders its own <table> (not TableView) because of sticky
// columns, month-by-month cells, and a totals row. Column reorder / resize /
// snapshot are intentionally skipped here. We still wire the Year chip so
// users can filter this spreadsheet by year in the same UX pattern.
// Per-sub compliance documents, rendered as toggle chips on each sub row in
// the Invoice expand view. `key` is the matrix-entry boolean the chip reads;
// `dbKey` is the project_subs column the toggle patches through onUpdateSubMeta.
const SUB_DOCS = [
  { key: "subAgreement", dbKey: "sub_agreement", label: "Sub-Agreement", full: "Subcontractor Agreement" },
  { key: "w9",           dbKey: "w9",            label: "W-9",           full: "W-9 Tax Form" },
  { key: "coi",          dbKey: "coi",           label: "COI",           full: "Certificate of Insurance" },
];

export const InvoiceTable = ({
  tab, rows, updateInvoice, updateInvoiceMsmm, updateRow = _noopUpdate,
  onOpenDrawer, onAlert, flashId,
  yearOptions, yearValue, onYearChange,
  actualThru = TODAY_MONTH,   // last month index shown as "Actual" (cutover-aware)
  cutoverDay = 1,             // day-of-month the current month flips Proj→Actual (for legend copy)
  cutoverNextMonth = false,   // whether that flip lands in the next month (for legend copy)
  orangeSourceIds,   // Set<uuid> of Potential IDs that are tagged Orange
  // Sub-invoices feature: per-project list of {companyId, companyName,
  // contractAmount, discipline, amounts[12], files[12], subInvoiceIds[12],
  // paid[12], paidAt[12]}
  subInvoices,       // Map<project_id, sub_entry[]>
  onUpdateSubAmount, // (projectId, companyId, monthIdx, value, kind) => void
  onOpenFiles,       // ({kind, projectRow, monthIdx, sub?}) => void
  onAddSub,          // (projectRow, kind) => void  — opens the AddSubModal
  onTogglePaid,      // ({projectId, companyId, monthIdx, paid, kind}) => void
  onTogglePrimePaid, // (invoiceId, monthIdx, paid) => void  — prime/total per-month paid
  canUntickPaid = true, // Admin? Paid ticks lock for non-admins (can't untick).
  onChangeRole,      // (projectRow, role) => void  — toggles Prime/Sub on the project
  onUpdateSubMeta,   // ({projectId, companyId, kind, patch}) => void  — inline edit (amount/discipline)
  onRemoveSub,       // ({projectId, companyId, kind, companyName}) => void  — × button on sub row
  onNew,             // () => void  — opens the New Invoice CreateModal
}) => {
  const USERS = getUsers();
  const invoiceTypeOptions = ["ENG", "PM"];
  const pmOptions = USERS.map(u => ({ value: u.id, label: u.name }));
  // A project month counts as "Actual" when the date-driven cutover has reached
  // it OR a bill has been attached to that month on the project's total/prime
  // row — attaching a bill promotes that month from Projection to Actual for
  // the project, even ahead of the cutover. Derived live from r.primeFiles
  // (re-annotated by refreshInvoiceArtifacts after every upload), so the cell
  // flips the instant a bill lands. Applies to the project's MSMM, sub, and
  // total rows; the column header + cross-project grand totals stay on the
  // global cutover.
  const hasPrimeBill = (row, i) => !!(row?.primeFiles && row.primeFiles[i] && row.primeFiles[i].length);
  // month-state class for a project's month cell. `cue` adds the subtle
  // "billed ahead" underline — used only on the total/prime row (where the
  // bill lives) so the promoted column doesn't stack underlines on every row:
  //   • date-driven actual            → "month-actual"
  //   • promoted by a bill (ahead of  → "month-actual" (+ " month-promoted"
  //     the cutover)                     when cue) — amber, billed
  //   • still a projection            → "month-proj"
  const monthCellState = (row, i, cue = false) =>
    i <= actualThru ? "month-actual"
    : hasPrimeBill(row, i) ? ("month-actual" + (cue ? " month-promoted" : ""))
    : "month-proj";
  // The parent row IS the MSMM view of each project — every dollar value
  // shown there reflects MSMM's portion (auto-calculated as Total minus
  // every sub's portion, or the user-saved override when set). The expand
  // block's "Project total" row carries the totals; per-sub rows carry
  // each sub's portion. Helpers below compute the MSMM auto-calc by
  // walking subInvoices for each project.
  //
  // MSMM math only ever subtracts kind='sub' entries — these are firms
  // MSMM hires (money MSMM pays out). The kind='prime' entry on a Sub-role
  // project is informational only (it records the upstream firm hiring
  // MSMM, for cross-reference); it must not be subtracted from Total CV.
  const subListFor = (r) =>
    (subInvoices?.get(r.sourceId) || []).filter(s => (s.kind || "sub") === "sub");
  // MSMM monthly value at month i — override takes precedence; else
  // auto = total[i] − Σ sub.amounts[i].
  const msmmAtMonth = (r, i) => {
    const override = r.msmmValues?.[i];
    if (override != null) return Number(override);
    const total = Number(r.values?.[i] || 0);
    const subSum = subListFor(r).reduce(
      (a, s) => a + Number((s.amounts && s.amounts[i]) || 0), 0);
    return total - subSum;
  };
  // MSMM contract portion — override (msmmAmount) takes precedence; else
  // auto = total contract − Σ sub.contractAmount.
  const msmmContractAuto = (r) => {
    const total = Number(r.amount || 0);
    const subSum = subListFor(r).reduce(
      (a, s) => a + Number(s.contractAmount || 0), 0);
    return total - subSum;
  };
  const msmmContractShown = (r) =>
    r.msmmAmount != null ? Number(r.msmmAmount) : msmmContractAuto(r);

  // Auto-calculated defaults. Shown values respect per-row overrides from
  // the DB (ytdActualOverride / rollforwardOverride). NULL override = auto.
  // YTD Actual is the FULL-YEAR sum (Jan–Dec, actual + projected): editing
  // any single month re-flows YTD automatically. Rollforward is the user's
  // "remaining Jan 1" minus YTD — negative values are surfaced (no clamp)
  // so contract overruns are visible at a glance.
  const totalAll         = (r) => r.values.reduce((a,b) => a + (b || 0), 0);
  const msmmTotalAll     = (r) => Array.from({ length: 12 }, (_, i) => msmmAtMonth(r, i)).reduce((a,b) => a + b, 0);
  const ytdActualAuto    = (r) => msmmTotalAll(r);
  const rollforwardAuto  = (r) => (Number(r.remainingStart) || 0) - ytdActualAuto(r);
  const ytdActualShown   = (r) => r.ytdActualOverride   != null ? r.ytdActualOverride   : ytdActualAuto(r);
  const rollforwardShown = (r) => r.rollforwardOverride != null ? r.rollforwardOverride : rollforwardAuto(r);
  const isYtdOverride    = (r) => r.ytdActualOverride   != null;
  const isRfOverride     = (r) => r.rollforwardOverride != null;
  // Sub / prime / project-total YTD + RF — same semantics scoped to each
  // line's own monthly amounts. "Remaining Jan 1" baseline = the row's own
  // editable remainingStart override when set, else falls back to its contract
  // amount (subs) / Total CV (project total) — matching the prior behavior.
  const subYtdAuto       = (s) => (s.amounts || []).reduce((a,b) => a + (b || 0), 0);
  const subRemaining     = (s) => s.remainingStart != null ? Number(s.remainingStart) : (Number(s.contractAmount) || 0);
  const subRollforward   = (s) => subRemaining(s) - subYtdAuto(s);
  const projectYtdAuto   = (r) => (r.values || []).reduce((a,b) => a + (b || 0), 0);
  const projectRemaining = (r) => r.totalRemainingStart != null ? Number(r.totalRemainingStart) : (Number(r.amount) || 0);
  const projectRollforward = (r) => projectRemaining(r) - projectYtdAuto(r);
  // v2 collapsed source_awarded_id + source_potential_id into a single
  // source_project_id (exposed as r.sourceId). orangeSourceIds is a Set of
  // Potential project ids tagged probability='Orange'; only those match.
  const isOrange = (r) => !!(r.sourceId && orangeSourceIds?.has(r.sourceId));
  const sumBy = (arr, fn) => arr.reduce((a, r) => a + fn(r), 0);
  const nonOrangeRows = rows.filter(r => !isOrange(r));
  const orangeRows    = rows.filter(isOrange);
  const orderedRows   = [...nonOrangeRows, ...orangeRows];

  // Set of invoice-row ids whose sub list is currently expanded inline.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  // Open note/description editor: { id, field, label, accent, name, value } | null
  const [noteModal, setNoteModal] = useState(null);
  const toggleExpand = (id) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Search across project name, project number, type, year, and PM names.
  // Mirrors the column-walking predicate the TableView-based tabs use.
  const [search, setSearch] = useState("");
  const hasSearch = !!search.trim();
  const matchesSearch = (r) => {
    if (!hasSearch) return true;
    const q = search.toLowerCase();
    const haystack = [
      r.name,
      r.projectNumber,
      r.type,
      String(r.year ?? ""),
      ...(r.pmIds || []).map(id => userById(id)?.name || ""),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  };

  // Type filter — multi-select over the invoice_type_enum (ENG / PM). Local
  // state since this is a view-only filter that doesn't affect what's
  // fetched. Default = ENG only (chip reads "Type: ENG") — the Engineering
  // book is the day-to-day view; PM is toggled on explicitly via the chip's
  // popover. Empty selection is still treated as "All" so a stray
  // double-uncheck doesn't suddenly hide every row.
  const [typeFilter, setTypeFilter] = useState(() => new Set(["ENG"]));
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeBtnRef = useRef(null);
  const typeFilterActive =
    typeFilter.size > 0 && typeFilter.size < invoiceTypeOptions.length;
  const matchesType = (r) => {
    if (!typeFilterActive) return true;
    return typeFilter.has(r.type);
  };
  const toggleType = (t) => setTypeFilter(prev => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });
  const typeChipLabel = typeFilterActive
    ? `Type: ${invoiceTypeOptions.filter(t => typeFilter.has(t)).join(" · ")}`
    : "Type: All";

  const passes = (r) => matchesSearch(r) && matchesType(r);

  // Column sort — limited to the columns the user asked to sort on:
  //   Proj # · Project Name · Role · PM
  // Click a header to cycle: unsorted → asc → desc → unsorted (so the
  // user can always get back to the unsorted-with-Orange-pinned-bottom
  // default). Sort applies INSIDE each group (non-Orange / Orange) so
  // the Orange-grouping convention from the line-chart era is preserved
  // — Orange rows always sit below the rest, regardless of sort.
  const [sortBy, setSortBy] = useState({ key: null, dir: "asc" });
  const toggleSort = (key) => {
    setSortBy(prev => {
      if (prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return { key: null, dir: "asc" };
    });
  };
  // Sort key extractors return either a string (compared by localeCompare,
  // case-insensitive) or a number. Empty / null values are normalized so
  // they always sort to the END regardless of direction — leading blanks
  // would otherwise dominate the top of an asc sort.
  const sortValue = (r, key) => {
    switch (key) {
      case "projectNumber": return (r.projectNumber || "").trim();
      case "name":          return (r.name || "").trim();
      case "role":          return (r.role || "").trim();
      case "pm": {
        // Sort by joined PM short-names so multi-PM rows have a stable key.
        // First-PM-name alone would be unstable when teams differ only in
        // the trailing PMs.
        const names = (r.pmIds || [])
          .map(id => userById(id)?.shortName || userById(id)?.name || "")
          .filter(Boolean)
          .sort();
        return names.join(" · ");
      }
      default: return null;
    }
  };
  const compareRows = (a, b) => {
    const va = sortValue(a, sortBy.key);
    const vb = sortValue(b, sortBy.key);
    const aEmpty = va == null || va === "" || (typeof va === "number" && !Number.isFinite(va));
    const bEmpty = vb == null || vb === "" || (typeof vb === "number" && !Number.isFinite(vb));
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    let cmp;
    if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb), undefined, { sensitivity: "base", numeric: true });
    }
    return sortBy.dir === "asc" ? cmp : -cmp;
  };
  // Default order (when no column sort is active): Type ENG before PM, then
  // by project name as a stable tiebreaker. Rows with neither type land last.
  // The Orange-at-bottom split is preserved because this runs per-group.
  const typeRank = (r) => (r.type === "ENG" ? 0 : r.type === "PM" ? 1 : 2);
  const defaultCompare = (a, b) => {
    const t = typeRank(a) - typeRank(b);
    if (t !== 0) return t;
    return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base", numeric: true });
  };
  const sortGroup = (arr) =>
    sortBy.key ? [...arr].sort(compareRows) : [...arr].sort(defaultCompare);

  const searchedNonOrange = sortGroup(nonOrangeRows.filter(passes));
  const searchedOrange    = sortGroup(orangeRows.filter(passes));
  const searchedRows      = [...searchedNonOrange, ...searchedOrange];

  // Expand-/collapse-all, scoped to the currently visible (filtered) rows so
  // it never toggles a project hidden by the type/year/search filter. Union
  // on expand and set-difference on collapse leave any off-screen row's own
  // expansion state untouched, so flipping the filter back is non-destructive.
  const visibleIds   = searchedRows.map(r => r.id);
  const allExpanded  = visibleIds.length > 0 && visibleIds.every(id => expandedIds.has(id));
  const noneExpanded = visibleIds.every(id => !expandedIds.has(id));
  const expandAll    = () => setExpandedIds(prev => new Set([...prev, ...visibleIds]));
  const collapseAll  = () => setExpandedIds(prev => {
    const next = new Set(prev);
    for (const id of visibleIds) next.delete(id);
    return next;
  });

  // "Expand w/ subs" — opens only the projects whose expanded panel would
  // actually show a firm breakdown, and collapses the rest of the visible
  // rows so the result is exactly "the ones with subs/primes are open".
  // rowSubList mirrors the subList logic in the row renderer: a Prime-role
  // row shows its sub firms; a Sub-role row shows the upstream prime plus any
  // further subs — so its breakdown is the whole entry list.
  const rowSubList = (r) => {
    const allEntries = subInvoices?.get(r.sourceId) || [];
    return (r.role || "Prime") === "Prime"
      ? allEntries.filter(s => (s.kind || "sub") === "sub")
      : allEntries;
  };
  const idsWithSubs    = searchedRows.filter(r => rowSubList(r).length > 0).map(r => r.id);
  const hasAnySubs     = idsWithSubs.length > 0;
  const expandWithSubs = () => setExpandedIds(prev => {
    const withSubs = new Set(idsWithSubs);
    const next = new Set(prev);
    for (const id of visibleIds) {
      if (withSubs.has(id)) next.add(id); else next.delete(id);
    }
    return next;
  });

  // Tiny header helper — wraps a sortable <th>'s content with the column's
  // active sort state. Used for the 5 sortable columns; non-sortable
  // columns (Type, Remaining Jan 1, months, totals) keep their plain
  // <th> markup. The caret sits on the right at constant width so click
  // target sizing doesn't shift between sorted/unsorted states.
  const sortableTh = (key, children, extra = {}) => {
    const active = sortBy.key === key;
    const dirGlyph = !active ? "" : sortBy.dir === "asc" ? "▲" : "▼";
    return (
      <th
        {...extra}
        className={(extra.className || "") + " invoice-th-sortable" + (active ? " active" : "")}
        onClick={() => toggleSort(key)}
        title={`Sort by ${typeof children === "string" ? children : key}`}
      >
        <span className="invoice-th-label">{children}</span>
        <span className="invoice-th-caret" aria-hidden="true">{dirGlyph}</span>
      </th>
    );
  };

  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const yearBtnRef = useRef(null);
  const hasYear = Array.isArray(yearOptions) && yearOptions.length > 0;
  const yearChipLabel = hasYear
    ? `Year: ${yearValue ?? "All"}`
    : `Year: ${THIS_YEAR}`;
  const invoiceWrapRef = useRef(null);
  const invoiceTopScrollRef = useRef(null);
  const invoiceTableRef = useRef(null);
  const [invoiceScrollWidth, setInvoiceScrollWidth] = useState(1280);

  // Full-screen toggle: a CSS fixed-overlay (NOT the native Fullscreen API,
  // which doesn't work on non-video elements in iOS Safari). While open we
  // lock body scroll and let Escape close it.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e) => { if (e.key === "Escape") setMaximized(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [maximized]);

  useEffect(() => {
    const wrap = invoiceWrapRef.current;
    const top = invoiceTopScrollRef.current;
    const table = invoiceTableRef.current;
    if (!wrap || !top || !table) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.max(wrap.scrollWidth, table.scrollWidth, wrap.clientWidth);
        setInvoiceScrollWidth(prev => prev === width ? prev : width);
        if (top.scrollLeft !== wrap.scrollLeft) top.scrollLeft = wrap.scrollLeft;
      });
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    ro?.observe(table);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [searchedRows.length, expandedIds.size, maximized]);

  const syncInvoiceScroll = (source) => {
    const wrap = invoiceWrapRef.current;
    const top = invoiceTopScrollRef.current;
    if (!wrap || !top) return;
    const from = source === "top" ? top : wrap;
    const to = source === "top" ? wrap : top;
    if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) {
      to.scrollLeft = from.scrollLeft;
    }
  };
  const onInvoiceTopScroll = () => syncInvoiceScroll("top");
  const onInvoiceBodyScroll = () => syncInvoiceScroll("body");

  return (
    <div className={"tablewrap" + (maximized ? " is-maximized" : "")}>
      <div className="toolbar">
        <div className={"chrome-search" + (hasSearch ? " active" : "")}>
          <Icon name="search" size={13}/>
          <input
            className="chrome-search-input"
            placeholder="Search invoices…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {hasSearch && (
            <button
              type="button"
              className="chrome-search-clear"
              title="Clear search"
              onClick={() => setSearch("")}
              aria-label="Clear search">
              <Icon name="x" size={11}/>
            </button>
          )}
        </div>
        <div className="invoice-count-chip" title={`${rows.length} total · ${nonOrangeRows.length} excluding Orange`}>
          <span className="invoice-count-num mono">{rows.length}</span>
          <span className="invoice-count-label">{rows.length === 1 ? "project" : "projects"}</span>
          <span className="invoice-count-sep">·</span>
          <span className="invoice-count-num mono" style={{ color: "var(--text-soft)" }}>{nonOrangeRows.length}</span>
          <span className="invoice-count-label">w/o Orange</span>
        </div>
        {hasYear ? (
          <button
            ref={yearBtnRef}
            className={"tool-chip" + (yearValue != null ? " on" : "")}
            onClick={() => setYearMenuOpen(v => !v)}
          >
            <Icon name="calendar" size={13}/>
            {yearChipLabel}
          </button>
        ) : (
          <button className="tool-chip on"><Icon name="calendar" size={13}/>{yearChipLabel}</button>
        )}
        <button
          ref={typeBtnRef}
          className={"tool-chip" + (typeFilterActive ? " on" : "")}
          onClick={() => setTypeMenuOpen(v => !v)}
        >
          <Icon name="filter" size={13}/>
          {typeChipLabel}
        </button>
        <button className="tool-chip"><Icon name="user" size={13}/>PM: All</button>
        <div className="tool-sep"/>
        <button
          type="button"
          className="tool-chip"
          onClick={expandAll}
          disabled={!visibleIds.length || allExpanded}
          title="Expand every project to show its sub / firm breakdown"
        >
          <Icon name="chevronDown" size={13}/>
          Expand all
        </button>
        <button
          type="button"
          className="tool-chip"
          onClick={expandWithSubs}
          disabled={!hasAnySubs}
          title="Expand only the projects that have a sub / prime breakdown"
        >
          <Icon name="link" size={13}/>
          Expand w/ subs
        </button>
        <button
          type="button"
          className="tool-chip"
          onClick={collapseAll}
          disabled={noneExpanded}
          title="Collapse every project's sub / firm breakdown"
        >
          <Icon name="chevronRight" size={13}/>
          Collapse all
        </button>
        <div className="tool-sep"/>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {actualThru >= 0 ? (
            <>Showing <strong style={{ color: "var(--accent-ink)" }}>Jan–{MONTHS[actualThru]} as Actual</strong> · {MONTHS[actualThru+1] || "Jan"}–Dec as Projection</>
          ) : (
            <>Showing <strong style={{ color: "var(--accent-ink)" }}>all months as Projection</strong></>
          )} · a month flips to Actual on the {ordinal(cutoverDay)}{cutoverNextMonth ? " of the following month" : ""}
        </span>
        <div className="ml-auto" style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className={"btn sm" + (maximized ? " primary" : "")}
            onClick={() => setMaximized(m => !m)}
            title={maximized ? "Exit full screen (Esc)" : "Expand the invoice table to full screen"}
          >
            <Icon name={maximized ? "minimize" : "maximize"} size={13}/>
            {maximized ? "Exit" : "Fullscreen"}
          </button>
          <button className="btn sm"><Icon name="export" size={13}/>Export</button>
          <button
            type="button"
            className="btn primary sm"
            onClick={() => onNew?.()}
          >
            <Icon name="plus" size={13}/>New invoice row
          </button>
        </div>

        {typeMenuOpen && (
          <Popover anchorRef={typeBtnRef} onClose={() => setTypeMenuOpen(false)} align="left">
            <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
              Filter by type
            </div>
            <button
              className="menu-item"
              onClick={() => setTypeFilter(new Set(invoiceTypeOptions))}
              style={!typeFilterActive ? { color: "var(--accent-ink)" } : undefined}
            >
              <Icon name="filter" size={13}/>
              <span style={{ flex: 1 }}>All types</span>
              {!typeFilterActive && (<span style={{ fontSize: 11, color: "var(--accent)" }}>✓</span>)}
            </button>
            <div className="menu-sep"/>
            {invoiceTypeOptions.map((t) => {
              const checked = typeFilter.has(t);
              return (
                <label
                  key={t}
                  className="menu-item invoice-type-check"
                  onClick={(e) => { e.preventDefault(); toggleType(t); }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleType(t)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span style={{ flex: 1 }}>{t}</span>
                </label>
              );
            })}
          </Popover>
        )}
        {yearMenuOpen && hasYear && (
          <Popover anchorRef={yearBtnRef} onClose={() => setYearMenuOpen(false)} align="left">
            <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
              Select year
            </div>
            <button
              className="menu-item"
              onClick={() => { onYearChange?.(null); setYearMenuOpen(false); }}
              style={yearValue == null ? { color: "var(--accent-ink)" } : undefined}
            >
              <Icon name="calendar" size={13}/>
              <span style={{ flex: 1 }}>All years</span>
              {yearValue == null && (<span style={{ fontSize: 11, color: "var(--accent)" }}>✓</span>)}
            </button>
            <div className="menu-sep"/>
            {yearOptions.map((y) => {
              const active = yearValue === y;
              return (
                <button
                  key={y}
                  className="menu-item"
                  onClick={() => { onYearChange?.(y); setYearMenuOpen(false); }}
                  style={active ? { color: "var(--accent-ink)" } : undefined}
                >
                  <Icon name="calendar" size={13}/>
                  <span style={{ flex: 1 }}>{y}</span>
                  {active && (<span style={{ fontSize: 11, color: "var(--accent)" }}>✓</span>)}
                </button>
              );
            })}
          </Popover>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No invoice rows for this year"
          hint="Invoice rows appear here automatically for each awarded project. Use New invoice row to add one manually."
          iconName="trend"
        />
      ) : (
        <>
          {hasSearch && (
            <div className="chrome-search-summary">
              {searchedRows.length === 0
                ? <>No invoices match <span className="mono">"{search}"</span>.</>
                : <><strong>{searchedRows.length}</strong> of <strong>{rows.length}</strong> match <span className="mono">"{search}"</span></>
              }
            </div>
          )}
          <div
            className="invoice-top-scroll"
            ref={invoiceTopScrollRef}
            onScroll={onInvoiceTopScroll}
            aria-hidden="true"
            tabIndex={-1}
          >
            <div
              className="invoice-top-scroll-spacer"
              style={{ width: invoiceScrollWidth }}
            />
          </div>
          <div className="invoice-wrap" ref={invoiceWrapRef} onScroll={onInvoiceBodyScroll}>
            <table className="invoice-table" ref={invoiceTableRef}>
              <thead>
                <tr>
                  <th className="invoice-expand-col"/>
                  {sortableTh("projectNumber", "Proj #", { className: "sticky-1" })}
                  {sortableTh("name", "Project Name", { className: "sticky-2", style: { minWidth: 260 } })}
                  {sortableTh("role", "Role", { style: { minWidth: 76 } })}
                  <th style={{ minWidth: 76 }}>Type</th>
                  {sortableTh("pm", "PM", { style: { minWidth: 70 } })}
                  {/* Per-sub contract amount slot. Parent rows show "—"; the
                      project's Total Contract Value + MSMM Portion + mismatch
                      live in the summary strip inside the expand block.
                      Sort removed — there's no parent-row value to sort by. */}
                  <th style={{ minWidth: 110 }}>Contract</th>
                  <th style={{ minWidth: 96 }}>Remaining<br/>Jan&nbsp;1</th>
                  {MONTHS.map((m, i) => (
                    <th key={i} className={i <= actualThru ? "month-actual" : "month-proj"}>
                      {m}
                      <div style={{ fontSize: 9, marginTop: 2, opacity: .7 }}>
                        {i <= actualThru ? "actual" : "proj"}
                      </div>
                    </th>
                  ))}
                  <th className="total-cell" style={{ minWidth: 96 }}>YTD Actual</th>
                  <th className="total-cell" style={{ minWidth: 104 }}>Rollforward</th>
                  <th style={{ minWidth: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {searchedRows.map((r) => {
                  const isExpanded = expandedIds.has(r.id);
                  const allEntries = (subInvoices?.get(r.sourceId) || []);
                  // Render block contents by role:
                  //   Prime project → list of sub firms (kind='sub')
                  //   Sub project   → the upstream prime firm (kind='prime',
                  //                    at most one — partial unique index)
                  //                    PLUS any sub firms MSMM further hires
                  //                    (kind='sub', unlimited).
                  // Prime entry sorted first so the upstream relationship is
                  // visually prominent above MSMM's own subs.
                  const role       = r.role || "Prime";
                  const isPrimeRow = role === "Prime";
                  const primeEntry = allEntries.find(s => s.kind === "prime");
                  const subEntries = allEntries.filter(s => (s.kind || "sub") === "sub");
                  const subList    = isPrimeRow
                    ? subEntries
                    : [...(primeEntry ? [primeEntry] : []), ...subEntries];
                  const hasPrimeEntry = !!primeEntry;
                  return (
                  <React.Fragment key={r.id}>
                  <tr className={(flashId === r.id ? "flash" : "") + (isExpanded ? " expanded" : "")}
                      data-prob={isOrange(r) ? "orange" : undefined}
                      onDoubleClick={() => onOpenDrawer?.(r)}
                      style={{ cursor: "default" }}>
                    <td className="invoice-expand-col" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        className={"directory-expand-btn" + (isExpanded ? " open" : "")}
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? "Collapse subs" : "Expand subs"}
                        title={isExpanded
                          ? "Hide subs"
                          : (subList.length > 0
                              ? `${subList.length} sub${subList.length === 1 ? "" : "s"} on this project`
                              : "No subs tracked yet — expand to add")}
                        onClick={() => toggleExpand(r.id)}>
                        <Icon name="chevronRight" size={12}/>
                      </button>
                    </td>
                    <td className="sticky-1 mono" style={{ fontSize: 12 }}>
                      <EditableCell value={r.projectNumber || ""}
                        onChange={v => updateRow(r.id, { projectNumber: v })}/>
                    </td>
                    <td className="sticky-2" style={{ fontWeight: 500 }}>
                      <div className="inv-name-wrap">
                        <EditableCell value={r.name}
                          onChange={v => updateRow(r.id, { name: v })}/>
                        {(() => {
                          const msmmFiles = r.partyFiles?.msmm || [];
                          const hasFiles  = msmmFiles.length > 0;
                          return (
                            <button
                              type="button"
                              className={"invoice-party-clip" + (hasFiles ? " has-files" : "")}
                              title={hasFiles
                                ? `${msmmFiles.length} MSMM file${msmmFiles.length === 1 ? "" : "s"} attached`
                                : "Attach project-level files for MSMM"}
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenFiles?.({ kind: "party-msmm", projectRow: r });
                              }}>
                              <Icon name="link" size={11}/>
                              {hasFiles && <span className="invoice-cell-clip-count">{msmmFiles.length}</span>}
                            </button>
                          );
                        })()}
                        <div className="inv-meta-chips" onDoubleClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            className={"inv-meta-chip accent" + (r.notes ? " has-content" : "")}
                            title={r.notes || "Add notes for this project"}
                            onClick={(e) => {
                              e.stopPropagation();
                              setNoteModal({ id: r.id, field: "notes", label: "Notes",
                                accent: "accent", name: r.name, value: r.notes || "" });
                            }}>
                            <Icon name="note" size={10}/>
                            <span>Notes</span>
                          </button>
                          <button
                            type="button"
                            className={"inv-meta-chip blue" + (r.description ? " has-content" : "")}
                            title={r.description || "Add a description for this project"}
                            onClick={(e) => {
                              e.stopPropagation();
                              setNoteModal({ id: r.id, field: "description", label: "Description",
                                accent: "blue", name: r.name, value: r.description || "" });
                            }}>
                            <Icon name="alignLeft" size={10}/>
                            <span>Description</span>
                          </button>
                        </div>
                      </div>
                    </td>
                    <td>
                      <EditableCell value={role} type="select" options={["Prime","Sub"]}
                        onChange={v => onChangeRole?.(r, v)}
                        render={v => v
                          ? <span className={`chip ${v === "Prime" ? "blue" : "accent"}`} style={{ fontSize: 11 }}>{v}</span>
                          : <span className="empty-cell">—</span>}/>
                    </td>
                    <td>
                      <EditableCell value={r.type} type="select" options={invoiceTypeOptions}
                        onChange={v => updateRow(r.id, { type: v })}
                        render={v => v
                          ? <span className={`chip ${v === "ENG" ? "sage" : "blue"}`} style={{ fontSize: 11 }}>{v}</span>
                          : <span className="empty-cell">—</span>}/>
                    </td>
                    <td>
                      <EditableCell
                        value={r.pmIds || []}
                        type="users"
                        options={pmOptions}
                        placeholder="Pick PMs…"
                        onChange={v => updateRow(r.id, { pmIds: v })}
                        render={v => (v || []).length > 0
                          ? <UserStack ids={v}/>
                          : <span className="empty-cell">—</span>}
                      />
                    </td>
                    {/* Parent row's Contract cell shows MSMM Portion —
                        auto-calc = Total CV − Σ sub.contractAmount when no
                        override is stored; override (msmmAmount) takes over
                        when set. Clearing the cell writes NULL → auto-calc. */}
                    {(() => {
                      const isOverride = r.msmmAmount != null;
                      const shown = msmmContractShown(r);
                      return (
                        <td className={isOverride ? "inv-override" : ""}
                            title={isOverride
                              ? `Override · auto would be ${fmtMoney(msmmContractAuto(r), false)} — clear to resume auto-calc`
                              : "MSMM Portion · auto-calculated as Total Contract Value − Σ subs. Click to override."}>
                          <EditableCell value={shown} type="number"
                            onChange={v => updateRow(r.id, {
                              msmmAmount: (v == null || v === "") ? null : Number(v)
                            })}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        </td>
                      );
                    })()}
                    <td>
                      <EditableCell value={r.remainingStart} type="number"
                        onChange={v => updateRow(r.id, { remainingStart: v })}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    {/* Parent-row month cells show MSMM monthly values —
                        auto-calc = total[i] − Σ sub.amounts[i]; override
                        via msmm_{jan..dec}_amount. Prime invoice file
                        attachments live on the Project total row in the
                        expand block (= the project's prime billing PDFs,
                        not the MSMM-portion view). */}
                    {r.values.map((_, i) => {
                      const override = r.msmmValues?.[i];
                      const isOverride = override != null;
                      const auto       = msmmAtMonth(r, i);
                      const shown      = isOverride ? Number(override) : auto;
                      // Read-only mirror of the Project total row's status for
                      // this month. The total (bottom of the expand) carries the
                      // real attach/paid; surfacing them on the prominent MSMM/
                      // top row gives an at-a-glance read without scrolling down.
                      // Echoes the total row's layout: paid top-left (like its
                      // toggle), attachment top-right (like its clip).
                      const totalPaid  = !!(r.primePaid && r.primePaid[i]);
                      const totalFiles = (r.primeFiles && r.primeFiles[i]) || [];
                      return (
                      <td key={i}
                          className={monthCellState(r, i) + (i === actualThru ? " month-today" : "") + " invoice-cell" + (isOverride ? " inv-override" : "")}
                          title={isOverride
                            ? `Override · auto would be ${fmtMoney(auto, false)}`
                            : "MSMM monthly · auto-calc. Click to override."}>
                        <EditableCell value={shown} type="number"
                          onChange={nv => updateInvoiceMsmm?.(r.id, i,
                            (nv == null || nv === "") ? null : Number(nv))}
                          format={v => v ? fmtMoney(v) : <span style={{ opacity: .4 }}>—</span>}
                        />
                        {totalPaid && (
                          <span className="msmm-mirror paid"
                                title="Project total is marked paid"
                                onClick={(e) => e.stopPropagation()}>
                            <Icon name="check" size={9} stroke={2.6}/>
                          </span>
                        )}
                        {totalFiles.length > 0 && (
                          <span className="msmm-mirror clip"
                                title={`Project total · ${totalFiles.length} file${totalFiles.length === 1 ? "" : "s"} attached`}
                                onClick={(e) => e.stopPropagation()}>
                            <Icon name="link" size={9} stroke={2.2}/>
                          </span>
                        )}
                      </td>
                      );
                    })}
                    <td className={"total-cell" + (isYtdOverride(r) ? " inv-override" : "")}
                        title={isYtdOverride(r)
                          ? "Manually overridden — clear the cell to reset to auto-calc (sum of MSMM Jan–Dec)"
                          : "Auto-calculated · sum of MSMM Jan–Dec (actual + projected). Click to override."}>
                      <EditableCell value={ytdActualShown(r)} type="number"
                        onChange={v => updateRow(r.id, { ytdActualOverride: v == null ? null : Number(v) })}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    <td className={"total-cell" + (isRfOverride(r) ? " inv-override" : "")}
                        style={{ color: rollforwardShown(r) < 0 ? "var(--rose)" : "var(--accent-ink)" }}
                        title={isRfOverride(r)
                          ? "Manually overridden — clear the cell to reset to auto-calc (Remaining Jan 1 − YTD)"
                          : "Auto-calculated · Remaining Jan 1 − YTD Actual. Negative = contract overrun. Click to override."}>
                      <EditableCell value={rollforwardShown(r)} type="number"
                        onChange={v => updateRow(r.id, { rollforwardOverride: v == null ? null : Number(v) })}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    <td style={{ textAlign: "center" }} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                      <button className="row-btn alert" title="Set alert" onClick={() => onAlert(r)}>
                        <Icon name="bell" size={14}/>
                      </button>
                    </td>
                  </tr>
                  {isExpanded && subList.length === 0 && (
                    <tr className="invoice-sub-row invoice-sub-empty">
                      <td className="invoice-expand-col"/>
                      <td className="sticky-1"/>
                      <td className="sticky-2" colSpan={4} style={{ paddingLeft: 28 }}>
                        <span style={{ fontStyle: "italic", color: "var(--text-soft)" }}>
                          {isPrimeRow
                            ? "No subs tracked on this project yet."
                            : "No prime or subs tracked on this project yet."}
                        </span>
                      </td>
                      <td colSpan={16}/>
                    </tr>
                  )}
                  {isExpanded && subList.map((s) => {
                    const entryKind = s.kind || "sub";
                    const isPrimeEntry = entryKind === "prime";
                    return (
                    <tr key={`${r.id}:${entryKind}:${s.companyId}`}
                        className={"invoice-sub-row" + (isPrimeEntry ? " invoice-prime-row" : "")}>
                      <td className="invoice-expand-col">
                        {onRemoveSub && (
                          <button
                            type="button"
                            className="invoice-sub-remove"
                            title={isPrimeEntry
                              ? `Remove ${s.companyName} as the prime`
                              : `Remove ${s.companyName} from this project`}
                            onClick={(e) => {
                              e.stopPropagation();
                              const ok = window.confirm(
                                isPrimeEntry
                                  ? `Remove ${s.companyName} as the prime on this project?\n\nMonthly billing data is preserved and will resurface if you re-add the same prime.`
                                  : `Remove ${s.companyName} as a sub on this project?\n\nMonthly billing data is preserved and will resurface if you re-add the same sub.`
                              );
                              if (!ok) return;
                              onRemoveSub({
                                projectId: r.sourceId,
                                companyId: s.companyId,
                                kind: entryKind,
                                companyName: s.companyName,
                              });
                            }}>
                            <Icon name="x" size={11}/>
                          </button>
                        )}
                      </td>
                      <td className="sticky-1 mono subtle" style={{ fontSize: 11 }}/>
                      <td className="sticky-2">
                        <span className="invoice-sub-name">
                          {s.companyName}
                          {isPrimeEntry && (
                            <span className="invoice-prime-tag mono">PRIME</span>
                          )}
                          {(() => {
                            const partyBucket = isPrimeEntry
                              ? (r.partyFiles?.prime?.[s.companyId] || [])
                              : (r.partyFiles?.sub?.[s.companyId] || []);
                            const hasFiles = partyBucket.length > 0;
                            return (
                              <button
                                type="button"
                                className={"invoice-party-clip" + (hasFiles ? " has-files" : "")}
                                title={hasFiles
                                  ? `${partyBucket.length} file${partyBucket.length === 1 ? "" : "s"} attached to ${s.companyName}`
                                  : `Attach project-level files for ${s.companyName}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenFiles?.({
                                    kind: isPrimeEntry ? "party-prime" : "party-sub",
                                    projectRow: r,
                                    companyId: s.companyId,
                                    companyName: s.companyName,
                                  });
                                }}>
                                <Icon name="link" size={11}/>
                                {hasFiles && <span className="invoice-cell-clip-count">{partyBucket.length}</span>}
                              </button>
                            );
                          })()}
                        </span>
                        <span className="invoice-sub-discipline mono">
                          {s.discipline ? "· " : null}
                          <EditableCell value={s.discipline || ""}
                            onChange={v => onUpdateSubMeta?.({
                              projectId: r.sourceId,
                              companyId: s.companyId,
                              kind: entryKind,
                              patch: { discipline: v },
                            })}
                            format={v => v
                              ? <span>{v}</span>
                              : <span className="invoice-sub-discipline-empty">+ discipline</span>}/>
                        </span>
                        {entryKind === "sub" && (
                          <span className="sub-docs" role="group"
                                aria-label={`Compliance documents for ${s.companyName}`}>
                            {SUB_DOCS.map(doc => {
                              const on = !!s[doc.key];
                              return (
                                <button
                                  key={doc.key}
                                  type="button"
                                  className={"sub-doc-chip" + (on ? " on" : "")}
                                  aria-pressed={on}
                                  title={`${doc.full} — ${on
                                    ? "received (click to clear)"
                                    : "not received (click to mark received)"}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onUpdateSubMeta?.({
                                      projectId: r.sourceId,
                                      companyId: s.companyId,
                                      kind: entryKind,
                                      patch: { [doc.dbKey]: !on },
                                    });
                                  }}>
                                  <span className="sub-doc-tick" aria-hidden="true">
                                    <Icon name="check" size={9}/>
                                  </span>
                                  {doc.label}
                                </button>
                              );
                            })}
                          </span>
                        )}
                      </td>
                      {/* Role column — empty on sub-rows */}
                      <td className="subtle"><span className="empty-cell">—</span></td>
                      <td className="subtle"><span className="empty-cell">—</span></td>
                      <td className="subtle"><span className="empty-cell">—</span></td>
                      <td className="mono">
                        <EditableCell value={s.contractAmount} type="number"
                          onChange={v => onUpdateSubMeta?.({
                            projectId: r.sourceId,
                            companyId: s.companyId,
                            kind: entryKind,
                            patch: { amount: v },
                          })}
                          format={v => v ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                      </td>
                      {/* Remaining Jan 1 (sub) — editable starting balance;
                          NULL falls back to the sub's contract amount. */}
                      <td className="mono"
                          title="Remaining to bill at Jan 1 for this sub. Defaults to the contract amount; edit if some was billed in a prior year. Clear to reset.">
                        <EditableCell value={s.remainingStart != null ? s.remainingStart : (s.contractAmount || null)} type="number"
                          onChange={v => onUpdateSubMeta?.({
                            projectId: r.sourceId,
                            companyId: s.companyId,
                            kind: entryKind,
                            patch: { remaining_to_bill_year_start: v },
                          })}
                          format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                      </td>
                      {s.amounts.map((amt, i) => {
                        const filesForCell = s.files[i] || [];
                        const hasFiles = filesForCell.length > 0;
                        const isPaid   = !!(s.paid && s.paid[i]);
                        const hasAmount = amt != null && amt !== 0;
                        const showPaidToggle = hasAmount || isPaid;
                        return (
                        <td key={i}
                            className={monthCellState(r, i) + (i === actualThru ? " month-today" : "") + " invoice-cell" + (isPaid ? " paid" : "")}
                            data-paid={isPaid ? "true" : undefined}>
                          <EditableCell value={amt} type="number"
                            onChange={nv => onUpdateSubAmount?.(r.sourceId, s.companyId, i, nv, entryKind)}
                            format={v => v != null && v !== 0
                              ? fmtMoney(v)
                              : <span style={{ opacity: 0.4 }}>—</span>}/>
                          {showPaidToggle && (
                            <button
                              type="button"
                              className={"invoice-cell-paid-toggle" + (isPaid ? " paid" : "") + (isPaid && !canUntickPaid ? " locked" : "")}
                              title={isPaid
                                ? (canUntickPaid
                                    ? `Paid${s.paidAt?.[i] ? ` · ${fmtDate(s.paidAt[i])}` : ""} — click to unmark (confirmation required)`
                                    : `Paid${s.paidAt?.[i] ? ` · ${fmtDate(s.paidAt[i])}` : ""} · locked — only an administrator can unmark`)
                                : "Mark as paid"}
                              onClick={(e) => {
                                e.stopPropagation();
                                onTogglePaid?.({
                                  projectId: r.sourceId,
                                  companyId: s.companyId,
                                  monthIdx: i,
                                  paid: !isPaid,
                                  kind: entryKind,
                                });
                              }}>
                              <Icon name={isPaid && !canUntickPaid ? "lock" : "check"} size={11}/>
                            </button>
                          )}
                          {(() => {
                            // Attachment gating is controlled by the
                            // ATTACH_ONLY_ON_ACTUAL flag (currently OFF, so
                            // uploads are allowed on every month). When ON, a
                            // projected month with no files shows a locked,
                            // non-opening clip; rows that already have files
                            // always open so they stay viewable.
                            const attachLocked = ATTACH_ONLY_ON_ACTUAL && !isActualInvoiceMonth(r.year, i) && !hasFiles;
                            return (
                            <button
                              type="button"
                              className={"invoice-cell-clip" + (hasFiles ? " has-files" : "") + (attachLocked ? " locked" : "")}
                              title={attachLocked
                                ? "Attachments can only be added to actual months"
                                : hasFiles
                                  ? `${filesForCell.length} file${filesForCell.length === 1 ? "" : "s"} attached`
                                  : (isPrimeEntry
                                      ? `Attach invoice to ${s.companyName}`
                                      : `Attach invoice from ${s.companyName}`)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (attachLocked) return;
                                onOpenFiles?.({ kind: "sub", projectRow: r, monthIdx: i, sub: s });
                              }}>
                              <Icon name="link" size={11}/>
                              {hasFiles && <span className="invoice-cell-clip-count">{filesForCell.length}</span>}
                            </button>
                            );
                          })()}
                        </td>
                        );
                      })}
                      {/* YTD Actual (sub) — sum of all 12 months, auto-updates
                          as cells change. Rollforward (sub) — contract amount
                          minus YTD; negative means the sub has billed past
                          their contract amount (surfaced in rose so it reads
                          as a warning, not a quiet zero). */}
                      <td className="total-cell mono"
                          title="Auto-calculated · sum of Jan–Dec billings on this sub">
                        {(() => {
                          const ytd = subYtdAuto(s);
                          return ytd ? fmtMoney(ytd) : <span className="empty-cell">—</span>;
                        })()}
                      </td>
                      <td className="total-cell mono"
                          title="Auto-calculated · contract amount − YTD actual">
                        {(() => {
                          const rf = subRollforward(s);
                          if (!s.contractAmount && !subYtdAuto(s)) {
                            return <span className="empty-cell">—</span>;
                          }
                          const overrun = rf < 0;
                          return (
                            <span style={overrun ? { color: "var(--rose)" } : undefined}>
                              {fmtMoney(rf)}
                            </span>
                          );
                        })()}
                      </td>
                      <td/>
                    </tr>
                    );
                  })}
                  {isExpanded && (() => {
                    // Prime-role projects: one button — "Add sub" (unlimited).
                    // Sub-role projects: two buttons —
                    //   "Add prime" (gated by the partial unique index — at
                    //                most one prime entry per project)
                    //   "Add sub"   (always shown; MSMM may further sub-
                    //                contract pieces of its own work)
                    return (
                    <tr className="invoice-sub-add-row">
                      <td className="invoice-expand-col"/>
                      <td className="sticky-1"/>
                      <td className="sticky-2" colSpan={20}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {!isPrimeRow && !hasPrimeEntry && (
                            <button
                              type="button"
                              className="invoice-add-sub-btn"
                              onClick={() => onAddSub?.(r, "prime")}
                              title="Add the upstream prime firm for this project">
                              <Icon name="plus" size={11}/>
                              Add prime
                            </button>
                          )}
                          <button
                            type="button"
                            className="invoice-add-sub-btn"
                            onClick={() => onAddSub?.(r, "sub")}
                            title={isPrimeRow
                              ? "Add a sub to this project"
                              : "Add a firm MSMM further sub-contracts on this project"}>
                            <Icon name="plus" size={11}/>
                            Add sub
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })()}
                  {isExpanded && (
                    // Project total row — sits at the BOTTOM of the expand
                    // block (below the MSMM line on the parent row + each
                    // sub-row + the Add-sub action) so the breakdown reads
                    // bottom-up: per-sub amounts → MSMM → reconciled total.
                    // Total Contract Value lands in the Contract column; the
                    // 12 monthly totals land in the Jan..Dec columns; total
                    // YTD aggregates the months actuals. Each month cell
                    // carries the prime invoice file-attachment button.
                    <tr className="invoice-sub-row invoice-total-row">
                      <td className="invoice-expand-col"/>
                      <td className="sticky-1"/>
                      <td className="sticky-2" style={{ paddingLeft: 28, fontWeight: 600 }}>
                        Project total
                        <span className="invoice-total-row-hint">Total CV + monthly totals</span>
                      </td>
                      <td/>
                      <td/>
                      <td/>
                      <td className="mono">
                        <EditableCell value={r.amount} type="number"
                          onChange={v => updateRow(r.id, { amount: (v == null || v === "") ? null : Number(v) })}
                          format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                      </td>
                      {/* Remaining Jan 1 (project total) — editable starting
                          balance; NULL falls back to Total Contract Value. */}
                      <td className="mono"
                          title="Remaining to bill at Jan 1 for the whole project. Defaults to Total Contract Value; edit if some was billed in a prior year. Clear to reset.">
                        <EditableCell value={r.totalRemainingStart != null ? r.totalRemainingStart : (r.amount || null)} type="number"
                          onChange={v => updateRow(r.id, { totalRemainingStart: (v == null || v === "") ? null : Number(v) })}
                          format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                      </td>
                      {r.values.map((v, i) => {
                        const filesForCell = (r.primeFiles && r.primeFiles[i]) || [];
                        const hasFiles = filesForCell.length > 0;
                        const isPaid   = !!(r.primePaid && r.primePaid[i]);
                        const hasAmount = v != null && v !== 0;
                        const showPaidToggle = hasAmount || isPaid;
                        // Per-month invoice number for this project total cell.
                        const invNum = (r.invoiceNumbers && r.invoiceNumbers[i]) || null;
                        return (
                        <td key={i}
                            className={monthCellState(r, i, true) + (i === actualThru ? " month-today" : "") + " invoice-cell" + (isPaid ? " paid" : "")}
                            data-paid={isPaid ? "true" : undefined}>
                          <EditableCell value={v} type="number"
                            onChange={nv => updateInvoice(r.id, i, nv)}
                            format={v => v ? fmtMoney(v) : <span style={{ opacity: .4 }}>—</span>}
                          />
                          {showPaidToggle && (
                            <button
                              type="button"
                              className={"invoice-cell-paid-toggle" + (isPaid ? " paid" : "") + (isPaid && !canUntickPaid ? " locked" : "")}
                              title={isPaid
                                ? (canUntickPaid
                                    ? "Paid — click to unmark (confirmation required)"
                                    : "Paid · locked — only an administrator can unmark")
                                : "Mark prime invoice as paid"}
                              onClick={(e) => {
                                e.stopPropagation();
                                onTogglePrimePaid?.(r.id, i, !isPaid);
                              }}>
                              <Icon name={isPaid && !canUntickPaid ? "lock" : "check"} size={11}/>
                            </button>
                          )}
                          {(() => {
                            // Same ATTACH_ONLY_ON_ACTUAL gate as the sub clip
                            // above (currently OFF → always attachable).
                            const attachLocked = ATTACH_ONLY_ON_ACTUAL && !isActualInvoiceMonth(r.year, i) && !hasFiles;
                            return (
                            <button
                              type="button"
                              className={"invoice-cell-clip" + (hasFiles ? " has-files" : "") + (attachLocked ? " locked" : "")}
                              title={attachLocked
                                ? "Attachments can only be added to actual months"
                                : hasFiles
                                  ? `${filesForCell.length} file${filesForCell.length === 1 ? "" : "s"} attached`
                                  : "Attach prime invoice file"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (attachLocked) return;
                                onOpenFiles?.({ kind: "prime", projectRow: r, monthIdx: i });
                              }}>
                              <Icon name="link" size={11}/>
                              {hasFiles && <span className="invoice-cell-clip-count">{filesForCell.length}</span>}
                            </button>
                            );
                          })()}
                          {invNum && (
                            <button
                              type="button"
                              className="invoice-cell-invnum"
                              title={`Invoice #${invNum} · click to edit`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenFiles?.({ kind: "prime", projectRow: r, monthIdx: i });
                              }}>
                              <span className="invoice-cell-invnum-hash">#</span>
                              <span className="invoice-cell-invnum-val">{invNum}</span>
                            </button>
                          )}
                        </td>
                        );
                      })}
                      {/* YTD Actual (project) — sum of all 12 monthly project
                          totals. Rollforward (project) — Total CV − YTD,
                          negative in rose to flag a contract overrun. */}
                      <td className="total-cell mono"
                          title="Auto-calculated · sum of Jan–Dec project totals">
                        {(() => {
                          const ytd = projectYtdAuto(r);
                          return ytd ? fmtMoney(ytd) : <span className="empty-cell">—</span>;
                        })()}
                      </td>
                      <td className="total-cell mono"
                          title="Auto-calculated · Total Contract Value − YTD actual">
                        {(() => {
                          const rf = projectRollforward(r);
                          if (!r.amount && !projectYtdAuto(r)) {
                            return <span className="empty-cell">—</span>;
                          }
                          const overrun = rf < 0;
                          return (
                            <span style={overrun ? { color: "var(--rose)" } : undefined}>
                              {fmtMoney(rf)}
                            </span>
                          );
                        })()}
                      </td>
                      <td/>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
                {searchedRows.length > 0 && (
                  <>
                    {/* Total excluding orange (non-orange invoice rows only).
                        Sums respect the active search filter so the totals
                        always match the visible rows. */}
                    <tr>
                      <td className="invoice-expand-col total-cell"/>
                      <td className="sticky-1 total-cell"/>
                      <td className="sticky-2 total-cell" style={{ fontWeight: 600 }}>
                        Total — excl. Orange
                      </td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">{fmtMoney(sumBy(searchedNonOrange, r => r.remainingStart || 0))}</td>
                      {MONTHS.map((_, i) => (
                        <td key={i} className={(i <= actualThru ? "month-actual" : "month-proj") + " total-cell"}>
                          {fmtMoney(sumBy(searchedNonOrange, r => msmmAtMonth(r, i)))}
                        </td>
                      ))}
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(searchedNonOrange, ytdActualShown))}
                      </td>
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(searchedNonOrange, rollforwardShown))}
                      </td>
                      <td className="total-cell"></td>
                    </tr>
                    {/* Total including orange (everything in the searched set) */}
                    <tr>
                      <td className="invoice-expand-col total-cell"/>
                      <td className="sticky-1 total-cell"/>
                      <td className="sticky-2 total-cell" style={{ fontWeight: 700, color: "var(--prob-orange)" }}>
                        Total — incl. Orange
                      </td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">{fmtMoney(sumBy(searchedRows, r => r.remainingStart || 0))}</td>
                      {MONTHS.map((_, i) => (
                        <td key={i} className={(i <= actualThru ? "month-actual" : "month-proj") + " total-cell"}>
                          {fmtMoney(sumBy(searchedRows, r => msmmAtMonth(r, i)))}
                        </td>
                      ))}
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(searchedRows, ytdActualShown))}
                      </td>
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(searchedRows, rollforwardShown))}
                      </td>
                      <td className="total-cell"></td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>

          <div className="invoice-legend">
            <span><span className="legend-sw actual"/>Actual (editable)</span>
            <span><span className="legend-sw proj"/>Projection (editable)</span>
            <span><span className="legend-sw promoted"/>Billed ahead → Actual</span>
            <span><span className="legend-today"/>Actual ▸ Projection boundary</span>
            <span className="ml-auto" style={{ marginLeft: "auto", color: "var(--text-soft)" }}>
              {cutoverNextMonth
                ? <>Each month switches from Projection to Actual on the {ordinal(cutoverDay)} of the following month</>
                : <>Cells automatically switch from Projection to Actual on the {ordinal(cutoverDay)} of each month</>}
              {" "}— or attach a bill to a projected month to mark it Actual now.
            </span>
          </div>
        </>
      )}
      {noteModal && (
        <InvoiceNoteModal
          meta={noteModal}
          onClose={() => setNoteModal(null)}
          onSave={(id, field, text) => updateRow(id, { [field]: text.trim() ? text : null })}
        />
      )}
    </div>
  );
};

// InvoiceNoteModal — lightweight editor for a project's Notes / Description
// (the two chips under the project name in InvoiceTable). Centered modal,
// portaled to <body> so it escapes the scrolling/sticky invoice table.
// Closing via overlay / X / Save / ⌘↵ commits; Cancel / Esc discards.
function InvoiceNoteModal({ meta, onClose, onSave }) {
  const [text, setText] = useState(meta.value || "");
  const taRef = useRef();
  const dirty = text !== (meta.value || "");

  useEffect(() => {
    const el = taRef.current;
    if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
  }, []);

  const commit = () => { if (dirty) onSave(meta.id, meta.field, text); onClose(); };
  const cancel = () => onClose();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return createPortal(
    <>
      <div className="overlay" onClick={commit}/>
      <div className={"modal note-modal note-modal-" + meta.accent} style={{ width: 480 }}>
        <div className="modal-head">
          <div className={"note-modal-badge " + meta.accent}>
            <Icon name={meta.field === "notes" ? "note" : "alignLeft"} size={15}/>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>{meta.label}</div>
            <h3 className="drawer-title note-modal-name" title={meta.name}>
              {meta.name || "Project"}
            </h3>
          </div>
          <button className="drawer-close" onClick={commit} title="Save & close">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body">
          <textarea
            ref={taRef}
            className="input note-textarea"
            placeholder={`Write ${meta.label.toLowerCase()} for this project…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="note-modal-meta">
            <span className="note-modal-hint">
              <kbd>⌘</kbd><kbd>↵</kbd> save · <kbd>Esc</kbd> cancel
            </span>
            <span className="note-modal-count">{text.length} chars</span>
          </div>
        </div>
        <div className="modal-foot">
          <div className="note-modal-foothint">Also shown in the row's detail drawer</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={cancel}>Cancel</button>
            <button className="btn primary sm" onClick={commit} disabled={!dirty}>
              <Icon name="check" size={13}/> Save
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

// ---------- Events: helpers shared by EventsTable ----------
//
// The List view used to render only `r.dateTime` and `r.status` verbatim,
// which meant (a) it never showed multi-day spans the Calendar view
// already exposes via outlookEndDateTime, (b) all-day events with only
// `r.date` rendered as "—", and (c) Status stayed "Booked" forever even
// after the event passed. These helpers bring the List in line with the
// Calendar so both views show the same picture of what's upcoming vs
// what's already happened.

// Re-renders the host component every `intervalMs` so derived Status
// flips Booked → Happened the moment the clock crosses an event's end.
// 60s is fine for status display — sub-minute precision isn't useful.
function useNowTick(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Derive Status purely from the event's timing — past = Happened, future
// (or in-progress mid-multi-day) = Booked. End wins over start so a
// 3-day conference stays "Booked" through day 2 and flips when day 3
// ends. Falls back to date-only for all-day events.
function derivedEventStatus(row, now) {
  // Outlook cancellations override everything else; the existing UI
  // already styles cancelled rows with strikethrough, but we still
  // surface a stable label so sorting/grouping by status is sensible.
  if (row?.outlookIsCancelled) return "Happened";
  const refISO = row?.outlookEndDateTime || row?.dateTime || row?.date;
  if (!refISO) return row?.status || "Booked";
  const refMs = +new Date(refISO);
  if (Number.isNaN(refMs)) return row?.status || "Booked";
  // For all-day events (no time component), treat the calendar day as
  // ending at 23:59:59 local — otherwise an all-day event on today's
  // date would already read "Happened" the moment the page loads.
  let endMs = refMs;
  if (!row?.dateTime && !row?.outlookEndDateTime && row?.date) {
    const d = new Date(refISO);
    d.setHours(23, 59, 59, 999);
    endMs = +d;
  }
  return endMs <= now ? "Happened" : "Booked";
}

// Structured event range formatter — returns { primary, secondary } so
// the cell can stack two lines without inline conditionals. Mirrors what
// the Calendar communicates via the start/end pair on each RBC event.
function fmtEventRange(row) {
  const startISO = row?.dateTime || row?.date;
  if (!startISO) return { primary: "—", secondary: null };
  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) return { primary: "—", secondary: null };
  const hasStartTime = !!row.dateTime;
  const endISO = row.outlookEndDateTime;
  const end = endISO ? new Date(endISO) : null;
  const hasEnd = end && !Number.isNaN(end.getTime());

  const D = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const T = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const startDate = D(start);
  const startTime = hasStartTime ? T(start) : null;

  // No end recorded — single point in time (or all-day) on the start date.
  if (!hasEnd) {
    return hasStartTime
      ? { primary: `${startDate} · ${startTime}`, secondary: null }
      : { primary: `${startDate} · All day`,       secondary: null };
  }

  // We have an end — figure out if it's same-day or multi-day. Compare by
  // date components (not UTC ms) so a Mar 4 11:30 PM → Mar 4 11:55 PM event
  // doesn't accidentally read as multi-day after a tz shift.
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth()    === end.getMonth() &&
    start.getDate()     === end.getDate();

  if (sameDay) {
    if (!hasStartTime) return { primary: `${startDate} · All day`, secondary: null };
    return { primary: `${startDate} · ${startTime} – ${T(end)}`, secondary: null };
  }

  // Multi-day. Day count is inclusive (Jun 4 → Jun 6 = 3 days).
  const msPerDay = 24 * 60 * 60 * 1000;
  const dayDiff = Math.round(
    (Date.UTC(end.getFullYear(),   end.getMonth(),   end.getDate()) -
     Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / msPerDay
  );
  const dayLabel = `${dayDiff + 1} days`;
  if (!hasStartTime) {
    return {
      primary:   `${startDate} → ${D(end)}`,
      secondary: `${dayLabel} · All day`,
      isMultiDay: true,
    };
  }
  return {
    primary:   `${startDate} · ${startTime}`,
    secondary: `→ ${D(end)} · ${T(end)}`,
    isMultiDay: true,
  };
}

// ---------- Events and Other ----------
export const EventsTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  // Tick once a minute so derived Status flips Booked → Happened live as
  // the clock crosses each event's end. Re-render cost is trivial for an
  // events-sized table.
  const now = useNowTick(60_000);

  const cols = [
    { label: "__select", w: "42px", locked: true },
    // Status sorts by the derived value so "Happened" rows cluster together
    // even though the column is no longer column-editable. Stored r.status
    // would mis-sort once events age past their datetime without a manual
    // edit.
    { label: "Status", w: "120px", sortKey: "status",
      sortValue: r => derivedEventStatus(r, now) },
    { label: "Type", w: "140px", sortKey: "type",
      sortValue: r => eventTypeRank(r.type) },
    { label: "Title", w: "minmax(260px, 2.5fr)", sortKey: "title" },
    // Date sort falls back to r.date so all-day events (no datetime, only
    // date) sort alongside timed events instead of sinking to "no value".
    // Multi-day events sort by their start, matching how the Calendar
    // anchors them in week/month views.
    { label: "Date & Time", w: "180px", sortKey: "dateTime",
      sortValue: r => r.dateTime || (r.date ? `${r.date}T00:00:00` : "") },
    { label: "Attendees", w: "minmax(160px, 1.2fr)" },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Rating", w: "150px", sortKey: "stars",
      sortValue: r => starsRank(r.stars) },
    { label: "__actions", w: "80px", locked: true },
  ];
  const typeColor = t => ({
    "Partner": "accent", "AI": "sage", "Project": "blue", "Meetings": "muted",
    "Board Meetings": "blue", "Event": "rose"
  }[t] || "muted");

  const { eventTypeOptions } = buildOptions();

  // No primarySort / postProcess: Events used to inject "Unrated · N events"
  // and "★★★★★ · N events" header rows between star-grouped sections, but
  // since most events are unrated the Unrated header dominated the top of
  // the table as visual noise. User asked to remove it; we dropped the
  // grouping entirely so rows follow whatever sort the user has active
  // (defaults to date desc — newest events at the top). Hot Leads keeps
  // its star-grouping pattern; that table is much smaller and the rating
  // is a primary navigation aid there.

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No events logged yet"
      emptyHint="Track partner touchpoints, conferences, and meetings here."
      emptyIcon="calendar"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Status": (() => {
            // Pure derived display — no inline edit. Calendar passing the
            // event's end flips Booked → Happened automatically via the
            // useNowTick re-render. Tooltip explains the source of truth
            // so an admin scanning the list isn't surprised that the chip
            // doesn't match what they may have stored in the DB.
            const derived = derivedEventStatus(r, now);
            const stale   = r.status && r.status !== derived;
            const refISO  = r.outlookEndDateTime || r.dateTime || r.date;
            const tip = refISO
              ? `Auto: ${derived} — ${derived === "Happened" ? "event already passed" : "event still upcoming"}` +
                (r.outlookEndDateTime ? ` (ends ${fmtDateTime(r.outlookEndDateTime)})` : "") +
                (stale ? ` · stored as "${r.status}"` : "")
              : `${derived} · no datetime recorded`;
            return (
              <div className="td" title={tip}>
                <StatusChip status={derived}/>
              </div>
            );
          })(),
          "Type": (
            <div className="td">
              <EditableCell value={r.type} type="select" options={eventTypeOptions}
                onChange={v => updateRow(r.id, { type: v })}
                render={v => v
                  ? <span className={`chip ${typeColor(v)}`}>{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Title": (
            <div className="td" style={{ fontWeight: 500 }}>
              {r.source === "outlook" ? (
                <span className="td-readonly" title={r.outlookWebLink ? "Synced from Outlook · Edit in Outlook" : "Synced from Outlook"}>
                  <span className="src-mark"><Icon name="link" size={9} stroke={2}/></span>
                  <span className="td-readonly-text">{r.title}</span>
                </span>
              ) : (
                <EditableCell value={r.title}
                  onChange={v => updateRow(r.id, { title: v })}/>
              )}
            </div>
          ),
          "Rating": (
            <div className="td">
              <StarRating value={r.stars}
                onChange={v => updateRow(r.id, { stars: v })}/>
            </div>
          ),
          "Date & Time": (() => {
            // Show the full event range (start + end if present), with
            // multi-day events stacking the end on a second line. Same
            // formatter the Calendar would have produced if it rendered as
            // a list — so a 3-day conference reads as "Jun 4 → Jun 6 ·
            // 3 days" instead of just "Jun 4". Inline edit still applies
            // to start datetime only; end is Outlook-managed.
            const range = fmtEventRange(r);
            const display = (
              <span className="event-range">
                <span className="event-range-primary">{range.primary}</span>
                {range.secondary && (
                  <span className="event-range-secondary">{range.secondary}</span>
                )}
                {range.isMultiDay && (
                  <span className="event-range-badge" title="Spans multiple days">multi-day</span>
                )}
              </span>
            );
            return (
              <div className="td mono subtle">
                {r.source === "outlook" ? (
                  <span className="td-readonly-text">{display}</span>
                ) : (
                  <EditableCell value={r.dateTime} type="datetime-local"
                    onChange={v => updateRow(r.id, { dateTime: v })}
                    format={() => display}/>
                )}
              </div>
            );
          })(),
          "Attendees": <div className="td"><UserStack ids={r.attendees}/></div>,
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end" }}>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                <button className="row-btn alert" title="Set alert" onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
            </div>
          ),
        };
        return (
          <div key={r.id} className={"trow" + (flashId === r.id ? " flash" : "")}
               data-stars={r.stars != null ? String(r.stars) : undefined}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};

// ---------- Hot Leads Quick View ----------
// "What's next" dashboard panel that sits ABOVE the Hot Leads table. Splits
// upcoming Scheduled leads into two type-coded columns (AI · Engineering)
// so the team can scan what's coming up at a glance without scrolling
// through the full table.
//
// Filter rules: dateTime >= now AND status === "Scheduled" AND type set.
// Untyped leads are intentionally skipped (the user has to set a type for
// them to appear) — the hint below the columns surfaces the count so the
// backfill prompt is visible. Cap at 5 cards per column; overflow surfaces
// as "+ N more in the table below" so the user knows where to look.
//
// Clicking a card opens the same DetailDrawer the table rows use.
export const HotLeadsQuickView = ({ rows, onOpenDrawer }) => {
  const CAP = 5;
  const upcoming = useMemo(() => {
    const now = Date.now();
    return (rows || [])
      .filter(r => r.dateTime
        && +new Date(r.dateTime) >= now
        && (r.status || "Scheduled") === "Scheduled")
      .sort((a, b) => +new Date(a.dateTime) - +new Date(b.dateTime));
  }, [rows]);

  const ai      = upcoming.filter(r => r.type === "AI");
  const eng     = upcoming.filter(r => r.type === "Engineering");
  const untyped = upcoming.filter(r => !r.type).length;

  const renderColumn = (label, tone, items) => (
    <section className="hl-quick-col" aria-label={`${label} upcoming hot leads`}>
      <header className="hl-quick-col-head">
        <div className="hl-quick-col-label">
          <span className={`hl-quick-col-dot tone-${tone}`} aria-hidden/>
          {label}
        </div>
        <span className="hl-quick-col-count">
          {items.length === 0
            ? "Nothing upcoming"
            : `${items.length} upcoming`}
        </span>
      </header>
      {items.length === 0 ? (
        <div className="hl-quick-empty">
          <Icon name="trend" size={14}/>
          <span>No {label.toLowerCase()} leads scheduled.</span>
        </div>
      ) : (
        <ol className="hl-quick-list">
          {items.slice(0, CAP).map(r => {
            const company = companyById(r.clientId);
            return (
              <li key={r.id}>
                <button type="button" className="hl-quick-card" data-tone={tone}
                        onClick={() => onOpenDrawer?.(r)}>
                  <div className="hl-quick-card-when">
                    <span className="hl-quick-card-date">{fmtQuickDate(r.dateTime)}</span>
                    <span className="hl-quick-card-time">{fmtQuickTime(r.dateTime)}</span>
                  </div>
                  <div className="hl-quick-card-body">
                    <div className="hl-quick-card-title">{r.title || "Untitled lead"}</div>
                    {company && (
                      <div className="hl-quick-card-client">{company.name}</div>
                    )}
                  </div>
                  {r.stars > 0 && (
                    <div className="hl-quick-card-stars" aria-label={`${r.stars} of 5 stars`}>
                      {"★".repeat(r.stars)}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
          {items.length > CAP && (
            <li className="hl-quick-more">
              + {items.length - CAP} more in the table below
            </li>
          )}
        </ol>
      )}
    </section>
  );

  return (
    <section className="hl-quick-view" aria-label="Upcoming hot leads quick view">
      <header className="hl-quick-view-head">
        <h2 className="hl-quick-view-title">Upcoming hot leads</h2>
        <span className="hl-quick-view-sub">
          {upcoming.length === 0
            ? "Nothing scheduled"
            : `${upcoming.length} scheduled · split by type`}
        </span>
      </header>
      <div className="hl-quick-view-cols">
        {renderColumn("AI",          "sage", ai)}
        {renderColumn("Engineering", "blue", eng)}
      </div>
      {untyped > 0 && (
        <p className="hl-quick-untyped-hint">
          {untyped} upcoming {untyped === 1 ? "lead" : "leads"} {untyped === 1 ? "has" : "have"} no type set · pick one to show {untyped === 1 ? "it" : "them"} here.
        </p>
      )}
    </section>
  );
};

function fmtQuickDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}
function fmtQuickTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
}

// ---------- Hot Leads ----------
// Lightweight tracker for early-stage opportunities (partner chats, trade
// shows, pre-RFP conversations) before they become Potential Projects.
// Structurally similar to Events: title + datetime + attendees + notes,
// plus a Client-or-Firm picker that routes to either client_id or
// prime_company_id on the underlying row via routeClientPick (handled in
// updateHotLeads in App.jsx). Chronological, sorted newest-first.
export const HotLeadsTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Status",      w: "120px", sortKey: "status" },
    { label: "Type",        w: "130px", sortKey: "type" },
    { label: "Title",       w: "minmax(260px, 2.2fr)", sortKey: "title" },
    { label: "Client / Firm", w: "minmax(180px, 1.5fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Date & Time", w: "170px", sortKey: "dateTime" },
    { label: "Attendees",   w: "minmax(160px, 1.2fr)" },
    { label: "Notes",       w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Rating",      w: "150px", sortKey: "stars",
      sortValue: r => starsRank(r.stars) },
    { label: "__actions",   w: "80px", locked: true },
  ];

  // Chip tone per Type. Engineering uses --blue (matches the Project total
  // accent + the existing PRIME chip), AI reuses the sage tone the Events
  // table already gives "AI" so the two tabs feel consistent.
  const hotLeadTypeColor = t => ({
    "Engineering": "blue",
    "AI":          "sage",
  }[t] || "muted");

  const { clientOrFirmOpts, hotLeadStatusOptions, hotLeadTypeOptions } = buildOptions();

  // Group-by-stars (5★ → 1★ → Unrated). Inside each bucket the user's
  // column sort applies — defaults to dateTime desc via buildEffectiveSort.
  const primarySort = [
    { key: "stars",    dir: "asc"  },
    { key: "dateTime", dir: "desc" },
  ];
  const injectStarHeaders = (sortedRows) => {
    if (!sortedRows || sortedRows.length === 0) return sortedRows;
    const counts = {};
    for (const r of sortedRows) {
      const k = r.stars == null ? "_unrated" : String(r.stars);
      counts[k] = (counts[k] || 0) + 1;
    }
    const out = [];
    let lastKey;
    for (const r of sortedRows) {
      const k = r.stars == null ? "_unrated" : String(r.stars);
      if (k !== lastKey) {
        out.push({
          id: `_starsheader_${k}`,
          _starsHeader: k === "_unrated" ? "Unrated" : Number(k),
          _count: counts[k],
        });
        lastKey = k;
      }
      out.push(r);
    }
    return out;
  };

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      primarySort={primarySort}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No hot leads yet"
      emptyHint="Log early-stage opportunities here — partner intros, conference chats, warm pre-RFPs."
      emptyIcon="trend"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        if (r._starsHeader != null) {
          const isUnrated = r._starsHeader === "Unrated";
          const label = isUnrated
            ? `Unrated · ${r._count} ${r._count === 1 ? "lead" : "leads"}`
            : `${"★".repeat(r._starsHeader)}${"☆".repeat(5 - r._starsHeader)} · ${r._count} ${r._count === 1 ? "lead" : "leads"}`;
          return (
            <div key={r.id} className="trow stars-header"
                 data-stars={isUnrated ? "0" : String(r._starsHeader)}
                 style={{ gridTemplateColumns: gridCols }}>
              <div className="td" style={{ color: "var(--text)" }}>
                {label}
              </div>
            </div>
          );
        }
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Status": (
            <div className="td">
              <EditableCell value={r.status} type="select" options={hotLeadStatusOptions}
                onChange={v => updateRow(r.id, { status: v })}
                render={v => <StatusChip status={v}/>}/>
            </div>
          ),
          "Type": (
            <div className="td">
              <EditableCell value={r.type} type="select" options={hotLeadTypeOptions}
                onChange={v => updateRow(r.id, { type: v })}
                render={v => v
                  ? <span className={`chip ${hotLeadTypeColor(v)}`}>{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Title": (
            <div className="td" style={{ fontWeight: 500 }}>
              <EditableCell value={r.title}
                onChange={v => updateRow(r.id, { title: v })}/>
            </div>
          ),
          "Client / Firm": (
            <div className="td subtle" style={{ overflow: "hidden" }}>
              <EditableCell value={r.clientId} type="combobox" options={clientOrFirmOpts}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Rating": (
            <div className="td">
              <StarRating value={r.stars}
                onChange={v => updateRow(r.id, { stars: v })}/>
            </div>
          ),
          "Date & Time": (
            <div className="td mono subtle">
              <EditableCell value={r.dateTime} type="datetime-local"
                onChange={v => updateRow(r.id, { dateTime: v })}
                format={v => fmtDateTime(v)}/>
            </div>
          ),
          "Attendees": <div className="td"><UserStack ids={r.attendees}/></div>,
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end" }}>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                <button className="row-btn alert" title="Set alert" onClick={() => onAlert && onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
            </div>
          ),
        };
        return (
          <div key={r.id} className={"trow" + (flashId === r.id ? " flash" : "")}
               data-stars={r.stars != null ? String(r.stars) : undefined}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};


// ---------- Open Bids ----------
// Pre-Awaiting-Verdict pipeline stage. Tracks RFQ/RFPs under evaluation.
// Inline-editable RFQ # / Client / Service / Due / Web Link / Notes.
// PDF cell renders an upload chip (one PDF per bid). Approval cell renders
// a state chip plus thumbs-up / thumbs-down toggle for Admins; non-admins
// see the state plus approver + timestamp in read-only form.
//
// Row stripe by approval state (pending/approved/rejected) via
// `data-approval` on the trow — see styles.css `.trow[data-approval=…]`.
//
// Move Forward is gated on approval_status==='approved'. The button stays
// rendered (so users can see it exists) but disabled with a tooltip.
export const OpenBidsTable = ({
  tab, rows, updateRow = _noopUpdate, isAdmin = false,
  onOpenDrawer, onForward,
  onApprove, onReject, onClearApproval,
  onUploadPdf, onRemovePdf, onOpenPdf,
  onDelete,
  flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "RFQ/RFP #", w: "minmax(120px, 1fr)", sortKey: "rfqNumber" },
    { label: "Client / Parish", w: "minmax(180px, 1.4fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Service", w: "minmax(220px, 1.6fr)", sortKey: "serviceDescription" },
    { label: "Due Date", w: "170px", sortKey: "dueAt" },
    { label: "PDF", w: "150px" },
    { label: "Web Link", w: "minmax(160px, 1.2fr)", sortKey: "webLink" },
    { label: "Approval", w: "200px", sortKey: "approvalStatus" },
    { label: "Approved By", w: "150px", sortKey: "approverName", defaultHidden: true,
      sortValue: r => userById(r.approvedBy)?.name || "" },
    { label: "Notes", w: "minmax(160px, 1.2fr)", sortKey: "notes", defaultHidden: true },
    { label: "__actions", w: "150px", locked: true },
  ];

  const { clientOptions } = buildOptions();
  const serviceOptions = BID_SERVICE_OPTIONS.map(s => ({ value: s, label: s }));

  // File-input refs keyed by bid id so each row's "Upload PDF" button can
  // trigger its own hidden <input type=file>. Refs live in a Map so the
  // table re-renders don't churn through them.
  const fileInputs = useRef(new Map());
  const triggerUpload = (id) => {
    const el = fileInputs.current.get(id);
    if (el) el.click();
  };

  // Approval state → chip class. sage = approved (positive, matches "check"
  // semantics elsewhere); rose = rejected; muted = pending/awaiting.
  const approvalChipClass = (status) => ({
    approved: "sage",
    rejected: "rose",
    pending:  "muted",
  })[status] || "muted";
  const approvalLabel = (status) => ({
    approved: "Approved",
    rejected: "Rejected",
    pending:  "Pending",
  })[status] || "Pending";

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No open bids yet"
      emptyHint="Add an RFQ/RFP to track it through review. Admins approve a bid before it can be moved to Awaiting Verdict."
      emptyIcon="briefcase"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const approver = r.approvedBy ? userById(r.approvedBy) : null;
        const stampedAt = r.approvedAt ? fmtDateTime(r.approvedAt) : "";
        const isApproved  = r.approvalStatus === "approved";
        const isRejected  = r.approvalStatus === "rejected";

        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "RFQ/RFP #": (
            <div className="td mono" style={{ fontSize: 12.5, fontWeight: 500 }}>
              <EditableCell value={r.rfqNumber}
                onChange={v => updateRow(r.id, { rfqNumber: v })}/>
            </div>
          ),
          "Client / Parish": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Service": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.serviceDescription} type="select" options={serviceOptions}
                onChange={v => updateRow(r.id, { serviceDescription: v || null })}
                render={v => v
                  ? <span className="chip muted" title={v} style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Due Date": (
            <div className="td mono" style={{ color: "var(--accent-ink)" }}>
              <EditableCell value={r.dueAt ? String(r.dueAt).slice(0, 16) : ""} type="datetime-local"
                onChange={v => updateRow(r.id, { dueAt: v ? new Date(v).toISOString() : null })}
                format={v => v ? fmtDateTime(v) : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "PDF": (
            <div className="td" onClick={e => e.stopPropagation()}>
              <input
                type="file"
                accept="application/pdf,.pdf"
                style={{ display: "none" }}
                ref={el => {
                  if (el) fileInputs.current.set(r.id, el);
                  else    fileInputs.current.delete(r.id);
                }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUploadPdf?.(r.id, f);
                  e.target.value = "";   // allow re-pick of same file
                }}
              />
              {r.pdfPath ? (
                <div className="bid-pdf-cell">
                  <button type="button" className="tool-chip on" title={r.pdfName || "Open PDF"}
                          onClick={() => onOpenPdf?.(r)}>
                    <Icon name="check" size={11}/>
                    <span className="bid-pdf-name">{r.pdfName || "PDF"}</span>
                  </button>
                  <button type="button" className="row-btn" title="Remove PDF"
                          onClick={() => onRemovePdf?.(r.id)}
                          style={{ color: "var(--rose)" }}>
                    <Icon name="x" size={11}/>
                  </button>
                </div>
              ) : (
                <button type="button" className="tool-chip" onClick={() => triggerUpload(r.id)}
                        title="Upload an RFQ/RFP PDF (max ~50 MB)">
                  <Icon name="plus" size={11}/>Upload
                </button>
              )}
            </div>
          ),
          "Web Link": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.webLink}
                onChange={v => updateRow(r.id, { webLink: v })}
                placeholder="https://…"
                render={v => v
                  ? <a href={v} target="_blank" rel="noopener noreferrer"
                       onClick={e => e.stopPropagation()}
                       className="bid-link" title={v}>
                      <Icon name="link" size={11}/>
                      <span>{(() => {
                        try { return new URL(v).hostname.replace(/^www\./, ""); }
                        catch { return v; }
                      })()}</span>
                    </a>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Approval": (
            <div className="td" onClick={e => e.stopPropagation()}>
              <div className="bid-approval">
                <span className={`chip ${approvalChipClass(r.approvalStatus)}`}
                      title={approver ? `${approvalLabel(r.approvalStatus)} by ${approver.name}${stampedAt ? " · " + stampedAt : ""}` : approvalLabel(r.approvalStatus)}>
                  <span className="chip-dot"/>{approvalLabel(r.approvalStatus)}
                </span>
                {(isApproved || isRejected) && approver && (
                  <span className="bid-approval-meta" title={stampedAt}>
                    {approver.name} · {fmtDate(r.approvedAt)}
                  </span>
                )}
                {isAdmin && (
                  <div className="bid-approval-actions">
                    {!isApproved && (
                      <button type="button" className="row-btn" title="Approve"
                              onClick={() => onApprove?.(r)} style={{ color: "var(--sage)" }}>
                        <Icon name="thumbsUp" size={13}/>
                      </button>
                    )}
                    {!isRejected && (
                      <button type="button" className="row-btn" title="Reject"
                              onClick={() => onReject?.(r)} style={{ color: "var(--rose)" }}>
                        <Icon name="thumbsDown" size={13}/>
                      </button>
                    )}
                    {(isApproved || isRejected) && (
                      <button type="button" className="row-btn" title="Clear approval"
                              onClick={() => onClearApproval?.(r)}>
                        <Icon name="x" size={12}/>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ),
          "Approved By": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              {approver
                ? <span className="bid-approver">{approver.name}{stampedAt ? ` · ${fmtDate(r.approvedAt)}` : ""}</span>
                : <span className="empty-cell">—</span>}
            </div>
          ),
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td" style={{ justifyContent: "flex-end", gap: 4 }}>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                <button
                  className="row-btn forward"
                  title={isApproved
                    ? "Move to Awaiting Verdict"
                    : "Approve this bid before moving forward"}
                  disabled={!isApproved}
                  onClick={() => isApproved && onForward?.(r)}>
                  <Icon name="forward" size={14}/>
                </button>
                <button className="row-btn" title="Delete bid"
                        onClick={() => {
                          if (confirm("Delete this open bid? This cannot be undone.")) {
                            onDelete?.(r.id);
                          }
                        }}
                        style={{ color: "var(--rose)" }}>
                  <Icon name="trash" size={13}/>
                </button>
              </div>
            </div>
          ),
        };
        return (
          <div key={r.id} className={"trow" + (flashId === r.id ? " flash" : "")}
               data-approval={r.approvalStatus}
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};


// ---------- Directory (Clients + Companies) ----------
// One table for both kinds. Section headers (clients first, companies second)
// come from injectKindHeaders. Columns are a UNION — irrelevant cells render
// an em-dash for the wrong kind so the visual rhythm holds.
//
// Each entity row is *expandable* — a chevron in the leftmost column toggles
// an inline expand row beneath the parent containing the same Linked Projects
// list the drawer shows. Multiple rows can be open at once. The drawer is
// still reachable via double-click (existing behavior preserved).
export const DirectoryTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, projectsByType, invoice, flashId, filters,
  onOpenProject, onMerge, mergeResetKey,
}) => {
  // Set of entity ids currently expanded. Set so multiple can be open.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Multi-select for merge. You can only select one KIND at a time (clients and
  // companies have different reference sets), so the first pick locks the kind
  // and the other kind's checkboxes disable until the selection is cleared.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const byId = React.useMemo(() => {
    const m = new Map();
    for (const r of (rows || [])) if (!r._kindHeader) m.set(r.id, r);
    return m;
  }, [rows]);
  const selectedRows = [...selectedIds].map(id => byId.get(id)).filter(Boolean);
  const selectedKind = selectedRows.length
    ? (selectedRows[0].type === "Client" ? "Client" : "Company")
    : null;
  const kindOf = (r) => (r.type === "Client" ? "Client" : "Company");
  const toggleSelect = (r) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  // Parent bumps mergeResetKey after a successful merge → drop the (now stale)
  // selection so the deleted rows don't linger as checked.
  React.useEffect(() => { setSelectedIds(new Set()); }, [mergeResetKey]);

  const startMerge = () => {
    if (selectedRows.length < 2 || !onMerge) return;
    onMerge(selectedRows, selectedKind);
  };

  const mergeBar = selectedRows.length > 0 ? (
    <div className="merge-actionbar">
      <span className="merge-actionbar-count">{selectedRows.length} selected</span>
      <button className="tool-chip" onClick={clearSelection}>Clear</button>
      <button className="btn primary sm" onClick={startMerge} disabled={selectedRows.length < 2}>
        <Icon name="merge" size={13}/>
        Merge {selectedKind === "Client" ? "clients" : "companies"}
      </button>
    </div>
  ) : null;

  const cols = [
    { label: "__expand", w: "30px", locked: true },
    { label: "__select", w: "42px", locked: true },
    { label: "Name", w: "minmax(220px, 2fr)", sortKey: "name",
      sortValue: r => (r.type === "Client" ? (r.baseName || r.name) : r.name) || "" },
    { label: "District", w: "140px", sortKey: "district",
      sortValue: r => r.district || "" },
    { label: "Org Type", w: "140px", sortKey: "orgType",
      sortValue: r => r.orgType || "" },
    { label: "Type", w: "120px", sortKey: "type",
      sortValue: r => r.type === "Client" ? "" : (r.type || "") },
    { label: "Contact", w: "minmax(150px, 1.2fr)", sortKey: "contact" },
    { label: "Email", w: "minmax(180px, 1.5fr)", sortKey: "email" },
    { label: "Phone", w: "140px", sortKey: "phone" },
    { label: "Location", w: "minmax(140px, 1fr)", sortKey: "address" },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Projects", w: "90px", sortKey: "projectCount",
      sortValue: r => countRefsFor(r.id, projectsByType) },
  ];

  const { orgTypeOptions, companyTypeOptions } = buildOptions();
  const typeColor = t => ({ "Prime": "blue", "Sub": "accent", "Multiple": "rose" }[t] || "muted");
  const dash = <span className="empty-cell">—</span>;

  return (
    <TableView
      tab={tab}
      filters={filters}
      right={mergeBar}
      columns={cols} rows={rows}
      postProcess={injectKindHeaders}
      emptyTitle="No directory entries yet"
      emptyHint="Clients (organizations you contract with) and companies (firms you team with) live here. Add either to start."
      emptyIcon="users"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        // Section header (clients/companies). Same shape as injectOrgHeaders' row.
        if (r._kindHeader) {
          const orgKey = r._kindHeader.toLowerCase();
          return (
            <div key={r.id} className="trow org-header"
                 data-org={orgKey}
                 style={{ gridTemplateColumns: gridCols }}>
              <div className="td" style={{ color: "var(--text)" }}>
                {r._kindHeader} · {r._count} {r._unit}
              </div>
            </div>
          );
        }
        const isClient = r.type === "Client";
        const isExpanded = expandedIds.has(r.id);
        const cells = {
          "__expand": (
            <div className="td td-expand" onClick={e => e.stopPropagation()}>
              <button
                type="button"
                className={"directory-expand-btn" + (isExpanded ? " open" : "")}
                aria-expanded={isExpanded}
                aria-label={isExpanded ? "Collapse linked projects" : "Expand linked projects"}
                onClick={(e) => { e.stopPropagation(); toggleExpand(r.id); }}>
                <Icon name="chevronRight" size={12}/>
              </button>
            </div>
          ),
          "__select": (() => {
            const otherKindLocked = selectedKind && kindOf(r) !== selectedKind;
            return (
              <div className="td row-check" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(r.id)}
                  disabled={otherKindLocked}
                  title={otherKindLocked
                    ? `Finish or clear the ${selectedKind.toLowerCase()} selection first — clients and companies can't be merged together.`
                    : "Select to merge"}
                  onChange={() => toggleSelect(r)}/>
              </div>
            );
          })(),
          "Name": isClient ? (
            <div className="td" style={{ fontWeight: 500 }}>
              <EditableCell value={r.baseName || r.name}
                onChange={v => {
                  const district = r.district || "";
                  updateRow(r.id, {
                    baseName: v,
                    name: district ? v + " — " + district : v,
                  });
                }}/>
            </div>
          ) : (
            <div className="td" style={{ fontWeight: 500 }}>
              <EditableCell value={r.name}
                onChange={v => updateRow(r.id, { name: v })}/>
            </div>
          ),
          "District": isClient ? (
            <div className="td subtle">
              <EditableCell value={r.district}
                onChange={v => {
                  const base = r.baseName || r.name || "";
                  updateRow(r.id, {
                    district: v || "",
                    name: v ? base + " — " + v : base,
                  });
                }}/>
            </div>
          ) : (<div className="td">{dash}</div>),
          "Org Type": isClient ? (
            <div className="td">
              <EditableCell value={r.orgType} type="select" options={orgTypeOptions}
                onChange={v => updateRow(r.id, { orgType: v })}
                render={v => v
                  ? <span className="chip muted">{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ) : (<div className="td">{dash}</div>),
          "Type": isClient ? (
            <div className="td">{dash}</div>
          ) : (
            <div className="td">
              <EditableCell value={r.type} type="select" options={companyTypeOptions}
                onChange={v => updateRow(r.id, { type: v })}
                render={v => v
                  ? <span className={`chip ${typeColor(v)}`}>{v}</span>
                  : <span className="empty-cell">—</span>}/>
            </div>
          ),
          "Contact": (
            <div className="td subtle">
              <EditableCell value={r.contact}
                onChange={v => updateRow(r.id, { contact: v })}/>
            </div>
          ),
          "Email": (
            <div className="td mono subtle" style={{ fontSize: 12 }}>
              <EditableCell value={r.email}
                onChange={v => updateRow(r.id, { email: v })}/>
            </div>
          ),
          "Phone": (
            <div className="td mono subtle" style={{ fontSize: 12 }}>
              <EditableCell value={r.phone}
                onChange={v => updateRow(r.id, { phone: v })}/>
            </div>
          ),
          "Location": (
            <div className="td subtle">
              <EditableCell value={r.address}
                onChange={v => updateRow(r.id, { address: v })}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle" style={{ fontSize: 12.5 }}>
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "Projects": (
            <div className="td mono">
              <button
                type="button"
                className="chip muted directory-projects-chip"
                title={isExpanded ? "Collapse linked projects" : "Expand linked projects"}
                onClick={(e) => { e.stopPropagation(); toggleExpand(r.id); }}>
                {countRefsFor(r.id, projectsByType)}
              </button>
            </div>
          ),
        };
        const linked = isExpanded
          ? linkedProjectsFor(r, projectsByType, invoice)
          : null;
        return (
          <React.Fragment key={r.id}>
            <div className={"trow" + (flashId === r.id ? " flash" : "") + (isExpanded ? " expanded" : "") + (selectedIds.has(r.id) ? " row-selected" : "")}
                 data-kind={isClient ? "client" : "company"}
                 style={{ gridTemplateColumns: gridCols, cursor: "default" }}
                 onDoubleClick={() => onOpenDrawer(r)}>
              {renderOrderedCells(visibleColumns, cells)}
            </div>
            {isExpanded && (
              <div className="directory-expand-row"
                   data-kind={isClient ? "client" : "company"}
                   role="region"
                   aria-label={`Linked projects for ${r.baseName || r.name}`}>
                <LinkedProjectsSection
                  projects={linked}
                  onOpenProject={onOpenProject}
                />
              </div>
            )}
          </React.Fragment>
        );
      }}
    />
  );
};

// ---------- shared helpers for the Directory ----------
function countRefsFor(id, projectsByType) {
  const all = [
    ...(projectsByType?.potential || []),
    ...(projectsByType?.awaiting  || []),
    ...(projectsByType?.awarded   || []),
    ...(projectsByType?.closed    || []),
  ];
  return all.filter(p => p.clientId === id || (p.subs || []).some(s => s.cId === id)).length;
}
