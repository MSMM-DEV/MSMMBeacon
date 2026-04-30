import React, { useMemo, useState, useRef, useEffect } from "react";
import { Icon } from "./icons.jsx";
import {
  fmtDate, fmtMoney, MONTHS, TODAY_MONTH, THIS_YEAR,
  companyById, userById,
} from "./data.js";

// ============================================================================
// Quad Sheet — executive snapshot for board members / decision-makers.
//
// Four live panes:
//   Q1  Invoice flow — interactive line chart over 12 months (Actual + Proj).
//   Q2  Events ledger — chronological list of upcoming + recent events.
//   Q3  Awaiting docket — project name + anticipated result date.
//   Q4  Hot Leads — chronological list of early-stage opportunities.
//
// Styling: editorial / executive — generous whitespace, mono numerics, an
// asymmetric 2x2 grid where Q1 gets extra visual weight (it's the only
// interactive panel). Content scrolls inside a panel if it overflows.
// ============================================================================

// How many items each list component renders inside the card. Picked so
// every list fits the 400px-tall quad card without internal scrolling —
// the Expand button uncaps this for the overlay modal.
const CARD_LIMIT = 6;

export const QuadSheet = ({ invoice, events, awaiting, hotLeads, orangeSourceIds, monthlyBenchmark, onOpen }) => {
  // `expanded` names which card is currently zoomed into the modal.
  // null = no modal open. Only list-type cards can be expanded (the
  // Invoice chart has intrinsic sizing and doesn't benefit from expand).
  const [expanded, setExpanded] = useState(null);

  // Close modal on ESC.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => { if (e.key === "Escape") setExpanded(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const cfgs = {
    events: {
      eyebrow: "02 · Calendar",
      title: "Events",
      sub: `${events.length} tracked · sorted by date`,
      accent: "cal",
    },
    awaiting: {
      eyebrow: "03 · Pipeline",
      title: "Awaiting Verdict",
      sub: `${awaiting.length} in review · anticipated result`,
      accent: "await",
    },
    hotleads: {
      eyebrow: "04 · Pre-Pipeline",
      title: "Hot Leads",
      sub: `${(hotLeads || []).length} tracked · early-stage`,
      accent: "soq",
    },
  };

  const renderList = (key, { limit }) => {
    if (key === "events")   return <EventLedger  events={events}   onOpen={r => onOpen("events", r)}   limit={limit}/>;
    if (key === "awaiting") return <AwaitingList awaiting={awaiting} onOpen={r => onOpen("awaiting", r)} limit={limit}/>;
    if (key === "hotleads") return <HotLeadsList hotLeads={hotLeads || []} onOpen={r => onOpen("hotleads", r)} limit={limit}/>;
    return null;
  };

  return (
    <>
      <div className="quad">
        <QuadCard
          eyebrow="01 · Cash Flow"
          title="Anticipated Invoice"
          sub={`${THIS_YEAR} · monthly actual vs. projection`}
          accent="flow"
          className="quad-q1">
          {(() => {
            // Hard split by invoice_type_enum so the executive view shows
            // Engineering and PM revenue as independent stories. Rows with a
            // missing/unknown type adapter-default to ENG (see adaptInvoice
            // in data.js), so the union is exhaustive.
            const invoiceEng = invoice.filter(r => (r.type || "ENG") === "ENG");
            const invoicePm  = invoice.filter(r => r.type === "PM");
            return (
              <div className="invoice-chart-stack">
                <InvoiceChart
                  eyebrow="Engineering · ENG"
                  invoice={invoiceEng}
                  orangeSourceIds={orangeSourceIds}
                  monthlyBenchmark={monthlyBenchmark}
                />
                <div className="invoice-chart-divider" aria-hidden="true"/>
                <InvoiceChart
                  eyebrow="Project Management · PM"
                  invoice={invoicePm}
                  orangeSourceIds={orangeSourceIds}
                  monthlyBenchmark={monthlyBenchmark}
                />
              </div>
            );
          })()}
        </QuadCard>

        <QuadCard
          {...cfgs.events}
          className="quad-q2"
          onExpand={() => setExpanded("events")}>
          {renderList("events", { limit: CARD_LIMIT })}
        </QuadCard>

        <QuadCard
          {...cfgs.awaiting}
          className="quad-q3"
          onExpand={() => setExpanded("awaiting")}>
          {renderList("awaiting", { limit: CARD_LIMIT })}
        </QuadCard>

        <QuadCard
          {...cfgs.hotleads}
          className="quad-q4"
          onExpand={() => setExpanded("hotleads")}>
          {renderList("hotleads", { limit: CARD_LIMIT })}
        </QuadCard>
      </div>

      {expanded && (
        <QuadExpandModal
          eyebrow={cfgs[expanded].eyebrow}
          title={cfgs[expanded].title}
          sub={cfgs[expanded].sub}
          onClose={() => setExpanded(null)}>
          {renderList(expanded, { limit: Infinity })}
        </QuadExpandModal>
      )}
    </>
  );
};

