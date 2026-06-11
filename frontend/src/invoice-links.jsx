// ============================================================================
// Awarded ↔ Invoice project links — chips cell + live project card.
// ============================================================================
// The Awarded table's "Proj #" column renders each linked invoice project as
// a mono chip. Clicking a chip opens <InvoiceProjectCard/> — a live snapshot
// of that project pulled from the merged Invoice rows (contract, billed to
// date, billing state, PMs) — with a one-click jump to the Invoice tab.
// The "+" affordance opens a search popover over every invoice project
// number; the highlighted result previews as the same card before linking,
// so "add a project number → see the project card" is a single gesture.
//
// Data contract (all provided by App.jsx):
//   row.invoiceLinks : string[]            — linked invoice project numbers
//   invoiceIndex     : Map<normNum, inv>   — merged invoice rows by number key
//   actualThru       : number              — last Actual month index (billed math)
//   onAdd(row, number) / onRemove(row, number) / onOpenInvoice(inv)

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import { UserStack } from "./primitives.jsx";
import { fmtMoney, normInvoiceNumber, THIS_YEAR } from "./data.js";

const STATE_META = {
  active:  { label: "Active",     cls: "active"  },
  between: { label: "In-Between", cls: "between" },
  closed:  { label: "Closed out", cls: "closed"  },
};

// Total dollars billed to date on a merged invoice project: every month of
// past years + Jan..actualThru of the current year. Future years (and the
// current year's projection months) don't count — mirrors the date-driven
// "Total Billed" semantics of the InvoiceTable.
export function invoiceBilledToDate(inv, actualThru) {
  const byYear = inv?.byYear && Object.keys(inv.byYear).length
    ? inv.byYear
    : (inv?.year != null ? { [inv.year]: inv } : {});
  let sum = 0;
  for (const [y, row] of Object.entries(byYear)) {
    const yr = Number(y);
    const vals = row.values || [];
    if (yr < THIS_YEAR) {
      sum += vals.reduce((a, v) => a + (v || 0), 0);
    } else if (yr === THIS_YEAR) {
      sum += vals.slice(0, Math.max(0, actualThru + 1)).reduce((a, v) => a + (v || 0), 0);
    }
  }
  return sum;
}

// ----------------------------------------------------------------------------
// Fixed-position portal anchored to a rect. Closes on outside-press, Escape,
// scroll (the tables scroll horizontally — a stale-anchored popover is worse
// than a closed one), and resize.
// ----------------------------------------------------------------------------
const AnchoredPop = ({ anchorRect, onClose, width = 300, children, className = "" }) => {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!anchorRect) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    let left = Math.min(Math.max(8, anchorRect.left), vw - w - 8);
    const below = anchorRect.bottom + 6;
    const estH = ref.current?.offsetHeight || 320;
    const flipUp = below + estH > vh - 8 && anchorRect.top - estH - 6 > 8;
    setPos({
      left,
      top: flipUp ? undefined : below,
      bottom: flipUp ? (vh - anchorRect.top + 6) : undefined,
      width: w,
    });
  }, [anchorRect, width, children]);

  // onClose is an inline lambda at every call site — route it through a ref
  // so the listeners register exactly once per popover open instead of
  // tearing down on every parent re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const close = () => onCloseRef.current();
    const press = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const key = (e) => { if (e.key === "Escape") close(); };
    const scroll = (e) => { if (ref.current && ref.current.contains(e.target)) return; close(); };
    document.addEventListener("mousedown", press);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", press);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  if (!anchorRect) return null;
  return createPortal(
    <div ref={ref} className={`inv-pop ${className}`}
         style={{ position: "fixed", zIndex: 90, ...pos, visibility: pos ? "visible" : "hidden" }}
         onMouseDown={(e) => e.stopPropagation()}
         onClick={(e) => e.stopPropagation()}
         onDoubleClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body
  );
};

