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

export const QuadSheet = ({ invoice, events, awaiting, hotLeads, onOpen }) => {
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
          <InvoiceChart invoice={invoice}/>
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
// Q1 — Invoice chart
// ============================================================================
// Aggregates the 12 monthly numbers across every invoice row. Months up to and
// including the current month render as a filled area curve; later months are
// shown as a dashed projection line. Hover snaps to the nearest month and
// shows a read-out.
// ----------------------------------------------------------------------------
const InvoiceChart = ({ invoice }) => {
  // Two parallel 12-month totals:
  //   totalsBase — sum of invoices NOT sourced from an Orange potential row
  //                (i.e. formally awarded work — the "secured" baseline)
  //   totalsAll  — sum of ALL invoices (base + Orange pre-awarded)
  // The delta between the two lines is the Orange pipeline's billing.
  // We pin yMax to totalsAll so the chart scales to the higher envelope.
  // BOTH lines are always rendered, even if they coincide (no Orange this
  // year) or base is flat at 0 (all billing is Orange) — the KPIs/tooltip
  // convey the numeric split even when the visual lines sit on top of
  // each other.
  const { totalsBase, totalsAll, yMax } = useMemo(() => {
    const totalsBase = Array(12).fill(0);
    const totalsAll  = Array(12).fill(0);
    for (const r of invoice) {
      const isOrange = !!r.sourcePotentialId;
      for (let i = 0; i < 12; i++) {
        const v = Number(r.values?.[i] || 0);
        totalsAll[i] += v;
        if (!isOrange) totalsBase[i] += v;
      }
    }
    const peak = Math.max(...totalsAll, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(peak)));
    const yMax = Math.ceil(peak / mag) * mag;
    return { totalsBase, totalsAll, yMax };
  }, [invoice]);

  const W = 760, H = 280;
  const padL = 48, padR = 20, padT = 20, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const step = plotW / 11;

  const mkPts = (arr) => arr.map((v, i) => [
    padL + i * step,
    padT + plotH - (v / yMax) * plotH,
  ]);
  const ptsAll  = mkPts(totalsAll);
  const ptsBase = mkPts(totalsBase);

  const toPath = (pts, from, to) =>
    pts.slice(from, to + 1)
       .map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1))
       .join(" ");

  // Actual = indices 0..TODAY_MONTH inclusive. Projection = TODAY_MONTH..11.
  // The projection path starts at TODAY_MONTH so the two meet.
  const allActualPath  = toPath(ptsAll,  0, TODAY_MONTH);
  const allProjPath    = toPath(ptsAll,  TODAY_MONTH, 11);
  const baseActualPath = toPath(ptsBase, 0, TODAY_MONTH);
  const baseProjPath   = toPath(ptsBase, TODAY_MONTH, 11);
  const allActualArea =
    allActualPath +
    ` L${ptsAll[TODAY_MONTH][0].toFixed(1)},${(padT + plotH).toFixed(1)}` +
    ` L${ptsAll[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  // Y-axis ticks (4 bands).
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: padT + plotH - t * plotH,
    v: t * yMax,
  }));

  // Hover state — tracked in DOM to avoid re-rendering the whole SVG per move.
  const [hoverIdx, setHoverIdx] = useState(null);
  const onMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < padL - step / 2 || x > padL + plotW + step / 2) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.max(0, Math.min(11, Math.round((x - padL) / step)));
    setHoverIdx(idx);
  };

  const ytdActualAll  = totalsAll.slice(0, TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const ytdActualBase = totalsBase.slice(0, TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const projRemAll    = totalsAll.slice(TODAY_MONTH + 1).reduce((a, b) => a + b, 0);
  const projRemBase   = totalsBase.slice(TODAY_MONTH + 1).reduce((a, b) => a + b, 0);

  return (
    <div className="chart-wrap">
      <div className="chart-kpis">
        <div className="kpi">
          <div className="kpi-label">YTD Actual</div>
          <div className="kpi-val">{fmtMoney(ytdActualAll, false)}</div>
          <div className="kpi-sub">w/o Orange · {fmtMoney(ytdActualBase, false)}</div>
        </div>
        <div className="kpi-sep"/>
        <div className="kpi">
          <div className="kpi-label">Projection remaining</div>
          <div className="kpi-val ink-soft">{fmtMoney(projRemAll, false)}</div>
          <div className="kpi-sub">w/o Orange · {fmtMoney(projRemBase, false)}</div>
        </div>
        <div className="kpi-sep"/>
        <div className="kpi">
          <div className="kpi-label">Full year</div>
          <div className="kpi-val mono-xl">{fmtMoney(ytdActualAll + projRemAll, false)}</div>
          <div className="kpi-sub">w/o Orange · {fmtMoney(ytdActualBase + projRemBase, false)}</div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="flow-chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Invoice flow chart"
      >
        <defs>
          <linearGradient id="flowFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="var(--prob-orange)" stopOpacity="0.28"/>
            <stop offset="100%" stopColor="var(--prob-orange)" stopOpacity="0.02"/>
          </linearGradient>
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
                x={ptsAll[i][0]} y={H - 14}
                textAnchor="middle"
                className={"chart-month" + (i === TODAY_MONTH ? " is-today" : "")}>
            {m}
          </text>
        ))}

        {/* Today marker */}
        <line
          x1={ptsAll[TODAY_MONTH][0]} x2={ptsAll[TODAY_MONTH][0]}
          y1={padT} y2={padT + plotH}
          className="chart-today"/>

        {/* Area fill under the WITH-ORANGE line — the primary envelope. */}
        <path d={allActualArea} fill="url(#flowFill)"/>

        {/* Without-Orange baseline — drawn before the primary so the amber
            (with-Orange) sits on top when they coincide. Both series always
            render so the chart reads as "base vs. total" even in years
            with no Orange activity (lines just overlap in that case). */}
        <path d={baseActualPath} fill="none" className="chart-actual-base"/>
        <path d={baseProjPath}   fill="none" className="chart-proj-base"/>

        {/* With-Orange total — primary line. */}
        <path d={allActualPath} fill="none" className="chart-actual"/>
        <path d={allProjPath}   fill="none" className="chart-proj"/>

        {/* Data dots — base series behind, primary series on top. */}
        {ptsBase.map((p, i) => (
          <circle key={`b${i}`} cx={p[0]} cy={p[1]} r={3}
                  className={i <= TODAY_MONTH ? "chart-dot actual-base" : "chart-dot proj-base"}/>
        ))}
        {ptsAll.map((p, i) => (
          <circle key={`a${i}`} cx={p[0]} cy={p[1]} r={3.5}
                  className={i <= TODAY_MONTH ? "chart-dot actual" : "chart-dot proj"}/>
        ))}

        {/* Hover readout — always shows both values. */}
        {hoverIdx != null && (
          <g>
            <line x1={ptsAll[hoverIdx][0]} x2={ptsAll[hoverIdx][0]}
                  y1={padT} y2={padT + plotH}
                  className="chart-hover-line"/>
            <circle cx={ptsAll[hoverIdx][0]} cy={ptsAll[hoverIdx][1]}
                    r={6} className="chart-hover-dot"/>
            <circle cx={ptsBase[hoverIdx][0]} cy={ptsBase[hoverIdx][1]}
                    r={5} className="chart-hover-dot-base"/>
            {(() => {
              const x = ptsAll[hoverIdx][0];
              const y = ptsAll[hoverIdx][1];
              const boxW = 180, boxH = 66;
              const left = Math.min(W - padR - boxW, Math.max(padL, x - boxW / 2));
              const top  = Math.max(padT, y - boxH - 14);
              return (
                <g transform={`translate(${left},${top})`}>
                  <rect width={boxW} height={boxH} rx={8}
                        className="chart-tip-bg"/>
                  <text x={12} y={18} className="chart-tip-label">
                    {MONTHS[hoverIdx]} {THIS_YEAR} · {hoverIdx <= TODAY_MONTH ? "Actual" : "Projection"}
                  </text>
                  <text x={12} y={38} className="chart-tip-val">
                    {fmtMoney(totalsAll[hoverIdx], false)}
                  </text>
                  <text x={12} y={56} className="chart-tip-sub">
                    w/o Orange · {fmtMoney(totalsBase[hoverIdx], false)}
                  </text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>

      <div className="chart-legend">
        <span><span className="swatch actual"/>With Orange · total</span>
        <span><span className="swatch actual-base"/>Without Orange · base</span>
        <span><span className="swatch proj"/>Projection · forecast</span>
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
