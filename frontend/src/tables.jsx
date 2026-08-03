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
  MONTHS, TODAY_MONTH, THIS_YEAR, isActualInvoiceMonth, ATTACH_ONLY_ON_ACTUAL, INVOICE_ACTUALS_MIN_YEAR,
  browseEgnyteFolders,
  linkedProjectsFor,
  BID_SERVICE_OPTIONS,
  CONTRACT_TYPE_OPTIONS, PROJECT_ITEM_TYPE_OPTIONS, PROJECT_ITEM_STATUS_OPTIONS,
  contractTypeLabel, projectItemTypeLabel, projectItemStatusLabel,
} from "./data.js";
import { LinkedProjectsSection } from "./panels.jsx";
import { InvoiceNotesThread } from "./invoice-notes-thread.jsx";
import { DescriptionGeneratorModal } from "./description-generator.jsx";
import { InvoiceLinkCell } from "./invoice-links.jsx";
import { invoiceIsOrange, nextInvoiceOrangePatch } from "./invoice-orange.js";
import {
  INVOICE_TYPE_OPTIONS,
  invoicePerspectiveRole,
  invoicePerspectiveRoleIsDerived,
  invoiceTypeTone,
  isMhzPerspectiveSub,
  isHzPrimeType,
  baseTypeForHz,
  hzTypeForBase,
  invoiceRemainderValue,
  basePerspectiveOwnValue,
  linkedMsmmValue,
  perspectiveSubListBase,
} from "./invoice-perspectives.js";
import { setCurrentTableSnapshot } from "./table-state.js";
import {
  canAttemptLocalFileOpen,
  defaultEgnyteLocalRoot,
  egnyteFolderOpenTarget,
  filterEgnyteFolders,
  EGNYTE_LOCAL_ROOT_STORAGE_KEY,
  openLocalFolderWithHelper,
} from "./egnyte-links.js";
import { HOT_LEAD_STAR_MAX, starLabel, starsRank } from "./star-rating.js";
import {
  Button, InputGroup, Badge, Progress,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
  EmptyState as UIEmptyState,
  Popover as UIPopover, PopoverAnchor as UIPopoverAnchor, PopoverContent as UIPopoverContent,
} from "@/ui";

// 1 → "1st", 2 → "2nd", 5 → "5th", 22 → "22nd". Used by the Invoice tab's
// Actual/Projection legend to phrase the configurable cutover day.
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

const EGNYTE_LOGO_LINKED = "/egnyte/Egnyte-Logo-Linked.svg";
const EGNYTE_LOGO_NOT_LINKED = "/egnyte/Egnyte-Logo--Streamline-Logos-Block.svg";

function EgnyteLogoMark({ size = 14, linked = false }) {
  return (
    <span className="egnyte-logo-mark" style={{ "--egnyte-logo-size": `${size}px` }} aria-hidden="true">
      <span className="egnyte-logo-fallback">E</span>
      <img
        src={linked ? EGNYTE_LOGO_LINKED : EGNYTE_LOGO_NOT_LINKED}
        alt=""
        loading="lazy"
        decoding="async"
        onError={(e) => { e.currentTarget.remove(); }}
      />
    </span>
  );
}

// ---------- Shared empty state ----------
//
// Thin adapter over the design-system EmptyState: the historic
// `{ title, hint, iconName }` signature is preserved for every existing call
// site, while the rendering (dashed frame, icon plate, type scale, both
// themes) comes from `@/ui`. The registry name is bridged to the component
// shape `EmptyState` expects via a memoised wrapper so the icon identity is
// stable across re-renders.
const _iconComponentCache = new Map();
const iconComponentFor = (name) => {
  if (!name) return undefined;
  let C = _iconComponentCache.get(name);
  if (!C) {
    C = (props) => <Icon name={name} {...props} />;
    C.displayName = `TableIcon(${name})`;
    _iconComponentCache.set(name, C);
  }
  return C;
};