// ----------------------------------------------------------------------------
// The project card — a live read of one merged invoice project.
// ----------------------------------------------------------------------------
export const InvoiceProjectCard = ({ number, inv, actualThru, onOpen, onUnlink }) => {
  if (!inv) {
    return (
      <div className="inv-card">
        <div className="inv-card-top">
          <span className="inv-card-num">{number}</span>
          <span className="inv-state missing">No invoice project</span>
        </div>
        <div className="inv-card-empty">
          No project in the Invoice table carries this number yet. The link
          activates by itself once one does.
        </div>
        {onUnlink && (
          <div className="inv-card-foot">
            <span/>
            <button className="btn sm" onClick={onUnlink}>
              <Icon name="x" size={12}/>Unlink
            </button>
          </div>
        )}
      </div>
    );
  }
  const state = STATE_META[inv.billingState || "active"] || STATE_META.active;
  const billed = invoiceBilledToDate(inv, actualThru);
  const years = (inv.years || []).join(" · ");
  return (
    <div className="inv-card">
      <div className="inv-card-top">
        <span className="inv-card-num">{inv.projectNumber || number}</span>
        <span className="chip muted inv-card-type">{inv.type || "ENG"}</span>
        <span className={`inv-state ${state.cls}`}>{state.label}</span>
      </div>
      <div className="inv-card-name">{inv.name || "Untitled project"}</div>
      <div className="inv-card-stats">
        <div>
          <span className="inv-card-statlabel">Contract</span>
          <span className="inv-card-statval">{inv.amount ? fmtMoney(inv.amount, false) : "—"}</span>
        </div>
        <div>
          <span className="inv-card-statlabel">Billed to date</span>
          <span className="inv-card-statval">{billed ? fmtMoney(billed, false) : "—"}</span>
        </div>
      </div>
      <div className="inv-card-foot">
        <span className="inv-card-meta">
          {(inv.pmIds || []).length > 0 && <UserStack ids={inv.pmIds}/>}
          {years && <span className="inv-card-years">{years}</span>}
        </span>
        <span className="inv-card-foot-btns">
          {onUnlink && (
            <button className="btn sm" onClick={onUnlink} title="Remove this link">
              <Icon name="x" size={12}/>Unlink
            </button>
          )}
          {onOpen && (
            <button className="btn sm primary" onClick={() => onOpen(inv)}>
              Open in Invoice<Icon name="forward" size={12}/>
            </button>
          )}
        </span>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// The cell: link chips + "+" search popover with live card preview.
// ----------------------------------------------------------------------------
export const InvoiceLinkCell = ({ row, invoiceIndex, actualThru, onAdd, onRemove, onOpenInvoice }) => {
  const links = row.invoiceLinks || [];
  const [cardFor, setCardFor] = useState(null);   // { number, rect }
  const [adding, setAdding] = useState(null);     // { rect }
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);

  const linkedKeys = useMemo(() => new Set(links.map(normInvoiceNumber)), [links]);

  // Candidates: every invoice project with a number, filtered by the query
  // against number + name. Already-linked rows stay listed (marked) so the
  // user sees why a number "isn't there".
  const results = useMemo(() => {
    if (!adding) return [];
    const q = query.trim().toLowerCase();
    const all = [...(invoiceIndex?.values() || [])].filter(v => v.projectNumber);
    const hits = q
      ? all.filter(v =>
          String(v.projectNumber).toLowerCase().includes(q) ||
          String(v.name || "").toLowerCase().includes(q))
      : all;
    hits.sort((a, b) => String(a.projectNumber).localeCompare(String(b.projectNumber), undefined, { numeric: true }));
    return hits.slice(0, 8);
  }, [adding, query, invoiceIndex]);

  useEffect(() => { setHi(0); }, [query, adding]);
  useEffect(() => {
    if (adding) setTimeout(() => inputRef.current?.focus(), 0);
  }, [adding]);

  const openAdd = (e) => {
    e.stopPropagation();
    setCardFor(null);
    // Seed the search with the row's own Proj # the first time, so the most
    // common flow ("link the project I already typed") is zero-typing.
    setQuery(links.length === 0 ? String(row.projectNumber || "") : "");
    setAdding({ rect: e.currentTarget.getBoundingClientRect() });
  };

  const commit = (inv) => {
    if (!inv || linkedKeys.has(normInvoiceNumber(inv.projectNumber))) return;
    onAdd(row, String(inv.projectNumber).trim());
    setAdding(null);
    setQuery("");
  };
  // Free-typed number with no matching invoice project: allow linking anyway
  // (the card explains it's dormant until an invoice row carries the number).
  const commitFree = () => {
    const num = query.trim();
    if (!num || linkedKeys.has(normInvoiceNumber(num))) return;
    onAdd(row, num);
    setAdding(null);
    setQuery("");
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => Math.min(h + 1, Math.max(0, results.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (results[hi]) commit(results[hi]); else commitFree();
    }
  };

  const hiInv = adding ? results[hi] : null;

  return (
    <div className="td inv-link-cell" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {links.map(num => {
        const inv = invoiceIndex?.get(normInvoiceNumber(num));
        const state = inv ? (inv.billingState || "active") : "missing";
        return (
          <span key={num}
                className={`inv-link-chip ${state}`}
                title={inv ? `${inv.name || ""} · click for project card` : "No invoice project carries this number yet"}
                onClick={(e) => {
                  e.stopPropagation();
                  setAdding(null);
                  setCardFor({ number: num, rect: e.currentTarget.getBoundingClientRect() });
                }}>
            <span className="inv-link-dot"/>
            {num}
            <button className="inv-link-x" title="Unlink"
                    onClick={(e) => { e.stopPropagation(); onRemove(row, num); setCardFor(null); }}>
              <Icon name="x" size={9}/>
            </button>
          </span>
        );
      })}
      {links.length === 0 && row.projectNumber && (
        <span className="inv-link-bare mono" title="Not linked yet — use + to attach invoice projects">
          {row.projectNumber}
        </span>
      )}
      <button className="inv-link-add" title="Link an invoice project by number" onClick={openAdd}>
        <Icon name="plus" size={11}/>
      </button>

      {cardFor && (
        <AnchoredPop anchorRect={cardFor.rect} onClose={() => setCardFor(null)} width={300}>
          <InvoiceProjectCard
            number={cardFor.number}
            inv={invoiceIndex?.get(normInvoiceNumber(cardFor.number))}
            actualThru={actualThru}
            onOpen={(inv) => { setCardFor(null); onOpenInvoice(inv); }}
            onUnlink={() => { onRemove(row, cardFor.number); setCardFor(null); }}
          />
        </AnchoredPop>
      )}

      {adding && (
        <AnchoredPop anchorRect={adding.rect} onClose={() => setAdding(null)} width={324} className="inv-pop-add">
          <div className="inv-add-search">
            <Icon name="search" size={12}/>
            <input ref={inputRef} value={query} placeholder="Search invoice project # or name…"
                   onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}/>
          </div>
          <div className="inv-add-list">
            {results.map((v, i) => {
              const already = linkedKeys.has(normInvoiceNumber(v.projectNumber));
              return (
                <button key={`${v.type}:${v.projectNumber}`}
                        className={"inv-add-item" + (i === hi ? " hi" : "") + (already ? " linked" : "")}
                        onMouseEnter={() => setHi(i)}
                        onClick={() => commit(v)}
                        disabled={already}>
                  <span className="mono inv-add-num">{v.projectNumber}</span>
                  <span className="inv-add-name">{v.name}</span>
                  {already
                    ? <span className="inv-add-flag"><Icon name="check" size={10}/>linked</span>
                    : <span className="chip muted inv-card-type">{v.type || "ENG"}</span>}
                </button>
              );
            })}
            {results.length === 0 && (
              <div className="inv-add-none">
                {query.trim()
                  ? <>No invoice project matches.
                      <button className="btn sm" onClick={commitFree} style={{ marginLeft: 8 }}>
                        <Icon name="plus" size={11}/>Link “{query.trim()}” anyway
                      </button>
                    </>
                  : "Type to search the Invoice table."}
              </div>
            )}
          </div>
          {hiInv && (
            <div className="inv-add-preview">
              <InvoiceProjectCard inv={hiInv} number={hiInv.projectNumber} actualThru={actualThru}/>
            </div>
          )}
        </AnchoredPop>
      )}
    </div>
  );
};