// Centered modal that renders a quadrant's list at a larger size with
// internal scrolling so every item is reachable. Opens on Expand-button
// click; closes on ESC, overlay click, or × button.
const QuadExpandModal = ({ eyebrow, title, sub, onClose, children }) => (
  <>
    <div className="quad-expand-overlay" onClick={onClose}/>
    <div className="quad-expand-modal" role="dialog" aria-modal="true">
      <div className="quad-expand-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="quad-eyebrow">{eyebrow}</div>
          <h3>{title}</h3>
          {sub && <div className="quad-sub" style={{ marginTop: 3 }}>{sub}</div>}
        </div>
        <button className="drawer-close" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16}/>
        </button>
      </div>
      <div className="quad-expand-body">{children}</div>
    </div>
  </>
);

// ----------------------------------------------------------------------------
// Card shell — shared chrome for every quadrant.
// ----------------------------------------------------------------------------
const QuadCard = ({ eyebrow, title, sub, accent, className, onExpand, children }) => (
  <section className={`quad-card ${className || ""}`} data-accent={accent}>
    <header className="quad-head">
      <div className="quad-eyebrow">{eyebrow}</div>
      <h2 className="quad-title">{title}</h2>
      {/* Sub-row: count/description on the left + optional Expand button
          on the right. Expand opens a modal that renders the same content
          uncapped; cards with no onExpand (Invoice chart) just show the
          sub text. */}
      {(sub || onExpand) && (
        <div className="quad-sub-row">
          {sub && <div className="quad-sub">{sub}</div>}
          {onExpand && (
            <button type="button" className="quad-expand-btn" onClick={onExpand}
                    aria-label={`Expand ${title}`}>
              Expand <Icon name="forward" size={10}/>
            </button>
          )}
        </div>
      )}
    </header>
    <div className="quad-body">{children}</div>
  </section>
);

