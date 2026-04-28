import React, { useState, useEffect, useRef, useMemo } from "react";
import { Icon } from "./icons.jsx";
import {
  EditableCell, RoleChip, StatusChip, UserTag, UserStack, SubsCell, RowActions,
} from "./primitives.jsx";
import {
  getCompanies, getClientsOnly, getCompaniesOnly, getUsers,
  buildClientOrCompanyOptions,
  companyById, userById,
  fmtMoney, fmtDate, fmtDateTime,
  MONTHS, TODAY_MONTH, THIS_YEAR,
} from "./data.js";
import { setCurrentTableSnapshot } from "./table-state.js";

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

  // Position relative to anchor
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!anchorRef?.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({
      top: r.bottom + 4 + window.scrollY,
      left: align === "right" ? r.right + window.scrollX : r.left + window.scrollX,
    });
  }, [anchorRef, align]);

  return (
    <div ref={ref} className="menu" style={{
      top: pos.top,
      left: align === "right" ? undefined : pos.left,
      right: align === "right" ? (window.innerWidth - pos.left) : undefined,
    }}>
      {children}
    </div>
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
  const searchLabel = hasSearch
    ? `Search · "${search.length > 16 ? search.slice(0, 16) + "…" : search}"`
    : "Add filter";

  const hasYear = Array.isArray(yearOptions) && yearOptions.length > 0;

  return (
    <div className="toolbar">
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
        ref={filterBtnRef}
        className={"tool-chip" + (hasSearch ? " on" : "")}
        onClick={() => setOpenMenu(openMenu === "filter" ? null : "filter")}
      >
        <Icon name="filter" size={13}/>
        {searchLabel}
      </button>

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

      {openMenu === "filter" && (
        <Popover anchorRef={filterBtnRef} onClose={() => setOpenMenu(null)} align="left">
          <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
            Filter rows
          </div>
          <div style={{ padding: "4px 8px 8px" }}>
            <input
              ref={searchInputRef}
              className="input"
              placeholder="Search all columns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              style={{ width: 260 }}
            />
          </div>
          {hasSearch && (
            <>
              <div className="menu-sep"/>
              <button
                className="menu-item"
                onClick={() => setSearch("")}
                style={{ color: "var(--text-muted)" }}
              >
                <Icon name="x" size={13}/>
                <span style={{ flex: 1 }}>Clear</span>
              </button>
            </>
          )}
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

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => {
      try {
        return JSON.stringify(r).toLowerCase().includes(q);
      } catch {
        return false;
      }
    });
  }, [rows, search]);

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
      {/* Table-only horizontal scroll container. Keeps the toolbar fixed-width
          while the header row + data rows scroll together when total column
          width exceeds viewport. The PAGE never gets a horizontal scrollbar.
          .table-scroll-body wraps header + rows so they share a single width
          (max of all children's intrinsic widths). Without the wrapper, each
          .trow would size to its own content and rows would drift out of
          alignment at narrow viewports. */}
      <div className="table-scroll">
        <div className="table-scroll-body">
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
                {fmtMoney(r.amount)}
              </div>
            ),
            "MSMM": (
              <div className="td mono" style={{ fontWeight: 600, color: "var(--accent-ink)" }}>
                {fmtMoney(r.msmm)}
              </div>
            ),
            "Subs": (
              <div className="td mono" style={{ fontWeight: 600 }}>
                {fmtMoney(r.subsTotal)}
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
                format={v => fmtMoney(v)}/>
            </div>
          ),
          "MSMM": (
            <div className="td mono" style={{ color: "var(--accent-ink)" }}>
              <EditableCell value={r.msmm} type="number"
                onChange={v => updateRow(r.id, { msmm: v })}
                format={v => fmtMoney(v)}/>
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
                format={v => fmtMoney(v)}/>
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
                format={v => fmtMoney(v)}/>
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
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Year", w: "64px", sortKey: "year" },
    { label: "Project", w: "minmax(220px, 2fr)", sortKey: "name" },
    { label: "Client", w: "minmax(150px, 1.2fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Org Type", w: "110px", sortKey: "orgType", defaultHidden: true,
      sortValue: r => orgRank(r.clientId) },
    { label: "Stage", w: "150px", sortKey: "stage" },
    { label: "Pool", w: "130px", sortKey: "pools" },
    { label: "Contract", w: "120px", sortKey: "contract",
      sortValue: r => (r.msmmUsed || 0) + (r.msmmRemaining || 0) },
    { label: "MSMM Used", w: "120px", sortKey: "msmmUsed" },
    { label: "Remaining", w: "120px", sortKey: "msmmRemaining" },
    { label: "Expiry", w: "110px", sortKey: "contractExpiry" },
    { label: "PM", w: "130px", sortKey: "pm",
      sortValue: r => (r.pmIds || []).map(id => userById(id)?.name || "").join(", ") },
    { label: "Proj #", w: "110px", sortKey: "projectNumber" },
    { label: "Role", w: "100px", sortKey: "role", defaultHidden: true },
    { label: "Subs", w: "minmax(180px, 1.5fr)", defaultHidden: true },
    { label: "Submitted", w: "120px", sortKey: "dateSubmitted", defaultHidden: true },
    { label: "Client Contract", w: "150px", sortKey: "clientContract", defaultHidden: true },
    { label: "MSMM Contract", w: "150px", sortKey: "msmmContract", defaultHidden: true },
    { label: "Status", w: "120px", sortKey: "status", defaultHidden: true },
    { label: "Details", w: "minmax(200px, 1.5fr)", sortKey: "details", defaultHidden: true },
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
          "Contract": <div className="td mono">{fmtMoney(total || null)}</div>,
          "MSMM Used": (
            <div className="td mono subtle">
              <EditableCell value={r.msmmUsed} type="number"
                onChange={v => updateRow(r.id, { msmmUsed: v })}
                format={v => fmtMoney(v)}/>
            </div>
          ),
          "Remaining": (
            <div className="td mono" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ color: "var(--accent-ink)", width: "100%" }}>
                <EditableCell value={r.msmmRemaining} type="number"
                  onChange={v => updateRow(r.id, { msmmRemaining: v })}
                  format={v => fmtMoney(v)}/>
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
          "Subs": <div className="td"><SubsCell subs={r.subs}/></div>,
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
                format={v => fmtMoney(v)}/>
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
export const InvoiceTable = ({
  tab, rows, updateInvoice, updateRow = _noopUpdate,
  onOpenDrawer, onAlert, flashId,
  yearOptions, yearValue, onYearChange,
  orangeSourceIds,   // Set<uuid> of Potential IDs that are tagged Orange
}) => {
  const USERS = getUsers();
  const invoiceTypeOptions = ["ENG", "PM"];
  const pmOptions = USERS.map(u => ({ value: u.id, label: u.name }));
  // Auto-calculated defaults. Shown values respect per-row overrides from
  // the DB (ytdActualOverride / rollforwardOverride). NULL override = auto.
  const ytdActualAuto    = (r) => r.values.slice(0, TODAY_MONTH + 1).reduce((a,b) => a + (b || 0), 0);
  const totalAll         = (r) => r.values.reduce((a,b) => a + (b || 0), 0);
  const rollforwardAuto  = (r) => Math.max(0, r.remainingStart - totalAll(r));
  const ytdActualShown   = (r) => r.ytdActualOverride   != null ? r.ytdActualOverride   : ytdActualAuto(r);
  const rollforwardShown = (r) => r.rollforwardOverride != null ? r.rollforwardOverride : rollforwardAuto(r);
  const isYtdOverride    = (r) => r.ytdActualOverride   != null;
  const isRfOverride     = (r) => r.rollforwardOverride != null;
  // v2 collapsed source_awarded_id + source_potential_id into a single
  // source_project_id (exposed as r.sourceId). orangeSourceIds is a Set of
  // Potential project ids tagged probability='Orange'; only those match.
  const isOrange = (r) => !!(r.sourceId && orangeSourceIds?.has(r.sourceId));
  const sumBy = (arr, fn) => arr.reduce((a, r) => a + fn(r), 0);
  const nonOrangeRows = rows.filter(r => !isOrange(r));
  const orangeRows    = rows.filter(isOrange);
  const orderedRows   = [...nonOrangeRows, ...orangeRows];

  const [yearMenuOpen, setYearMenuOpen] = useState(false);
  const yearBtnRef = useRef(null);
  const hasYear = Array.isArray(yearOptions) && yearOptions.length > 0;
  const yearChipLabel = hasYear
    ? `Year: ${yearValue ?? "All"}`
    : `Year: ${THIS_YEAR}`;

  return (
    <div className="tablewrap">
      <div className="toolbar">
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
        <button className="tool-chip"><Icon name="filter" size={13}/>Type: All</button>
        <button className="tool-chip"><Icon name="user" size={13}/>PM: All</button>
        <div className="tool-sep"/>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Showing <strong style={{ color: "var(--accent-ink)" }}>Jan–{MONTHS[TODAY_MONTH]} as Actual</strong> · {MONTHS[TODAY_MONTH+1] || "Jan"}–Dec as Projection · switches on the 1st
        </span>
        <div className="ml-auto" style={{ display: "flex", gap: 8 }}>
          <button className="btn sm"><Icon name="export" size={13}/>Export</button>
          <button className="btn primary sm"><Icon name="plus" size={13}/>New invoice row</button>
        </div>

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
          <div className="invoice-wrap">
            <table className="invoice-table">
              <thead>
                <tr>
                  <th className="sticky-1">Proj #</th>
                  <th className="sticky-2" style={{ minWidth: 260 }}>Project Name</th>
                  <th style={{ minWidth: 70 }}>Type</th>
                  <th style={{ minWidth: 80 }}>PM</th>
                  <th>Contract</th>
                  <th>Remaining<br/>Jan 1</th>
                  {MONTHS.map((m, i) => (
                    <th key={i} className={i <= TODAY_MONTH ? "month-actual" : "month-proj"}>
                      {m}
                      <div style={{ fontSize: 9, marginTop: 2, opacity: .7 }}>
                        {i <= TODAY_MONTH ? "actual" : "proj"}
                      </div>
                    </th>
                  ))}
                  <th className="total-cell">YTD Actual</th>
                  <th className="total-cell">Rollforward</th>
                  <th style={{ minWidth: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {orderedRows.map((r) => (
                  <tr key={r.id}
                      className={flashId === r.id ? "flash" : ""}
                      data-prob={isOrange(r) ? "orange" : undefined}
                      onDoubleClick={() => onOpenDrawer?.(r)}
                      style={{ cursor: "default" }}>
                    <td className="sticky-1 mono" style={{ fontSize: 12 }}>
                      <EditableCell value={r.projectNumber || ""}
                        onChange={v => updateRow(r.id, { projectNumber: v })}/>
                    </td>
                    <td className="sticky-2" style={{ fontWeight: 500 }}>
                      <div className="inv-name-wrap">
                        <EditableCell value={r.name}
                          onChange={v => updateRow(r.id, { name: v })}/>
                      </div>
                    </td>
                    <td>
                      <EditableCell value={r.type} type="select" options={invoiceTypeOptions}
                        onChange={v => updateRow(r.id, { type: v })}
                        render={v => v
                          ? <span className={`chip ${v === "ENG" ? "sage" : "blue"}`} style={{ fontSize: 11 }}>{v}</span>
                          : <span className="empty-cell">—</span>}/>
                    </td>
                    <td>
                      {(r.pmIds || []).length > 0
                        ? <UserStack ids={r.pmIds}/>
                        : <span className="empty-cell">—</span>}
                    </td>
                    <td>
                      <EditableCell value={r.amount} type="number"
                        onChange={v => updateRow(r.id, { amount: v })}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    <td>
                      <EditableCell value={r.remainingStart} type="number"
                        onChange={v => updateRow(r.id, { remainingStart: v })}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    {r.values.map((v, i) => (
                      <td key={i}
                          className={(i <= TODAY_MONTH ? "month-actual" : "month-proj") + (i === TODAY_MONTH ? " month-today" : "")}>
                        <EditableCell value={v} type="number"
                          onChange={nv => updateInvoice(r.id, i, nv)}
                          format={v => v ? fmtMoney(v) : <span style={{ opacity: .4 }}>—</span>}
                        />
                      </td>
                    ))}
                    <td className={"total-cell" + (isYtdOverride(r) ? " inv-override" : "")}
                        title={isYtdOverride(r) ? "Manually overridden — clear the cell to reset to auto-calc" : "Auto-calculated — click to override"}>
                      <EditableCell value={ytdActualShown(r)} type="number"
                        onChange={v => updateRow(r.id, { ytdActualOverride: v == null ? null : Number(v) })}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    <td className={"total-cell" + (isRfOverride(r) ? " inv-override" : "")}
                        style={{ color: "var(--accent-ink)" }}
                        title={isRfOverride(r) ? "Manually overridden — clear the cell to reset to auto-calc" : "Auto-calculated — click to override"}>
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
                ))}
                {rows.length > 0 && (
                  <>
                    {/* Total excluding orange (non-orange invoice rows only) */}
                    <tr>
                      <td className="sticky-1 total-cell"/>
                      <td className="sticky-2 total-cell" style={{ fontWeight: 600 }}>
                        Total — excl. Orange
                      </td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">{fmtMoney(sumBy(nonOrangeRows, r => r.amount || 0))}</td>
                      <td className="total-cell">{fmtMoney(sumBy(nonOrangeRows, r => r.remainingStart || 0))}</td>
                      {MONTHS.map((_, i) => (
                        <td key={i} className={(i <= TODAY_MONTH ? "month-actual" : "month-proj") + " total-cell"}>
                          {fmtMoney(sumBy(nonOrangeRows, r => r.values[i] || 0))}
                        </td>
                      ))}
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(nonOrangeRows, ytdActualShown))}
                      </td>
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(nonOrangeRows, rollforwardShown))}
                      </td>
                      <td className="total-cell"></td>
                    </tr>
                    {/* Total including orange (everything) */}
                    <tr>
                      <td className="sticky-1 total-cell"/>
                      <td className="sticky-2 total-cell" style={{ fontWeight: 700, color: "var(--prob-orange)" }}>
                        Total — incl. Orange
                      </td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">—</td>
                      <td className="total-cell">{fmtMoney(sumBy(rows, r => r.amount || 0))}</td>
                      <td className="total-cell">{fmtMoney(sumBy(rows, r => r.remainingStart || 0))}</td>
                      {MONTHS.map((_, i) => (
                        <td key={i} className={(i <= TODAY_MONTH ? "month-actual" : "month-proj") + " total-cell"}>
                          {fmtMoney(sumBy(rows, r => r.values[i] || 0))}
                        </td>
                      ))}
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(rows, ytdActualShown))}
                      </td>
                      <td className="total-cell" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(rows, rollforwardShown))}
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
            <span><span className="legend-today"/>Today column</span>
            <span className="ml-auto" style={{ marginLeft: "auto", color: "var(--text-soft)" }}>
              Cells automatically switch from Projection to Actual on the 1st of each new month.
            </span>
          </div>
        </>
      )}
    </div>
  );
};