// The dashed frame the kit's empty state normally draws is dropped here:
// inside a table shell the `.tablewrap` card already provides the boundary,
// and a second frame reads as a box inside a box. `sticky left-0` keeps the
// message centred in the viewport when a wide table is scrolled sideways.
// These have to be utilities, not CSS in styles.css, because `.bx-empty`
// lives in a later cascade layer than the legacy stylesheet.
export const EmptyState = ({ title, hint, iconName }) => (
  <UIEmptyState
    className="bxt-empty sticky left-0 border-0 bg-none bg-transparent rounded-none"
    icon={iconComponentFor(iconName)}
    title={title}
    description={hint}
  />
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
  if (!text) return <span className="empty-cell">–</span>;
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

// Readable name for an internal (__*) column, used only as the accessible
// name of its header cell — the visible label stays blank.
const INTERNAL_COLUMN_NAMES = {
  __select:  "Select",
  __actions: "Actions",
  __expand:  "Expand",
};
const internalColumnName = (label) => {
  if (INTERNAL_COLUMN_NAMES[label]) return INTERNAL_COLUMN_NAMES[label];
  const bare = String(label || "").replace(/^_+/, "").replace(/[-_]+/g, " ").trim();
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Column";
};

// Accessible name for the grid as a whole. Purely a label lookup: it never
// affects which rows or columns a table renders.
const TAB_TABLE_NAMES = {
  potential:       "Potential projects",
  awaiting:        "Proposals",
  awarded:         "Awarded projects",
  closed:          "Closed out projects",
  events:          "Events and other",
  hotleads:        "Hot leads",
  openbids:        "Open bids",
  directory:       "Directory",
  projects:        "Projects",
  "leads-deleted": "Deleted leads and bids",
};
// The tables are CSS-grid rows rather than <tr> elements (column widths are
// user-resizable and user-reorderable, which a real <table> can't express),
// so the grid carries explicit ARIA roles instead. `asGridRow` stamps
// role="row" onto whatever a table's renderRow returned, and
// renderOrderedCells stamps role="cell" onto each cell. Both are strictly
// additive: an element that already declares a role, or that isn't a plain
// DOM element (fragments, arrays, null), is returned untouched.
const withRole = (node, role) => {
  if (!React.isValidElement(node)) return node;
  if (typeof node.type !== "string") return node;
  if (node.props.role != null) return node;
  return React.cloneElement(node, { role });
};
const asGridRow = (node) => withRole(node, "row");

const tableAccessibleName = (tab) => {
  if (!tab) return "Data table";
  if (TAB_TABLE_NAMES[tab]) return TAB_TABLE_NAMES[tab];
  const s = String(tab).replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Data table";
};

// ---------- Shared no-op for optional `updateRow` props ----------
//
// Parent callers (App.jsx) don't currently pass an `updateRow` into a few of
// the tables (ClosedTable, EventsTable, ClientsTable, CompaniesTable). Those
// tables still render EditableCell now, so we default to a harmless no-op.
const _noopUpdate = () => {};

// ---------- Popover (menu) ----------
//
// Same call signature as the hand-rolled version it replaces
// (`anchorRef`, `onClose`, `align`, children) but the overlay itself is now
// the Radix-backed `Popover` from `@/ui`: portalling, collision flipping,
// Escape, outside-dismiss and the `aria-*` wiring are handled by the
// primitive instead of by three hand-written document listeners.
//
// Two deliberate carry-overs from the old behaviour:
//   • the anchor is a *virtual* anchor, so callers keep passing a ref to a
//     button they render themselves rather than wrapping it in a trigger;
//   • an interaction on that anchor does NOT dismiss here — the anchor's own
//     onClick already toggles the menu, and letting both fire would reopen
//     the menu on every close click.
const Popover = ({ anchorRef, onClose, children, align = "left" }) => (
  <UIPopover open onOpenChange={(next) => { if (!next) onClose(); }}>
    <UIPopoverAnchor virtualRef={anchorRef} />
    <UIPopoverContent
      align={align === "right" ? "end" : "start"}
      sideOffset={6}
      className="bxt-menu w-auto min-w-[220px] max-w-[min(340px,calc(100vw-24px))] p-1"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onInteractOutside={(e) => {
        if (anchorRef?.current && anchorRef.current.contains(e.target)) e.preventDefault();
      }}
    >
      {children}
    </UIPopoverContent>
  </UIPopover>
);

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
    <div className="thead bxt-thead" role="row" style={{ gridTemplateColumns: grid }}>
      {visible.map((c, i) => {
        const sortable = !!c.sortKey;
        const active = sortable && sort.key === c.sortKey;
        const canDrag = !c.locked && !!onReorder;
        const isDragging = dragLabel === c.label;
        const isOver = overLabel === c.label && dragLabel && dragLabel !== c.label && canDrag;
        const internal = isInternalLabel(c.label);
        const displayLabel = internal ? "" : c.label;
        const accessibleLabel = internal ? internalColumnName(c.label) : c.label;

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
          "bxt-th",
          active ? "sorted" : "",
          c.className || "",
          isDragging ? "col-dragging" : "",
          isOver ? "col-dragover" : "",
        ].filter(Boolean).join(" ");

        return (
          <div key={c.label + ":" + i}
               className={classes}
               role="columnheader"
               aria-sort={sortable ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
               data-sorted={active ? (sort.dir === "asc" ? "asc" : "desc") : undefined}
               {...dragProps}>
            {sortable ? (
              // A real button, so the column is reachable and operable from
              // the keyboard. It carries `draggable` too: dragstart bubbles up
              // to the header cell's handler, which is what browsers need in
              // order to start a column drag from inside a form control.
              <button
                type="button"
                className="bxt-th-btn"
                draggable={canDrag || undefined}
                onClick={() => onSortToggle(c.sortKey)}
                title={`Sort by ${accessibleLabel}`}
              >
                <span className="bxt-th-label">{displayLabel}</span>
                <span className="bxt-th-sort" aria-hidden="true">
                  <Icon
                    name={active ? (sort.dir === "asc" ? "chevronUp" : "chevronDown") : "chevronsUpDown"}
                    size={12}
                  />
                </span>
              </button>
            ) : (
              <span className="bxt-th-label">
                {displayLabel || <span className="sr-only">{accessibleLabel}</span>}
              </span>
            )}
            {!c.locked && setColumnWidths && (
              <div
                className="col-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${accessibleLabel} column`}
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
  const sortedColLabel = sort.key
    ? (columns.find(c => c.sortKey === sort.key)?.label || sort.key)
    : null;
  const hiddenCount = hiddenCols.size;

  return (
    <div className="bxt-toolbar">
      {/* Search — first control in the chrome and the one users reach for
          most, so it keeps the leading slot at every width. */}
      <InputGroup
        ref={searchInputRef}
        className="bxt-search"
        // The design-system input paints from Tailwind utilities, which sit in
        // a later cascade layer than styles.css — so the "has a query" tint
        // has to be expressed as utilities too rather than in the CSS block.
        inputClassName={hasSearch
          ? "border-[var(--accent)] bg-[var(--accent-softer)] text-[var(--accent-ink)]"
          : undefined}
        type="text"
        placeholder="Search rows"
        aria-label="Search rows"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        leading={<Icon name="search" size={14}/>}
        trailing={hasSearch ? (
          <button
            type="button"
            className="bxt-search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => setSearch("")}
          >
            <Icon name="x" size={12}/>
          </button>
        ) : null}
      />

      {/* Filter strip — scrolls sideways on phones rather than wrapping into
          a tall stack or pushing the page wide. */}
      {(filters?.length > 0 || hasYear) && (
        <div className="bxt-filterstrip" role="group" aria-label="Filters">
          {filters?.map((f, i) => (
            <button
              key={i}
              type="button"
              className={"bxt-chip" + (f.active ? " is-on" : "")}
              aria-pressed={!!f.active}
              onClick={f.onClick}
            >
              {f.icon && <Icon name={f.icon} size={13}/>}
              <span className="bxt-chip-label">{f.label}</span>
              {f.count != null && <span className="bxt-chip-count num">{f.count}</span>}
            </button>
          ))}

          {hasYear && (
            <DropdownMenu
              modal={false}
              open={openMenu === "year"}
              onOpenChange={(o) => setOpenMenu(o ? "year" : null)}
            >
              <DropdownMenuTrigger asChild>
                <button
                  ref={yearBtnRef}
                  type="button"
                  className={"bxt-chip" + (yearValue != null ? " is-on" : "")}
                >
                  <Icon name="calendar" size={13}/>
                  <span className="bxt-chip-label">Year</span>
                  <span className="bxt-chip-count num">{yearValue ?? "All"}</span>
                  <Icon name="chevronDown" size={12} className="bxt-chip-caret"/>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bxt-menu">
                <DropdownMenuLabel>Select year</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={yearValue == null ? "__all" : String(yearValue)}
                  onValueChange={(v) => {
                    onYearChange?.(v === "__all"
                      ? null
                      : yearOptions.find(y => String(y) === v));
                  }}
                >
                  <DropdownMenuRadioItem value="__all">All years</DropdownMenuRadioItem>
                  <DropdownMenuSeparator/>
                  {yearOptions.map((y) => (
                    <DropdownMenuRadioItem key={y} value={String(y)} className="num">
                      {y}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <div className="bxt-toolbar-actions">
        <DropdownMenu
          modal={false}
          open={openMenu === "sort"}
          onOpenChange={(o) => setOpenMenu(o ? "sort" : null)}
        >
          <DropdownMenuTrigger asChild>
            <button
              ref={sortBtnRef}
              type="button"
              className={"bxt-tool" + (sort.key ? " is-on" : "")}
            >
              <Icon name="sort" size={13}/>
              <span className="bxt-tool-label">Sort</span>
              {sort.key && (
                <span className="bxt-tool-value">
                  <span className="bxt-truncate">{sortedColLabel}</span>
                  <Icon name={sort.dir === "asc" ? "chevronUp" : "chevronDown"} size={11}/>
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="bxt-menu">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            {sortableCols.length === 0 && (
              <p className="bxt-menu-empty">No sortable columns</p>
            )}
            {sortableCols.map((c, i) => {
              const active = sort.key === c.sortKey;
              return (
                <DropdownMenuItem
                  key={i}
                  // Keep the menu open after a toggle so the user can cycle
                  // asc → desc → off, or pick a different column, in place.
                  onSelect={(e) => { e.preventDefault(); onSortToggle(c.sortKey); }}
                  data-active={active ? "true" : undefined}
                >
                  <Icon name="sort" size={13}/>
                  <span className="bxt-menu-text">{c.label}</span>
                  {active && (
                    <span className="bxt-menu-hint">
                      <Icon name={sort.dir === "asc" ? "chevronUp" : "chevronDown"} size={11}/>
                      {sort.dir === "asc" ? "Asc" : "Desc"}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
            {sort.key && (
              <>
                <DropdownMenuSeparator/>
                <DropdownMenuItem onSelect={() => { /* clear */ }}>
                  <Icon name="x" size={13}/>
                  <span className="bxt-menu-text">Clear sort</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu
          modal={false}
          open={openMenu === "columns"}
          onOpenChange={(o) => setOpenMenu(o ? "columns" : null)}
        >
          <DropdownMenuTrigger asChild>
            <button
              ref={colsBtnRef}
              type="button"
              className={"bxt-tool" + (hiddenCount > 0 ? " is-on" : "")}
            >
              <Icon name="columns" size={13}/>
              <span className="bxt-tool-label">Columns</span>
              {hiddenCount > 0 && (
                <span className="bxt-tool-value">
                  <span className="num">{hiddenCount}</span> hidden
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bxt-menu">
            <DropdownMenuLabel>Show columns</DropdownMenuLabel>
            {columns.map((c, i) => {
              if (c.locked) return null; // can't hide checkbox or actions
              if (isInternalLabel(c.label)) return null; // defensive: never expose __* columns
              const visible = !hiddenCols.has(c.label);
              return (
                <DropdownMenuCheckboxItem
                  key={i}
                  checked={visible}
                  onCheckedChange={() => toggleHidden(c.label)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="bxt-menu-text">
                    {c.label || <span className="bxt-menu-unnamed">(unnamed)</span>}
                  </span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {right}

        {onNew && (
          <Button variant="primary" size="sm" onClick={onNew}>
            <Icon name="plus" size={14}/>{newLabel}
          </Button>
        )}
      </div>
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
        <div className="bxt-searchsummary" role="status" aria-live="polite">
          {filteredRows.length === 0
            ? <>No rows match <span className="bxt-searchterm">"{search}"</span>.</>
            : <><strong className="num">{filteredRows.length}</strong> of <strong className="num">{rows.length}</strong> match <span className="bxt-searchterm">"{search}"</span></>
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
        <div
          className="table-scroll-body"
          ref={tableScrollBodyRef}
          role="table"
          aria-label={`${tableAccessibleName(tab)} table`}
        >
          <HeaderRow
            columns={orderedColumns} gridCols={gridCols} sort={sort}
            onSortToggle={onSortToggle} hiddenCols={hiddenCols}
            onReorder={onReorder}
            columnWidths={columnWidths} setColumnWidths={setColumnWidths}
          />
          {sortedRows.length === 0
            ? null
            : processedRows.map((r, i) => asGridRow(renderRow(r, i, gridCols, visibleColumns, hiddenCols)))}
        </div>
        {/* The empty state sits beside the grid rather than inside it: it is
            not a row, and keeping it out of the `role="table"` subtree means
            assistive tech never announces a stray cell-less row. It also lets
            the message centre on the viewport instead of on the (possibly
            much wider) column track sum. */}
        {sortedRows.length === 0 && (
          showNoMatches ? (
            <EmptyState
              title="No matches"
              hint={`Nothing matches "${search}".`}
              iconName="search"
            />
          ) : (
            <EmptyState title={emptyTitle} hint={emptyHint} iconName={emptyIcon}/>
          )
        )}
      </div>
    </div>
  );
};

// ---------- Standalone Toolbar (kept for any external caller) ----------
export const Toolbar = ({ filters, right, onNew, newLabel = "New" }) => (
  <div className="bxt-toolbar">
    {filters?.length > 0 && (
      <div className="bxt-filterstrip" role="group" aria-label="Filters">
        {filters.map((f, i) => (
          <button
            key={i}
            type="button"
            className={"bxt-chip" + (f.active ? " is-on" : "")}
            aria-pressed={!!f.active}
            onClick={f.onClick}
          >
            {f.icon && <Icon name={f.icon} size={13}/>}
            <span className="bxt-chip-label">{f.label}</span>
            {f.count != null && <span className="bxt-chip-count num">{f.count}</span>}
          </button>
        ))}
      </div>
    )}
    <div className="bxt-toolbar-actions">
      <button type="button" className="bxt-tool">
        <Icon name="filter" size={13}/><span className="bxt-tool-label">Add filter</span>
      </button>
      <button type="button" className="bxt-tool">
        <Icon name="sort" size={13}/><span className="bxt-tool-label">Sort</span>
      </button>
      <button type="button" className="bxt-tool">
        <Icon name="columns" size={13}/><span className="bxt-tool-label">Columns</span>
      </button>
      {right}
      {onNew && (
        <Button variant="primary" size="sm" onClick={onNew}>
          <Icon name="plus" size={14}/>{newLabel}
        </Button>
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
      {withRole(cells[col.label] ?? null, "cell")}
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
    invoiceTypeOptions:  INVOICE_TYPE_OPTIONS,
    companyTypeOptions:  ["Prime", "Sub", "Multiple"],
    stageOptions:        ["Multi-Use Contract", "Single Use Contract (Project)", "AE Selected List"],
  };
};

/* ======================================================================
   PROPOSALS & AWARDED PIPELINE — shared presentation helpers
   ----------------------------------------------------------------------
   Used only by PotentialTable / AwaitingTable / AwardedTable /
   ClosedTable. Everything below is presentation: each helper takes a value
   the row already carries and returns a tone name, a short flag and a
   spelled-out description. Nothing here reads, writes, filters or reorders
   a row.

   The thresholds deliberately mirror the filter chips App.jsx already
   ships ("Over 30 days", "Expiring soon", "Low remaining", "Losses only"),
   so a row that lights up in the table is exactly a row the matching chip
   would keep. Every tone is paired with a glyph and a worded flag, so a
   state is never carried by colour alone.
   ====================================================================== */

const PIPE_DAY_MS = 86400000;

// Whole days elapsed since an ISO date. Null when absent or unparseable.
const daysSinceISO = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / PIPE_DAY_MS);
};

// Whole days left until an ISO date. Negative once the date is past.
const daysUntilISO = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / PIPE_DAY_MS);
};

// Proposals: how long a submittal has waited for a verdict. `over` mirrors
// the "Over 30 days" chip and maps onto the brand/ochre "needs attention"
// token; everything younger stays neutral.
const submissionAge = (iso) => {
  const days = daysSinceISO(iso);
  if (days == null || days < 0) return null;
  const over = days > 30;
  const unit = days === 1 ? "day" : "days";
  return {
    days,
    tone: over ? "over" : "fresh",
    icon: over ? "hourglass" : "clock",
    flag: `${days}d`,
    text: over
      ? `${days} ${unit} since submission, over 30 days`
      : `${days} ${unit} since submission`,
  };
};

// Awarded: contract expiry runway. `expiring` mirrors the "Expiring soon"
// chip (inside 180 days); a date already past reads as expired (clay).
const expiryRunway = (iso) => {
  const days = daysUntilISO(iso);
  if (days == null) return null;
  const unit = Math.abs(days) === 1 ? "day" : "days";
  if (days < 0) {
    return {
      days, tone: "expired", icon: "warn", flag: "Expired",
      text: `Contract expired ${Math.abs(days)} ${unit} ago`,
    };
  }
  if (days < 180) {
    return {
      days, tone: "expiring", icon: "hourglass", flag: `${days}d`,
      text: `Contract expires in ${days} ${unit}`,
    };
  }
  return { days, tone: "ok", icon: null, flag: null, text: `Contract expires in ${days} ${unit}` };
};

// Awarded: remaining contract capacity as a share of the awarded total.
// `low` mirrors the "Low remaining" chip (under 20% left). The percentage
// is always printed next to the bar, so the bar is a second reading of a
// figure the user can already see rather than the only reading.
const capacityState = (used, remaining) => {
  const total = (used || 0) + (remaining || 0);
  if (total <= 0) return null;
  const share = (remaining || 0) / total;
  const pct = Math.round(share * 100);
  const low = share < 0.2;
  return {
    pct,
    low,
    text: low
      ? `${pct}% of contract capacity left, below 20%`
      : `${pct}% of contract capacity left`,
  };
};

// Closed Out: mirrors the "Losses only" chip so a lost or descoped closure
// carries a word rather than being left to be read out of free text.
const LOSS_REASON_RE = /lost|cancel|descope|withdraw/i;

// A date plus its urgency flag, stacked so both stay legible in a column
// narrow enough that they cannot sit side by side. Built from the same
// `.bxt-due-*` atoms the Open Bids due-date cell uses. The glyph rides in
// the flag rather than ahead of the date, so the date always gets the full
// column width before anything else is allowed to take room.
const renderDateFlag = (formatted, state) => (
  <span
    className="bxt-due bxt-due-stack"
    title={state ? `${formatted} · ${state.text}` : formatted}
  >
    <span className="bxt-due-date num">{formatted}</span>
    {state?.flag && (
      <span className="bxt-due-flag">
        {state.icon && <Icon name={state.icon} size={10} aria-hidden="true"/>}
        {state.flag}
        <span className="sr-only"> {state.text}</span>
      </span>
    )}
  </span>
);

// Section-header row for the org-type groups injectOrgHeaders() injects
// into Proposals and Awarded. It is a single cell spanning the whole grid,
// so — unlike a data row, which goes through renderOrderedCells — it has to
// declare its own row/cell roles and its column span.
const renderOrgHeaderRow = (r, gridCols, colCount) => {
  const raw = r._orgHeader;
  // injectOrgHeaders falls back to an en dash for an unassigned org type;
  // rows shaped before that used an em dash. Both mean "not set".
  const unassigned = !raw || raw === "–" || raw === "—";
  const orgKey = unassigned ? "unknown" : String(raw).toLowerCase();
  return (
    <div
      key={r.id}
      className="trow org-header bxt-grouphead bxt-orghead"
      role="row"
      data-org={orgKey}
      style={{ gridTemplateColumns: gridCols }}
    >
      <div
        className="td bxt-grouphead-cell bxt-orghead-cell"
        role="cell"
        aria-colspan={colCount}
      >
        {/* The bar spans the whole grid, which on these tables is far wider
            than the viewport, so its content is pinned to the left edge and
            stays readable while the table is scrolled sideways. */}
        <span className="bxt-orghead-inner">
          <span className="bxt-orghead-dot" aria-hidden="true"/>
          <span className="bxt-orghead-kicker">Org type</span>
          <span className="bxt-grouphead-label bxt-truncate">
            {unassigned ? "Unassigned" : raw}
          </span>
          <span className="bxt-grouphead-count">
            <span className="num">{r._count}</span> {r._unit}
          </span>
        </span>
      </div>
    </div>
  );
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
      const p = r.probability || "–";
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
          const label = isGrand ? "Grand total" : r._total;
          const cells = {
            "__select": <div className="td"/>,
            "Year": <div className="td"/>,
            "Project": (
              <div className="td bxt-totalrow-label">
                <span className="bxt-totalrow-name bxt-truncate">{label}</span>
                <span className="bxt-totalrow-count">
                  <span className="num">{r._count}</span> {countNoun}
                </span>
              </div>
            ),
            "Role": <div className="td"/>,
            "Client": <div className="td"/>,
            "Contract": (
              <div className="td mono num bxt-totalrow-money">
                {fmtMoney(r.amount, false)}
              </div>
            ),
            "MSMM": (
              <div className="td mono num bxt-totalrow-money is-accent">
                {fmtMoney(r.msmm, false)}
              </div>
            ),
            "Subs": (
              <div className="td mono num bxt-totalrow-money">
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
                 className={"trow total-row bxt-totalrow" + (isGrand ? " grand-total" : "")}
                 data-prob={isGrand ? "all" : String(r._total).toLowerCase()}
                 style={{ gridTemplateColumns: gridCols }}>
              {renderOrderedCells(visibleColumns, cells)}
            </div>
          );
        }

        const projName = r.name || "this project";
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${projName}`}/>
            </div>
          ),
          "Year": (
            <div className="td mono num subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td bxt-td-identity">
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
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Contract": (
            <div className="td mono num">
              <EditableCell value={r.amount} type="number"
                onChange={v => updateRow(r.id, { amount: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "MSMM": (
            <div className="td mono num bxt-td-accent">
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
                : <span className="empty-cell">–</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono num subtle">
              <EditableCell value={r.projectNumber}
                onChange={v => updateRow(r.id, { projectNumber: v })}/>
            </div>
          ),
          "Probability": (
            <div className="td">
              {/* The probability palette (prob-high … prob-orange) is shared
                  with this table's row stripes, so the chip deliberately
                  keeps that palette rather than a kit Badge tone — the chip
                  and the stripe have to read as the same colour. The written
                  label carries the state on its own. */}
              <EditableCell value={r.probability} type="select" options={probOptions}
                onChange={v => updateRow(r.id, { probability: v })}
                render={v => v
                  ? (
                    <span className={`chip ${probChipClass(v)} bxt-chip-trunc`} title={`${v} probability`}>
                      <span className="chip-dot" aria-hidden="true"/>{v}
                    </span>
                  )
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "Dates & Comments": (
            <div className="td subtle bxt-td-note bxt-td-stack">
              {r.nextActionDate && (
                <span className="mono num bxt-td-nextaction">
                  <Icon name="calendarClock" size={11} aria-hidden="true"/>
                  {fmtDate(r.nextActionDate)}
                  <span className="sr-only"> next action date</span>
                </span>
              )}
              <EditableCell value={r.dates}
                onChange={v => updateRow(r.id, { dates: v })}
                format={v => v
                  ? truncCell(v)
                  : (!r.nextActionDate ? <span className="empty-cell">–</span> : null)}/>
            </div>
          ),
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions bxt-pipeactions" onClick={e => e.stopPropagation()}>
                <button type="button"
                        className="row-btn bxt-rowbtn bxt-rowbtn-primary"
                        title="Move to Invoice"
                        aria-label={`Move ${projName} to Invoice`}
                        onClick={() => onForward(r)}>
                  <Icon name="forward" size={14}/>
                </button>
                <button type="button"
                        className="row-btn bxt-rowbtn bxt-rowbtn-alert"
                        title="Set alert"
                        aria-label={`Set an alert on ${projName}`}
                        onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
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

// ---------- Proposals (status key: awaiting) ----------
// Org-type ordering used as the primary sort for Proposals AND Awarded.
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
    const o = companyById(r.clientId)?.orgType || "–";
    counts[o] = (counts[o] || 0) + 1;
  }
  const plural = (n) => n === 1 ? unitLabel : (unitLabel + "s");
  const out = [];
  let lastOrg;
  for (const r of sortedRows) {
    const o = companyById(r.clientId)?.orgType || "–";
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
  deletedMode = false, onSoftDelete, onRestore,
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
      emptyTitle="No proposals"
      emptyHint="Submitted proposals live here until awarded or closed out."
      emptyIcon="clock"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        if (r._orgHeader) return renderOrgHeaderRow(r, gridCols, visibleColumns.length);

        const proposalName = r.name || "this proposal";
        // Age since submission. Presentation only: it never reorders or
        // filters, it just gives the "Over 30 days" chip a row-level read.
        const age = submissionAge(r.dateSubmitted);
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${proposalName}`}/>
            </div>
          ),
          "Year": (
            <div className="td mono num subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td bxt-td-identity bxt-td-titleline">
              <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
              {r.projectNumber && (
                <Badge tone="outline" size="sm" className="num bxt-projno" title={`Project number ${r.projectNumber}`}>
                  {r.projectNumber}
                </Badge>
              )}
            </div>
          ),
          "Client": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={r.role === "Sub" ? clientOrFirmOpts : clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Org Type": (
            <div className="td subtle">
              {(() => {
                const o = companyById(r.clientId)?.orgType;
                return o
                  ? <Badge tone="neutral" className="max-w-full"><span className="min-w-0 truncate">{o}</span></Badge>
                  : <span className="empty-cell">–</span>;
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
            <div className="td mono bxt-td-age" data-age={age?.tone}>
              <EditableCell value={r.dateSubmitted} type="date"
                onChange={v => updateRow(r.id, { dateSubmitted: v })}
                format={v => v
                  ? renderDateFlag(fmtDate(v), age)
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Anticipated Result": (
            <div className="td mono num bxt-td-accent">
              <EditableCell value={r.anticipatedResultDate} type="date"
                onChange={v => updateRow(r.id, { anticipatedResultDate: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Client Contract": (
            <div className="td mono num bxt-td-ref">
              <EditableCell value={r.clientContract}
                onChange={v => updateRow(r.id, { clientContract: v })}/>
            </div>
          ),
          "MSMM Contract": (
            <div className="td mono num bxt-td-ref">
              <EditableCell value={r.msmmContract}
                onChange={v => updateRow(r.id, { msmmContract: v })}/>
            </div>
          ),
          "MSMM Remaining": (
            <div className="td mono num bxt-td-accent">
              <EditableCell value={r.msmmRemaining} type="number"
                onChange={v => updateRow(r.id, { msmmRemaining: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">–</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono num subtle">
              <EditableCell value={r.projectNumber}
                onChange={v => updateRow(r.id, { projectNumber: v })}/>
            </div>
          ),
          "Subs": <div className="td"><SubsCell subs={r.subs}/></div>,
          "Status": <div className="td"><StatusChip status="Proposal"/></div>,
          "MSMM Used": (
            <div className="td mono num subtle">
              <EditableCell value={r.msmmUsed} type="number"
                onChange={v => updateRow(r.id, { msmmUsed: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          // The two verdict actions (award, close out) are the whole point
          // of this table, so they stay exposed and tone-coded; alerting and
          // deleting are housekeeping and move into the row menu.
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions bxt-pipeactions" onClick={e => e.stopPropagation()}>
                {deletedMode ? (
                  <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-primary"
                          title="Restore this proposal"
                          aria-label={`Restore ${proposalName}`}
                          onClick={() => onRestore?.(r)}>
                    <Icon name="undo" size={14}/>
                  </button>
                ) : (
                  <>
                    <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-primary"
                            title="Award, moves to Awarded"
                            aria-label={`Award ${proposalName}, moves it to Awarded`}
                            onClick={() => onForward(r, "Awarded")}>
                      <Icon name="check" size={14}/>
                    </button>
                    <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-verdict"
                            title="Close out"
                            aria-label={`Close out ${proposalName}`}
                            onClick={() => onCloseOut(r)}>
                      <Icon name="ban" size={14}/>
                    </button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="row-btn bxt-rowbtn"
                                title="More actions"
                                aria-label={`More actions for ${proposalName}`}>
                          <Icon name="more" size={14}/>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bxt-menu">
                        <DropdownMenuItem onSelect={() => onAlert(r)}>
                          <Icon name="bell" size={13}/>
                          <span className="bxt-menu-text">Set alert</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem destructive onSelect={() => onSoftDelete?.(r)}>
                          <Icon name="trash" size={13}/>
                          <span className="bxt-menu-text">Delete proposal</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
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
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onForward, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
  deletedMode = false, onSoftDelete, onRestore,
  // Awarded ↔ Invoice links (project_invoice_links). The Proj # column
  // renders each row's linked invoice projects as chips backed by the live
  // merged Invoice rows; see invoice-links.jsx.
  invoiceIndex,            // Map<normInvoiceNumber, merged invoice row>
  actualThru = -1,         // last Actual month index (billed-to-date math)
  onAddInvoiceLink,        // (row, number) => void
  onRemoveInvoiceLink,     // (row, number) => void
  onOpenInvoiceProject,    // (mergedInvoiceRow) => void — jump to Invoice tab
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
    { label: "Proj #", w: "minmax(170px, 1.2fr)", sortKey: "projectNumber",
      sortValue: r => (r.invoiceLinks || [])[0] || r.projectNumber || "" },
    { label: "__actions", w: "90px", locked: true },
  ];
  const stageColor = s => s?.includes("Construction") ? "sage" : s?.includes("60") ? "accent" : s?.includes("Draft") ? "blue" : "muted";
  // Bridge from the historic chip palette names above onto the kit's Badge
  // tones. The mapping is a rename only; stageColor() is untouched.
  const stageTone = { sage: "success", accent: "brand", blue: "info", muted: "neutral" };

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
        if (r._orgHeader) return renderOrgHeaderRow(r, gridCols, visibleColumns.length);

        const total = (r.msmmUsed || 0) + (r.msmmRemaining || 0);
        // Presentation of the same two numbers the Contract column already
        // sums: what share of the awarded capacity is still unspent, and
        // whether that share is under the 20% the "Low remaining" chip uses.
        const cap = capacityState(r.msmmUsed, r.msmmRemaining);
        const expiry = expiryRunway(r.contractExpiry);
        const projName = r.name || "this project";
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${projName}`}/>
            </div>
          ),
          "Year": (
            <div className="td mono num subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td bxt-td-stack bxt-td-identity">
              <span className="bxt-td-fullwidth">
                <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
              </span>
              {r.projectNumber
                ? <span className="mono num bxt-td-sub">{r.projectNumber}</span>
                : null}
            </div>
          ),
          "Client": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Prime": (
            <div className="td subtle">
              <EditableCell value={r.primeId} type="combobox" options={clientOrFirmOpts}
                onChange={v => updateRow(r.id, { primeId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Org Type": (
            <div className="td subtle">
              {(() => {
                const o = companyById(r.clientId)?.orgType;
                return o
                  ? <Badge tone="neutral" className="max-w-full"><span className="min-w-0 truncate">{o}</span></Badge>
                  : <span className="empty-cell">–</span>;
              })()}
            </div>
          ),
          "Stage": (
            <div className="td">
              <EditableCell value={r.stage} type="select" options={stageOptions}
                onChange={v => updateRow(r.id, { stage: v })}
                render={v => v
                  ? (
                    <Badge tone={stageTone[stageColor(v)] || "neutral"} dot className="max-w-full" title={v}>
                      <span className="min-w-0 truncate">{v}</span>
                    </Badge>
                  )
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Pool": (
            <div className="td subtle bxt-td-ref">
              <EditableCell value={r.pools}
                onChange={v => updateRow(r.id, { pools: v })}/>
            </div>
          ),
          "Contract": <div className="td mono num">{fmtMoney(total || null, false)}</div>,
          "MSMM Used": (
            <div className="td mono num subtle">
              <EditableCell value={r.msmmUsed} type="number"
                onChange={v => updateRow(r.id, { msmmUsed: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          // Remaining capacity: the money, then the same figure as a share
          // of the contract in words AND as a bar. The bar is never the only
          // reading, and "Low" is spelled out when the share drops under 20%.
          "Remaining": (
            <div className="td mono bxt-cap" data-capacity={cap ? (cap.low ? "low" : "ok") : undefined}>
              <span className="bxt-cap-money num bxt-td-fullwidth">
                <EditableCell value={r.msmmRemaining} type="number"
                  onChange={v => updateRow(r.id, { msmmRemaining: v })}
                  format={v => fmtMoney(v, false)}/>
              </span>
              {cap ? (
                <div className="bxt-cap-meter" title={cap.text}>
                  <Progress
                    className="bxt-cap-bar"
                    value={cap.pct}
                    tone={cap.low ? "danger" : "brand"}
                    aria-label={`Contract capacity remaining for ${projName}`}
                  />
                  <span className="bxt-cap-fig">
                    <span className="num">{cap.pct}%</span>
                    <span className="sr-only"> {cap.text}</span>
                  </span>
                  {cap.low && <span className="bxt-cap-flag">Low</span>}
                </div>
              ) : (
                <span className="bxt-cap-none">No capacity recorded</span>
              )}
            </div>
          ),
          "Expiry": (
            <div className="td mono bxt-td-expiry" data-expiry={expiry?.tone}>
              <EditableCell value={r.contractExpiry} type="date"
                onChange={v => updateRow(r.id, { contractExpiry: v })}
                format={v => v
                  ? renderDateFlag(fmtDate(v), expiry)
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">–</span>}
            </div>
          ),
          "Proj #": (
            // Linked invoice projects, keyed on project number. Chips open
            // the live project card; "+" links more. The awarded row's own
            // project_number text stays editable from the drawer.
            <InvoiceLinkCell
              row={r}
              invoiceIndex={invoiceIndex}
              actualThru={actualThru}
              onAdd={onAddInvoiceLink}
              onRemove={onRemoveInvoiceLink}
              onOpenInvoice={onOpenInvoiceProject}
            />
          ),
          "Role": (
            <div className="td">
              <EditableCell value={r.role} type="select" options={roleOptions}
                onChange={v => updateRow(r.id, { role: v })}
                render={v => <RoleChip role={v}/>}/>
            </div>
          ),
          "Subs": (
            <div className="td bxt-td-subs">
              <SubsCell subs={r.subs} wrap/>
            </div>
          ),
          "Submitted": (
            <div className="td mono num subtle">
              <EditableCell value={r.dateSubmitted} type="date"
                onChange={v => updateRow(r.id, { dateSubmitted: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          "Client Contract": (
            <div className="td mono num bxt-td-ref">
              <EditableCell value={r.clientContract}
                onChange={v => updateRow(r.id, { clientContract: v })}/>
            </div>
          ),
          "MSMM Contract": (
            <div className="td mono num bxt-td-ref">
              <EditableCell value={r.msmmContract}
                onChange={v => updateRow(r.id, { msmmContract: v })}/>
            </div>
          ),
          "Status": <div className="td"><StatusChip status="Awarded"/></div>,
          "Details": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.details} type="textarea"
                onChange={v => updateRow(r.id, { details: v })}
                format={v => truncCell(v, 100)}/>
            </div>
          ),
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions bxt-pipeactions" onClick={e => e.stopPropagation()}>
                {deletedMode ? (
                  <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-primary"
                          title="Restore this project"
                          aria-label={`Restore ${projName}`}
                          onClick={() => onRestore?.(r)}>
                    <Icon name="undo" size={14}/>
                  </button>
                ) : (
                  <>
                    {onForward && (
                      <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-primary"
                              title="Move to Invoice"
                              aria-label={`Move ${projName} to Invoice`}
                              onClick={() => onForward(r)}>
                        <Icon name="forward" size={14}/>
                      </button>
                    )}
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="row-btn bxt-rowbtn"
                                title="More actions"
                                aria-label={`More actions for ${projName}`}>
                          <Icon name="more" size={14}/>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bxt-menu">
                        <DropdownMenuItem onSelect={() => onAlert(r)}>
                          <Icon name="bell" size={13}/>
                          <span className="bxt-menu-text">Set alert</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem destructive onSelect={() => onSoftDelete?.(r)}>
                          <Icon name="trash" size={13}/>
                          <span className="bxt-menu-text">Delete project</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
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
      emptyHint="Rows appear here when a Proposal or Invoice project is closed out."
      emptyIcon="x"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const projName = r.name || "this project";
        // Mirrors the "Losses only" chip so a lost or descoped closure is
        // labelled in words instead of having to be read out of free text.
        const isLoss = LOSS_REASON_RE.test(r.reason || "");
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${projName}`}/>
            </div>
          ),
          "Year": (
            <div className="td mono num subtle">
              <EditableCell value={r.year} type="number"
                onChange={v => updateRow(r.id, { year: v })}/>
            </div>
          ),
          "Project": (
            <div className="td bxt-td-identity bxt-td-titleline">
              <EditableCell value={r.name} onChange={v => updateRow(r.id, { name: v })}/>
              {r.projectNumber && (
                <Badge tone="outline" size="sm" className="num bxt-projno" title={`Project number ${r.projectNumber}`}>
                  {r.projectNumber}
                </Badge>
              )}
            </div>
          ),
          "Client": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={r.role === "Sub" ? clientOrFirmOpts : clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Submitted": (
            <div className="td mono num subtle">
              <EditableCell value={r.dateSubmitted} type="date"
                onChange={v => updateRow(r.id, { dateSubmitted: v })}
                format={v => fmtDate(v)}/>
            </div>
          ),
          // The closing date is the fact that puts the row in this archive,
          // so unlike every other date here it keeps full-strength text
          // while the rest of the row sits back.
          "Closed": (
            <div className="td mono num bxt-td-closed">
              <EditableCell value={r.dateClosed} type="date"
                onChange={v => updateRow(r.id, { dateClosed: v })}
                format={v => v
                  ? (
                    <span className="bxt-closedon num" title={`Closed out ${fmtDate(v)}`}>
                      {fmtDate(v)}
                    </span>
                  )
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Contract": (
            <div className="td mono num subtle">
              <EditableCell value={r.amount} type="number"
                onChange={v => updateRow(r.id, { amount: v })}
                format={v => fmtMoney(v, false)}/>
            </div>
          ),
          "Reason": (
            <div className="td bxt-td-reason">
              <EditableCell value={r.reason} type="textarea"
                onChange={v => updateRow(r.id, { reason: v })}
                format={v => v
                  ? (
                    <span className="bxt-reason" title={String(v)}>
                      {isLoss && <Badge tone="danger" size="sm" className="bxt-reason-tag">Loss</Badge>}
                      <span className="bxt-reason-text">{v}</span>
                    </span>
                  )
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "PM": (
            <div className="td">
              {(r.pmIds || []).length > 0
                ? <UserStack ids={r.pmIds}/>
                : <span className="empty-cell">–</span>}
            </div>
          ),
          "Proj #": (
            <div className="td mono num subtle">
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
            <div className="td mono num bxt-td-ref">
              <EditableCell value={r.clientContract}
                onChange={v => updateRow(r.id, { clientContract: v })}/>
            </div>
          ),
          "MSMM Contract": (
            <div className="td mono num bxt-td-ref">
              <EditableCell value={r.msmmContract}
                onChange={v => updateRow(r.id, { msmmContract: v })}/>
            </div>
          ),
          "Notes": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "Status": <div className="td"><StatusChip status="Closed Out"/></div>,
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions bxt-pipeactions" onClick={e => e.stopPropagation()}>
                <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-alert"
                        title="Set alert"
                        aria-label={`Set an alert on ${projName}`}
                        onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
              </div>
            </div>
          ),
        };
        return (
          // `data-archived` is what makes this table read as an archive
          // rather than a grey copy of the live ones: a clay edge rule and a
          // recessed wash, both drawn from the closed-out semantic tokens.
          <div key={r.id} className={"trow bxt-closedrow" + (flashId === r.id ? " flash" : "")}
               data-archived="true"
               data-loss={isLoss ? "true" : undefined}
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
  tab, rows, updateInvoice, updateMsmmMonth, updateMsmmFields,
  updateRow = _noopUpdate,
  onOpenDrawer, onAlert, flashId,
  // Rolling month window — a descriptor list { abs, year, monthIdx, mon, yy,
  // label } (default = prev 3 + current + next 12 = 16 months) shared with the
  // charts + Manish export. Back/Forward shift it by one month; Today resets.
  windowMonths = [],
  onWindowBack, onWindowFwd, onWindowToday, windowAtDefault = false,
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
  onNotesChanged,    // (invoiceId, notesLog) => void  — sync the threaded Notes count back to App state
  canEditMsmm = true,   // Admin? Applies only to legacy/unlinked ENG/PM MSMM cells.
  onBlockedMsmmEdit,    // () => void  — fired when a locked legacy MSMM cell is clicked.
  // Billing-state surface: 'active' (Invoices tab), 'between' (In-Between tab),
  // or 'closed' (Closed Out tab). Drives which transition actions render on each
  // row — pause on Invoices; resume + close-out on In-Between; reopen on Closed
  // Out. All handlers get the merged row (groupIds carries every underlying
  // year-row id). Closed rows keep the full expand/subs/cells surface — only
  // the row action + accent differ.
  billingMode = "active",
  onPause,           // (row) => void  — Invoices → In-Between
  onResume,          // (row) => void  — In-Between → Invoices, and Closed Out → Invoices (reopen)
  onCloseOutRow,     // (row) => void  — In-Between → Closed Out (MoveForwardPanel)
  onSaveEgnyteFolder, // (row, egnyteFolderPath) => Promise<string>
  // Invoice-type filter — LIFTED to App.jsx (shared across the Invoice sub-tabs
  // so the sub-tab count badges track it). Falls back to local state if a caller
  // doesn't provide it.
  typeFilter: propTypeFilter,
  setTypeFilter: propSetTypeFilter,
}) => {
  const USERS = getUsers();
  const invoiceTypeOptions = INVOICE_TYPE_OPTIONS;
  const pmOptions = USERS.map(u => ({ value: u.id, label: u.name }));
  // A project month counts as "Actual" when the date-driven cutover has reached
  // it OR a bill has been attached to that month on the project's total/prime
  // row — attaching a bill promotes that month from Projection to Actual for
  // the project, even ahead of the cutover. Derived live from r.primeFiles
  // (re-annotated by refreshInvoiceArtifacts after every upload), so the cell
  // flips the instant a bill lands. Applies to the project's MSMM, sub, and
  // total rows; the column header + cross-project grand totals stay on the
  // global cutover.
  // (Per-month Actual/Projection state + bill-ahead promotion now live in the
  // rolling-window helpers below — monthStateAtDesc / hasPrimeBillAtDesc.)
  // The white parent row is a remainder view. Ordinary ENG/PM rows show MSMM's
  // Total − subs portion. MHZ/MHZ PM rows subtract EVERY rendered sub, including
  // the independent MSMM row, from the editable Project-total row below.
  //
  // MSMM math only ever subtracts kind='sub' entries — these are firms
  // MSMM hires (money MSMM pays out). The kind='prime' entry on a Sub-role
  // project is informational only (it records the upstream firm hiring
  // MSMM, for cross-reference); it must not be subtracted from Total CV.
  const subListFor = (r) =>
    (subInvoices?.get(r.sourceId) || []).filter(s => (s.kind || "sub") === "sub");
  const msmmContractAuto = (r) => {
    const total = Number(r.amount || 0);
    const subValues = subListFor(r).map(s => s.contractAmount);
    return basePerspectiveOwnValue(total, subValues);
  };
  const msmmContractShown = (r) => linkedMsmmValue({
    linked: isMhzPerspectiveSub(r, rows),
    storedValue: r.msmmAmount,
    total: r.amount,
    subValues: subListFor(r).map(s => s.contractAmount),
  });

  // ---- Rolling-window month accessors -------------------------------------
  // Each visible month is a descriptor d = { year, monthIdx, mon, label } from
  // the `windowMonths` prop. The data for that month lives in the merged row's
  // byYear[year] slot (a project's per-year invoice rows are folded together by
  // mergeInvoiceYears), so EVERY month read goes through these helpers — never
  // r.values[i] directly, since index i is no longer "month i of one year".
  const yrow = (r, year) => r?.byYear?.[year] || null;
  const valAtDesc          = (r, d) => Number(yrow(r, d.year)?.values?.[d.monthIdx] || 0);
  const primePaidAtDesc    = (r, d) => !!(yrow(r, d.year)?.primePaid?.[d.monthIdx]);
  const primeFilesAtDesc   = (r, d) => yrow(r, d.year)?.primeFiles?.[d.monthIdx] || [];
  const invNumAtDesc       = (r, d) => yrow(r, d.year)?.invoiceNumbers?.[d.monthIdx] || null;
  const subAmtAtDesc       = (s, d) => s?.byYear?.[d.year]?.amounts?.[d.monthIdx] ?? null;
  const subFilesAtDesc     = (s, d) => s?.byYear?.[d.year]?.files?.[d.monthIdx] || [];
  const subPaidAtDesc      = (s, d) => !!(s?.byYear?.[d.year]?.paid?.[d.monthIdx]);
  const subPaidWhenDesc    = (s, d) => s?.byYear?.[d.year]?.paidAt?.[d.monthIdx] || null;
  // A month is "Actual" when the date-driven cutover has reached it (year-aware
  // via isActualInvoiceMonth) OR a bill is attached to the project's total/prime
  // row for that month (promotes it ahead of the cutover). `cue` adds the
  // "billed ahead" underline — used only on the total/prime row.
  const hasPrimeBillAtDesc = (r, d) => primeFilesAtDesc(r, d).length > 0;
  const monthStateAtDesc = (r, d, cue = false) =>
    isActualInvoiceMonth(d.year, d.monthIdx) ? "month-actual"
    : hasPrimeBillAtDesc(r, d) ? ("month-actual" + (cue ? " month-promoted" : ""))
    : "month-proj";
  const msmmAtDesc = (r, d) => {
    const yr = yrow(r, d.year);
    return linkedMsmmValue({
      linked: isMhzPerspectiveSub(r, rows),
      storedValue: yr?.msmmValues?.[d.monthIdx],
      total: yr?.values?.[d.monthIdx],
      subValues: subListFor(r).map(s => subAmtAtDesc(s, d)),
    });
  };
  const setMsmmMonth = (row, d, v) => {
    const typed = (v == null || v === "") ? 0 : Number(v);
    updateMsmmMonth?.(row, d.year, d.monthIdx, typed);
  };
  const setMsmmContract = (row, v) => {
    const typed = (v == null || v === "") ? 0 : Number(v);
    updateMsmmFields?.(row.id, { msmmAmount: typed });
  };
  // YTD Actual = ALL the actuals for the project, summed across EVERY year in
  // byYear (the rolling-window definition — not just the current year). Computed
  // / read-only now; the old per-row override + Rollforward column were removed.
  const yearsOf = (r) => Object.keys(r?.byYear || {}).map(Number);
  const msmmAtYM = (r, year, m) => {
    const yr = yrow(r, year); if (!yr) return 0;
    return linkedMsmmValue({
      linked: isMhzPerspectiveSub(r, rows),
      storedValue: yr.msmmValues?.[m],
      total: yr.values?.[m],
      subValues: subListFor(r).map(s => s?.byYear?.[year]?.amounts?.[m]),
    });
  };
  // ---- Total Billed = Contract − Rollforward + Actuals (client direction) ----
  // Rollforward = "remaining to bill at year start"; Contract − Rollforward is
  // therefore the billing that predates the loaded window. A NULL rollforward
  // means the WHOLE contract still remains (nothing billed before), so it falls
  // back to the line's contract → Total Billed collapses to just the Actuals.
  // Actuals = months already billed = whose invoice is ATTACHED, summed at each
  // scope. Total Remaining = Contract − Total Billed  (= Rollforward − Actuals).
  //
  // Actuals per scope — only months with an attachment count as billed, and
  // only from INVOICE_ACTUALS_MIN_YEAR onward (after Dec 31, 2025): pre-2026
  // billing is already captured by Contract − Rollforward, so counting it here
  // too would double-count.
  const projectBilledAttached = (r) => yearsOf(r).reduce((a, y) => {
    if (Number(y) < INVOICE_ACTUALS_MIN_YEAR) return a;
    const yr = yrow(r, y); if (!yr) return a;
    const files = yr.primeFiles || [];
    return a + Array.from({ length: 12 }, (_, m) =>
      (files[m]?.length > 0) ? Number(yr.values?.[m] || 0) : 0
    ).reduce((x, z) => x + z, 0);
  }, 0);
  const subBilledAttached = (s) => Object.entries(s?.byYear || {}).reduce((a, [y, yr]) => {
    if (Number(y) < INVOICE_ACTUALS_MIN_YEAR) return a;
    const files = yr?.files || [];
    return a + Array.from({ length: 12 }, (_, m) =>
      (files[m]?.length > 0) ? Number(yr?.amounts?.[m] || 0) : 0
    ).reduce((x, z) => x + z, 0);
  }, 0);
  // Effective Rollforward per scope — the stored "remaining at year start", else
  // the line's full contract (nothing rolled off yet). Mirrors the value shown
  // in each level's Rollforward cell.
  const msmmRollforward    = (r) => (r.remainingStart      != null && r.remainingStart      !== "") ? Number(r.remainingStart)      : msmmContractShown(r);
  const projectRollforward = (r) => (r.totalRemainingStart != null && r.totalRemainingStart !== "") ? Number(r.totalRemainingStart) : Number(r.amount || 0);
  const subRollforward     = (s) => (s.remainingStart      != null && s.remainingStart      !== "") ? Number(s.remainingStart)      : Number(s.contractAmount || 0);
  // MSMM Actuals — a month's MSMM value only when the project's total/prime cell
  // for that month has an invoice attached (primeFiles non-empty).
  const msmmBilledAttached = (r) => {
    // MSMM's own prime invoice now lives on THIS (base ENG/PM) row's prime store
    // — the MSMM total row and the linked MHZ "MSMM · sub" row both attach here
    // — so a month counts as MSMM-billed exactly when this row has an
    // attachment. The JV's full prime invoice is separate (on the MHZ row) and
    // must NOT count toward MSMM's billed.
    return yearsOf(r).reduce((a, y) => {
      if (Number(y) < INVOICE_ACTUALS_MIN_YEAR) return a;
      const yr = yrow(r, y); if (!yr) return a;
      const files = yr.primeFiles || [];
      return a + Array.from({ length: 12 }, (_, m) =>
        (files[m]?.length > 0) ? msmmAtYM(r, y, m) : 0
      ).reduce((x, z) => x + z, 0);
    }, 0);
  };
  // Total Billed = Contract − Rollforward + Actuals, at each scope.
  const msmmTotalBilled    = (r) => msmmContractShown(r)      - msmmRollforward(r)    + msmmBilledAttached(r);
  const projectTotalBilled = (r) => Number(r.amount || 0)     - projectRollforward(r) + projectBilledAttached(r);
  const subTotalBilled     = (s) => Number(s.contractAmount || 0) - subRollforward(s) + subBilledAttached(s);
  // Resolve the linked sibling of a given perspective. Uses the SAME
  // source-OR-number linkage as linkedInvoiceIdsFor / isMhzPerspectiveSub so
  // classification (hide the ENG row's subs) and injection (add the MHZ prime
  // line) can never disagree — a number-only link resolves here too.
  const linkedPerspectiveFor = (r, targetType) => {
    const key = String(r.projectNumber || "").trim().toLowerCase();
    return rows.find(other =>
      other.id !== r.id &&
      (other.type || "ENG") === targetType &&
      (
        (r.sourceId && other.sourceId === r.sourceId) ||
        (key && String(other.projectNumber || "").trim().toLowerCase() === key)
      )
    ) || null;
  };
  const invoiceMsmmAsSubYears = (r) => Object.fromEntries(
    yearsOf(r).map(year => [year, {
      amounts: Array.from({ length: 12 }, (_, m) => msmmAtYM(r, year, m)),
      // MSMM's invoice + paid live on THIS base (ENG/PM) row's prime store, so
      // the MSMM-as-sub line reads (and, via its clip/toggle, writes) the same
      // place as the base's MSMM total row — keeping the two perspectives in
      // lockstep on attachments AND paid status.
      files: yrow(r, year)?.primeFiles || Array.from({ length: 12 }, () => []),
      subInvoiceIds: Array(12).fill(null),
      paid: yrow(r, year)?.primePaid || Array(12).fill(false),
      paidAt: Array(12).fill(null),
    }])
  );
  const withPerspectiveRows = (r, entries) => {
    const type = r.type || "ENG";
    // The base (ENG/PM) view of an hz-prime project hides the hz prime entirely;
    // its header row shows MSMM derived from the base reconciliation total. A
    // normal base row has no hz sibling, so nothing is injected for it.
    //
    // The hz view (MHZ / MHZ PM) shows the real subs A/B/C followed by MSMM as a
    // sub (read from the linked base ENG/PM row). There is NO separate "earned
    // value" row — the hz HEADER row itself is the remainder (Project total −
    // every sub, including MSMM). Editing MSMM writes the base row directly and
    // leaves the hz Project total untouched.
    if (isHzPrimeType(type)) {
      const base = linkedPerspectiveFor(r, baseTypeForHz(type));
      if (!base) return entries;
      const msmm = getCompanies().find(c => c.isMsmm) || { id: "__msmm_sub__", name: "MSMM" };
      const already = entries.some(e => (e.kind || "sub") === "sub" && e.companyId === msmm.id);
      if (already) return entries;
      const msmmByYear = invoiceMsmmAsSubYears(base);
      const msmmSub = {
        kind: "sub",
        companyId: msmm.id,
        companyName: msmm.name || "MSMM",
        contractAmount: msmmContractShown(base),
        remainingStart: base.remainingStart ?? null,
        discipline: "MSMM perspective",
        amounts: msmmByYear[THIS_YEAR]?.amounts || Array(12).fill(0),
        files: msmmByYear[THIS_YEAR]?.files || Array.from({ length: 12 }, () => []),
        subInvoiceIds: Array(12).fill(null),
        paid: msmmByYear[THIS_YEAR]?.paid || Array(12).fill(false),
        paidAt: Array(12).fill(null),
        byYear: msmmByYear,
        // The base (ENG/PM) row this MSMM-as-sub mirrors. Editing it (contract /
        // months) writes the base row DIRECTLY — that IS "sync to the ENG/PM
        // perspective", and it leaves this hz row's Project total untouched.
        // Its clip + paid toggle route to the base row's prime
        // store too — instant two-way sync.
        perspectiveBaseRow: base,
        syntheticPerspective: true,
      };
      return [...entries, msmmSub];
    }
    return entries;
  };

  // The exact rows rendered beneath a project. MHZ/MHZ PM includes every real
  // sub plus the synthetic, independently editable MSMM row. First-row math
  // uses this complete list so the displayed breakdown always reconciles.
  const invoiceSubRowsFor = (r) => {
    const allEntries = subInvoices?.get(r.sourceId) || [];
    const role = invoicePerspectiveRole(r, rows);
    const isPrimeRow = role === "Prime";
    const primeEntry = allEntries.find(s => s.kind === "prime");
    const subEntries = allEntries.filter(s => (s.kind || "sub") === "sub");
    const subListBase = perspectiveSubListBase({
      isPrimeRow,
      mhzPerspectiveSub: isMhzPerspectiveSub(r, rows),
      primeEntry,
      subEntries,
    });
    return withPerspectiveRows(r, subListBase);
  };

  const firstRowContract = (r) => isHzPrimeType(r.type)
    ? invoiceRemainderValue(r.amount, invoiceSubRowsFor(r).map(s => s.contractAmount))
    : msmmContractShown(r);
  const firstRowRollforward = (r) => isHzPrimeType(r.type)
    ? invoiceRemainderValue(projectRollforward(r), invoiceSubRowsFor(r).map(subRollforward))
    : msmmRollforward(r);
  const firstRowMonth = (r, d) => isHzPrimeType(r.type)
    ? invoiceRemainderValue(valAtDesc(r, d), invoiceSubRowsFor(r).map(s => subAmtAtDesc(s, d)))
    : msmmAtDesc(r, d);
  const firstRowTotalBilled = (r) => isHzPrimeType(r.type)
    ? invoiceRemainderValue(projectTotalBilled(r), invoiceSubRowsFor(r).map(subTotalBilled))
    : msmmTotalBilled(r);
  const firstRowTotalRemaining = (r) => {
    if (!isHzPrimeType(r.type)) return msmmContractShown(r) - msmmTotalBilled(r);
    const projectRemaining = Number(r.amount || 0) - projectTotalBilled(r);
    const subRemaining = invoiceSubRowsFor(r).map(
      s => Number(s.contractAmount || 0) - subTotalBilled(s));
    return invoiceRemainderValue(projectRemaining, subRemaining);
  };
  // Index of the last visible month that is "Actual" by the global cutover —
  // drives the amber Actual▸Projection boundary line in the window.
  const lastActualWi = windowMonths.reduce(
    (acc, d, wi) => (isActualInvoiceMonth(d.year, d.monthIdx) ? wi : acc), -1);

  // Orange is invoice-owned once a row has been toggled. Untoggled legacy rows
  // can still fall back to the old Potential-probability source ids.
  const isOrange = (r) => invoiceIsOrange(r, orangeSourceIds);
  const sumBy = (arr, fn) => arr.reduce((a, r) => a + fn(r), 0);
  const nonOrangeRows = rows.filter(r => !isOrange(r));
  const orangeRows    = rows.filter(isOrange);
  const orderedRows   = [...nonOrangeRows, ...orangeRows];

  // Set of invoice-row ids whose sub list is currently expanded inline.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  // Ref to the currently-flashed (just-created) row's <tr>, so a freshly
  // added invoice row can be scrolled into view. Unlike the other tabs (which
  // prepend new rows to the top), InvoiceTable re-sorts by project name, so a
  // new row lands alphabetically mid-list — without this it can be created
  // below the fold and look like nothing happened.
  const flashRowRef = useRef(null);
  // Open note/description editor: { id, field, label, accent, name, value } | null
  const [noteModal, setNoteModal] = useState(null);
  // Open threaded Notes log: { id, name, log } | null
  const [notesThread, setNotesThread] = useState(null);
  // Egnyte linking surface. Linked rows get an action chooser; unlinked rows
  // jump straight to the folder browser.
  const [egnytePicker, setEgnytePicker] = useState(null);
  const [egnyteAction, setEgnyteAction] = useState(null);
  const toggleExpand = (id) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // "Edit on the MHZ view" jump target — the linked MHZ row id we switched the
  // Type filter to reach, so it can be scrolled into view + flashed once it renders.
  const [jumpId, setJumpId] = useState(null);
  // From an hz-prime base row's read-only total (ENG→MHZ, PM→MHZ PM), switch to
  // the hz view (where the full total + subs are editable) and open + reveal its
  // linked hz row.
  const jumpToMhzPerspective = (baseRow) => {
    const hzType = hzTypeForBase(baseRow.type || "ENG");
    const hz = linkedPerspectiveFor(baseRow, hzType);
    setTypeFilter(new Set([hzType]));
    if (hz) {
      setExpandedIds(prev => new Set([...prev, hz.id]));
      setJumpId(hz.id);
    }
  };
  useEffect(() => {
    if (!jumpId) return;
    // setTypeFilter + setExpandedIds + setJumpId are batched in one handler, so
    // by the time this runs the MHZ row is rendered and flashRowRef points at it.
    const node = flashRowRef.current;
    if (node) node.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setJumpId(null), 1800);
    return () => clearTimeout(t);
  }, [jumpId]);

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
      r.mhzProjectName,
      r.mhzProjectNumber,
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
  const [localTypeFilter, setLocalTypeFilter] = useState(() => new Set(["ENG"]));
  const typeFilter    = propTypeFilter    || localTypeFilter;
  const setTypeFilter = propSetTypeFilter || setLocalTypeFilter;
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeBtnRef = useRef(null);
  const typeFilterActive =
    typeFilter.size > 0 && typeFilter.size < invoiceTypeOptions.length;
  const matchesType = (r) => {
    if (!typeFilterActive) return true;
    // NULL type reads as ENG everywhere else (mergeInvoiceYears, the perspective
    // helpers) — match that here so a legacy row with no type is reachable.
    return typeFilter.has(r.type || "ENG");
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
      case "role":          return invoicePerspectiveRole(r, rows).trim();
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
  const typeRank = (r) => {
    const idx = invoiceTypeOptions.indexOf(r.type || "ENG");
    return idx === -1 ? invoiceTypeOptions.length : idx;
  };
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

  // The project-count chip reflects the Type filter (matchesType) — total and
  // non-Orange counts of the currently-selected type(s), e.g. ENG only, or
  // ENG + PM. Falls back to all rows when no type subset is selected.
  const typeCountTotal     = rows.filter(matchesType).length;
  const typeCountNonOrange = nonOrangeRows.filter(matchesType).length;

  // Publish the current display order + filters so the "Print for Mark"
  // exports (handleExport / handleExportInvoiceSubs in App.jsx) render the
  // SAME rows the user sees: sorted by the active column sort, Orange rows
  // pinned to the bottom, and filtered by type/search. InvoiceTable renders
  // its own <table> (not TableView), so it must publish its own snapshot —
  // without this the exports fell back to the unsorted base rows and ignored
  // the column sort entirely. Columns aren't reorderable/hideable here, so we
  // omit visibleColumns (the export uses the full column defs in that case).
  useEffect(() => {
    setCurrentTableSnapshot({
      tab,
      processedRows: searchedRows,
      sort: sortBy,
      search,
      year: null,
      // Type-filter context so the export handlers can name files + title the
      // Excel sheet by the scope the user is looking at (req 1.7 / 1.8).
      // typeFilter = the list of types actually shown (all types when the
      // filter is inactive), typeFilterActive = whether a subset is selected.
      typeFilter: typeFilterActive ? invoiceTypeOptions.filter(t => typeFilter.has(t)) : invoiceTypeOptions.slice(),
      typeFilterActive,
      typeChipLabel,
    });
    // Deps are the full set of inputs to `searchedRows`; it's recomputed each
    // render from these, so referencing it in the closure is always current.
  }, [tab, rows, sortBy, search, typeFilter, orangeSourceIds]);

  // When a row is freshly created (flashId set by handleCreated), make sure
  // it's actually visible, then scroll it into view. Two ways a brand-new
  // invoice row can look like a no-op even though it saved:
  //   1. It's hidden by the active type filter (e.g. a new PM row while the
  //      default ENG-only view is on) — widen the filter so it shows.
  //   2. It renders but the name sort places it off-screen — scroll to it.
  useEffect(() => {
    if (!flashId) return;
    const created = rows.find(r => r.id === flashId);
    // Normalize NULL → ENG to match matchesType, so a legacy row with no type
    // is revealed rather than silently staying hidden.
    const createdType = created && (created.type || "ENG");
    if (created && typeFilterActive && !typeFilter.has(createdType)) {
      // Reveal the just-created row's type; the re-render re-runs this effect
      // (typeFilter dep) and then scrolls now that the row is on-screen.
      setTypeFilter(prev => new Set([...prev, createdType]));
      return;
    }
    const node = flashRowRef.current;
    if (node) node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [flashId, rows, typeFilter, typeFilterActive]);

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
    const base = perspectiveSubListBase({
      isPrimeRow: invoicePerspectiveRole(r, rows) === "Prime",
      mhzPerspectiveSub: isMhzPerspectiveSub(r, rows),
      primeEntry: allEntries.find(s => s.kind === "prime"),
      subEntries: allEntries.filter(s => (s.kind || "sub") === "sub"),
    });
    return withPerspectiveRows(r, base);
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
        <div className="invoice-count-chip" title={`${typeCountTotal} total · ${typeCountNonOrange} excluding Orange`}>
          <span className="invoice-count-num mono">{typeCountTotal}</span>
          <span className="invoice-count-label">{typeCountTotal === 1 ? "project" : "projects"}</span>
          <span className="invoice-count-sep">·</span>
          <span className="invoice-count-num mono" style={{ color: "var(--text-soft)" }}>{typeCountNonOrange}</span>
          <span className="invoice-count-label">w/o Orange</span>
        </div>
        <div className="invoice-window-nav" role="group" aria-label="Visible month window">
          {/* A compact "month dial" — Back / range / Forward share one
              segmented pill; Today resets to the default window. The YTD
              column stays pinned, so only the month columns slide. */}
          <button
            type="button"
            className="iwn-arrow back"
            onClick={() => onWindowBack?.()}
            title="Show one month earlier"
            aria-label="Earlier months"
          >
            <Icon name="chevronRight" size={15}/>
          </button>
          <span className="iwn-range" title="Visible month range — slide it with the arrows">
            <Icon name="calendar" size={13}/>
            <span className="iwn-range-text">
              {windowMonths.length
                ? `${windowMonths[0].label} – ${windowMonths[windowMonths.length - 1].label}`
                : "—"}
            </span>
            <span className="iwn-range-sub mono">{windowMonths.length} mo</span>
          </span>
          <button
            type="button"
            className="iwn-arrow fwd"
            onClick={() => onWindowFwd?.()}
            title="Show one month later"
            aria-label="Later months"
          >
            <Icon name="chevronRight" size={15}/>
          </button>
          <button
            type="button"
            className={"iwn-today" + (windowAtDefault ? " is-current" : "")}
            onClick={() => onWindowToday?.()}
            disabled={windowAtDefault}
            title={windowAtDefault
              ? "Already showing the default window — last 3 months, this month, and the next 12"
              : "Reset to the default window — last 3 months, this month, and the next 12"}
          >
            <span className="iwn-today-dot"/>
            Today
          </button>
        </div>
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
          {lastActualWi >= 0 ? (
            <>Actual through <strong style={{ color: "var(--accent-ink)" }}>{windowMonths[lastActualWi]?.label}</strong>, then Projection</>
          ) : (
            <>Showing <strong style={{ color: "var(--accent-ink)" }}>all visible months as Projection</strong></>
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
          {onNew && (
            <button
              type="button"
              className="btn primary sm"
              onClick={() => onNew()}
            >
              <Icon name="plus" size={13}/>New invoice row
            </button>
          )}
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
      </div>

      {rows.length === 0 ? (
        billingMode === "between" ? (
          <EmptyState
            title="Nothing in between"
            hint="Pause an active project from the Invoices tab and it lands here — billing data intact — until you resume it or close it out."
            iconName="pause"
          />
        ) : billingMode === "closed" ? (
          <EmptyState
            title="Nothing closed out"
            hint="Close a project out from Invoices or In-Between and its full billing history is archived here — subs, months, and attachments intact — ready to reopen any time."
            iconName="x"
          />
        ) : (
          <EmptyState
            title="No invoice rows"
            hint="Invoice rows appear here automatically for each awarded project. Use New invoice row to add one manually."
            iconName="trend"
          />
        )
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
            <table className={`invoice-table inv-mode-${billingMode}`} ref={invoiceTableRef}>
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
                  <th style={{ minWidth: 96 }}
                      title="Roll-forward from 2025 — the carry-in starting amount. Beacon's billing history starts in 2026, so this is what was still left to bill on Jan 1.">
                    Rollforward
                  </th>
                  {windowMonths.map((d, wi) => (
                    <th key={d.abs}
                        className={(isActualInvoiceMonth(d.year, d.monthIdx) ? "month-actual" : "month-proj") + (wi === lastActualWi ? " month-today" : "")}>
                      {d.mon}
                      <div style={{ fontSize: 9, marginTop: 2, opacity: .7 }}>
                        {d.year}
                      </div>
                    </th>
                  ))}
                  <th className="total-cell inv-pin-ytd" style={{ minWidth: 96 }}
                      title="Total Billed = Contract − Rollforward + billed actuals (only months with an invoice/file attached, 2026 onward)">Total Billed</th>
                  <th className="total-cell inv-pin-rem" style={{ minWidth: 96 }}
                      title="Auto-calculated · Contract − Total Billed">Total Remaining</th>
                  <th className="inv-pin-act" aria-label="Actions"></th>
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
                  const role       = invoicePerspectiveRole(r, rows);
                  const roleDerived = invoicePerspectiveRoleIsDerived(r, rows);
                  const isPrimeRow = role === "Prime";
                  const primeEntry = allEntries.find(s => s.kind === "prime");
                  const subEntries = allEntries.filter(s => (s.kind || "sub") === "sub");
                  // MHZ-perspective Sub = an ENG row for an MHZ-prime project
                  // (MSMM is only a sub because MHZ is the prime). From MSMM's
                  // viewpoint it must see ONLY the MHZ prime line + the total —
                  // never MHZ's sibling subs (A, B, C). A genuine external-prime
                  // Sub (no MHZ sibling) keeps showing its real subs; the MHZ
                  // row (isPrimeRow) keeps its subs + MSMM (added by
                  // withPerspectiveRows).
                  const mhzPerspectiveSub = isMhzPerspectiveSub(r, rows);
                  const subList = invoiceSubRowsFor(r);
                  const hasPrimeEntry = !!primeEntry;
                  // Per-view identity: an hz-type row (MHZ / MHZ PM) shows/edits
                  // its own mhz_project_number / mhz_project_name (falling back to
                  // the shared base values when blank); every other row uses the
                  // default project_number / project_name.
                  const isMhzRow    = isHzPrimeType(r.type);
                  const shownNumber = isMhzRow ? (r.mhzProjectNumber || r.projectNumber || "") : (r.projectNumber || "");
                  const shownName   = isMhzRow ? (r.mhzProjectName   || r.name || "")          : r.name;
                  return (
                  <React.Fragment key={r.id}>
                  <tr ref={(flashId === r.id || jumpId === r.id) ? flashRowRef : null}
                      className={((flashId === r.id || jumpId === r.id) ? "flash" : "") + (isExpanded ? " expanded" : "")}
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
                      <EditableCell value={shownNumber}
                        onChange={v => updateRow(r.id, isMhzRow ? { mhzProjectNumber: v } : { projectNumber: v })}/>
                    </td>
                    <td className="sticky-2" style={{ fontWeight: 500 }}>
                      <div className="inv-name-wrap">
                        <EditableCell value={shownName}
                          onChange={v => updateRow(r.id, isMhzRow ? { mhzProjectName: v } : { name: v })}/>
                        <button
                          type="button"
                          className={"invoice-egnyte-link" + (r.egnyteFolderPath ? " has-link" : "")}
                          title={r.egnyteFolderPath
                            ? `Egnyte folder linked: ${r.egnyteFolderPath}`
                            : "Link an Egnyte folder to this project"}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (r.egnyteFolderPath) setEgnyteAction({ row: r });
                            else setEgnytePicker({ row: r });
                          }}>
                          <EgnyteLogoMark size={16} linked={!!r.egnyteFolderPath}/>
                        </button>
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
                          {(() => {
                            const count = (r.notesLog || []).length;
                            const latest = (r.notesLog || [])[0];
                            const tip = count
                              ? `${count} update${count === 1 ? "" : "s"} · latest: ${latest?.body?.slice(0, 80) || ""}`
                              : "Add notes & updates for this project";
                            return (
                              <button
                                type="button"
                                className={"inv-meta-chip accent" + (count ? " has-content" : "")}
                                title={tip}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setNotesThread({ id: r.id, name: r.name, log: r.notesLog || [] });
                                }}>
                                <Icon name="note" size={10}/>
                                <span>Notes</span>
                                {count > 0 && <span className="inv-meta-chip-count">{count}</span>}
                              </button>
                            );
                          })()}
                          <button
                            type="button"
                            className={"inv-meta-chip blue" + (r.description ? " has-content" : "")}
                            title={r.description || "Add a description for this project"}
                            onClick={(e) => {
                              e.stopPropagation();
                              setNoteModal({ id: r.id, field: "description", label: "Description",
                                accent: "blue", name: r.name, projectNumber: r.projectNumber,
                                value: r.description || "" });
                            }}>
                            <Icon name="alignLeft" size={10}/>
                            <span>Description</span>
                          </button>
                        </div>
                      </div>
                    </td>
                    <td>
                      {roleDerived ? (
                        <span
                          className={`chip ${role === "Prime" ? "blue" : "accent"}`}
                          style={{ fontSize: 11 }}
                          title="Role is derived from the selected ENG/MHZ perspective">
                          {role}
                        </span>
                      ) : (
                        <EditableCell value={role} type="select" options={["Prime","Sub"]}
                          onChange={v => onChangeRole?.(r, v)}
                          render={v => v
                            ? <span className={`chip ${v === "Prime" ? "blue" : "accent"}`} style={{ fontSize: 11 }}>{v}</span>
                            : <span className="empty-cell">—</span>}/>
                      )}
                    </td>
                    <td>
                      <EditableCell value={r.type} type="select" options={invoiceTypeOptions}
                        onChange={v => updateRow(r.id, { type: v })}
                        render={v => v
                          ? <span className={`chip ${invoiceTypeTone(v)}`} style={{ fontSize: 11 }}>{v}</span>
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
                    {/* The white MHZ/MHZ PM Contract cell is the read-only
                        remainder: Project total − every sub, including MSMM. */}
                    <td className="msmm-locked"
                        title={isMhzRow
                          ? "Auto-calculated · Project total − all sub rows, including MSMM"
                          : "MSMM Portion is auto-calculated as Total Contract Value − Σ subs. Edit the Total or a sub to change it."}>
                      <EditableCell value={firstRowContract(r)} type="number"
                        disabled onBlocked={isMhzRow ? undefined : onBlockedMsmmEdit}
                        format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                    </td>
                    {isMhzRow ? (
                      <td className="mono msmm-locked"
                          title="Auto-calculated · Project total Rollforward − all sub-row Rollforward values, including MSMM">
                        <EditableCell value={firstRowRollforward(r)} type="number"
                          disabled
                          format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                      </td>
                    ) : (
                      <td className={canEditMsmm ? "" : "msmm-locked"}
                          title={!canEditMsmm ? "MSMM value — only an admin can edit it. Change the Total or a sub instead." : undefined}>
                        <EditableCell value={r.remainingStart != null ? r.remainingStart : (msmmContractShown(r) || null)} type="number"
                          disabled={!canEditMsmm} onBlocked={onBlockedMsmmEdit}
                          onChange={v => updateRow(r.id, { remainingStart: v })}
                          format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                      </td>
                    )}
                    {/* The white first-row months are read-only earned-value
                        remainders. In MHZ/MHZ PM they subtract every expanded
                        sub row, including independently stored MSMM. */}
                    {windowMonths.map((d, wi) => {
                      // Parent (white) row month value = earned value for the
                      // month. Read-only; edit the project total or a sub row.
                      const shown      = firstRowMonth(r, d);
                      // Read-only mirror of the Project total row's status for
                      // this month (paid top-left, attachment top-right) so the
                      // prominent top row reads at a glance.
                      const totalPaid  = primePaidAtDesc(r, d);
                      const totalFiles = primeFilesAtDesc(r, d);
                      return (
                      <td key={d.abs}
                          className={monthStateAtDesc(r, d) + (wi === lastActualWi ? " month-today" : "") + " invoice-cell msmm-locked"}
                          title={isMhzRow
                            ? "Auto-calculated · Project total month − all sub-row month values, including MSMM"
                            : "Earned value for this month — auto-calculated (month total − Σ subs). Edit the monthly total on the Project total row."}>
                        <EditableCell value={shown} type="number"
                          disabled onBlocked={isMhzRow ? undefined : onBlockedMsmmEdit}
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
                    <td className="total-cell inv-pin-ytd"
                        title={isMhzRow
                          ? "Auto-calculated · Project total billed − all sub-row total billed values, including MSMM"
                          : "Auto-calculated · MSMM contract − Rollforward + billed actuals (months with an invoice attached, 2026 onward)"}>
                      {(() => {
                        const v = firstRowTotalBilled(r);
                        return v ? fmtMoney(v) : <span className="empty-cell">—</span>;
                      })()}
                    </td>
                    <td className="total-cell inv-pin-rem"
                        title={isMhzRow
                          ? "Auto-calculated · Project total remaining − all sub-row remaining values, including MSMM"
                          : "Auto-calculated · MSMM Portion − Total Billed"}>
                      {(() => {
                        const v = firstRowTotalRemaining(r);
                        return v ? fmtMoney(v) : <span className="empty-cell">—</span>;
                      })()}
                    </td>
                    <td className="inv-pin-act" style={{ textAlign: "center" }} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                      <span className="inv-act-btns">
                        {billingMode === "active" && onPause && (
                          <button className="row-btn" title="Pause — move to In-Between"
                                  onClick={() => onPause(r)}>
                            <Icon name="pause" size={13}/>
                          </button>
                        )}
                        {billingMode === "between" && onResume && (
                          <button className="row-btn forward" title="Resume — move back to Invoices"
                                  onClick={() => onResume(r)}>
                            <Icon name="play" size={13}/>
                          </button>
                        )}
                        {billingMode === "between" && onCloseOutRow && (
                          <button className="row-btn" title="Close out project"
                                  style={{ color: "var(--rose)" }}
                                  onClick={() => onCloseOutRow(r)}>
                            <Icon name="x" size={13}/>
                          </button>
                        )}
                        {billingMode === "closed" && onResume && (
                          <button className="row-btn forward" title="Reopen — move back to Invoices"
                                  onClick={() => onResume(r)}>
                            <Icon name="play" size={13}/>
                          </button>
                        )}
                        <button
                          className={"row-btn invoice-orange-toggle" + (isOrange(r) ? " is-orange" : "")}
                          title={isOrange(r) ? "Move to Normal / White" : "Move to Orange"}
                          aria-label={isOrange(r) ? "Move to Normal / White" : "Move to Orange"}
                          onClick={() => updateRow(r.id, nextInvoiceOrangePatch(r, orangeSourceIds))}>
                          <Icon name="flag" size={13}/>
                        </button>
                        <button className="row-btn alert" title="Set alert" onClick={() => onAlert(r)}>
                          <Icon name="bell" size={14}/>
                        </button>
                      </span>
                    </td>
                  </tr>
                  {isExpanded && subList.length === 0 && (
                    <tr className="invoice-sub-row invoice-sub-empty">
                      <td className="invoice-expand-col"/>
                      <td className="sticky-1"/>
                      <td className="sticky-2" colSpan={4} style={{ paddingLeft: 28 }}>
                        <span style={{ fontStyle: "italic", color: "var(--text-soft)" }}>
                          {mhzPerspectiveSub
                            ? `${hzTypeForBase(r.type || "ENG") || "MHZ"} is the prime — the prime and subs are managed on the ${hzTypeForBase(r.type || "ENG") || "MHZ"} view.`
                            : isPrimeRow
                              ? "No subs tracked on this project yet."
                              : "No prime or subs tracked on this project yet."}
                        </span>
                      </td>
                      <td colSpan={windowMonths.length + 2}/>
                      <td className="inv-pin-ytd"/>
                      <td className="inv-pin-rem"/>
                      <td className="inv-pin-act"/>
                    </tr>
                  )}
                  {isExpanded && subList.map((s) => {
                    const entryKind = s.kind || "sub";
                    const isPrimeEntry = entryKind === "prime";
                    return (
                    <tr key={`${r.id}:${entryKind}:${s.companyId}`}
                        className={"invoice-sub-row" + (isPrimeEntry ? " invoice-prime-row" : "")}>
                      <td className="invoice-expand-col">
                        {onRemoveSub && !s.syntheticPerspective && !s.syntheticMhzPrime && (
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
                            if (s.syntheticPerspective || s.syntheticMhzPrime) return null;
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
                          {(s.syntheticPerspective || s.syntheticMhzPrime) ? (
                            <span>{s.discipline}</span>
                          ) : (
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
                          )}
                        </span>
                        {entryKind === "sub" && !s.syntheticPerspective && !s.syntheticMhzPrime && (
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
                      {/* Role + Type columns — empty on sub-rows. PM is editable
                          on the synthetic MSMM · sub line (project-level PMs,
                          synced to the linked base perspective). */}
                      <td className="subtle"><span className="empty-cell">—</span></td>
                      <td className="subtle"><span className="empty-cell">—</span></td>
                      <td className={s.syntheticPerspective ? "" : "subtle"}>
                        {s.syntheticPerspective ? (
                          <EditableCell
                            value={r.pmIds || []}
                            type="users"
                            options={pmOptions}
                            placeholder="Pick PMs…"
                            onChange={v => updateRow(r.id, { pmIds: v })}
                            render={v => (v || []).length > 0
                              ? <UserStack ids={v}/>
                              : <span className="empty-cell">—</span>}/>
                        ) : (
                          <span className="empty-cell">—</span>
                        )}
                      </td>
                      <td className="mono">
                        {s.syntheticMhzPrime ? (
                          <span title="MHZ earned value = Total Contract − all subs (incl. MSMM). Auto-calculated — edit the Total or a sub to change it.">
                            {s.contractAmount ? fmtMoney(s.contractAmount) : <span className="empty-cell">—</span>}
                          </span>
                        ) : s.syntheticPerspective ? (
                          <EditableCell value={s.contractAmount} type="number"
                            onChange={v => setMsmmContract(s.perspectiveBaseRow, v)}
                            format={v => v ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        ) : (
                          <EditableCell value={s.contractAmount} type="number"
                            onChange={v => onUpdateSubMeta?.({
                              projectId: r.sourceId,
                              companyId: s.companyId,
                              kind: entryKind,
                              patch: { amount: v },
                            })}
                            format={v => v ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        )}
                      </td>
                      {/* Remaining Jan 1 (sub) — editable starting balance;
                          NULL falls back to the sub's contract amount. */}
                      <td className="mono"
                          title="Remaining amount to bill for this sub. Defaults to the contract amount; edit if some was billed previously. Clear to reset.">
                        {s.syntheticMhzPrime ? (
                          <span className="empty-cell">—</span>
                        ) : s.syntheticPerspective ? (
                          <EditableCell value={s.remainingStart != null ? s.remainingStart : (s.contractAmount || null)} type="number"
                            onChange={v => updateMsmmFields?.(s.perspectiveBaseRow.id, { remainingStart: v })}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        ) : (
                          <EditableCell value={s.remainingStart != null ? s.remainingStart : (s.contractAmount || null)} type="number"
                            onChange={v => onUpdateSubMeta?.({
                              projectId: r.sourceId,
                              companyId: s.companyId,
                              kind: entryKind,
                              patch: { remaining_to_bill_year_start: v },
                            })}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        )}
                      </td>
                      {windowMonths.map((d, wi) => {
                        const amt = subAmtAtDesc(s, d);
                        const filesForCell = subFilesAtDesc(s, d);
                        const hasFiles = filesForCell.length > 0;
                        const isPaid   = subPaidAtDesc(s, d);
                        const paidWhen = subPaidWhenDesc(s, d);
                        const hasAmount = amt != null && amt !== 0;
                        const showPaidToggle = hasAmount || isPaid;
                        return (
                        <td key={d.abs}
                            className={monthStateAtDesc(r, d) + (wi === lastActualWi ? " month-today" : "") + " invoice-cell" + (isPaid ? " paid" : "")}
                            data-paid={isPaid ? "true" : undefined}>
                          {s.syntheticMhzPrime ? (
                            <span className="mono" title="MHZ earned value — auto-calculated (month total − subs).">
                              {amt != null && amt !== 0 ? fmtMoney(amt) : <span style={{ opacity: 0.4 }}>—</span>}
                            </span>
                          ) : (
                            <EditableCell value={amt} type="number"
                              onChange={nv => s.syntheticPerspective
                                ? setMsmmMonth(s.perspectiveBaseRow, d, nv)
                                : onUpdateSubAmount?.(r.sourceId, s.companyId, d.monthIdx, nv, entryKind, d.year)}
                              format={v => v != null && v !== 0
                                ? fmtMoney(v)
                                : <span style={{ opacity: 0.4 }}>—</span>}/>
                          )}
                          {!s.syntheticMhzPrime && showPaidToggle && (
                            <button
                              type="button"
                              className={"invoice-cell-paid-toggle" + (isPaid ? " paid" : "") + (isPaid && !canUntickPaid ? " locked" : "")}
                              title={isPaid
                                ? (canUntickPaid
                                    ? `Paid${paidWhen ? ` · ${fmtDate(paidWhen)}` : ""} — click to unmark (confirmation required)`
                                    : `Paid${paidWhen ? ` · ${fmtDate(paidWhen)}` : ""} · locked — only an administrator can unmark`)
                                : "Mark as paid"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (s.syntheticPerspective) {
                                  // MSMM-as-sub: paid lives on the base ENG/PM prime store,
                                  // shared with the base's MSMM total row (two-way sync).
                                  onTogglePrimePaid?.(s.perspectiveBaseRow, d.year, d.monthIdx, !isPaid);
                                } else {
                                  onTogglePaid?.({
                                    projectId: r.sourceId,
                                    companyId: s.companyId,
                                    monthIdx: d.monthIdx,
                                    paid: !isPaid,
                                    kind: entryKind,
                                    year: d.year,
                                  });
                                }
                              }}>
                              <Icon name={isPaid && !canUntickPaid ? "lock" : "check"} size={11}/>
                            </button>
                          )}
                          {!s.syntheticMhzPrime && (() => {
                            // Attachment gating is controlled by the
                            // ATTACH_ONLY_ON_ACTUAL flag (currently OFF, so
                            // uploads are allowed on every month). When ON, a
                            // projected month with no files shows a locked,
                            // non-opening clip; rows that already have files
                            // always open so they stay viewable.
                            const attachLocked = ATTACH_ONLY_ON_ACTUAL && !isActualInvoiceMonth(d.year, d.monthIdx) && !hasFiles;
                            return (
                            <button
                              type="button"
                              className={"invoice-cell-clip" + (hasFiles ? " has-files" : "") + (attachLocked ? " locked" : "")}
                              title={attachLocked
                                ? "Attachments can only be added to actual months"
                                : hasFiles
                                  ? `${filesForCell.length} file${filesForCell.length === 1 ? "" : "s"} attached`
                                  : (s.syntheticPerspective
                                      ? "Attach MSMM invoice file"
                                      : isPrimeEntry
                                        ? `Attach invoice to ${s.companyName}`
                                        : `Attach invoice from ${s.companyName}`)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (attachLocked) return;
                                if (s.syntheticPerspective) {
                                  // MSMM-as-sub: attach to the base ENG/PM prime store,
                                  // shared with the base's MSMM total row (two-way sync).
                                  onOpenFiles?.({ kind: "prime", projectRow: s.perspectiveBaseRow, monthIdx: d.monthIdx, year: d.year });
                                } else {
                                  onOpenFiles?.({ kind: "sub", projectRow: r, monthIdx: d.monthIdx, sub: s, year: d.year });
                                }
                              }}>
                              <Icon name="link" size={11}/>
                              {hasFiles && <span className="invoice-cell-clip-count">{filesForCell.length}</span>}
                            </button>
                            );
                          })()}
                        </td>
                        );
                      })}
                      {/* Total Billed (sub) = sub contract − Rollforward + billed
                          actuals (months with a sub invoice attached). */}
                      <td className="total-cell mono inv-pin-ytd"
                          title="Auto-calculated · sub contract − Rollforward + billed actuals (months with an invoice attached, 2026 onward)">
                        {s.syntheticMhzPrime ? <span className="empty-cell">—</span> : (() => {
                          const ytd = subTotalBilled(s);
                          return ytd ? fmtMoney(ytd) : <span className="empty-cell">—</span>;
                        })()}
                      </td>
                      <td className="total-cell mono inv-pin-rem"
                          title="Auto-calculated · sub contract − Total Billed">
                        {s.syntheticMhzPrime ? <span className="empty-cell">—</span> : (() => {
                          const c = Number(s.contractAmount || 0), b = subTotalBilled(s);
                          return (c || b) ? fmtMoney(c - b) : <span className="empty-cell">—</span>;
                        })()}
                      </td>
                      <td className="inv-pin-act"/>
                    </tr>
                    );
                  })}
                  {isExpanded && !mhzPerspectiveSub && (() => {
                    // Prime-role projects: one button — "Add sub" (unlimited).
                    // Sub-role projects: two buttons —
                    //   "Add prime" (gated by the partial unique index — at
                    //                most one prime entry per project)
                    //   "Add sub"   (always shown; MSMM may further sub-
                    //                contract pieces of its own work)
                    // MHZ-perspective Sub rows (ENG view of an MHZ-prime project)
                    // are read-only — the shared subs belong to the MHZ view, so
                    // no add affordance here (a sub added would be hidden anyway).
                    return (
                    <tr className="invoice-sub-add-row">
                      <td className="invoice-expand-col"/>
                      <td className="sticky-1"/>
                      <td className="sticky-2" colSpan={windowMonths.length + 6}>
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
                      <td className="inv-pin-ytd"/>
                      <td className="inv-pin-rem"/>
                      <td className="inv-pin-act"/>
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
                        {mhzPerspectiveSub && (() => {
                          const hzLabel = hzTypeForBase(r.type || "ENG") || "MHZ";
                          return (
                          <button
                            type="button"
                            className="invoice-mhz-jump-btn"
                            title={`${hzLabel} is the prime — edit the full total and the subs on the ${hzLabel} view`}
                            onClick={(e) => { e.stopPropagation(); jumpToMhzPerspective(r); }}>
                            Edit totals &amp; subs in {hzLabel} view
                            <Icon name="chevronRight" size={11}/>
                          </button>
                          );
                        })()}
                      </td>
                      <td/>
                      <td/>
                      {/* PM — editable on the MSMM Project-total row of an hz-prime
                          base view (project-level PMs, synced to the hz sibling). */}
                      <td>
                        {mhzPerspectiveSub && (
                          <EditableCell
                            value={r.pmIds || []}
                            type="users"
                            options={pmOptions}
                            placeholder="Pick PMs…"
                            onChange={v => updateRow(r.id, { pmIds: v })}
                            render={v => (v || []).length > 0
                              ? <UserStack ids={v}/>
                              : <span className="empty-cell">—</span>}/>
                        )}
                      </td>
                      <td className="mono"
                          title={mhzPerspectiveSub ? "MSMM Portion — editable here; writes the shared total (MSMM + subs) and mirrors to the linked perspective" : undefined}>
                        {mhzPerspectiveSub ? (
                          <EditableCell value={msmmContractShown(r)} type="number"
                            onChange={v => setMsmmContract(r, v)}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        ) : (
                          <EditableCell value={r.amount} type="number"
                            onChange={v => updateRow(r.id, { amount: (v == null || v === "") ? null : Number(v) })}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        )}
                      </td>
                      {/* Remaining Jan 1 (project total) — editable starting
                          balance; NULL falls back to Total Contract Value. For an
                          MHZ-prime ENG row it mirrors MSMM's Rollforward (read-only). */}
                      <td className="mono"
                          title="Remaining amount to bill for the whole project. Defaults to Total Contract Value; edit if some was billed previously. Clear to reset.">
                        {mhzPerspectiveSub ? (
                          <EditableCell value={r.remainingStart != null ? r.remainingStart : (msmmContractShown(r) || null)} type="number"
                            disabled={!canEditMsmm} onBlocked={onBlockedMsmmEdit}
                            onChange={v => updateMsmmFields?.(r.id, { remainingStart: v })}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        ) : (
                          <EditableCell value={r.totalRemainingStart != null ? r.totalRemainingStart : (r.amount || null)} type="number"
                            onChange={v => updateRow(r.id, { totalRemainingStart: (v == null || v === "") ? null : Number(v) })}
                            format={v => v != null ? fmtMoney(v) : <span className="empty-cell">—</span>}/>
                        )}
                      </td>
                      {windowMonths.map((d, wi) => {
                        if (mhzPerspectiveSub) {
                          // ENG view of an MHZ-prime project — the Project total
                          // row shows MSMM's own monthly portion and is EDITABLE:
                          // it writes the shared total (= MSMM + subs) so it stays
                          // in lockstep with the MHZ "MSMM · sub" line, and the
                          // edit is mirrored to the MHZ perspective. MSMM's OWN
                          // prime invoice + paid live on THIS (ENG/PM) row and
                          // stay in lockstep with the MHZ MSMM-sub row (same
                          // store); the JV's full prime invoice is separate, on
                          // the MHZ total.
                          const shown = msmmAtDesc(r, d);
                          const filesForCell = primeFilesAtDesc(r, d);
                          const hasFiles = filesForCell.length > 0;
                          const isPaid   = primePaidAtDesc(r, d);
                          const showPaidToggle = (shown != null && shown !== 0) || isPaid;
                          const attachLocked = ATTACH_ONLY_ON_ACTUAL && !isActualInvoiceMonth(d.year, d.monthIdx) && !hasFiles;
                          return (
                          <td key={d.abs}
                              className={monthStateAtDesc(r, d) + (wi === lastActualWi ? " month-today" : "") + " invoice-cell" + (isPaid ? " paid" : "")}
                              data-paid={isPaid ? "true" : undefined}>
                            <EditableCell value={shown || null} type="number"
                              onChange={nv => setMsmmMonth(r, d, nv)}
                              format={v => v ? fmtMoney(v) : <span style={{ opacity: .4 }}>—</span>}/>
                            {showPaidToggle && (
                              <button
                                type="button"
                                className={"invoice-cell-paid-toggle" + (isPaid ? " paid" : "") + (isPaid && !canUntickPaid ? " locked" : "")}
                                title={isPaid
                                  ? (canUntickPaid
                                      ? "MSMM paid — click to unmark (confirmation required)"
                                      : "MSMM paid · locked — only an administrator can unmark")
                                  : "Mark MSMM invoice as paid"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onTogglePrimePaid?.(r, d.year, d.monthIdx, !isPaid);
                                }}>
                                <Icon name={isPaid && !canUntickPaid ? "lock" : "check"} size={11}/>
                              </button>
                            )}
                            <button
                              type="button"
                              className={"invoice-cell-clip" + (hasFiles ? " has-files" : "") + (attachLocked ? " locked" : "")}
                              title={attachLocked
                                ? "Attachments can only be added to actual months"
                                : hasFiles
                                  ? `${filesForCell.length} file${filesForCell.length === 1 ? "" : "s"} attached`
                                  : "Attach MSMM invoice file"}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (attachLocked) return;
                                onOpenFiles?.({ kind: "prime", projectRow: r, monthIdx: d.monthIdx, year: d.year });
                              }}>
                              <Icon name="link" size={11}/>
                              {hasFiles && <span className="invoice-cell-clip-count">{filesForCell.length}</span>}
                            </button>
                          </td>
                          );
                        }
                        const v = valAtDesc(r, d);
                        const filesForCell = primeFilesAtDesc(r, d);
                        const hasFiles = filesForCell.length > 0;
                        const isPaid   = primePaidAtDesc(r, d);
                        const hasAmount = v != null && v !== 0;
                        const showPaidToggle = hasAmount || isPaid;
                        // Per-month invoice number for this project total cell.
                        const invNum = invNumAtDesc(r, d);
                        return (
                        <td key={d.abs}
                            className={monthStateAtDesc(r, d, true) + (wi === lastActualWi ? " month-today" : "") + " invoice-cell" + (isPaid ? " paid" : "")}
                            data-paid={isPaid ? "true" : undefined}>
                          <EditableCell value={v} type="number"
                            onChange={nv => updateInvoice(r, d.year, d.monthIdx, nv)}
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
                                onTogglePrimePaid?.(r, d.year, d.monthIdx, !isPaid);
                              }}>
                              <Icon name={isPaid && !canUntickPaid ? "lock" : "check"} size={11}/>
                            </button>
                          )}
                          {(() => {
                            // Same ATTACH_ONLY_ON_ACTUAL gate as the sub clip
                            // above (currently OFF → always attachable).
                            const attachLocked = ATTACH_ONLY_ON_ACTUAL && !isActualInvoiceMonth(d.year, d.monthIdx) && !hasFiles;
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
                                onOpenFiles?.({ kind: "prime", projectRow: r, monthIdx: d.monthIdx, year: d.year });
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
                                onOpenFiles?.({ kind: "prime", projectRow: r, monthIdx: d.monthIdx, year: d.year });
                              }}>
                              <span className="invoice-cell-invnum-hash">#</span>
                              <span className="invoice-cell-invnum-val">{invNum}</span>
                            </button>
                          )}
                        </td>
                        );
                      })}
                      {/* Total Billed (project) = Total CV − Rollforward + billed
                          actuals (months with a prime invoice attached). For an
                          MHZ-prime ENG row it mirrors MSMM's own Total Billed so
                          no full-JV figure shows in the ENG view. */}
                      <td className="total-cell mono inv-pin-ytd"
                          title={mhzPerspectiveSub
                            ? "Auto-calculated · MSMM contract − Rollforward + billed actuals (months with an invoice attached, 2026 onward)"
                            : "Auto-calculated · Total CV − Rollforward + billed actuals (months with an invoice attached, 2026 onward)"}>
                        {(() => {
                          const ytd = mhzPerspectiveSub ? msmmTotalBilled(r) : projectTotalBilled(r);
                          return ytd ? fmtMoney(ytd) : <span className="empty-cell">—</span>;
                        })()}
                      </td>
                      <td className="total-cell mono inv-pin-rem"
                          title="Auto-calculated · contract − Total Billed">
                        {(() => {
                          const c = mhzPerspectiveSub ? msmmContractShown(r) : Number(r.amount || 0);
                          const b = mhzPerspectiveSub ? msmmTotalBilled(r) : projectTotalBilled(r);
                          return (c || b) ? fmtMoney(c - b) : <span className="empty-cell">—</span>;
                        })()}
                      </td>
                      <td className="inv-pin-act"/>
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
                      <td className="total-cell">{fmtMoney(sumBy(searchedNonOrange, firstRowRollforward))}</td>
                      {windowMonths.map((d, wi) => (
                        <td key={d.abs} className={(isActualInvoiceMonth(d.year, d.monthIdx) ? "month-actual" : "month-proj") + (wi === lastActualWi ? " month-today" : "") + " total-cell"}>
                          {fmtMoney(sumBy(searchedNonOrange, r => firstRowMonth(r, d)))}
                        </td>
                      ))}
                      <td className="total-cell inv-pin-ytd" style={{ color: "var(--accent-ink)" }}
                          title="Sum of the visible first-row Total Billed values">
                        {fmtMoney(sumBy(searchedNonOrange, firstRowTotalBilled))}
                      </td>
                      <td className="total-cell inv-pin-rem" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(searchedNonOrange, firstRowTotalRemaining))}
                      </td>
                      <td className="total-cell inv-pin-act"></td>
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
                      <td className="total-cell">{fmtMoney(sumBy(searchedRows, firstRowRollforward))}</td>
                      {windowMonths.map((d, wi) => (
                        <td key={d.abs} className={(isActualInvoiceMonth(d.year, d.monthIdx) ? "month-actual" : "month-proj") + (wi === lastActualWi ? " month-today" : "") + " total-cell"}>
                          {fmtMoney(sumBy(searchedRows, r => firstRowMonth(r, d)))}
                        </td>
                      ))}
                      <td className="total-cell inv-pin-ytd" style={{ color: "var(--accent-ink)" }}
                          title="Sum of the visible first-row Total Billed values">
                        {fmtMoney(sumBy(searchedRows, firstRowTotalBilled))}
                      </td>
                      <td className="total-cell inv-pin-rem" style={{ color: "var(--accent-ink)" }}>
                        {fmtMoney(sumBy(searchedRows, firstRowTotalRemaining))}
                      </td>
                      <td className="total-cell inv-pin-act"></td>
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
      {notesThread && (
        <InvoiceNotesThread
          meta={notesThread}
          onClose={() => setNotesThread(null)}
          onChange={(log) => onNotesChanged?.(notesThread.id, log)}
        />
      )}
      {egnyteAction && (
        <EgnyteLinkedFolderModal
          row={egnyteAction.row}
          onClose={() => setEgnyteAction(null)}
          onChangePath={() => {
            setEgnytePicker({ row: egnyteAction.row });
            setEgnyteAction(null);
          }}
        />
      )}
      {egnytePicker && (
        <EgnyteFolderModal
          row={egnytePicker.row}
          onClose={() => setEgnytePicker(null)}
          onSave={async (path) => {
            if (!onSaveEgnyteFolder) throw new Error("Egnyte folder saving is not available.");
            const saved = await onSaveEgnyteFolder(egnytePicker.row, path);
            setEgnytePicker(null);
            return saved;
          }}
        />
      )}
    </div>
  );
};

function EgnyteFolderModal({ row, onClose, onSave }) {
  const [currentPath, setCurrentPath] = useState(null);
  const [folders, setFolders] = useState([]);
  const [selected, setSelected] = useState(row?.egnyteFolderPath || "");
  const [viewMode, setViewMode] = useState("list");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async (path) => {
    setLoading(true);
    setError("");
    try {
      const result = await browseEgnyteFolders(path);
      setCurrentPath(result.path);
      setFolders(result.folders || []);
    } catch (e) {
      setError(e?.message || "Egnyte folders could not be loaded.");
      setFolders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const parts = (currentPath || "").split("/").filter(Boolean);
  const crumbs = parts.map((part, i) => ({
    label: part,
    path: `/${parts.slice(0, i + 1).join("/")}`,
  }));
  const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : null;
  const selectedIsCurrent = !!currentPath && selected === currentPath;
  const searchText = search.trim();
  const visibleFolders = useMemo(() => filterEgnyteFolders(folders, search), [folders, search]);

  const save = async (path = selected) => {
    setSaving(true);
    setError("");
    try {
      await onSave(path);
    } catch (e) {
      setError(e?.message || "Egnyte folder could not be saved.");
      setSaving(false);
    }
  };

  const renderFolder = (folder) => {
    const active = selected === folder.path;
    return (
      <div className={"egnyte-folder-card" + (active ? " selected" : "")} role="listitem" key={folder.path}>
        <button className="egnyte-folder-open" type="button" onClick={() => load(folder.path)}>
          <span className="egnyte-folder-glyph"><Icon name="chevronRight" size={13}/></span>
          <span className="egnyte-folder-main">
            <strong>{folder.name}</strong>
            <span className="mono">{folder.path}</span>
          </span>
        </button>
        <button className="btn sm egnyte-select-btn" type="button" onClick={() => setSelected(folder.path)}>
          {active ? <><Icon name="check" size={12}/>Selected</> : "Select"}
        </button>
      </div>
    );
  };

  return createPortal(
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal modal-wide egnyte-modal" role="dialog" aria-modal="true" aria-labelledby="egnyte-title">
        <div className="modal-head">
          <div className="icon-badge egnyte-badge"><EgnyteLogoMark size={20} linked={!!row?.egnyteFolderPath}/></div>
          <div>
            <div className="modal-eyebrow">Egnyte folder</div>
            <h2 className="modal-title" id="egnyte-title">{row?.name || "Project"}</h2>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body egnyte-body">
          <div className="egnyte-current-panel">
            <div>
              <span>Current link</span>
              <strong className="mono">{row?.egnyteFolderPath || "No folder linked"}</strong>
            </div>
            {currentPath && (
              <button
                className={"btn sm" + (selectedIsCurrent ? " primary" : "")}
                type="button"
                onClick={() => setSelected(currentPath)}
                disabled={loading}>
                {selectedIsCurrent ? <><Icon name="check" size={12}/>Current selected</> : "Select current folder"}
              </button>
            )}
          </div>
          <div className="egnyte-browser">
            <div className="egnyte-toolbar">
              <div className="egnyte-nav-actions">
                <button className="btn sm" type="button" disabled={!parentPath || loading} onClick={() => load(parentPath)}>
                  <Icon name="back" size={12}/>Up
                </button>
                <button className="btn sm" type="button" disabled={loading} onClick={() => load(currentPath)}>
                  <Icon name="refresh" size={12}/>Refresh
                </button>
              </div>
              <div className="egnyte-crumbs" aria-label="Current Egnyte path">
                {crumbs.length === 0 ? (
                  <span className="mono subtle">Loading PData…</span>
                ) : crumbs.map((c, i) => (
                  <React.Fragment key={c.path}>
                    {i > 0 && <span className="egnyte-sep">/</span>}
                    <button type="button" onClick={() => load(c.path)} disabled={loading}>{c.label}</button>
                  </React.Fragment>
                ))}
              </div>
              <div className="egnyte-view-toggle" role="tablist" aria-label="Egnyte folder view">
                <button
                  type="button"
                  className={viewMode === "list" ? "active" : ""}
                  onClick={() => setViewMode("list")}
                  aria-selected={viewMode === "list"}
                  title="List view">
                  <Icon name="alignLeft" size={14}/>
                </button>
                <button
                  type="button"
                  className={viewMode === "grid" ? "active" : ""}
                  onClick={() => setViewMode("grid")}
                  aria-selected={viewMode === "grid"}
                  title="Grid view">
                  <Icon name="columns" size={14}/>
                </button>
              </div>
            </div>
            <label className={"egnyte-search" + (searchText ? " active" : "")}>
              <Icon name="search" size={14}/>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search folders"
                aria-label="Search Egnyte folders"
              />
              {searchText && (
                <button type="button" onClick={() => setSearch("")} aria-label="Clear folder search">
                  <Icon name="x" size={12}/>
                </button>
              )}
            </label>
            {error && (
              <div className="egnyte-error">
                <Icon name="warn" size={14}/>
                <span>{error}</span>
                <button className="link-btn" type="button" onClick={() => load(currentPath || undefined)}>Retry</button>
              </div>
            )}
            {loading ? (
              <div className="egnyte-state">
                <span className="egnyte-spinner" aria-hidden="true"/>
                <span>Loading folders…</span>
              </div>
            ) : folders.length === 0 && !error ? (
              <div className="egnyte-state">No subfolders found.</div>
            ) : visibleFolders.length === 0 && !error ? (
              <div className="egnyte-state">No folders match <span className="mono">"{searchText}"</span>.</div>
            ) : (
              <div className={`egnyte-folder-results ${viewMode}`} role="list">
                {visibleFolders.map(renderFolder)}
              </div>
            )}
          </div>
          <div className={"egnyte-selected-panel" + (selected ? " has-selection" : "")}>
            <div>
              <span>Selected folder</span>
              <strong className="mono">{selected || "Choose a folder from the browser"}</strong>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <div className="egnyte-foot-actions">
            {row?.egnyteFolderPath && (
              <button className="btn" type="button" onClick={() => save("")} disabled={saving}>
                Remove link
              </button>
            )}
            <button className="btn primary" type="button" onClick={() => save()} disabled={!selected || saving}>
              {saving ? "Saving…" : "Save folder"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

function EgnyteLinkedFolderModal({ row, onClose, onChangePath }) {
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const defaultLocalRoot = defaultEgnyteLocalRoot(platform);
  const [localRoot, setLocalRoot] = useState(() => {
    if (typeof window === "undefined") return defaultLocalRoot;
    try {
      return window.localStorage.getItem(EGNYTE_LOCAL_ROOT_STORAGE_KEY) || defaultLocalRoot;
    } catch {
      return defaultLocalRoot;
    }
  });
  const [message, setMessage] = useState("");

  const target = useMemo(() => egnyteFolderOpenTarget({
    path: row?.egnyteFolderPath || "",
    platform,
    userAgent,
    localRoot,
  }), [row?.egnyteFolderPath, platform, userAgent, localRoot]);

  const persistLocalRoot = (value) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EGNYTE_LOCAL_ROOT_STORAGE_KEY, value);
    } catch {
      // Local storage can be disabled; opening still works from current state.
    }
  };

  const resetLocalRoot = () => {
    setLocalRoot(defaultLocalRoot);
    persistLocalRoot(defaultLocalRoot);
  };

  const openLinkedFolder = async () => {
    const nextRoot = localRoot.trim() || defaultLocalRoot;
    const nextTarget = egnyteFolderOpenTarget({
      path: row?.egnyteFolderPath || "",
      platform,
      userAgent,
      localRoot: nextRoot,
    });
    if (nextTarget.mobile) {
      setMessage("Egnyte is not available on mobile.");
      return;
    }
    setLocalRoot(nextRoot);
    persistLocalRoot(nextRoot);
    try {
      if (typeof navigator !== "undefined") {
        await navigator.clipboard?.writeText(nextTarget.localPath);
      }
    } catch {
      // Best-effort convenience only; browser clipboard permission varies.
    }
    const helperOpened = await openLocalFolderWithHelper({ localPath: nextTarget.localPath });
    if (helperOpened) {
      setMessage(`Opened ${nextTarget.localPath}`);
      return;
    }
    const pageProtocol = typeof window !== "undefined" ? window.location.protocol : "";
    if (!canAttemptLocalFileOpen(pageProtocol)) {
      setMessage(`Local path copied: ${nextTarget.localPath}`);
      return;
    }
    setMessage(`Opening ${nextTarget.localPath}`);
    const opened = window.open(nextTarget.url, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.href = nextTarget.url;
    }
  };

  return createPortal(
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal egnyte-action-modal" role="dialog" aria-modal="true" aria-labelledby="egnyte-action-title">
        <div className="modal-head">
          <div className="icon-badge egnyte-badge"><EgnyteLogoMark size={20} linked/></div>
          <div>
            <div className="modal-eyebrow">Linked Egnyte folder</div>
            <h2 className="modal-title" id="egnyte-action-title">{row?.name || "Project"}</h2>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body egnyte-action-body">
          <div className="egnyte-linked-path">
            <span>Linked path</span>
            <strong className="mono">{row?.egnyteFolderPath}</strong>
          </div>
          <div className="egnyte-local-root">
            <label htmlFor="egnyte-local-root">Local Egnyte root</label>
            <div className="egnyte-local-root-control">
              <input
                id="egnyte-local-root"
                value={localRoot}
                onChange={(e) => setLocalRoot(e.target.value)}
                onBlur={() => persistLocalRoot(localRoot.trim() || defaultLocalRoot)}
              />
              <button className="btn sm" type="button" onClick={resetLocalRoot}>Reset</button>
            </div>
            <span className="mono">{target.mobile ? "Unavailable on mobile" : target.localPath}</span>
          </div>
          <div className="egnyte-action-grid">
            <button type="button" className="egnyte-action-card primary" onClick={openLinkedFolder}>
              <span className="egnyte-action-icon"><Icon name="export" size={18}/></span>
              <strong>Open Egnyte Folder</strong>
              <span>Open the local synced folder path in Finder or File Explorer.</span>
            </button>
            <button type="button" className="egnyte-action-card" onClick={onChangePath}>
              <span className="egnyte-action-icon"><Icon name="edit" size={18}/></span>
              <strong>Change Egnyte Path</strong>
              <span>Choose another folder from PData.</span>
            </button>
          </div>
          {message && (
            <div className="egnyte-action-message">
              <Icon name="warn" size={14}/>
              <span>{message}</span>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}

// InvoiceNoteModal — lightweight editor for a project's Notes / Description
// (the two chips under the project name in InvoiceTable). Centered modal,
// portaled to <body> so it escapes the scrolling/sticky invoice table.
// Closing via overlay / X / Save / ⌘↵ commits; Cancel / Esc discards.
function InvoiceNoteModal({ meta, onClose, onSave }) {
  const [text, setText] = useState(meta.value || "");
  // AI generator is launched from within the Description editor (description
  // field only) and stacks on top; accepting a draft drops the text into this
  // textarea for review before the user Saves through the normal path.
  const [genOpen, setGenOpen] = useState(false);
  const canGenerate = meta.field === "description";
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
      if (genOpen) return; // the stacked generator owns the keyboard while open
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
          {canGenerate ? (
            <button className="btn sm note-modal-genbtn" onClick={() => setGenOpen(true)}
              title="Draft this description with AI from project documents & testimonials">
              <Icon name="sparkles" size={13}/> Generate with AI
            </button>
          ) : (
            <div className="note-modal-foothint">Also shown in the row's detail drawer</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={cancel}>Cancel</button>
            <button className="btn primary sm" onClick={commit} disabled={!dirty}>
              <Icon name="check" size={13}/> Save
            </button>
          </div>
        </div>
      </div>
      {genOpen && (
        <DescriptionGeneratorModal
          meta={{ id: meta.id, name: meta.name, projectNumber: meta.projectNumber, current: text }}
          acceptLabel="Use this draft"
          onClose={() => setGenOpen(false)}
          onAccept={(_id, draft) => { setText(draft); setGenOpen(false); }}/>
      )}
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
    { label: "__actions", w: "96px", locked: true },
  ];

  // Status vocabulary, shared verbatim with the Calendar view
  // (STATUS_META in events-calendar.jsx): same word, same glyph, same
  // semantic tone, so the two views of the same page never disagree about
  // what state a row is in. Tones follow design/README §2 — steel for a
  // booked/in-between date, brand for something still scheduled, neutral
  // once it has happened, clay for an Outlook cancellation.
  const STATUS_META = {
    "Booked":    { icon: "calendarClock", tone: "info" },
    "Scheduled": { icon: "clock",         tone: "brand" },
    "Happened":  { icon: "checkCircle",   tone: "neutral" },
  };
  const CANCELLED_META = { icon: "ban", tone: "danger" };

  // Event type is a category, not a state, so it carries the same tone the
  // Calendar paints its tiles with (TYPE_TONE in events-calendar.jsx),
  // translated into the kit's Badge tone names. The word is always printed
  // next to the swatch, so the category never rests on colour.
  const typeColor = t => ({
    "Partner": "accent", "AI": "sage", "Project": "blue", "Meetings": "muted",
    "Board Meetings": "blue", "Event": "rose"
  }[t] || "muted");
  const TYPE_BADGE_TONE = {
    accent: "brand", sage: "success", blue: "info", rose: "danger", muted: "neutral",
  };

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
      emptyHint="Add an event, or run an Outlook sync, and partner touchpoints, conferences and meetings show up here."
      emptyIcon="calendar"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const eventName = r.title || "this event";
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${eventName}`}/>
            </div>
          ),
          "Status": (() => {
            // Pure derived display — no inline edit. Calendar passing the
            // event's end flips Booked → Happened automatically via the
            // useNowTick re-render. Tooltip explains the source of truth
            // so an admin scanning the list isn't surprised that the chip
            // doesn't match what they may have stored in the DB.
            const derived   = derivedEventStatus(r, now);
            const cancelled = !!r.outlookIsCancelled;
            const meta  = cancelled ? CANCELLED_META : (STATUS_META[derived] || STATUS_META["Booked"]);
            const label = cancelled ? "Cancelled" : derived;
            const stale   = r.status && r.status !== derived;
            const refISO  = r.outlookEndDateTime || r.dateTime || r.date;
            const tip = cancelled
              ? "Cancelled in Outlook"
              : refISO
                ? `Auto: ${derived}, ${derived === "Happened" ? "event already passed" : "event still upcoming"}` +
                  (r.outlookEndDateTime ? ` (ends ${fmtDateTime(r.outlookEndDateTime)})` : "") +
                  (stale ? ` · stored as "${r.status}"` : "")
                : `${derived} · no datetime recorded`;
            return (
              <div className="td bxt-td-status" title={tip}>
                <Badge tone={meta.tone} className="max-w-full">
                  <Icon name={meta.icon} size={12} aria-hidden="true"/>
                  <span className="min-w-0 truncate">{label}</span>
                </Badge>
              </div>
            );
          })(),
          "Type": (
            <div className="td">
              <EditableCell value={r.type} type="select" options={eventTypeOptions}
                onChange={v => updateRow(r.id, { type: v })}
                render={v => v
                  ? (
                    <Badge tone={TYPE_BADGE_TONE[typeColor(v)] || "neutral"} dot className="max-w-full" title={v}>
                      <span className="min-w-0 truncate">{v}</span>
                    </Badge>
                  )
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Title": (
            <div className="td bxt-td-identity">
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
            // fmtEventRange returns an em dash when nothing is recorded;
            // the table's placeholder for an empty cell is an en dash.
            const hasWhen = range.primary && range.primary !== "—";
            const display = hasWhen ? (
              <span className="bxt-when">
                <span className="bxt-when-primary num">{range.primary}</span>
                {range.secondary && (
                  <span className="bxt-when-secondary num">{range.secondary}</span>
                )}
                {range.isMultiDay && (
                  <Badge tone="outline" size="sm" className="mt-px w-fit">Multi-day</Badge>
                )}
              </span>
            ) : (
              <span className="empty-cell">–</span>
            );
            return (
              <div className="td bxt-td-when">
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
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions bxt-actions-persist"
                   onClick={e => e.stopPropagation()}>
                <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-alert"
                        title="Set alert" aria-label={`Set an alert for ${eventName}`}
                        onClick={() => onAlert(r)}>
                  <Icon name="bell" size={14}/>
                </button>
                <button type="button" className="row-btn bxt-rowbtn"
                        title="Open details" aria-label={`Open details for ${eventName}`}
                        onClick={() => onOpenDrawer(r)}>
                  <Icon name="maximize" size={14}/>
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
    <section className="hlq-col" data-tone={tone} aria-label={`${label} upcoming hot leads`}>
      <header className="hlq-col-head">
        <h3 className="hlq-col-title">
          <span className="hlq-col-dot" aria-hidden="true"/>
          {label}
        </h3>
        <span className="hlq-col-count">
          {items.length === 0
            ? "Nothing upcoming"
            : <><span className="num">{items.length}</span> upcoming</>}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="hlq-empty">
          <Icon name="calendar" size={14}/>
          <span>No {label.toLowerCase()} leads scheduled.</span>
        </p>
      ) : (
        <ol className="hlq-list">
          {items.slice(0, CAP).map(r => {
            const company = companyById(r.clientId);
            return (
              <li key={r.id}>
                <button type="button" className="hlq-card"
                        onClick={() => onOpenDrawer?.(r)}>
                  <span className="hlq-card-when">
                    <span className="hlq-card-date num">{fmtQuickDate(r.dateTime)}</span>
                    <span className="hlq-card-time num">{fmtQuickTime(r.dateTime)}</span>
                  </span>
                  <span className="hlq-card-body">
                    <span className="hlq-card-title">{r.title || "Untitled lead"}</span>
                    {company && (
                      <span className="hlq-card-client">{company.name}</span>
                    )}
                  </span>
                  {r.stars > 0 && (
                    <span className="hlq-card-stars" data-stars={String(r.stars)}>
                      <Icon name="star" size={12}/>
                      <span className="num">{r.stars}</span>
                      <span className="sr-only">{starLabel(r.stars, HOT_LEAD_STAR_MAX)}</span>
                    </span>
                  )}
                  <Icon name="chevronRight" size={14} className="hlq-card-go"/>
                </button>
              </li>
            );
          })}
          {items.length > CAP && (
            <li className="hlq-more">
              {items.length - CAP} more in the table below
            </li>
          )}
        </ol>
      )}
    </section>
  );

  return (
    <section className="hlq" aria-label="Upcoming hot leads quick view">
      <header className="hlq-head">
        <h2 className="hlq-title">Upcoming hot leads</h2>
        <span className="hlq-sub">
          {upcoming.length === 0
            ? "Nothing scheduled"
            : <><span className="num">{upcoming.length}</span> scheduled, split by type</>}
        </span>
      </header>
      <div className="hlq-cols">
        {renderColumn("AI",          "sage", ai)}
        {renderColumn("Engineering", "blue", eng)}
      </div>
      {untyped > 0 && (
        <p className="hlq-hint">
          <Icon name="info" size={13}/>
          <span>
            {untyped} upcoming {untyped === 1 ? "lead" : "leads"} {untyped === 1 ? "has" : "have"} no type set. Pick one to show {untyped === 1 ? "it" : "them"} here.
          </span>
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
  tab, rows, updateRow = _noopUpdate, onOpenDrawer, onForward, onAlert, flashId, filters,
  yearOptions, yearValue, onYearChange,
  deletedMode = false, onSoftDelete, onRestore,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "Type",        w: "130px", sortKey: "type" },
    { label: "Title",       w: "minmax(260px, 2.2fr)", sortKey: "title" },
    { label: "Client / Firm", w: "minmax(180px, 1.5fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Date & Time", w: "170px", sortKey: "dateTime" },
    { label: "Anticipated Amount", w: "150px", sortKey: "anticipatedAmount",
      sortValue: r => r.anticipatedAmount || 0 },
    { label: "Attendees",   w: "minmax(160px, 1.2fr)" },
    { label: "Notes",       w: "minmax(180px, 1.4fr)", sortKey: "notes", defaultHidden: true },
    { label: "Rating",      w: "150px", sortKey: "stars",
      sortValue: r => starsRank(r.stars, HOT_LEAD_STAR_MAX) },
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

  // Group-by-stars (3★ → 1★ → Unrated). Inside each bucket the user's
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
      emptyHint="Log early-stage opportunities here: partner intros, conference chats, warm pre-RFPs."
      emptyIcon="trend"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        if (r._starsHeader != null) {
          const isUnrated = r._starsHeader === "Unrated";
          const unit = r._count === 1 ? "lead" : "leads";
          return (
            <div key={r.id} className="trow stars-header bxt-grouphead"
                 data-stars={isUnrated ? "0" : String(r._starsHeader)}
                 style={{ gridTemplateColumns: gridCols }}>
              <div className="td bxt-grouphead-cell">
                {isUnrated ? (
                  <span className="bxt-grouphead-label">Unrated</span>
                ) : (
                  <span className="bxt-grouphead-label">
                    <StarRating value={r._starsHeader} max={HOT_LEAD_STAR_MAX} size="sm"
                      title={starLabel(r._starsHeader, HOT_LEAD_STAR_MAX)}/>
                  </span>
                )}
                <span className="bxt-grouphead-count"><span className="num">{r._count}</span> {unit}</span>
              </div>
            </div>
          );
        }
        const leadWhen = r.dateTime ? new Date(r.dateTime) : null;
        const leadUpcoming = !!(leadWhen && !Number.isNaN(+leadWhen) && +leadWhen >= Date.now());
        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${r.title || "lead"}`}/>
            </div>
          ),
          "Type": (
            <div className="td">
              <EditableCell value={r.type} type="select" options={hotLeadTypeOptions}
                onChange={v => updateRow(r.id, { type: v })}
                render={v => v
                  ? <span className={`chip ${hotLeadTypeColor(v)}`}><span className="chip-dot"/>{v}</span>
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Title": (
            <div className="td bxt-td-identity">
              <EditableCell value={r.title}
                onChange={v => updateRow(r.id, { title: v })}/>
            </div>
          ),
          "Client / Firm": (
            <div className="td subtle" style={{ overflow: "hidden" }}>
              <EditableCell value={r.clientId} type="combobox" options={clientOrFirmOpts}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Rating": (
            <div className="td hotlead-rating">
              <StarRating value={r.stars}
                max={HOT_LEAD_STAR_MAX}
                onChange={v => updateRow(r.id, { stars: v })}/>
            </div>
          ),
          "Date & Time": (
            <div className="td mono subtle bxt-td-when" data-upcoming={leadUpcoming ? "true" : undefined}>
              <EditableCell value={r.dateTime} type="datetime-local"
                onChange={v => updateRow(r.id, { dateTime: v })}
                format={v => fmtDateTime(v)}/>
            </div>
          ),
          "Anticipated Amount": (
            <div className="td mono num">
              <EditableCell value={r.anticipatedAmount} type="number" align="right"
                onChange={v => updateRow(r.id, { anticipatedAmount: v })}
                format={v => v != null && v !== "" ? fmtMoney(v, false) : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Attendees": <div className="td"><UserStack ids={r.attendees}/></div>,
          "Notes": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions" onClick={e => e.stopPropagation()}>
                {deletedMode ? (
                  <button type="button" className="row-btn bxt-rowbtn forward"
                          title="Restore this lead" aria-label="Restore this lead"
                          onClick={() => onRestore?.(r)}>
                    <Icon name="undo" size={14}/>
                  </button>
                ) : (
                  <>
                    {onForward && (
                      <button type="button" className="row-btn bxt-rowbtn forward"
                              title="Move to Proposals" aria-label="Move to Proposals"
                              onClick={() => onForward(r)}>
                        <Icon name="forward" size={14}/>
                      </button>
                    )}
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="row-btn bxt-rowbtn"
                                title="More actions" aria-label="More actions for this lead">
                          <Icon name="more" size={14}/>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bxt-menu">
                        <DropdownMenuItem onSelect={() => onAlert && onAlert(r)}>
                          <Icon name="bell" size={13}/>
                          <span className="bxt-menu-text">Set alert</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator/>
                        <DropdownMenuItem destructive onSelect={() => onSoftDelete?.(r)}>
                          <Icon name="trash" size={13}/>
                          <span className="bxt-menu-text">Delete lead</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
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
  deletedMode = false, onSoftDelete, onRestore,
}) => {
  const cols = [
    { label: "__select", w: "42px", locked: true },
    { label: "RFQ/RFP #", w: "minmax(120px, 1fr)", sortKey: "rfqNumber" },
    { label: "Client / Parish", w: "minmax(180px, 1.4fr)", sortKey: "clientName",
      sortValue: r => companyById(r.clientId)?.name || "" },
    { label: "Service", w: "minmax(220px, 1.6fr)", sortKey: "serviceDescription" },
    { label: "Due Date", w: "170px", sortKey: "dueAt" },
    { label: "Anticipated Amount", w: "150px", sortKey: "anticipatedAmount",
      sortValue: r => r.anticipatedAmount || 0 },
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

  // Approval state → chip class, mapped onto the product-wide semantic
  // palette: sage = approved, clay/rose = rejected, ochre/accent = awaiting a
  // decision. Each state also carries its own glyph below, so the state never
  // relies on colour alone.
  const approvalChipClass = (status) => ({
    approved: "sage",
    rejected: "rose",
    pending:  "accent",
  })[status] || "accent";
  const approvalLabel = (status) => ({
    approved: "Approved",
    rejected: "Rejected",
    pending:  "Pending",
  })[status] || "Pending";
  const approvalIcon = (status) => ({
    approved: "checkCircle",
    rejected: "ban",
    pending:  "hourglass",
  })[status] || "hourglass";

  // Due-date urgency, purely presentational: it colours and annotates the
  // Due Date cell and never touches the stored value or the sort comparator.
  // `flag` is the short badge that has to survive a 170px column; `text` is
  // the full phrasing, carried on the cell's title and for screen readers,
  // so the state is never conveyed by colour alone.
  const dueUrgency = (iso) => {
    if (!iso) return null;
    const due = new Date(iso);
    if (Number.isNaN(+due)) return null;
    const days = Math.floor((+due - Date.now()) / 86400000);
    if (days < 0)  return { tone: "overdue", icon: "warn",  flag: "Late", text: "Past due" };
    if (days <= 2) return {
      tone: "urgent", icon: "clock",
      flag: days === 0 ? "Today" : `${days}d`,
      text: days === 0 ? "Due today" : `Due in ${days} ${days === 1 ? "day" : "days"}`,
    };
    if (days <= 7) return { tone: "soon", icon: "clock", flag: `${days}d`, text: `Due in ${days} days` };
    return null;
  };

  return (
    <TableView
      tab={tab}
      filters={filters}
      columns={cols} rows={rows}
      yearOptions={yearOptions} yearValue={yearValue} onYearChange={onYearChange}
      emptyTitle="No open bids yet"
      emptyHint="Add an RFQ/RFP to track it through review. Admins approve a bid before it can be moved to Proposals."
      emptyIcon="briefcase"
      renderRow={(r, _i, gridCols, visibleColumns) => {
        const approver = r.approvedBy ? userById(r.approvedBy) : null;
        const stampedAt = r.approvedAt ? fmtDateTime(r.approvedAt) : "";
        const isApproved  = r.approvalStatus === "approved";
        const isRejected  = r.approvalStatus === "rejected";
        const urgency = dueUrgency(r.dueAt);
        const bidName = r.rfqNumber || "bid";

        const cells = {
          "__select": (
            <div className="td row-check" onClick={e => e.stopPropagation()}>
              <input type="checkbox" aria-label={`Select ${bidName}`}/>
            </div>
          ),
          "RFQ/RFP #": (
            <div className="td mono bxt-td-identity">
              <EditableCell value={r.rfqNumber}
                onChange={v => updateRow(r.id, { rfqNumber: v })}/>
            </div>
          ),
          "Client / Parish": (
            <div className="td subtle">
              <EditableCell value={r.clientId} type="combobox" options={clientOptions}
                onChange={v => updateRow(r.id, { clientId: v })}
                render={v => companyById(v)?.name || <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Service": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.serviceDescription} type="select" options={serviceOptions}
                onChange={v => updateRow(r.id, { serviceDescription: v || null })}
                render={v => v
                  ? <span className="chip muted bxt-chip-trunc" title={v}>{v}</span>
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Due Date": (
            <div className="td mono bxt-td-due" data-urgency={urgency?.tone}>
              <EditableCell value={r.dueAt ? String(r.dueAt).slice(0, 16) : ""} type="datetime-local"
                onChange={v => updateRow(r.id, { dueAt: v ? new Date(v).toISOString() : null })}
                format={v => v
                  ? (
                    <span className="bxt-due" title={urgency ? `${fmtDateTime(v)} · ${urgency.text}` : fmtDateTime(v)}>
                      {urgency && <Icon name={urgency.icon} size={12} className="bxt-due-icon"/>}
                      <span className="bxt-due-date num">{fmtDateTime(v)}</span>
                      {urgency && (
                        <span className="bxt-due-flag">
                          {urgency.flag}
                          <span className="sr-only"> {urgency.text}</span>
                        </span>
                      )}
                    </span>
                  )
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Anticipated Amount": (
            <div className="td mono num">
              <EditableCell value={r.anticipatedAmount} type="number" align="right"
                onChange={v => updateRow(r.id, { anticipatedAmount: v })}
                format={v => v != null && v !== "" ? fmtMoney(v, false) : <span className="empty-cell">–</span>}/>
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
                <div className="bid-pdf-cell bxt-pdf">
                  <button type="button" className="bxt-filechip"
                          title={r.pdfName ? `Open ${r.pdfName}` : "Open PDF"}
                          aria-label={r.pdfName ? `Open ${r.pdfName}` : "Open the attached PDF"}
                          onClick={() => onOpenPdf?.(r)}>
                    <Icon name="file" size={12}/>
                    <span className="bid-pdf-name">{r.pdfName || "PDF"}</span>
                    <Icon name="external" size={11} className="bxt-filechip-go"/>
                  </button>
                  <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-danger"
                          title="Remove PDF" aria-label="Remove the attached PDF"
                          onClick={() => onRemovePdf?.(r.id)}>
                    <Icon name="x" size={12}/>
                  </button>
                </div>
              ) : (
                <button type="button" className="bxt-filechip is-empty"
                        onClick={() => triggerUpload(r.id)}
                        aria-label="Attach an RFQ or RFP PDF"
                        title="Attach an RFQ/RFP PDF (up to about 50 MB)">
                  <Icon name="attachment" size={12}/>
                  <span>Attach</span>
                </button>
              )}
            </div>
          ),
          "Web Link": (
            <div className="td subtle bxt-td-note">
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
                  : <span className="empty-cell">–</span>}/>
            </div>
          ),
          "Approval": (
            <div className="td" onClick={e => e.stopPropagation()}>
              <div className="bid-approval bxt-approval">
                <span className={`chip ${approvalChipClass(r.approvalStatus)} bxt-approval-chip`}
                      title={approver ? `${approvalLabel(r.approvalStatus)} by ${approver.name}${stampedAt ? " · " + stampedAt : ""}` : approvalLabel(r.approvalStatus)}>
                  <Icon name={approvalIcon(r.approvalStatus)} size={12}/>
                  {approvalLabel(r.approvalStatus)}
                </span>
                {(isApproved || isRejected) && approver && (
                  <span className="bid-approval-meta" title={stampedAt}>
                    {approver.name} · {fmtDate(r.approvedAt)}
                  </span>
                )}
                {isAdmin && (
                  <div className="bid-approval-actions bxt-approval-actions">
                    {!isApproved && (
                      <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-approve"
                              title="Approve" aria-label={`Approve ${bidName}`}
                              onClick={() => onApprove?.(r)}>
                        <Icon name="thumbsUp" size={13}/>
                      </button>
                    )}
                    {!isRejected && (
                      <button type="button" className="row-btn bxt-rowbtn bxt-rowbtn-danger"
                              title="Reject" aria-label={`Reject ${bidName}`}
                              onClick={() => onReject?.(r)}>
                        <Icon name="thumbsDown" size={13}/>
                      </button>
                    )}
                    {(isApproved || isRejected) && (
                      <button type="button" className="row-btn bxt-rowbtn"
                              title="Clear approval" aria-label={`Clear the approval on ${bidName}`}
                              onClick={() => onClearApproval?.(r)}>
                        <Icon name="undo" size={12}/>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ),
          "Approved By": (
            <div className="td subtle bxt-td-note">
              {approver
                ? <span className="bid-approver">{approver.name}{stampedAt ? ` · ${fmtDate(r.approvedAt)}` : ""}</span>
                : <span className="empty-cell">–</span>}
            </div>
          ),
          "Notes": (
            <div className="td subtle bxt-td-note">
              <EditableCell value={r.notes} type="textarea"
                onChange={v => updateRow(r.id, { notes: v })}
                format={v => truncCell(v)}/>
            </div>
          ),
          "__actions": (
            <div className="td bxt-td-actions">
              <div className="row-actions bxt-rowactions" onClick={e => e.stopPropagation()}>
                {deletedMode ? (
                  <button type="button" className="row-btn bxt-rowbtn forward"
                          title="Restore this bid" aria-label="Restore this bid"
                          onClick={() => onRestore?.(r)}>
                    <Icon name="undo" size={14}/>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="row-btn bxt-rowbtn forward"
                      title={isApproved
                        ? "Move to Proposals"
                        : "Approve this bid before moving forward"}
                      aria-label={isApproved
                        ? `Move ${bidName} to Proposals`
                        : `Move to Proposals, unavailable until ${bidName} is approved`}
                      disabled={!isApproved}
                      onClick={() => isApproved && onForward?.(r)}>
                      <Icon name="forward" size={14}/>
                    </button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="row-btn bxt-rowbtn"
                                title="More actions" aria-label={`More actions for ${bidName}`}>
                          <Icon name="more" size={14}/>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bxt-menu">
                        <DropdownMenuItem destructive onSelect={() => onSoftDelete?.(r)}>
                          <Icon name="trash" size={13}/>
                          <span className="bxt-menu-text">Delete bid</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
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
// One roster for both kinds. Clients come first, companies second, each
// section introduced by a group bar; columns are a UNION, so a cell that
// does not apply to a row's kind renders the en-dash placeholder and the
// visual rhythm holds.
//
// The grid is hand-built rather than routed through TableView because the
// roster carries two extra structures TableView has no vocabulary for: an
// inline expand row per entity, and a merge selection that is locked to one
// kind at a time. It therefore borrows TableView's *chrome* wholesale (the
// `.bxt-toolbar` search + filter strip, the `.bxt-thead` sortable header,
// `.trow` / `.td` rows) and declares the ARIA table roles by hand.
//
// Each entity row is expandable: a disclosure button in the leading column,
// mirrored by the Projects count button, toggles an inline row beneath the
// parent holding the same Linked Projects list the drawer shows. Multiple
// rows can be open at once. The drawer is still reachable via double-click
// and via the row's Open details action (existing behaviour preserved).

// Org-type is the client sub-attribute axis; the swatch reads from the
// product-wide `--org-*` ramp already used by the Proposals / Awarded group
// bars, and the word is always printed next to it.
const DIR_ORG_KEY = (v) => String(v || "").trim().toLowerCase() || "unset";

// Kind axis. Icon + word carry it; the tone is a quiet informational one so
// it can never be confused with the sage / brand / clay status ramp.
const DIR_KIND_META = {
  Client:  { label: "Client",  icon: "users",     tone: "info" },
  Company: { label: "Company", icon: "building",  tone: "outline" },
};
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

  const [search, setSearch] = useState("");
  const searchableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter(r => {
      const projectCount = countRefsFor(r.id, projectsByType);
      const related = relatedDirectoryPartiesFor(r, projectsByType, r.type === "Client" ? "companies" : "clients")
        .map(p => p.name)
        .join(" ");
      const haystack = [
        r.baseName, r.name, r.type === "Client" ? "Client" : r.type, related,
        String(projectCount),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, search, projectsByType]);

  // Linked-project totals, resolved once per render instead of once per
  // cell. Same figure countRefsFor() returns, just cached.
  const projectCounts = useMemo(() => {
    const m = new Map();
    for (const r of (rows || [])) m.set(r.id, countRefsFor(r.id, projectsByType));
    return m;
  }, [rows, projectsByType]);
  const countFor = (r) => projectCounts.get(r.id) ?? 0;

  // Column definitions. `w` feeds the shared grid template, `get` is the
  // sort key extractor. Nothing here filters or hides a row.
  const dirColumns = useMemo(() => ([
    { label: "__expand", w: "40px", locked: true },
    { label: "__select", w: "42px", locked: true },
    { label: "Name",           w: "minmax(220px, 2fr)",   sortKey: "name" },
    // Kind is the outer grouping axis, so it is deliberately not sortable:
    // the roster always reads clients first, then companies.
    { label: "Kind",           w: "118px" },
    { label: "Role / Org Type", w: "168px",               sortKey: "class",
      get: r => (r.type === "Client" ? (r.orgType || "") : (r.type || "")) },
    { label: "Related",        w: "minmax(180px, 1.3fr)" },
    { label: "Projects",       w: "124px",                sortKey: "projects",
      get: r => countFor(r) },
    { label: "Contact",        w: "minmax(150px, 1fr)",   sortKey: "contact",
      get: r => r.contact || "" },
    { label: "Email",          w: "minmax(180px, 1.2fr)", sortKey: "email",
      get: r => r.email || "" },
    { label: "Phone",          w: "140px",                sortKey: "phone",
      get: r => r.phone || "" },
    { label: "Location",       w: "minmax(170px, 1.1fr)", sortKey: "address",
      get: r => r.address || "" },
    { label: "Notes",          w: "minmax(190px, 1.3fr)", sortKey: "notes",
      get: r => r.notes || "" },
    { label: "__actions",      w: "92px", locked: true },
    // countFor is derived from projectCounts, which is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]), [projectCounts]);

  const dirGridCols = useMemo(() => dirColumns.map(c => c.w).join(" "), [dirColumns]);

  // Interactive sort. The default is name-ascending, which is the order the
  // roster has always shipped with; cycling a column past "descending"
  // returns to that default rather than to an arbitrary insertion order.
  const [sort, setSort] = useState({ key: "name", dir: "asc" });
  const onSortToggle = (key) => setSort(s => {
    const next = nextSortDir(s, s.key, key);
    return (next.key && next.dir) ? next : { key: "name", dir: "asc" };
  });

  const groupedRows = useMemo(() => {
    const byName = (a, b) =>
      String(a.baseName || a.name || "").localeCompare(String(b.baseName || b.name || ""), undefined, { sensitivity: "base" });
    const col = dirColumns.find(c => c.sortKey === sort.key);
    const compare = (!col || !col.get)
      ? byName
      : (a, b) => {
        const d = cmp(col.get(a), col.get(b));
        if (d !== 0) return sort.dir === "desc" ? -d : d;
        return byName(a, b);
      };
    const dirAware = (sort.key === "name" && sort.dir === "desc")
      ? (a, b) => -byName(a, b)
      : compare;
    // Kind stays the outer axis whatever the user sorts by, so the roster
    // never loses its clients-then-companies reading.
    return {
      clients: searchableRows.filter(r => r.type === "Client").slice().sort(dirAware),
      companies: searchableRows.filter(r => r.type !== "Client").slice().sort(dirAware),
    };
  }, [searchableRows, sort, dirColumns]);

  const snapshotColumns = useMemo(() => ([
    { label: "Name", sortKey: "name" },
    { label: "Kind", sortKey: "type" },
    { label: "Contact", sortKey: "contact" },
    { label: "Email", sortKey: "email" },
    { label: "Phone", sortKey: "phone" },
    { label: "Location", sortKey: "address" },
    { label: "Notes", sortKey: "notes" },
    { label: "Projects", sortKey: "projectCount" },
  ]), []);

  useEffect(() => {
    const processedRows = [...groupedRows.clients, ...groupedRows.companies].map(r => ({
      ...r,
      projectCount: countRefsFor(r.id, projectsByType),
    }));
    setCurrentTableSnapshot({
      tab,
      columns: snapshotColumns,
      visibleColumns: snapshotColumns,
      hiddenCols: new Set(),
      columnOrder: snapshotColumns.map(c => c.label),
      columnWidths: {},
      sort: null,
      search,
      year: null,
      processedRows,
    });
  }, [tab, snapshotColumns, groupedRows, projectsByType, search]);

  const { companyTypeOptions } = buildOptions();

  const nameOf = (r) => r.baseName || r.name || "directory entry";
  const hasSearch = !!search.trim();

  // ---- Related parties (firms for a client, clients for a firm) --------
  const renderRelated = (row, isClient) => {
    const related = relatedDirectoryPartiesFor(row, projectsByType, isClient ? "companies" : "clients");
    if (related.length === 0) {
      return (
        <span className="empty-cell">
          No related {isClient ? "firms" : "clients"} yet
        </span>
      );
    }
    return (
      <span className="bxt-dir-related">
        {related.slice(0, 2).map(p => (
          <Badge key={p.id} tone="neutral" className="min-w-0 shrink" title={`${p.name} · ${p.count} shared ${p.count === 1 ? "project" : "projects"}`}>
            <span className="min-w-0 truncate">{p.name}</span>
            <span className="num shrink-0 font-normal opacity-70">{p.count}</span>
          </Badge>
        ))}
        {related.length > 2 && (
          <Badge
            tone="outline"
            className="shrink-0"
            title={related.slice(2).map(p => `${p.name} (${p.count})`).join(", ")}
          >
            +{related.length - 2}
            <span className="sr-only"> more related {isClient ? "firms" : "clients"}</span>
          </Badge>
        )}
      </span>
    );
  };

  // ---- One entity row (plus its expand row when open) ------------------
  const renderRow = (r) => {
    const isClient        = r.type === "Client";
    const kindKey         = isClient ? "Client" : "Company";
    const kindMeta        = DIR_KIND_META[kindKey];
    const isExpanded      = expandedIds.has(r.id);
    const isSelected      = selectedIds.has(r.id);
    const otherKindLocked = selectedKind && kindOf(r) !== selectedKind;
    const projectCount    = countFor(r);
    const label           = nameOf(r);
    const panelId         = `bxt-dir-linked-${r.id}`;
    const linked          = isExpanded ? linkedProjectsFor(r, projectsByType, invoice) : null;
    const orgKey          = DIR_ORG_KEY(r.orgType);

    const expandLabel = isExpanded
      ? `Hide the ${projectCount} linked ${projectCount === 1 ? "project" : "projects"} for ${label}`
      : `Show the ${projectCount} linked ${projectCount === 1 ? "project" : "projects"} for ${label}`;

    const row = (
      <div
        key={r.id}
        className={
          "trow bxt-dirrow" +
          (flashId === r.id ? " flash" : "") +
          (isExpanded ? " is-expanded" : "") +
          (isSelected ? " selected" : "")
        }
        role="row"
        data-kind={isClient ? "client" : "company"}
        style={{ gridTemplateColumns: dirGridCols, cursor: "default" }}
        onDoubleClick={() => onOpenDrawer(r)}
      >
        {/* Disclosure — the primary way into an entity's linked projects,
            a real button so it is reachable and operable from the keyboard. */}
        <div className="td bxt-dir-disclose" role="cell" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className="bxt-dir-chevron"
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? panelId : undefined}
            aria-label={expandLabel}
            title={isExpanded ? "Hide linked projects" : "Show linked projects"}
            onClick={() => toggleExpand(r.id)}
          >
            <Icon name={isExpanded ? "chevronDown" : "chevronRight"} size={14}/>
          </button>
        </div>

        <div className="td row-check" role="cell" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            disabled={!!otherKindLocked}
            aria-label={`Select ${label} for merge`}
            title={otherKindLocked
              ? `Finish or clear the ${String(selectedKind).toLowerCase()} selection first. Clients and companies cannot be merged together.`
              : "Select to merge"}
            onChange={() => toggleSelect(r)}
          />
        </div>

        <div className="td bxt-td-identity bxt-td-stack" role="cell">
          <span className="bxt-td-fullwidth">
            {isClient ? (
              <EditableCell value={r.baseName || r.name}
                onChange={v => {
                  const district = r.district || "";
                  updateRow(r.id, {
                    baseName: v,
                    // Fourth and last builder of the merged client display
                    // name. adaptClient (data.js), adaptInsertedRow and
                    // updateClients (App.jsx) build the same string, so the
                    // separator has to match all three or a renamed row would
                    // render differently from the same row after a reload.
                    name: district ? v + " – " + district : v,
                  });
                }}/>
            ) : (
              <EditableCell value={r.name}
                onChange={v => updateRow(r.id, { name: v })}/>
            )}
          </span>
          {isClient && r.district && (
            <span className="bxt-td-sub" title={r.district}>{r.district}</span>
          )}
        </div>

        <div className="td" role="cell">
          <Badge tone={kindMeta.tone} className="max-w-full">
            <Icon name={kindMeta.icon} size={12} aria-hidden="true"/>
            <span className="min-w-0 truncate">{kindMeta.label}</span>
          </Badge>
        </div>

        {/* Sub-attribute axis: org type for a client (read-only, set on the
            record), commercial role for a firm (inline editable, as before). */}
        <div className="td" role="cell">
          {isClient ? (
            r.orgType ? (
              <Badge tone="outline" className="max-w-full" title={`Org type: ${r.orgType}`}>
                <span className="bxt-dir-orgdot" data-org={orgKey} aria-hidden="true"/>
                <span className="min-w-0 truncate">{r.orgType}</span>
              </Badge>
            ) : (
              <span className="empty-cell">No org type</span>
            )
          ) : (
            <EditableCell value={r.type} type="select" options={companyTypeOptions}
              onChange={v => updateRow(r.id, { type: v })}
              render={v => v
                ? <RoleChip role={v}/>
                : <span className="empty-cell">No role</span>}/>
          )}
        </div>

        <div className="td bxt-td-note" role="cell">
          {renderRelated(r, isClient)}
        </div>

        {/* Second, wordier route to the same disclosure, so the count and
            the affordance are one control rather than two ideas. */}
        <div className="td" role="cell" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className={"bxt-dir-projects" + (isExpanded ? " is-open" : "")}
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? panelId : undefined}
            aria-label={expandLabel}
            onClick={() => toggleExpand(r.id)}
          >
            <Icon name="briefcase" size={12} aria-hidden="true"/>
            <span className="num">{projectCount}</span>
            <span className="bxt-dir-projects-word">
              {projectCount === 1 ? "project" : "projects"}
            </span>
          </button>
        </div>

        <div className="td subtle" role="cell">
          {r.contact ? truncCell(r.contact, 40) : <span className="empty-cell">–</span>}
        </div>
        <div className="td subtle bxt-td-note" role="cell">
          {r.email ? truncCell(r.email, 48) : <span className="empty-cell">–</span>}
        </div>
        <div className="td subtle num" role="cell">
          {r.phone ? truncCell(r.phone, 24) : <span className="empty-cell">–</span>}
        </div>
        <div className="td subtle bxt-td-note" role="cell">
          {r.address ? truncCell(r.address, 60) : <span className="empty-cell">–</span>}
        </div>
        <div className="td subtle bxt-td-note" role="cell">
          {r.notes ? truncCell(r.notes, 80) : <span className="empty-cell">–</span>}
        </div>

        <div className="td bxt-td-actions" role="cell">
          <div className="bxt-rowactions bxt-diractions" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="row-btn bxt-rowbtn"
              title="Open details"
              aria-label={`Open details for ${label}`}
              onClick={() => onOpenDrawer(r)}
            >
              <Icon name="maximize" size={14}/>
            </button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="row-btn bxt-rowbtn"
                  title="More actions"
                  aria-label={`More actions for ${label}`}
                >
                  <Icon name="more" size={14}/>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bxt-menu">
                <DropdownMenuItem onSelect={() => onOpenDrawer(r)}>
                  <Icon name="maximize" size={13}/>
                  <span className="bxt-menu-text">Open details</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => toggleExpand(r.id)}>
                  <Icon name="briefcase" size={13}/>
                  <span className="bxt-menu-text">
                    {isExpanded ? "Hide linked projects" : "Show linked projects"}
                  </span>
                  <span className="bxt-menu-hint num">{projectCount}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator/>
                <DropdownMenuItem
                  disabled={!!otherKindLocked}
                  onSelect={() => { if (!otherKindLocked) toggleSelect(r); }}
                >
                  <Icon name="merge" size={13}/>
                  <span className="bxt-menu-text">
                    {isSelected ? "Remove from merge selection" : "Select for merge"}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );

    if (!isExpanded) return row;

    return (
      <React.Fragment key={r.id}>
        {row}
        <div
          className="trow bxt-dirx"
          role="row"
          data-kind={isClient ? "client" : "company"}
          style={{ gridTemplateColumns: dirGridCols }}
        >
          <div className="td bxt-dirx-cell" role="cell" aria-colspan={dirColumns.length}>
            {/* Pinned to the viewport's left edge: the row spans a grid far
                wider than the screen, so an unpinned panel would scroll out
                of sight the moment the roster is scrolled sideways. */}
            <div
              className="bxt-dirx-inner"
              id={panelId}
              role="region"
              aria-label={`Linked projects for ${label}`}
            >
              <LinkedProjectsSection
                projects={linked}
                onOpenProject={onOpenProject}
              />
            </div>
          </div>
        </div>
      </React.Fragment>
    );
  };

  // ---- Section bar introducing each kind -------------------------------
  const renderGroupHead = (kind, unit, items) => (
    <div
      key={`head-${kind}`}
      className="trow bxt-grouphead bxt-dirhead"
      role="row"
      data-kind={kind}
      style={{ gridTemplateColumns: dirGridCols }}
    >
      <div className="td bxt-grouphead-cell bxt-dirhead-cell" role="cell" aria-colspan={dirColumns.length}>
        <span className="bxt-dirhead-inner">
          <span className="bxt-dirhead-dot" aria-hidden="true"/>
          <span className="bxt-orghead-kicker">Kind</span>
          <span className="bxt-grouphead-label bxt-truncate">
            {kind === "client" ? "Clients" : "Companies"}
          </span>
          <span className="bxt-grouphead-count">
            <span className="num">{items.length}</span> {items.length === 1 ? unit : `${unit}s`}
          </span>
        </span>
      </div>
    </div>
  );

  const showNoMatches = hasSearch && searchableRows.length === 0 && (rows || []).length > 0;
  const totalRows = (rows || []).length;
  const shownRows = groupedRows.clients.length + groupedRows.companies.length;

  return (
    <div className="tablewrap bxt-dir">
      {/* Same chrome vocabulary as every other Beacon table. */}
      <div className="bxt-toolbar">
        <InputGroup
          className="bxt-search"
          inputClassName={hasSearch
            ? "border-[var(--accent)] bg-[var(--accent-softer)] text-[var(--accent-ink)]"
            : undefined}
          type="text"
          placeholder="Search directory"
          aria-label="Search the directory"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          leading={<Icon name="search" size={14}/>}
          trailing={hasSearch ? (
            <button
              type="button"
              className="bxt-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              <Icon name="x" size={12}/>
            </button>
          ) : null}
        />

        {filters?.length > 0 && (
          <div className="bxt-filterstrip" role="group" aria-label="Filters">
            {filters.map((f, i) => (
              <button
                key={i}
                type="button"
                className={"bxt-chip" + (f.active ? " is-on" : "")}
                aria-pressed={!!f.active}
                onClick={f.onClick}
              >
                {f.icon && <Icon name={f.icon} size={13}/>}
                <span className="bxt-chip-label">{f.label}</span>
                {f.count != null && <span className="bxt-chip-count num">{f.count}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="bxt-toolbar-actions">
          <span className="bxt-dir-tally">
            <span className="num">{shownRows}</span>
            <span className="bxt-dir-tally-sep">/</span>
            <span className="num">{totalRows}</span>
            <span className="sr-only"> entries shown</span>
          </span>
        </div>
      </div>

      {/* Merge selection. Its own bar rather than a control squeezed into
          the toolbar: it appears only while a selection exists, states what
          is selected, and says why the other kind is locked out. */}
      {selectedRows.length > 0 && (
        <div className="bxt-selbar" role="status" aria-live="polite">
          <span className="bxt-selbar-count">
            <Icon name="checkAll" size={14} aria-hidden="true"/>
            <strong className="num">{selectedRows.length}</strong>
            {" "}
            {selectedKind === "Client"
              ? (selectedRows.length === 1 ? "client" : "clients")
              : (selectedRows.length === 1 ? "company" : "companies")}
            {" "}selected
          </span>
          <span className="bxt-selbar-hint">
            {selectedRows.length < 2
              ? "Pick one more record of the same kind to merge."
              : "Merging keeps a single record and repoints every linked project onto it."}
          </span>
          <span className="bxt-selbar-actions">
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              <Icon name="x" size={13}/>Clear
            </Button>
            <Button variant="primary" size="sm" onClick={startMerge} disabled={selectedRows.length < 2}>
              <Icon name="merge" size={13}/>
              Merge {selectedKind === "Client" ? "clients" : "companies"}
            </Button>
          </span>
        </div>
      )}

      {hasSearch && (
        <div className="bxt-searchsummary" role="status" aria-live="polite">
          {showNoMatches
            ? <>No entries match <span className="bxt-searchterm">"{search}"</span>.</>
            : <><strong className="num">{searchableRows.length}</strong> of <strong className="num">{totalRows}</strong> match <span className="bxt-searchterm">"{search}"</span></>
          }
        </div>
      )}

      <div className="table-scroll">
        {/* The roster is a CSS grid rather than a <table>: rows expand in
            place and a group bar spans every track. The ARIA roles put the
            table structure back for assistive technology. */}
        <div className="table-scroll-body" role="table" aria-label={`${tableAccessibleName(tab)} table`}>
          <div className="thead bxt-thead" role="row" style={{ gridTemplateColumns: dirGridCols }}>
            {dirColumns.map((c) => {
              const internal   = isInternalLabel(c.label);
              const accessible = internal ? internalColumnName(c.label) : c.label;
              const sortable   = !!c.sortKey;
              const active     = sortable && sort.key === c.sortKey;
              return (
                <div
                  key={c.label}
                  className={"th bxt-th" + (active ? " sorted" : "")}
                  role="columnheader"
                  aria-sort={sortable ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                  data-sorted={active ? (sort.dir === "asc" ? "asc" : "desc") : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="bxt-th-btn"
                      onClick={() => onSortToggle(c.sortKey)}
                      title={`Sort by ${accessible}`}
                    >
                      <span className="bxt-th-label">{c.label}</span>
                      <span className="bxt-th-sort" aria-hidden="true">
                        <Icon
                          name={active ? (sort.dir === "asc" ? "chevronUp" : "chevronDown") : "chevronsUpDown"}
                          size={12}
                        />
                      </span>
                    </button>
                  ) : (
                    <span className="bxt-th-label">
                      {internal ? <span className="sr-only">{accessible}</span> : c.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {groupedRows.clients.length > 0 && renderGroupHead("client", "client", groupedRows.clients)}
          {groupedRows.clients.map(r => renderRow(r))}
          {groupedRows.companies.length > 0 && renderGroupHead("company", "company", groupedRows.companies)}
          {groupedRows.companies.map(r => renderRow(r))}
        </div>

        {/* Outside the role="table" subtree, so no cell-less row is ever
            announced, and so the message centres on the viewport rather
            than on the (much wider) column track sum. */}
        {totalRows === 0 ? (
          <EmptyState
            title="No directory entries yet"
            hint="Add a client or a company and it joins this roster, with every project it is linked to."
            iconName="users"
          />
        ) : showNoMatches ? (
          <EmptyState
            title="No matches"
            hint={`Nothing matches "${search}". Clear the search, or pick a different filter, to see the whole roster.`}
            iconName="search"
          />
        ) : shownRows === 0 ? (
          <EmptyState
            title="Nothing in this filter"
            hint="No client or company is in this group right now. Switch back to All to see the whole roster."
            iconName="filter"
          />
        ) : null}
      </div>
    </div>
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
  return all.filter(p =>
    p.clientId === id ||
    p.primeId === id ||
    (p.subs || []).some(s => s.cId === id)
  ).length;
}

function relatedDirectoryPartiesFor(row, projectsByType, targetKind) {
  const all = [
    ...(projectsByType?.potential || []),
    ...(projectsByType?.awaiting  || []),
    ...(projectsByType?.awarded   || []),
    ...(projectsByType?.closed    || []),
  ];
  const clients = getClientsOnly();
  const companies = getCompaniesOnly();
  const isCompany = row?.type !== "Client";
  const counts = new Map();
  const add = (entity) => {
    if (!entity || entity.id === row.id) return;
    const name = entity.baseName || entity.name || "Unnamed";
    const key = name.trim().toLowerCase();
    counts.set(key, {
      id: counts.get(key)?.id || entity.id,
      name,
      count: (counts.get(key)?.count || 0) + 1,
    });
  };

  for (const p of all) {
    const isPrimeMatch = p.clientId === row.id || p.primeId === row.id;
    const isSubMatch = (p.subs || []).some(s => s.cId === row.id);
    const isClientMatch = p.clientId === row.id;

    if (targetKind === "clients" && isCompany && (isPrimeMatch || isSubMatch)) {
      add(clients.find(c => c.id === p.clientId));
      continue;
    }

    if (targetKind === "companies" && !isCompany && isClientMatch) {
      add(companies.find(c => c.id === p.primeId));
      for (const s of (p.subs || [])) add(companies.find(c => c.id === s.cId));
    }
  }

  return [...counts.values()].sort((a, b) =>
    b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

// ======================================================================
// ProjectsTable — the tree-structured work-breakdown view (beacon_v2.project_items).
// Self-contained (does NOT use TableView, which is flat): builds the
// project → phase → subphase tree from `parentId`, renders an indented
// outline grid with expand/collapse, inline edits, and per-row actions
// (add child / open / delete). Search + the Main/Standard/status filter run
// inside here with ancestor-preservation so a matching node's parents stay
// visible. Publishes the flattened visible rows to the table snapshot so the
// page-head "Export PDF" button works.
// ======================================================================
const PTREE_COLS =
  "minmax(240px,2fr) 132px 116px minmax(150px,1.1fr) minmax(130px,1fr) 150px 124px 124px 152px 96px 130px 116px";
// Header descriptors rather than bare strings: the trailing actions column
// has no visible label but still needs an accessible name, and two columns
// are right-aligned figures.
const PTREE_HEADS = [
  { label: "Project" },
  { label: "Project ID" },
  { label: "Type" },
  { label: "Client / Prime" },
  { label: "Subs" },
  { label: "Contract Type" },
  { label: "Contract", align: "right" },
  { label: "% Done", align: "right" },
  { label: "Manager" },
  { label: "+PMs" },
  { label: "Status" },
  { label: "Actions", silent: true },
];

export const ProjectsTable = ({
  items = [], updateRow = () => {}, onOpenDrawer, onOpenProject, onAddChild, onDelete,
  companies = [], users = [],
  activeFilter = "all", onFilterChange, filterChips = [], flashId, tab = "projects",
}) => {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());

  // parent uuid → sorted children (a dangling/missing parent is treated as a
  // root). Keyed on the surrogate `id`; display order is by the scoped local_id.
  const byParent = useMemo(() => {
    const ids = new Set(items.map(it => it.id));
    const m = new Map();
    for (const it of items) {
      const pid = (it.parentId && ids.has(it.parentId)) ? it.parentId : null;
      (m.get(pid) || m.set(pid, []).get(pid)).push(it);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) =>
        (a.sortOrd ?? 1e9) - (b.sortOrd ?? 1e9) ||
        String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
    }
    return m;
  }, [items]);

  const matchesFilter = (it) => {
    switch (activeFilter) {
      case "main":     return it.itemType === "main";
      case "standard": return it.itemType === "standard";
      case "active":   return it.status === "active";
      case "between":  return it.status === "between";
      case "closed":   return it.status === "closed_out";
      default:         return true;
    }
  };
  const matchesQuery = (it) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const client = companyById(it.clientId)?.name || "";
    const mgr = userById(it.managerId)?.name || "";
    return [it.name, it.localId, client, mgr]
      .some(s => String(s || "").toLowerCase().includes(q));
  };
  const isFiltering = !!query.trim() || activeFilter !== "all";

  // Keep set (of uuids): a node survives if it matches OR any descendant
  // matches, so a matching leaf keeps its whole ancestor chain visible.
  const keep = useMemo(() => {
    if (!isFiltering) return null;
    const set = new Set();
    const visit = (it) => {
      let anyChild = false;
      for (const c of (byParent.get(it.id) || [])) if (visit(c)) anyChild = true;
      if ((matchesFilter(it) && matchesQuery(it)) || anyChild) { set.add(it.id); return true; }
      return false;
    };
    for (const r of (byParent.get(null) || [])) visit(r);
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byParent, isFiltering, query, activeFilter]);

  // Flatten the tree depth-first into render rows (honoring collapse; when
  // filtering, everything is force-expanded so matches are visible).
  const flat = useMemo(() => {
    const out = [];
    const walk = (pid, depth) => {
      for (const it of (byParent.get(pid) || [])) {
        if (keep && !keep.has(it.id)) continue;
        const kids = (byParent.get(it.id) || []).filter(c => !keep || keep.has(c.id));
        const isCollapsed = !isFiltering && collapsed.has(it.id);
        out.push({ ...it, _depth: depth, _hasKids: kids.length > 0, _collapsed: isCollapsed });
        if (kids.length > 0 && !isCollapsed) walk(it.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [byParent, keep, collapsed, isFiltering]);

  // Publish flattened rows for the page-head Export PDF (tab-guarded reader).
  useEffect(() => {
    setCurrentTableSnapshot({ tab, processedRows: flat, visibleColumns: null });
  }, [flat, tab]);

  const toggle = (pid) => setCollapsed(s => {
    const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n;
  });
  const parentIds = useMemo(
    () => items.filter(it => (byParent.get(it.id) || []).length > 0).map(it => it.id),
    [items, byParent]);
  const expandAll   = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(parentIds));

  // Start fully collapsed: once items first load, collapse every parent so only
  // the top-level projects show. Runs once — later expand/collapse choices stick.
  const didInitCollapse = useRef(false);
  useEffect(() => {
    if (didInitCollapse.current || items.length === 0) return;
    didInitCollapse.current = true;
    setCollapsed(new Set(parentIds));
  }, [items.length, parentIds]);

  // Chip counts (ignore the search box; count against the type/status axis).
  const chipCount = (key) => {
    if (key === "all") return items.length;
    return items.filter(it => {
      switch (key) {
        case "main": return it.itemType === "main";
        case "standard": return it.itemType === "standard";
        case "active": return it.status === "active";
        case "between": return it.status === "between";
        case "closed": return it.status === "closed_out";
        default: return true;
      }
    }).length;
  };

  if (items.length === 0) {
    return (
      <div className="tablewrap bxt-ptree">
        <EmptyState
          title="No projects yet"
          hint='Use "New project" to create a top-level project, then add phases and subphases under it.'
          iconName="briefcase"
        />
      </div>
    );
  }

  // Main is a container the team cannot book time against; Standard is
  // where the work actually lands. Brand tone for the container, sage for
  // the billable leaf, and the word is always printed beside the swatch.
  const typeBadge = (it) => (
    <Badge
      tone={it.itemType === "main" ? "brand" : "success"}
      dot
      className="max-w-full"
      title={it.itemType === "main"
        ? "Main: a container, time and expenses cannot be logged here"
        : "Standard: time and expenses can be logged here"}
    >
      <span className="min-w-0 truncate">{projectItemTypeLabel(it.itemType)}</span>
    </Badge>
  );
  // Semantic tones per design/README §2: sage on track, steel in-between,
  // clay closed out.
  const statusBadge = (it) => {
    const tone = it.status === "active" ? "success"
      : it.status === "between" ? "info"
      : it.status === "closed_out" ? "danger"
      : "neutral";
    return (
      <Badge tone={tone} dot className="max-w-full">
        <span className="min-w-0 truncate">{projectItemStatusLabel(it.status)}</span>
      </Badge>
    );
  };

  const hasQuery = !!query.trim();

  return (
    <div className="tablewrap bxt-ptree">
      {/* Same toolbar vocabulary as every other Beacon table: search first,
          then a scrolling filter strip, then the tools pushed right. */}
      <div className="bxt-toolbar">
        <InputGroup
          className="bxt-search"
          inputClassName={hasQuery
            ? "border-[var(--accent)] bg-[var(--accent-softer)] text-[var(--accent-ink)]"
            : undefined}
          type="text"
          placeholder="Search projects"
          aria-label="Search projects, IDs, clients and managers"
          value={query}
          onChange={e => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          leading={<Icon name="search" size={14}/>}
          trailing={hasQuery ? (
            <button
              type="button"
              className="bxt-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <Icon name="x" size={12}/>
            </button>
          ) : null}
        />

        {filterChips.length > 0 && (
          <div className="bxt-filterstrip" role="group" aria-label="Filters">
            {filterChips.map(chip => (
              <button
                key={chip.key}
                type="button"
                className={"bxt-chip" + (activeFilter === chip.key ? " is-on" : "")}
                aria-pressed={activeFilter === chip.key}
                onClick={() => onFilterChange?.(chip.key)}
              >
                {chip.icon && <Icon name={chip.icon} size={13}/>}
                <span className="bxt-chip-label">{chip.label}</span>
                <span className="bxt-chip-count num">{chipCount(chip.key)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="bxt-toolbar-actions">
          <button type="button" className="bxt-tool" onClick={expandAll}
                  title="Expand every project">
            <Icon name="chevronDown" size={13}/>
            <span className="bxt-tool-label">Expand all</span>
          </button>
          <button type="button" className="bxt-tool" onClick={collapseAll}
                  title="Collapse to top level">
            <Icon name="chevronRight" size={13}/>
            <span className="bxt-tool-label">Collapse all</span>
          </button>
        </div>
      </div>

      {isFiltering && (
        <div className="bxt-searchsummary" role="status" aria-live="polite">
          {flat.length === 0
            ? (hasQuery
              ? <>No projects match <span className="bxt-searchterm">"{query}"</span>.</>
              : <>No projects in this filter.</>)
            : (
              <>
                <strong className="num">{flat.length}</strong> of{" "}
                <strong className="num">{items.length}</strong> shown
                {hasQuery && <> for <span className="bxt-searchterm">"{query}"</span></>}
              </>
            )}
        </div>
      )}

      <div className="table-scroll">
        {/* The outline is a CSS grid, not a <table>: rows carry their own
            depth padding and the tree collapses in place. The ARIA roles
            put the structure back for assistive tech. */}
        <div className="table-scroll-body" role="table" aria-label="Projects table">
          <div className="thead bxt-thead" role="row" style={{ gridTemplateColumns: PTREE_COLS }}>
            {PTREE_HEADS.map((h) => (
              <div
                key={h.label}
                className={"th bxt-th" + (h.align === "right" ? " bxt-th-right" : "")}
                role="columnheader"
              >
                <span className="bxt-th-label">
                  {h.silent ? <span className="sr-only">{h.label}</span> : h.label}
                </span>
              </div>
            ))}
          </div>

          {flat.map(it => {
            const itemName = it.name || it.localId || "this item";
            const pct = it.percentComplete == null
              ? null
              : Math.max(0, Math.min(100, Number(it.percentComplete) || 0));
            return (
              <div
                key={it.id}
                className={"trow bxt-ptrow" + (flashId === it.id ? " flash" : "")}
                role="row"
                data-itemtype={it.itemType === "main" ? "main" : "standard"}
                data-depth={it._depth}
                style={{ gridTemplateColumns: PTREE_COLS, cursor: "default" }}
                onDoubleClick={() => it._depth === 0 ? onOpenProject?.(it) : onOpenDrawer?.(it)}
              >
                {/* Name — indented by depth, with expand chevron. A ROOT project's
                    name is a link that opens its detail page; phases/subphases
                    keep the inline name editor. */}
                <div
                  className="td bxt-pt-name"
                  role="cell"
                  style={{ paddingLeft: 12 + it._depth * 20 }}
                >
                  {it._hasKids ? (
                    <button
                      type="button"
                      className="bxt-pt-toggle"
                      aria-expanded={!it._collapsed}
                      aria-label={`${it._collapsed ? "Expand" : "Collapse"} ${itemName}`}
                      title={it._collapsed ? "Expand" : "Collapse"}
                      onClick={(e) => { e.stopPropagation(); toggle(it.id); }}
                    >
                      <Icon name={it._collapsed ? "chevronRight" : "chevronDown"} size={13}/>
                    </button>
                  ) : (
                    <span className="bxt-pt-togglespacer" aria-hidden="true"/>
                  )}
                  <span className="bxt-pt-dot" data-itemtype={it.itemType === "main" ? "main" : "standard"} aria-hidden="true"/>
                  <span className="bxt-pt-nametext">
                    {/* Indentation alone carries the hierarchy visually, so
                        the depth is also written out for screen readers. */}
                    {it._depth > 0 && (
                      <span className="sr-only">Level {it._depth + 1}, </span>
                    )}
                    {it._depth === 0 ? (
                      <button
                        type="button"
                        className="bxt-pt-open"
                        title="Open project detail"
                        onClick={(e) => { e.stopPropagation(); onOpenProject?.(it); }}
                      >
                        {it.name}
                      </button>
                    ) : (
                      <EditableCell value={it.name} type="text"
                        onChange={(v) => updateRow(it.id, { name: v })}/>
                    )}
                  </span>
                </div>

                <div className="td mono bxt-td-ref" role="cell">
                  <EditableCell value={it.localId} type="text"
                    onChange={(v) => updateRow(it.id, { localId: v })}/>
                </div>
                <div className="td" role="cell">
                  <EditableCell value={it.itemType} type="select" options={PROJECT_ITEM_TYPE_OPTIONS}
                    render={() => typeBadge(it)}
                    onChange={(v) => updateRow(it.id, { itemType: v })}/>
                </div>
                <div className="td subtle" role="cell">
                  {companyById(it.clientId)?.name || <span className="empty-cell">–</span>}
                </div>
                <div className="td" role="cell">
                  <SubsCell subs={it.subs}/>
                </div>
                <div className="td subtle" role="cell">
                  <EditableCell value={it.contractType} type="select" options={CONTRACT_TYPE_OPTIONS}
                    render={(v) => v ? contractTypeLabel(v) : <span className="empty-cell">–</span>}
                    onChange={(v) => updateRow(it.id, { contractType: v })}/>
                </div>
                <div className="td mono num bxt-td-money" role="cell">
                  <EditableCell value={it.contractAmount} type="number" align="right"
                    render={(v) => v == null ? <span className="empty-cell">–</span> : fmtMoney(v, false)}
                    onChange={(v) => updateRow(it.id, { contractAmount: v })}/>
                </div>
                <div className="td bxt-td-pct" role="cell">
                  <EditableCell value={it.percentComplete} type="number" align="right"
                    render={() => (
                      <span className="bxt-pct" title={pct == null ? "No progress recorded" : `${pct}% complete`}>
                        <Progress
                          className="bxt-pct-bar"
                          value={pct ?? 0}
                          tone={pct === 100 ? "success" : "brand"}
                          aria-label={`${itemName} percent complete`}
                        />
                        <span className="bxt-pct-num num">
                          {pct == null ? "–" : `${pct}%`}
                        </span>
                      </span>
                    )}
                    onChange={(v) => updateRow(it.id, { percentComplete: v })}/>
                </div>
                <div className="td" role="cell">
                  {it.managerId
                    ? <UserTag userId={it.managerId} size="xs"/>
                    : <span className="empty-cell">–</span>}
                </div>
                <div className="td" role="cell">
                  {(it.pmIds && it.pmIds.length)
                    ? <UserStack ids={it.pmIds} max={3}/>
                    : <span className="empty-cell">–</span>}
                </div>
                <div className="td" role="cell">
                  <EditableCell value={it.status} type="select" options={PROJECT_ITEM_STATUS_OPTIONS}
                    render={() => statusBadge(it)}
                    onChange={(v) => updateRow(it.id, { status: v })}/>
                </div>
                <div className="td bxt-td-actions" role="cell">
                  <div className="bxt-rowactions bxt-ptactions" onClick={e => e.stopPropagation()}>
                    <button
                      type="button"
                      className="row-btn bxt-rowbtn"
                      title="Add child (phase / subphase)"
                      aria-label={`Add a phase or subphase under ${itemName}`}
                      onClick={(e) => { e.stopPropagation(); onAddChild?.(it.id); }}
                    >
                      <Icon name="plus" size={13}/>
                    </button>
                    <button
                      type="button"
                      className="row-btn bxt-rowbtn"
                      title={it._depth === 0 ? "Open project detail" : "Open details"}
                      aria-label={it._depth === 0
                        ? `Open the project detail page for ${itemName}`
                        : `Open details for ${itemName}`}
                      onClick={(e) => { e.stopPropagation(); it._depth === 0 ? onOpenProject?.(it) : onOpenDrawer?.(it); }}
                    >
                      <Icon name={it._depth === 0 ? "maximize" : "eye"} size={13}/>
                    </button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="row-btn bxt-rowbtn"
                          title="More actions"
                          aria-label={`More actions for ${itemName}`}
                        >
                          <Icon name="more" size={14}/>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bxt-menu">
                        <DropdownMenuItem destructive onSelect={() => onDelete?.(it.id)}>
                          <Icon name="trash" size={13}/>
                          <span className="bxt-menu-text">
                            {it._hasKids ? "Delete with children" : "Delete"}
                          </span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Outside the role="table" subtree, exactly like TableView does, so
            no cell-less row is ever announced. */}
        {flat.length === 0 && (
          hasQuery ? (
            <EmptyState
              title="No matches"
              hint={`Nothing matches "${query}". Clear the search, or pick a different filter, to see the full tree.`}
              iconName="search"
            />
          ) : (
            <EmptyState
              title="Nothing in this filter"
              hint="No project, phase or subphase is in this state right now. Switch back to All to see the whole tree."
              iconName="filter"
            />
          )
        )}
      </div>
    </div>
  );
};