// ============================================================================
// Q1 — Invoice bar chart
// ============================================================================
// Twelve monthly bars (one per calendar month). Each bar's color is driven
// by the workspace-wide `monthlyBenchmark` (set by Admins in Settings →
// Targets):
//   total ≥ benchmark  → green ("on target")
//   total <  benchmark → red   ("below target")
//   benchmark unset    → neutral cadmium (keeps the chart legible before
//                                          a target is configured)
//
// Each bar visualizes BOTH the with-Orange total and the without-Orange
// base via stacked segments — the base portion sits at the bottom in a
// muted shade of the verdict color, and the Orange-attributable delta
// stacks on top in the saturated shade. Past months are solid; projection
// months get a softer fill + diagonal hatch so the actual/projection split
// remains visually obvious.
//
// A horizontal benchmark line is overlaid across the plot when set, with
// a small numeric chip so the threshold is readable at a glance.
// ----------------------------------------------------------------------------
const InvoiceChart = ({ invoice, orangeSourceIds, monthlyBenchmark, eyebrow }) => {
  // Two parallel 12-month totals:
  //   totalsBase — sum of invoices NOT sourced from an Orange potential row
  //                (formally awarded work — the "secured" baseline)
  //   totalsAll  — sum of ALL invoices (base + Orange pre-awarded)
  // The delta between them is the Orange pipeline's billing for the month.
  const { totalsBase, totalsAll, yMax } = useMemo(() => {
    const totalsBase = Array(12).fill(0);
    const totalsAll  = Array(12).fill(0);
    for (const r of invoice) {
      const isOrange = !!(r.sourceId && orangeSourceIds?.has(r.sourceId));
      for (let i = 0; i < 12; i++) {
        const v = Number(r.values?.[i] || 0);
        totalsAll[i] += v;
        if (!isOrange) totalsBase[i] += v;
      }
    }
    // Pin yMax to the larger of (peak month, benchmark) so the benchmark
    // line stays inside the plot even when every month sits well under it.
    // Round up to a clean magnitude tick (e.g. peak=84k → 100k; peak=4.6M
    // → 5M). Floor of 1 keeps the divisor from blowing up on empty data.
    const benchFloor = Number(monthlyBenchmark) > 0 ? Number(monthlyBenchmark) : 0;
    const peak = Math.max(...totalsAll, benchFloor, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(peak)));
    const yMax = Math.ceil(peak / mag) * mag;
    return { totalsBase, totalsAll, yMax };
  }, [invoice, orangeSourceIds, monthlyBenchmark]);

  // Track SVG pixel box via ResizeObserver so internal geometry reflows
  // with the card. Fallback dims apply before the observer fires.
  const svgRef = useRef(null);
  const [box, setBox] = useState({ w: 1600, h: 400 });
  useEffect(() => {
    const node = svgRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) {
          setBox({ w: Math.round(width), h: Math.round(height) });
        }
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const W = box.w, H = box.h;
  const padL = 56, padR = 24, padT = 24, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Bar geometry: 12 evenly-spaced slots across plotW. Each month renders a
  // pair of side-by-side bars (Without-Orange on the left, With-Orange on
  // the right) so the user can read "secured" and "secured + Orange"
  // independently — instead of stacking which can hide whether a bar is
  // dominated by Orange. When the subset has no Orange rows at all, fall
  // back to a single wider bar per month so empty-half slots don't waste
  // visual real estate.
  const slot = plotW / 12;
  const hasOrange = invoice.some(r => r.sourceId && orangeSourceIds?.has(r.sourceId));
  const PAIR_GAP = 3;
  const barW = hasOrange
    ? Math.max(6, Math.min(26, slot * 0.30))
    : Math.max(8, Math.min(54, slot * 0.62));
  const slotCx = (i) => padL + slot * i + slot / 2;
  const baseBarX = (i) =>
    hasOrange ? slotCx(i) - barW - PAIR_GAP / 2 : slotCx(i) - barW / 2;
  const allBarX  = (i) => slotCx(i) + PAIR_GAP / 2;
  const yFor = (v) => padT + plotH - (v / yMax) * plotH;

  // Benchmark band — only rendered when set + > 0.
  const hasBenchmark = Number(monthlyBenchmark) > 0;
  const benchmarkY = hasBenchmark ? yFor(Number(monthlyBenchmark)) : null;

  // Y-axis ticks (5 bands, 0..yMax).
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: padT + plotH - t * plotH,
    v: t * yMax,
  }));

  // Hover snapping: pointer x → nearest month slot.
  const [hoverIdx, setHoverIdx] = useState(null);
  const onMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < padL || x > padL + plotW) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.max(0, Math.min(11, Math.floor((x - padL) / slot)));
    setHoverIdx(idx);
  };

  // Verdict per month: above/below benchmark drives the bar color class.
  // When no benchmark is set, every bar is "neutral" so the chart still
  // communicates magnitude without misleading green/red noise.
  const verdictFor = (i) => {
    if (!hasBenchmark) return "neutral";
    return totalsAll[i] >= Number(monthlyBenchmark) ? "above" : "below";
  };

  const ytdActualAll  = totalsAll.slice(0, TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const ytdActualBase = totalsBase.slice(0, TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const projRemAll    = totalsAll.slice(TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const projRemBase   = totalsBase.slice(TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const ytdAboveCount = hasBenchmark
    ? totalsAll.slice(0, TODAY_MONTH + 1).filter(v => v >= Number(monthlyBenchmark)).length
    : 0;

  return (
    <div className="chart-wrap">
      {eyebrow && (
        <div className="chart-eyebrow">
          <span className="chart-eyebrow-mark"/>
          <span>{eyebrow}</span>
        </div>
      )}
      <div className="chart-kpis">
        <div className="kpi">
          <div className="kpi-label">YTD Actual</div>
          <div className="kpi-val">{fmtMoney(ytdActualAll, false)}</div>
          {hasOrange && (
            <div className="kpi-sub">w/o Orange · {fmtMoney(ytdActualBase, false)}</div>
          )}
        </div>
        <div className="kpi-sep"/>
        <div className="kpi">
          <div className="kpi-label">Projection remaining</div>
          <div className="kpi-val ink-soft">{fmtMoney(projRemAll, false)}</div>
          {hasOrange && (
            <div className="kpi-sub">w/o Orange · {fmtMoney(projRemBase, false)}</div>
          )}
        </div>
        <div className="kpi-sep"/>
        <div className="kpi">
          <div className="kpi-label">{hasBenchmark ? "Months on target" : "Full year"}</div>
          {hasBenchmark ? (
            <>
              <div className="kpi-val mono-xl">
                {ytdAboveCount}<span className="kpi-frac">/{TODAY_MONTH + 1}</span>
              </div>
              <div className="kpi-sub">benchmark · {fmtMoney(monthlyBenchmark, false)}/mo</div>
            </>
          ) : (
            <>
              <div className="kpi-val mono-xl">{fmtMoney(ytdActualAll + projRemAll, false)}</div>
              <div className="kpi-sub">no benchmark set</div>
            </>
          )}
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="flow-chart bar-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Monthly invoice bars vs benchmark"
      >
        <defs>
          {/* Diagonal hatch for projection bars — same hue as the bar, just
              softer. One pattern per verdict class so the hatch picks up
              the right tint without runtime CSS variable resolution. */}
          {["above", "below", "neutral"].map((v) => (
            <pattern key={v} id={`hatch-${v}`}
                     patternUnits="userSpaceOnUse" width="6" height="6"
                     patternTransform="rotate(45)">
              <rect width="6" height="6" className={`hatch-bg verdict-${v}`}/>
              <line x1="0" y1="0" x2="0" y2="6" className={`hatch-line verdict-${v}`}/>
            </pattern>
          ))}
        </defs>

        {/* Y-axis grid */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.y} y2={t.y}
                  stroke="var(--border)" strokeDasharray="2 3" opacity="0.55"/>
            <text x={padL - 10} y={t.y + 4}
                  textAnchor="end"
                  className="chart-tick">
              {t.v === 0 ? "0" : t.v >= 1e6 ? (t.v / 1e6).toFixed(1) + "M" : (t.v / 1e3).toFixed(0) + "k"}
            </text>
          </g>
        ))}

        {/* Month labels */}
        {MONTHS.map((m, i) => (
          <text key={i}
                x={slotCx(i)} y={H - 14}
                textAnchor="middle"
                className={"chart-month" + (i === TODAY_MONTH ? " is-today" : "")}>
            {m}
          </text>
        ))}

        {/* Today marker — vertical dashed line at the leading edge of the
            current month's slot, so it visually separates Actual from
            Projection bars without overlapping any single bar. */}
        <line
          x1={padL + slot * (TODAY_MONTH + 1)} x2={padL + slot * (TODAY_MONTH + 1)}
          y1={padT} y2={padT + plotH}
          className="chart-today"/>

        {/* Bars — side-by-side pair per month. Left bar = Without-Orange
            (secured baseline). Right bar = With-Orange (total). Each bar's
            verdict color is computed against the same monthly benchmark
            independently, so a month can read "base on target / total
            on target" or "base below / total above" — useful when Orange
            pre-awarded billing is what's pushing the month over the line. */}
        {totalsAll.map((vAll, i) => {
          const vBase = totalsBase[i];
          const isProj = i > TODAY_MONTH;
          const verdictAll  = verdictFor(i);
          const verdictBase = !hasBenchmark
            ? "neutral"
            : (vBase >= Number(monthlyBenchmark) ? "above" : "below");

          const yBottom = padT + plotH;
          const yTopAll  = yFor(vAll);
          const yTopBase = yFor(vBase);
          const heightAll  = Math.max(0, yBottom - yTopAll);
          const heightBase = Math.max(0, yBottom - yTopBase);

          const projCls = isProj ? " proj" : " actual";
          const fillForVerdict = (v) => isProj ? `url(#hatch-${v})` : undefined;

          return (
            <g key={i} className={hoverIdx === i ? "bar-grp hover" : "bar-grp"}>
              {/* Slot guide — barely-visible track behind the pair so the
                  eye can find empty months. Spans the full pair width. */}
              <rect
                x={slotCx(i) - (hasOrange ? barW + PAIR_GAP/2 : barW / 2)}
                y={padT}
                width={hasOrange ? barW * 2 + PAIR_GAP : barW}
                height={plotH}
                rx="4"
                className="bar-track"
              />

              {/* Without-Orange bar (always rendered). When hasOrange is
                  false this is the only bar and fills the wider slot. */}
              {heightBase > 0.5 && (
                <rect
                  x={baseBarX(i)} y={yTopBase}
                  width={barW} height={heightBase}
                  rx="3"
                  className={`bar bar-pair-base verdict-${verdictBase}${projCls}`}
                  fill={fillForVerdict(verdictBase)}
                />
              )}
              {vBase > 0 && (
                <line
                  x1={baseBarX(i)} x2={baseBarX(i) + barW}
                  y1={yTopBase} y2={yTopBase}
                  className={`bar-cap verdict-${verdictBase}`}
                />
              )}

              {/* With-Orange bar (only when subset has any Orange rows). */}
              {hasOrange && heightAll > 0.5 && (
                <rect
                  x={allBarX(i)} y={yTopAll}
                  width={barW} height={heightAll}
                  rx="3"
                  className={`bar bar-pair-all verdict-${verdictAll}${projCls}`}
                  fill={fillForVerdict(verdictAll)}
                />
              )}
              {hasOrange && vAll > 0 && (
                <line
                  x1={allBarX(i)} x2={allBarX(i) + barW}
                  y1={yTopAll} y2={yTopAll}
                  className={`bar-cap verdict-${verdictAll}`}
                />
              )}
            </g>
          );
        })}

        {/* Benchmark line — drawn last so it sits on top of every bar.
            A small chip at the right edge labels the threshold. */}
        {hasBenchmark && (
          <g className="benchmark">
            <line x1={padL} x2={W - padR} y1={benchmarkY} y2={benchmarkY}
                  className="benchmark-line"/>
            <g transform={`translate(${W - padR},${benchmarkY})`}>
              <rect x={-86} y={-12} width="86" height="22" rx="6"
                    className="benchmark-chip-bg"/>
              <text x={-78} y={3} className="benchmark-chip-label">TARGET</text>
              <text x={-8}  y={3} textAnchor="end" className="benchmark-chip-val">
                {fmtMoney(monthlyBenchmark, false)}
              </text>
            </g>
          </g>
        )}

        {/* Hover readout */}
        {hoverIdx != null && (() => {
          const v = totalsAll[hoverIdx];
          const vBase = totalsBase[hoverIdx];
          const verdict = verdictFor(hoverIdx);
          const isProj = hoverIdx > TODAY_MONTH;
          const x = slotCx(hoverIdx);
          const yTop = yFor(v);
          const lines = [];
          lines.push({ y: 18, cls: "chart-tip-label", text: `${MONTHS[hoverIdx]} ${THIS_YEAR} · ${isProj ? "Projection" : "Actual"}` });
          lines.push({ y: 38, cls: `chart-tip-val verdict-${verdict}`, text: fmtMoney(v, false) });
          if (hasOrange) {
            lines.push({ y: 56, cls: "chart-tip-sub", text: `w/o Orange · ${fmtMoney(vBase, false)}` });
          }
          if (hasBenchmark) {
            const diff = v - Number(monthlyBenchmark);
            lines.push({
              y: hasOrange ? 74 : 56,
              cls: `chart-tip-diff verdict-${verdict}`,
              text: `${diff >= 0 ? "▲ " : "▼ "}${fmtMoney(Math.abs(diff), false)} vs target`,
            });
          }
          const lastY = lines[lines.length - 1].y;
          const boxW = 200;
          const boxH = lastY + 14;
          const left = Math.min(W - padR - boxW, Math.max(padL, x - boxW / 2));
          const top  = Math.max(padT + 4, yTop - boxH - 14);
          return (
            <g transform={`translate(${left},${top})`}>
              <rect width={boxW} height={boxH} rx={8} className="chart-tip-bg"/>
              {lines.map((line, idx) => (
                <text key={idx} x={12} y={line.y} className={line.cls}>{line.text}</text>
              ))}
            </g>
          );
        })()}
      </svg>

      <div className="chart-legend">
        {hasBenchmark ? (
          <>
            <span><span className="swatch verdict-above"/>Above target</span>
            <span><span className="swatch verdict-below"/>Below target</span>
          </>
        ) : (
          <span><span className="swatch verdict-orange-cap"/>Monthly total</span>
        )}
        {hasOrange && (
          <span className="legend-pair">
            <span className="swatch pair-base"/>w/o Orange
            <span className="swatch pair-all"/>with Orange
          </span>
        )}
        <span><span className="swatch hatched"/>Projection</span>
        <span><span className="swatch today"/>Today</span>
      </div>
    </div>
  );
};