// ---------- Events and Other ----------
export const EventsTable = ({
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Status", w: "120px", sortKey: "status" },
    { label: "Type", w: "140px", sortKey: "type",
      sortValue: r => eventTypeRank(r.type) },
    { label: "Title", w: "minmax(260px, 2.5fr)", sortKey: "title" },
    { label: "Date & Time", w: "160px", sortKey: "dateTime" },
    { label: "Attendees", w: "minmax(160px, 1.2fr)" },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "__actions", w: "80px", locked: true },
  ];
  const typeColor = t => ({
    "Partner": "accent", "AI": "sage", "Project": "blue", "Meetings": "muted",
    "Board Meetings": "blue", "Event": "rose"
  }[t] || "muted");

  const { eventStatusOptions, eventTypeOptions } = buildOptions();

  // Group-by-type: rows keep their user sort inside each type, and a header
  // row introduces each type block (same mechanic the Awarded/Awaiting
  // tables use for org-type). eventTypeRank lives at module scope.
  const primarySort = [{ key: "type", dir: "asc" }];
  const injectTypeHeaders = (sortedRows) => {
    if (!sortedRows || sortedRows.length === 0) return sortedRows;
    const counts = {};
    for (const r of sortedRows) {
      const t = r.type || "—";
      counts[t] = (counts[t] || 0) + 1;
    }
    const out = [];
    let lastType;
    for (const r of sortedRows) {
      const t = r.type || "—";
      if (t !== lastType) {
        out.push({
          id: `_typeheader_${t}`,
          _typeHeader: t,
          _count: counts[t],
        });
        lastType = t;
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
      postProcess={injectTypeHeaders}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No events logged yet"
      emptyHint="Track partner touchpoints, conferences, and meetings here."
      emptyIcon="calendar"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        if (r._typeHeader) {
          const raw = r._typeHeader;
          const typeKey = raw === "—" ? "unknown" : raw.toLowerCase().replace(/\s+/g, "-");
          return (
            <div key={r.id} className="trow org-header"
                 data-org={typeKey}
                 style={{ gridTemplateColumns: gridCols }}>
              <div className="td" style={{ color: "var(--text)" }}>
                Type : {raw === "—" ? "(unassigned)" : raw} · {r._count} {r._count === 1 ? "event" : "events"}
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
              <EditableCell value={r.status} type="select" options={eventStatusOptions}
                onChange={v => updateRow(r.id, { status: v })}
                render={v => <StatusChip status={v}/>}/>
            </div>
          ),
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
          "Date & Time": (
            <div className="td mono subtle">
              {r.source === "outlook" ? (
                <span className="td-readonly-text">
                  {r.dateTime ? fmtDateTime(r.dateTime) : (r.date ? fmtDate(r.date) : "—")}
                </span>
              ) : (
                <EditableCell value={r.dateTime} type="datetime-local"
                  onChange={v => updateRow(r.id, { dateTime: v })}
                  format={v => v ? fmtDateTime(v) : (r.date ? fmtDate(r.date) : fmtDateTime(v))}/>
              )}
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
    { label: "Title",       w: "minmax(260px, 2.2fr)", sortKey: "title" },
    { label: "Client / Firm", w: "minmax(180px, 1.5fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Date & Time", w: "170px", sortKey: "dateTime" },
    { label: "Attendees",   w: "minmax(160px, 1.2fr)" },
    { label: "Notes",       w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "__actions",   w: "80px", locked: true },
  ];

  const { clientOrFirmOpts, hotLeadStatusOptions } = buildOptions();

  // Newest-first is the most intuitive default for a running lead list.
  const primarySort = [{ key: "dateTime", dir: "desc" }];

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
               style={{ gridTemplateColumns: gridCols, cursor: "default" }}
               onDoubleClick={() => onOpenDrawer(r)}>
            {renderOrderedCells(visibleColumns, cells)}
          </div>
        );
      }}
    />
  );
};

