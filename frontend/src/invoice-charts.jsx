import React, { useMemo, useState, useRef, useEffect } from "react";
import { Icon } from "./icons.jsx";
import { fmtMoney, isActualInvoiceMonth, THIS_YEAR, TODAY_MONTH } from "./data.js";

// ============================================================================
// InvoiceCharts — Engineering + Project Management cash-flow charts.
//
// Originally lived at the top-left quadrant of the Quad Sheet. The Quad Sheet
// page was retired (2026-05) — the two charts moved verbatim to the top of
// the Invoice tab.
//
// As of the rolling-window rework the charts follow the SAME sliding month
// window as the InvoiceTable: a `windowMonths` descriptor list (default = prev
// 3 + current + next 12 = 16 months) that crosses calendar years. Each bar
// sums the merged rows' MSMM PORTION for that month — the same msmmAtDesc
// math as the InvoiceTable's parent rows and grand-total rows (per-month MSMM
// override wins; else year total − Σ sub amounts) — so the bars, tooltips,
// and the table's "Total — excl./incl. Orange" rows reconcile exactly. This
// needs the `subInvoices` matrix (Map<project_id, sub_entry[]>) from App.
// Actual vs projection is decided per (year, month) via isActualInvoiceMonth.
//
// Behavior preserved: ENG up top, collapsible PM below; Pair/Average view
// toggle (ENG only — PM has no Orange); benchmark coloring; hover tooltip.
// ============================================================================