// ============================================================================
// Q2 — Event ledger
// ============================================================================
// Sorted by anchor date (datetime first, then date). Future events are
// highlighted; past events subdued. Click opens the event in its drawer.
// ----------------------------------------------------------------------------
const EventLedger = ({ events, onOpen, limit = 40 }) => {
  const anchored = useMemo(() => {
    const now = Date.now();
    return events
      .map(e => {
        const iso = e.dateTime || e.date || null;
        const t = iso ? new Date(iso).getTime() : null;
        return { ...e, _t: t, _future: t != null && t >= now };
      })
      .filter(e => e._t != null)
      .sort((a, b) => a._t - b._t);
  }, [events]);

  if (anchored.length === 0) {
    return <div className="quad-empty">No dated events yet.</div>;
  }

  // Future first, then past-reverse-chronological so the most recent is next.
  const future = anchored.filter(e => e._future);
  const past   = anchored.filter(e => !e._future).reverse();
  const cap = limit === Infinity ? anchored.length : Math.min(limit, 40);
  const ordered = [...future, ...past].slice(0, cap);

  return (
    <ul className="event-ledger">
      {ordered.map(e => (
        <li key={e.id}
            className={"evt" + (e._future ? " future" : " past")}
            onClick={() => onOpen(e)}>
          <div className="evt-date">
            <div className="evt-mo">{monthShort(e._t)}</div>
            <div className="evt-day">{dayOf(e._t)}</div>
          </div>
          <div className="evt-body">
            <div className="evt-title">{e.title}</div>
            <div className="evt-meta">
              {e.type && <span className={`chip ${typeColor(e.type)}`}>{e.type}</span>}
              <span className="evt-when">
                {e.dateTime
                  ? new Date(e.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                  : fmtDate(e.date)}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
};

const monthShort = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short" });
const dayOf = (ms) => new Date(ms).getDate();
const typeColor = (t) => ({
  "Partner": "accent", "AI": "sage", "Project": "blue",
  "Meetings": "muted", "Board Meetings": "blue", "Event": "rose",
}[t] || "muted");

// ============================================================================
// Q3 — Awaiting verdict: name + anticipated result date
// ============================================================================
// Sorted by anticipatedResultDate ascending (soonest first); rows without a
// date fall to the bottom. The row shows days-until if the date is in the
// future, or the elapsed time if overdue.
// ----------------------------------------------------------------------------
const AwaitingList = ({ awaiting, onOpen, limit = Infinity }) => {
  const rows = useMemo(() => {
    const withDate = [];
    const withoutDate = [];
    const now = Date.now();
    for (const r of awaiting) {
      if (r.anticipatedResultDate) {
        const t = new Date(r.anticipatedResultDate).getTime();
        const daysOut = Math.round((t - now) / 86400000);
        withDate.push({ ...r, _t: t, _daysOut: daysOut });
      } else {
        withoutDate.push({ ...r, _t: null, _daysOut: null });
      }
    }
    withDate.sort((a, b) => a._t - b._t);
    return [...withDate, ...withoutDate];
  }, [awaiting]);

  if (rows.length === 0) {
    return <div className="quad-empty">No projects awaiting verdict.</div>;
  }
  const capped = limit === Infinity ? rows : rows.slice(0, limit);

  return (
    <ul className="await-list">
      {capped.map(r => {
        const client = companyById(r.clientId)?.name || "";
        const d = r._daysOut;
        const tone =
          d == null     ? "tba" :
          d < 0         ? "overdue" :
          d <= 14       ? "soon" :
          d <= 60       ? "upcoming" : "later";
        const label =
          d == null     ? "TBA" :
          d < 0         ? `${-d}d overdue` :
          d === 0       ? "today" :
          d === 1       ? "tomorrow" :
          d < 30        ? `in ${d}d` :
                          `in ${Math.round(d/30)}mo`;
        return (
          <li key={r.id} className="await-row" onClick={() => onOpen(r)}>
            <div className="await-main">
              <div className="await-name">{r.name}</div>
              {client && <div className="await-client">{client}</div>}
            </div>
            <div className={`await-pill ${tone}`}>
              <div className="await-pill-date">{fmtDate(r.anticipatedResultDate) === "—" ? "—" : fmtDate(r.anticipatedResultDate)}</div>
              <div className="await-pill-rel">{label}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
};

// ============================================================================
// Q4 — Hot Leads: chronological list of early-stage opportunities
// ============================================================================
// Mirrors the EventLedger visual vocabulary so Q2 and Q4 feel related but
// distinct — left date-tile + right body (title + client/firm name). Future
// leads first, then recent past. Click routes to the drawer.
// ----------------------------------------------------------------------------
const HotLeadsList = ({ hotLeads, onOpen, limit = 40 }) => {
  const anchored = useMemo(() => {
    const now = Date.now();
    return (hotLeads || [])
      .map(h => {
        const iso = h.dateTime || null;
        const t = iso ? new Date(iso).getTime() : null;
        return { ...h, _t: t, _future: t != null && t >= now };
      })
      .filter(h => h._t != null)
      .sort((a, b) => a._t - b._t);
  }, [hotLeads]);

  if (anchored.length === 0) {
    return <div className="quad-empty">No dated hot leads yet.</div>;
  }

  const future = anchored.filter(h => h._future);
  const past   = anchored.filter(h => !h._future).reverse();
  const cap = limit === Infinity ? anchored.length : Math.min(limit, 40);
  const ordered = [...future, ...past].slice(0, cap);

  return (
    <ul className="event-ledger">
      {ordered.map(h => {
        const firm = companyById(h.clientId);
        return (
          <li key={h.id}
              className={"evt" + (h._future ? " future" : " past")}
              onClick={() => onOpen(h)}>
            <div className="evt-date">
              <div className="evt-mo">{monthShort(h._t)}</div>
              <div className="evt-day">{dayOf(h._t)}</div>
            </div>
            <div className="evt-body">
              <div className="evt-title">{h.title}</div>
              <div className="evt-meta">
                {firm && <span className="chip accent">{firm.name}</span>}
                <span className="evt-when">
                  {new Date(h._t).toLocaleTimeString("en-US",
                    { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
};

// ============================================================================
// SOQ timeline: gantt-style bars from start → expiration (kept for
// reference — currently not rendered; SOQ quadrant replaced by Hot Leads).
// ============================================================================
// Computes the global [minStart, maxEnd] window across all SOQs, then draws
// each bar proportionally. Today's position is marked with a vertical line.
// Bars are color-coded by recurring status.
// ----------------------------------------------------------------------------
const SoqTimeline = ({ soq, onOpen }) => {
  const { items, minT, maxT, todayT } = useMemo(() => {
    const now = Date.now();
    const items = [];
    let minT = Infinity, maxT = -Infinity;
    for (const r of soq) {
      const s = r.startDate ? new Date(r.startDate).getTime() : null;
      const e = r.contractExpiry ? new Date(r.contractExpiry).getTime() : null;
      if (!s && !e) continue;
      const sT = s ?? e;
      const eT = e ?? s;
      items.push({ row: r, sT, eT });
      if (sT < minT) minT = sT;
      if (eT > maxT) maxT = eT;
    }
    // Include today in the window so the "today" marker always shows up.
    if (now < minT) minT = now;
    if (now > maxT) maxT = now;
    // Small padding so bars don't hug the edges.
    const pad = (maxT - minT) * 0.04 || 86400000 * 14;
    return { items, minT: minT - pad, maxT: maxT + pad, todayT: now };
  }, [soq]);

  if (items.length === 0) {
    return <div className="quad-empty">No SOQs recorded.</div>;
  }

  const range = maxT - minT || 1;
  const pctFor = (t) => ((t - minT) / range) * 100;
  const todayPct = pctFor(todayT);

  // Year tick marks — calendar-year boundaries that fall inside the window.
  const yTicks = [];
  const y0 = new Date(minT).getFullYear();
  const y1 = new Date(maxT).getFullYear();
  for (let y = y0; y <= y1 + 1; y++) {
    const t = new Date(y, 0, 1).getTime();
    if (t >= minT && t <= maxT) yTicks.push({ y, pct: pctFor(t) });
  }

  const toneFor = (rec) => ({
    "Yes": "yes", "In Talks": "talks", "Maybe": "maybe", "No": "no",
  }[rec] || "unknown");

  return (
    <div className="soq-timeline">
      <div className="soq-axis">
        {yTicks.map((t, i) => (
          <div key={i} className="soq-tick" style={{ left: `${t.pct}%` }}>
            <span className="soq-tick-label">{t.y}</span>
          </div>
        ))}
        <div className="soq-today" style={{ left: `${todayPct}%` }} title="Today">
          <span>NOW</span>
        </div>
      </div>
      <ul className="soq-bars">
        {items.map(({ row, sT, eT }) => {
          const left = pctFor(sT);
          const width = Math.max(1.4, pctFor(eT) - left);
          const tone = toneFor(row.recurring);
          const pm = (row.pmIds || [])
            .map(id => userById(id)?.shortName)
            .filter(Boolean)
            .join(", ");
          return (
            <li key={row.id} className="soq-row" onClick={() => onOpen(row)}>
              <div className="soq-name">
                <div className="soq-project">{row.name}</div>
                <div className="soq-client">{companyById(row.clientId)?.name || "—"}{pm ? ` · ${pm}` : ""}</div>
              </div>
              <div className="soq-lane">
                <div className={`soq-bar tone-${tone}`}
                     style={{ left: `${left}%`, width: `${width}%` }}
                     title={`${fmtDate(row.startDate)} → ${fmtDate(row.contractExpiry)}`}>
                  <span className="soq-bar-start">{fmtDateShort(sT)}</span>
                  <span className="soq-bar-end">{fmtDateShort(eT)}</span>
                </div>
              </div>
              <div className={`soq-rec tone-${tone}`}>
                {row.recurring || "—"}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const fmtDateShort = (ms) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