// ---------- Clients (clients only, with Org Type) ----------
export const ClientsTable = ({ tab, rows, updateRow = _noopUpdate, onOpenDrawer, projectsByType, flashId, filters }) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Name", w: "minmax(220px, 2fr)", sortKey: "name",
      sortValue: r => r.baseName || r.name || "" },
    { label: "District", w: "140px", sortKey: "district",
      sortValue: r => r.district || "" },
    { label: "Org Type", w: "140px", sortKey: "orgType" },
    { label: "Contact", w: "minmax(150px, 1.2fr)", sortKey: "contact" },
    { label: "Email", w: "minmax(180px, 1.5fr)", sortKey: "email" },
    { label: "Phone", w: "140px", sortKey: "phone" },
    { label: "Location", w: "minmax(140px, 1fr)", sortKey: "address" },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Projects", w: "90px", sortKey: "projectCount",
      sortValue: r => countRefsFor(r.id, projectsByType) },
  ];

  const { orgTypeOptions } = buildOptions();

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      emptyTitle="No clients yet"
      emptyHint="Clients are organizations you contract with directly. Add one to start associating projects."
      emptyIcon="users"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Name": (
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
          ),
          "District": (
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
          ),
          "Org Type": (
            <div className="td">
              <EditableCell value={r.orgType} type="select" options={orgTypeOptions}
                onChange={v => updateRow(r.id, { orgType: v })}
                render={v => v
                  ? <span className="chip muted">{v}</span>
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
              <span className="chip muted">{countRefsFor(r.id, projectsByType)}</span>
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

// ---------- Companies (Prime/Sub/Multiple) ----------
export const CompaniesTable = ({ tab, rows, updateRow = _noopUpdate, onOpenDrawer, projectsByType, flashId, filters }) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Company", w: "minmax(220px, 2fr)", sortKey: "name" },
    { label: "Type", w: "130px", sortKey: "type" },
    { label: "Contact", w: "minmax(150px, 1.2fr)", sortKey: "contact" },
    { label: "Email", w: "minmax(180px, 1.5fr)", sortKey: "email" },
    { label: "Phone", w: "140px", sortKey: "phone" },
    { label: "Location", w: "minmax(140px, 1fr)", sortKey: "address" },
    { label: "Notes", w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Projects", w: "90px", sortKey: "projectCount",
      sortValue: r => countRefsFor(r.id, projectsByType) },
  ];
  const typeColor = t => ({ "Prime": "blue", "Sub": "accent", "Multiple": "rose" }[t] || "muted");

  const { companyTypeOptions } = buildOptions();

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      emptyTitle="No companies yet"
      emptyHint="Primes, subs, and partners you work with across projects show up here."
      emptyIcon="briefcase"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox"/>
            </div>
          ),
          "Company": (
            <div className="td" style={{ gap: 8 }}>
              <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
                <EditableCell value={r.name}
                  onChange={v => updateRow(r.id, { name: v })}/>
              </span>
              {r.type && <span className={`chip ${typeColor(r.type)}`} style={{ fontSize: 11 }}>{r.type}</span>}
            </div>
          ),
          "Type": (
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
              <span className="chip muted">{countRefsFor(r.id, projectsByType)}</span>
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

// ---------- shared counter for ClientsTable and CompaniesTable ----------
function countRefsFor(id, projectsByType) {
  const all = [
    ...(projectsByType?.potential || []),
    ...(projectsByType?.awaiting  || []),
    ...(projectsByType?.awarded   || []),
    ...(projectsByType?.closed    || []),
  ];
  return all.filter(p => p.clientId === id || (p.subs || []).some(s => s.cId === id)).length;
}