export const InvoiceCharts = ({ rows = [], windowMonths = [], orangeSourceIds, monthlyBenchmark, subInvoices }) => {
  const [pmCollapsed, setPmCollapsed] = useState(() => {
    try { return localStorage.getItem("beacon.quadPmCollapsed") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("beacon.quadPmCollapsed", pmCollapsed ? "1" : "0"); }
    catch { /* storage disabled — fine */ }
  }, [pmCollapsed]);

  const [chartView, setChartView] = useState(() => {
    try {
      const v = localStorage.getItem("beacon.chartView");
      return v === "average" ? "average" : "pair";
    } catch { return "pair"; }
  });
  useEffect(() => {
    try { localStorage.setItem("beacon.chartView", chartView); }
    catch { /* storage disabled — fine */ }
  }, [chartView]);

  // Hard split by invoice_type_enum so the Invoice view shows Engineering
  // and PM revenue as independent stories. Rows with a missing/unknown type
  // default to ENG (see adaptInvoice in data.js), so the union is exhaustive.
  const invoiceEng = rows.filter(r => (r.type || "ENG") === "ENG");
  const invoicePm  = rows.filter(r => r.type === "PM");

  const rangeLabel = windowMonths.length
    ? `${windowMonths[0].label} – ${windowMonths[windowMonths.length - 1].label}`
    : `${THIS_YEAR}`;

  return (
    <section className="quad-card inv-charts-card" data-accent="flow">
      <header className="quad-head">
        <div className="quad-eyebrow">Cash Flow</div>
        <h2 className="quad-title">Anticipated Invoice</h2>
        <div className="quad-sub-row">
          <div className="quad-sub">{rangeLabel} · monthly MSMM billing — actual vs. projection (matches the table totals)</div>
        </div>
      </header>
      <div className="quad-body">
        <div className={"invoice-chart-stack" + (pmCollapsed ? " pm-collapsed" : "")}>
          <InvoiceChart
            eyebrow="Engineering · ENG"
            rows={invoiceEng}
            windowMonths={windowMonths}
            orangeSourceIds={orangeSourceIds}
            monthlyBenchmark={monthlyBenchmark}
            subInvoices={subInvoices}
            view={chartView}
            onViewChange={setChartView}
          />

          {pmCollapsed ? (
            <button
              type="button"
              className="invoice-chart-toggle collapsed"
              onClick={() => setPmCollapsed(false)}
              aria-expanded="false"
              aria-label="Show PM chart"
            >
              <span className="chart-eyebrow-mark"/>
              <span className="invoice-chart-toggle-label">
                Project Management · PM
              </span>
              <span className="invoice-chart-toggle-count">
                {invoicePm.length} {invoicePm.length === 1 ? "row" : "rows"}
              </span>
              <span className="invoice-chart-toggle-action">
                <Icon name="chevronDown" size={12}/>Show
              </span>
            </button>
          ) : (
            <>
              <div className="invoice-chart-divider" aria-hidden="true"/>
              <div className="invoice-chart-pm-wrap">
                <button
                  type="button"
                  className="invoice-chart-hide-btn"
                  onClick={() => setPmCollapsed(true)}
                  aria-expanded="true"
                  aria-label="Hide PM chart"
                  title="Hide PM chart"
                >
                  <Icon name="eyeOff" size={11}/>Hide
                </button>
                <InvoiceChart
                  eyebrow="Project Management · PM"
                  rows={invoicePm}
                  windowMonths={windowMonths}
                  orangeSourceIds={orangeSourceIds}
                  subInvoices={subInvoices}
                  view={chartView}
                  /* No onViewChange — PM doesn't render the toggle UI. */
                  /* No benchmark — engineering-revenue only. */
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
};

// ============================================================================
// InvoiceChart — one bar per visible month, color-graded by benchmark verdict.
// ============================================================================
const NICE_LADDER = [1.0, 1.2, 1.4, 1.6, 2.0, 2.4, 2.8, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0];
const niceChartMax = (peak) => {
  const safePeak = Math.max(Number(peak) || 0, 1);
  const target = safePeak * 1.04;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const ratio = target / mag;
  const nice = NICE_LADDER.find((x) => x >= ratio) ?? 10.0;
  return nice * mag;
};

const InvoiceChart = ({ rows = [], windowMonths = [], orangeSourceIds, monthlyBenchmark, subInvoices, eyebrow, view = "pair", onViewChange }) => {
  const N = Math.max(1, windowMonths.length);
  // Per-window-month totals — each row contributes its MSMM PORTION for the
  // month, mirroring the InvoiceTable's msmmAtDesc exactly (the per-month
  // MSMM override wins; else year total − Σ that month's sub amounts). This
  // is what the table's "Total — excl./incl. Orange" rows sum, so the chart
  // and the table can never disagree:
  //   totalsBase — invoices NOT sourced from an Orange potential (secured)
  //   totalsAll  — all invoices (base + Orange pre-awarded)
  //   totalsAvg  — midpoint of the two (the Average view)
  const { totalsBase, totalsAll, totalsAvg } = useMemo(() => {
    const subListFor = (r) =>
      (subInvoices?.get(r.sourceId) || []).filter(s => (s.kind || "sub") === "sub");
    const msmmAtDesc = (r, d) => {
      const yr = r.byYear?.[d.year];
      if (!yr) return 0;
      // MSMM is purely derived — stored override is no longer consulted.
      const total = Number(yr.values?.[d.monthIdx] || 0);
      const subSum = subListFor(r).reduce(
        (a, s) => a + Number(s.byYear?.[d.year]?.amounts?.[d.monthIdx] || 0), 0);
      return total - subSum;
    };
    const totalsBase = Array(N).fill(0);
    const totalsAll  = Array(N).fill(0);
    for (const r of rows) {
      const isOrange = !!(r.sourceId && orangeSourceIds?.has(r.sourceId));
      windowMonths.forEach((d, wi) => {
        const v = msmmAtDesc(r, d);
        totalsAll[wi] += v;
        if (!isOrange) totalsBase[wi] += v;
      });
    }
    const totalsAvg = totalsAll.map((v, i) => (v + totalsBase[i]) / 2);
    return { totalsBase, totalsAll, totalsAvg };
  }, [rows, windowMonths, orangeSourceIds, subInvoices, N]);

  // Actual / projection split is per (year, month). The actual months form a
  // contiguous prefix of the window (past → present), so lastActualWi is the
  // boundary and actualCount = lastActualWi + 1.
  const lastActualWi = useMemo(
    () => windowMonths.reduce((acc, d, wi) => (isActualInvoiceMonth(d.year, d.monthIdx) ? wi : acc), -1),
    [windowMonths]);
  const actualCount = lastActualWi + 1;
  const isProjWi = (wi) => wi > lastActualWi;
  const todayWi = windowMonths.findIndex(d => d.year === THIS_YEAR && d.monthIdx === TODAY_MONTH);

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
  const hasBenchmark = Number(monthlyBenchmark) > 0;
  const CHIP_W = 96;
  const CHIP_H = 26;
  const padL = 56;
  const padR = hasBenchmark ? CHIP_W + 18 : 24;
  const padT = 24;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const slot = plotW / N;
  const hasOrange = rows.some(r => r.sourceId && orangeSourceIds?.has(r.sourceId));
  const isAvgView = view === "average" && hasOrange;
  const visibleBarValues = isAvgView
    ? totalsAvg
    : (hasOrange ? totalsBase.concat(totalsAll) : totalsAll);
  const yMax = niceChartMax(Math.max(...visibleBarValues, 1));
  const PAIR_GAP = 3;
  const barW = (hasOrange && !isAvgView)
    ? Math.max(6, Math.min(26, slot * 0.30))
    : Math.max(8, Math.min(54, slot * 0.62));
  const slotCx = (i) => padL + slot * i + slot / 2;
  const baseBarX = (i) =>
    (hasOrange && !isAvgView) ? slotCx(i) - barW - PAIR_GAP / 2 : slotCx(i) - barW / 2;
  const allBarX  = (i) => slotCx(i) + PAIR_GAP / 2;
  const yFor = (v) => padT + plotH - (v / yMax) * plotH;

  const rawBenchmarkY = hasBenchmark ? yFor(Number(monthlyBenchmark)) : null;
  const benchmarkY = hasBenchmark
    ? Math.max(padT, Math.min(padT + plotH, rawBenchmarkY))
    : null;
  const chipCy = hasBenchmark
    ? Math.max(padT + CHIP_H / 2, Math.min(H - padB + CHIP_H / 2, benchmarkY))
    : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: padT + plotH - t * plotH,
    v: t * yMax,
  }));

  const [hoverIdx, setHoverIdx] = useState(null);
  const onMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < padL || x > padL + plotW) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.max(0, Math.min(N - 1, Math.floor((x - padL) / slot)));
    setHoverIdx(idx);
  };

  const verdictFor = (i) => {
    if (!hasBenchmark) return "neutral";
    const v = isAvgView ? totalsAvg[i] : totalsAll[i];
    return v >= Number(monthlyBenchmark) ? "above" : "below";
  };

  const ytdActualAll  = totalsAll.slice(0, actualCount).reduce((a, b) => a + b, 0);
  const ytdActualBase = totalsBase.slice(0, actualCount).reduce((a, b) => a + b, 0);
  const projRemAll    = totalsAll.slice(actualCount).reduce((a, b) => a + b, 0);
  const projRemBase   = totalsBase.slice(actualCount).reduce((a, b) => a + b, 0);
  const ytdAboveCount = hasBenchmark
    ? totalsAll.slice(0, actualCount).filter(v => v >= Number(monthlyBenchmark)).length
    : 0;

  const showViewToggle = !!onViewChange && hasOrange;

  return (
    <div className="chart-wrap">
      {(eyebrow || showViewToggle) && (
        <div className="chart-eyebrow-row">
          {eyebrow && (
            <div className="chart-eyebrow">
              <span className="chart-eyebrow-mark"/>
              <span>{eyebrow}</span>
            </div>
          )}
          {showViewToggle && (
            <div className="events-view-toggle chart-view-toggle"
                 role="tablist"
                 aria-label="Chart view">
              <button
                type="button" role="tab"
                aria-selected={view === "pair"}
                className={view === "pair" ? "active" : ""}
                onClick={() => onViewChange("pair")}
                title="Show with-Orange and without-Orange as side-by-side bars">
                Pair
              </button>
              <button
                type="button" role="tab"
                aria-selected={view === "average"}
                className={view === "average" ? "active" : ""}
                onClick={() => onViewChange("average")}
                title="Show a single bar at the midpoint of with/without Orange">
                Average
              </button>
            </div>
          )}
        </div>
      )}
      <div className="chart-kpis">
        <div className="kpi">
          <div className="kpi-label">Actual in view</div>
          <div className="kpi-val">{fmtMoney(ytdActualAll, false)}</div>
          {hasOrange && (
            <div className="kpi-sub">w/o Orange · {fmtMoney(ytdActualBase, false)}</div>
          )}
        </div>
        <div className="kpi-sep"/>
        <div className="kpi">
          <div className="kpi-label">Projection in view</div>
          <div className="kpi-val ink-soft">{fmtMoney(projRemAll, false)}</div>
          {hasOrange && (
            <div className="kpi-sub">w/o Orange · {fmtMoney(projRemBase, false)}</div>
          )}
        </div>
        <div className="kpi-sep"/>
        <div className="kpi">
          <div className="kpi-label">{hasBenchmark ? "Months on target" : "Window total"}</div>
          {hasBenchmark ? (
            <>
              <div className="kpi-val mono-xl">
                {ytdAboveCount}<span className="kpi-frac">/{Math.max(0, actualCount)}</span>
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

      <div className="chart-svg-wrap">
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
          {["above", "below", "neutral"].map((v) => (
            <pattern key={v} id={`hatch-${v}`}
                     patternUnits="userSpaceOnUse" width="6" height="6"
                     patternTransform="rotate(45)">
              <rect width="6" height="6" className={`hatch-bg verdict-${v}`}/>
              <line x1="0" y1="0" x2="0" y2="6" className={`hatch-line verdict-${v}`}/>
            </pattern>
          ))}
        </defs>

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

        {windowMonths.map((d, wi) => (
          <text key={d.abs}
                x={slotCx(wi)} y={H - 14}
                textAnchor="middle"
                className={"chart-month" + (wi === todayWi ? " is-today" : "")}>
            {(d.monthIdx === 0 || wi === 0) ? `${d.mon} '${d.yy}` : d.mon}
          </text>
        ))}

        {/* Actual/Projection divider — sits at the cutover boundary. */}
        {actualCount > 0 && actualCount < N && (
          <line
            x1={padL + slot * actualCount} x2={padL + slot * actualCount}
            y1={padT} y2={padT + plotH}
            className="chart-today"/>
        )}

        {hasBenchmark && (
          <line
            x1={padL} x2={W - padR}
            y1={benchmarkY} y2={benchmarkY}
            className="benchmark-line"
          />
        )}

        {totalsAll.map((vAll, i) => {
          const vBase = totalsBase[i];
          const vAvg  = totalsAvg[i];
          const isProj = isProjWi(i);
          const verdictAll  = verdictFor(i);
          const verdictBase = !hasBenchmark
            ? "neutral"
            : (vBase >= Number(monthlyBenchmark) ? "above" : "below");
          const verdictAvg  = !hasBenchmark
            ? "neutral"
            : (vAvg >= Number(monthlyBenchmark) ? "above" : "below");

          const yBottom = padT + plotH;
          const yTopAll  = yFor(vAll);
          const yTopBase = yFor(vBase);
          const yTopAvg  = yFor(vAvg);
          const heightAll  = Math.max(0, yBottom - yTopAll);
          const heightBase = Math.max(0, yBottom - yTopBase);
          const heightAvg  = Math.max(0, yBottom - yTopAvg);

          const projCls = isProj ? " proj" : " actual";
          const fillForVerdict = (v) => isProj ? `url(#hatch-${v})` : undefined;

          // Label on top of each ENG bar = the month's TOTAL value (what the
          // bar represents), not the amount above the target. The verdict class
          // still tints it above/below the benchmark when one is set.
          const showTotal = isAvgView && vAvg > 0;
          const totalText = fmtMoney(vAvg, false);
          const totalY = Math.max(padT + 12, yTopAvg - 8);

          if (isAvgView) {
            return (
              <g key={i} className={hoverIdx === i ? "bar-grp hover" : "bar-grp"}>
                <rect
                  x={slotCx(i) - barW / 2}
                  y={padT}
                  width={barW}
                  height={plotH}
                  rx="4"
                  className="bar-track"
                />
                {heightAvg > 0.5 && (
                  <rect
                    x={baseBarX(i)} y={yTopAvg}
                    width={barW} height={heightAvg}
                    rx="3"
                    className={`bar bar-avg verdict-${verdictAvg}${projCls}`}
                    fill={fillForVerdict(verdictAvg)}
                  />
                )}
                {vAvg > 0 && (
                  <line
                    x1={baseBarX(i)} x2={baseBarX(i) + barW}
                    y1={yTopAvg} y2={yTopAvg}
                    className={`bar-cap verdict-${verdictAvg}`}
                  />
                )}
                {showTotal && (
                  <text
                    x={slotCx(i)} y={totalY}
                    textAnchor="middle"
                    className={`chart-bar-diff verdict-${verdictAvg}`}
                  >
                    {totalText}
                  </text>
                )}
              </g>
            );
          }

          return (
            <g key={i} className={hoverIdx === i ? "bar-grp hover" : "bar-grp"}>
              <rect
                x={slotCx(i) - (hasOrange ? barW + PAIR_GAP/2 : barW / 2)}
                y={padT}
                width={hasOrange ? barW * 2 + PAIR_GAP : barW}
                height={plotH}
                rx="4"
                className="bar-track"
              />

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

        {hasBenchmark && (
          <g className="benchmark">
            <line
              x1={W - padR} y1={benchmarkY}
              x2={W - padR + 8} y2={chipCy}
              className="benchmark-line"
            />
            <g transform={`translate(${W - padR + 8},${chipCy})`}>
              <polygon
                points="0,-5 5,0 0,5"
                className="benchmark-chip-pointer"
              />
              <rect
                x={5} y={-CHIP_H / 2}
                width={CHIP_W - 8} height={CHIP_H}
                rx={7}
                className="benchmark-chip-bg"
              />
              <text x={13} y={-2} className="benchmark-chip-label">TARGET</text>
              <text
                x={CHIP_W - 6} y={10}
                textAnchor="end"
                className="benchmark-chip-val"
              >
                {fmtMoney(monthlyBenchmark, false)}
              </text>
            </g>
          </g>
        )}

        {hoverIdx != null && windowMonths[hoverIdx] && (() => {
          const d = windowMonths[hoverIdx];
          const vAll  = totalsAll[hoverIdx];
          const vBase = totalsBase[hoverIdx];
          const vAvg  = totalsAvg[hoverIdx];
          const v = isAvgView ? vAvg : vAll;
          const verdict = verdictFor(hoverIdx);
          const isProj = isProjWi(hoverIdx);
          const x = slotCx(hoverIdx);
          const yTop = yFor(v);
          const lines = [];
          lines.push({ y: 18, cls: "chart-tip-label", text: `${d.mon} ${d.year} · ${isProj ? "Projection" : "Actual"}` });
          lines.push({ y: 38, cls: `chart-tip-val verdict-${verdict}`, text: fmtMoney(v, false) + (isAvgView ? " avg" : "") });
          if (isAvgView) {
            lines.push({ y: 56, cls: "chart-tip-sub", text: `range · ${fmtMoney(vBase, false)} – ${fmtMoney(vAll, false)}` });
          } else if (hasOrange) {
            lines.push({ y: 56, cls: "chart-tip-sub", text: `w/o Orange · ${fmtMoney(vBase, false)}` });
          }
          if (hasBenchmark) {
            const diff = v - Number(monthlyBenchmark);
            lines.push({
              y: (isAvgView || hasOrange) ? 74 : 56,
              cls: `chart-tip-diff verdict-${verdict}`,
              text: `${diff >= 0 ? "▲ " : "▼ "}${fmtMoney(Math.abs(diff), false)} vs target`,
            });
          }
          const lastY = lines[lines.length - 1].y;
          const boxW = 220;
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
      </div>

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
          isAvgView ? (
            <span className="legend-pair">
              <span className="swatch pair-avg"/>Average · w/o + with Orange
            </span>
          ) : (
            <span className="legend-pair">
              <span className="swatch pair-base"/>w/o Orange
              <span className="swatch pair-all"/>with Orange
            </span>
          )
        )}
        <span><span className="swatch hatched"/>Projection</span>
        <span><span className="swatch today"/>Today</span>
      </div>
    </div>
  );
};

export default InvoiceCharts;
