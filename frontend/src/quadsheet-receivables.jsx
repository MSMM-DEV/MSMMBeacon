import React, { useMemo, useState } from "react";
import { Icon } from "./icons.jsx";
import { fmtMoney, fmtDate, MONTHS, companyById, getCompanies, getInvoiceFileSignedUrl } from "./data.js";

// ============================================================================
// Subs Receivables — sub-centric inversion of the project-centric Invoice tab.
// ----------------------------------------------------------------------------
// The Invoice table reads "for this project, who are the subs and what have
// we billed them?". Executives want the reverse lens: "for each sub firm we
// engage, where's our money?". This panel pivots subInvoicesMatrix by sub
// company and exposes three levels of drill-down:
//
//   L1  Sub firm — Contract · Billed · Pending · Remaining (across all projects)
//   L2  Per-project breakdown — same four numbers, scoped to one project
//   L3  Monthly billing ledger — derived from the 12 month columns + per-month
//       paid flag + per-month uploaded files (the user's mental model of
//       "billing history" is implemented here as that derived ledger; there
//       is no separate billings table)
//
// "Pending" = sum of monthly amounts where paid=false. "Billed" = sum where
// paid=true. "Remaining" = contract − billed − pending. Remaining can go
// negative when a sub overruns their contract; we display that in red rather
// than clamping to zero so the variance is visible to execs.
// ============================================================================

export const SubsReceivablesPanel = ({ subInvoices, projectsById, onOpenProject }) => {
  const subs = useMemo(
    () => pivotSubsReceivables(subInvoices, projectsById),
    [subInvoices, projectsById]
  );

  const [sortKey, setSortKey] = useState("pending");
  const [showFullyPaid, setShowFullyPaid] = useState(false);
  const [expandedSubs, setExpandedSubs] = useState(() => new Set());
  const [expandedHistory, setExpandedHistory] = useState(() => new Set());
  const [query, setQuery] = useState("");

  const toggleSub = (id) => setExpandedSubs(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleHistory = (key) => setExpandedHistory(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = subs;
    if (q) arr = arr.filter(s => s.companyName.toLowerCase().includes(q));
    return arr;
  }, [subs, query]);

  const sorted = useMemo(() => {
    const arr = filtered.slice();
    arr.sort((a, b) => {
      // Primary: chosen metric (desc). Tie-break: name asc, so the order
      // is stable when two subs are at $0 on the chosen axis.
      const ka = sortKey === "pending" ? a.totalPending : a.totalBilled;
      const kb = sortKey === "pending" ? b.totalPending : b.totalBilled;
      if (kb !== ka) return kb - ka;
      return a.companyName.localeCompare(b.companyName);
    });
    return arr;
  }, [filtered, sortKey]);

  // Sticky workspace totals — at-a-glance for the exec scanning the section.
  const totals = useMemo(() => {
    const t = { contract: 0, billed: 0, pending: 0, remaining: 0 };
    for (const s of sorted) {
      t.contract  += s.totalContract;
      t.billed    += s.totalBilled;
      t.pending   += s.totalPending;
      t.remaining += s.totalRemaining;
    }
    return t;
  }, [sorted]);

  return (
    <section className="quad-card recv-card" data-accent="recv">
      <header className="quad-head recv-head">
        <div className="recv-head-l">
          <div className="quad-eyebrow">05 · Receivables</div>
          <h2 className="quad-title">Subs · Outstanding Invoices</h2>
          <div className="quad-sub">
            {sorted.length} {sorted.length === 1 ? "sub firm" : "sub firms"}
            {" · "}
            <span className="recv-head-sub-num">{fmtMoney(totals.pending, false)}</span>
            {" pending across the book"}
          </div>
        </div>
        <div className="recv-head-r">
          <input
            className="recv-search"
            type="search"
            placeholder="Filter by sub name…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Filter receivables by sub name"
          />
          <div className="events-view-toggle recv-toggle" role="tablist" aria-label="Sort receivables">
            <button
              type="button" role="tab"
              aria-selected={sortKey === "pending"}
              className={sortKey === "pending" ? "active" : ""}
              onClick={() => setSortKey("pending")}>
              Pending
            </button>
            <button
              type="button" role="tab"
              aria-selected={sortKey === "paid"}
              className={sortKey === "paid" ? "active" : ""}
              onClick={() => setSortKey("paid")}>
              Paid
            </button>
          </div>
        </div>
      </header>

      <div className="recv-col-legend" aria-hidden="true">
        <div className="recv-legend-name"></div>
        <div className="recv-legend-num">Contract</div>
        <div className="recv-legend-num">Billed</div>
        <div className="recv-legend-num">Pending</div>
        <div className="recv-legend-num">Remaining</div>
        <div className="recv-legend-meter">% Paid</div>
      </div>

      <div className="recv-body">
        {sorted.length === 0 ? (
          <div className="quad-empty recv-empty">
            {query
              ? `No subs match "${query}".`
              : "No sub receivables yet — tag subs on projects and bill them to populate this view."}
          </div>
        ) : (
          <ul className="recv-list">
            {sorted.map(sub => {
              const isOpen = expandedSubs.has(sub.companyId);
              const visibleProjects = showFullyPaid
                ? sub.projects
                : sub.projects.filter(p => p.pending > 0);
              const projectCount = visibleProjects.length;
              const denom = sub.totalContract || 1;
              const paidPct = Math.max(0, Math.min(100, (sub.totalBilled / denom) * 100));
              const pendingPct = Math.max(0, Math.min(100 - paidPct, (sub.totalPending / denom) * 100));
              const tone = sub.totalPending === 0 && sub.totalBilled > 0 ? "settled"
                : sub.totalPending > sub.totalBilled ? "high"
                : "active";
              return (
                <li key={sub.companyId}
                    className={"recv-sub" + (isOpen ? " open" : "") + ` tone-${tone}` + (sub.isMsmm ? " is-msmm" : "")}>
                  <button
                    type="button"
                    className="recv-sub-row"
                    onClick={() => toggleSub(sub.companyId)}
                    aria-expanded={isOpen}>
                    <span className="recv-name">
                      <span className={"recv-chev" + (isOpen ? " open" : "")} aria-hidden="true">
                        <Icon name="chevronRight" size={11}/>
                      </span>
                      <span className="recv-name-text">{sub.companyName}</span>
                      {sub.isMsmm && (
                        <span className="recv-msmm-badge" title="MSMM acts as sub on these projects — pending = money owed TO us">
                          As Sub
                        </span>
                      )}
                      <span className="recv-projects-pill">
                        {sub.projects.length} {sub.projects.length === 1 ? "project" : "projects"}
                      </span>
                    </span>
                    <span className="recv-num mono">{fmtMoney(sub.totalContract, false)}</span>
                    <span className="recv-num mono recv-num-billed">{fmtMoney(sub.totalBilled, false)}</span>
                    <span className={"recv-num mono recv-num-pending" + (sub.totalPending > 0 ? " is-pending" : "")}>
                      {fmtMoney(sub.totalPending, false)}
                    </span>
                    <span className={"recv-num mono recv-num-remaining" + (sub.totalRemaining < 0 ? " is-overrun" : "")}>
                      {fmtMoney(sub.totalRemaining, false)}
                    </span>
                    <span className="recv-meter" aria-label={`${Math.round(paidPct)}% paid`}>
                      <span className="recv-meter-fill paid"  style={{ width: `${paidPct}%` }}/>
                      <span className="recv-meter-fill pending" style={{ width: `${pendingPct}%`, left: `${paidPct}%` }}/>
                      <span className="recv-meter-pct mono">{Math.round(paidPct)}%</span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="recv-sub-body">
                      <div className="recv-sub-toolbar">
                        <span className="recv-sub-toolbar-l">
                          {projectCount} of {sub.projects.length}
                          {showFullyPaid ? " · all projects" : " · with pending"}
                        </span>
                        {sub.projects.length > visibleProjects.length || showFullyPaid ? (
                          <button
                            type="button"
                            className={"recv-link-btn" + (showFullyPaid ? " is-on" : "")}
                            onClick={() => setShowFullyPaid(v => !v)}>
                            {showFullyPaid
                              ? <>Hide fully-paid <Icon name="chevronDown" size={9}/></>
                              : <>Show fully-paid ({sub.projects.length - visibleProjects.length}) <Icon name="chevronDown" size={9}/></>}
                          </button>
                        ) : null}
                      </div>

                      {projectCount === 0 ? (
                        <div className="recv-empty-inline">
                          All projects with this sub are fully paid.
                        </div>
                      ) : (
                        <ul className="recv-projects">
                          {visibleProjects.map(p => {
                            const histKey = `${sub.companyId}:${p.projectId}`;
                            const histOpen = expandedHistory.has(histKey);
                            const projectTone =
                              p.pending === 0 ? "settled" :
                              p.pending > p.billedToDate ? "high" : "active";
                            return (
                              <li key={p.projectId}
                                  className={"recv-project tone-" + projectTone + (histOpen ? " open" : "")}>
                                <div className="recv-project-row">
                                  <div className="recv-project-name">
                                    <span className="recv-project-title">{p.projectName || "Untitled project"}</span>
                                    <span className="recv-project-meta">
                                      {p.projectNumber && <span className="mono recv-project-pn">#{p.projectNumber}</span>}
                                      {p.year && <span className="recv-project-year">· {p.year}</span>}
                                      {p.primeFirmName && (
                                        <span className="recv-prime-chip"
                                              title={`MSMM is a sub on this project under ${p.primeFirmName}`}>
                                          Prime · {p.primeFirmName}
                                        </span>
                                      )}
                                      {p.statusKey && (
                                        <span className={`recv-status-chip status-${p.statusKey}`}>
                                          {labelForStatus(p.statusKey)}
                                        </span>
                                      )}
                                      {onOpenProject && (
                                        <button
                                          type="button"
                                          className="recv-open-btn"
                                          title="Open project"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            onOpenProject(p.statusKey, p.projectId);
                                          }}>
                                          <Icon name="forward" size={10}/>
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                  <span className="recv-num mono">{fmtMoney(p.contractAmount, false)}</span>
                                  <button
                                    type="button"
                                    className={"recv-num mono recv-billed-btn" + (histOpen ? " open" : "")}
                                    title={histOpen
                                      ? "Hide monthly billing"
                                      : `${p.billingEntries.length} billing entries`}
                                    aria-expanded={histOpen}
                                    onClick={() => toggleHistory(histKey)}
                                    disabled={p.billingEntries.length === 0}>
                                    <span className="recv-billed-chev"><Icon name="chevronRight" size={9}/></span>
                                    {fmtMoney(p.billedToDate, false)}
                                  </button>
                                  <span className={"recv-num mono recv-num-pending" + (p.pending > 0 ? " is-pending" : "")}>
                                    {fmtMoney(p.pending, false)}
                                  </span>
                                  <span className={"recv-num mono recv-num-remaining" + (p.remaining < 0 ? " is-overrun" : "")}>
                                    {fmtMoney(p.remaining, false)}
                                  </span>
                                  <span className="recv-meter recv-meter-sm">
                                    <span className="recv-meter-fill paid"
                                          style={{ width: `${Math.max(0, Math.min(100, (p.billedToDate / (p.contractAmount || 1)) * 100))}%` }}/>
                                  </span>
                                </div>

                                {histOpen && p.billingEntries.length > 0 && (
                                  <div className="recv-history">
                                    <div className="recv-history-head">
                                      <span>Month</span>
                                      <span className="recv-history-amt">Amount</span>
                                      <span>Status</span>
                                      <span>Files</span>
                                    </div>
                                    <ul className="recv-history-list">
                                      {p.billingEntries.map((b, idx) => (
                                        <li key={idx} className={"recv-history-row" + (b.paid ? " paid" : " pending")}>
                                          <span className="recv-history-month">
                                            <span className="recv-history-mo">{b.monthLabel}</span>
                                          </span>
                                          <span className="recv-num mono recv-history-amt">{fmtMoney(b.amount, false)}</span>
                                          <span className="recv-history-status">
                                            {b.paid
                                              ? <span className="chip sage" title={b.paidAt ? `Paid · ${fmtDate(b.paidAt)}` : "Paid"}>
                                                  <Icon name="check" size={9}/>
                                                  Paid{b.paidAt ? <span className="recv-paid-at">· {fmtDate(b.paidAt)}</span> : null}
                                                </span>
                                              : <span className="chip recv-pending-chip">Pending</span>}
                                          </span>
                                          <span className="recv-history-files">
                                            {b.files.length === 0
                                              ? <span className="empty-cell">—</span>
                                              : (
                                                <button
                                                  type="button"
                                                  className="recv-files-pill"
                                                  title={`Open ${b.files[0].file_name || "invoice"}${b.files.length > 1 ? ` (+${b.files.length - 1} more — drill into project for all)` : ""}`}
                                                  onClick={async (e) => {
                                                    e.stopPropagation();
                                                    try {
                                                      const url = await getInvoiceFileSignedUrl(b.files[0].file_path, 60);
                                                      if (url) window.open(url, "_blank", "noopener,noreferrer");
                                                    } catch { /* signed URL flake — silent fail; user can retry */ }
                                                  }}>
                                                  <Icon name="link" size={10}/>
                                                  {b.files.length} {b.files.length === 1 ? "file" : "files"}
                                                </button>
                                              )}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {sorted.length > 0 && (
        <footer className="recv-foot">
          <span className="recv-foot-label">Totals</span>
          <span className="recv-num mono">{fmtMoney(totals.contract, false)}</span>
          <span className="recv-num mono">{fmtMoney(totals.billed, false)}</span>
          <span className={"recv-num mono recv-num-pending" + (totals.pending > 0 ? " is-pending" : "")}>
            {fmtMoney(totals.pending, false)}
          </span>
          <span className={"recv-num mono recv-num-remaining" + (totals.remaining < 0 ? " is-overrun" : "")}>
            {fmtMoney(totals.remaining, false)}
          </span>
          <span className="recv-foot-pct mono">
            {totals.contract > 0
              ? `${Math.round((totals.billed / totals.contract) * 100)}% paid`
              : "—"}
          </span>
        </footer>
      )}
    </section>
  );
};

// ----------------------------------------------------------------------------
// Pivot — flatten subInvoicesMatrix into a sub-centric structure.
// ----------------------------------------------------------------------------
// Two flavors of entry exist in subInvoicesMatrix:
//
//   kind='sub'   — MSMM is Prime on the project; the entry's company is a
//                  downstream sub MSMM hires. The amounts are invoices the
//                  sub bills MSMM (money MSMM owes them). Bucket per sub.
//
//   kind='prime' — MSMM is Sub on the project; the entry's company is the
//                  upstream prime firm that hired MSMM. The amounts are
//                  invoices MSMM bills the prime (money owed TO MSMM).
//                  All such entries roll up under MSMM as the "sub" entity,
//                  with the upstream prime carried through as project context.
//
// Both flavors land in the same list — execs want a unified view of every
// invoicing relationship. The MSMM bucket gets an `isMsmm` flag the UI uses
// to render an "AS SUB" badge so viewers know that bucket represents
// receivables (money in) instead of payables (money out).
// ----------------------------------------------------------------------------
function pivotSubsReceivables(subInvoices, projectsById) {
  if (!subInvoices) return [];
  const byCompany = new Map();

  // Resolve MSMM once. The DB seeds exactly one company with is_msmm=true;
  // adaptCompany surfaces that as `isMsmm` on the cached company list.
  const msmm = (getCompanies() || []).find(c => c.isMsmm) || null;
  const msmmId = msmm?.id || "__msmm__"; // fallback synthetic id keeps the bucket distinct

  for (const [projectId, entries] of subInvoices) {
    const project = projectsById?.get(projectId);
    if (!project) continue; // skip orphan projects (e.g. only-in-invoice rows)
    for (const e of entries) {
      const isPrimeKind = e.kind === "prime";

      // For kind='sub' entries, drop anything whose company doesn't resolve
      // in the companies cache — that's an orphaned project_subs row
      // pointing at a deleted/missing company. The matrix builder
      // upstream stamps these as "Unknown company"; surfacing them in
      // the exec view is noise. (Data-quality issue worth fixing at the
      // source, but we don't want to leak it here.)
      if (!isPrimeKind) {
        const resolved = companyById(e.companyId);
        if (!resolved || !resolved.name) continue;
      }

      // Bucket key: kind='prime' rolls up under MSMM (since MSMM is the sub
      // on those projects); kind='sub' uses the sub firm's id directly.
      const bucketId = isPrimeKind ? msmmId : e.companyId;
      const bucketName = isPrimeKind
        ? (msmm?.name || "MSMM")
        : (e.companyName || companyById(e.companyId)?.name);

      const billingEntries = [];
      let billed = 0, pending = 0;
      for (let i = 0; i < 12; i++) {
        const amt = e.amounts?.[i];
        if (amt == null || amt === 0) continue;
        const paid = !!(e.paid && e.paid[i]);
        billingEntries.push({
          monthIdx: i,
          monthLabel: MONTHS[i],
          amount: amt,
          paid,
          paidAt: e.paidAt?.[i] || null,
          files: e.files?.[i] || [],
        });
        if (paid) billed += amt; else pending += amt;
      }

      const contract = e.contractAmount || 0;
      // Allow negative remaining — surfaces overruns visibly. Clamping would
      // hide the bad signal that the sub's been billed past their contract.
      const remaining = contract - billed - pending;

      let bucket = byCompany.get(bucketId);
      if (!bucket) {
        bucket = {
          companyId: bucketId,
          companyName: bucketName,
          isMsmm: isPrimeKind,
          projects: [],
          totalContract: 0,
          totalBilled: 0,
          totalPending: 0,
          totalRemaining: 0,
        };
        byCompany.set(bucketId, bucket);
      }
      bucket.projects.push({
        projectId,
        projectName: project.name,
        projectNumber: project.projectNumber,
        year: project.year,
        statusKey: project.statusKey,
        // For MSMM-as-sub rows, the entry's companyName is the upstream
        // prime firm (e.g. "Donald Bond"). The UI renders this as a
        // "Prime: <name>" chip on the project row so viewers know who
        // owes MSMM the money.
        primeFirmName: isPrimeKind ? (e.companyName || companyById(e.companyId)?.name || "") : null,
        contractAmount: contract,
        billedToDate: billed,
        pending,
        remaining,
        billingEntries,
      });
      bucket.totalContract  += contract;
      bucket.totalBilled    += billed;
      bucket.totalPending   += pending;
      bucket.totalRemaining += remaining;
    }
  }

  // Hide subs with zero activity entirely — no contract, no billing, no
  // pending. Otherwise empty rows clutter the executive view.
  const out = [];
  for (const sub of byCompany.values()) {
    if (sub.totalContract === 0 && sub.totalBilled === 0 && sub.totalPending === 0) continue;
    // Sort projects: pending desc primary, billed desc secondary, name asc tie-break.
    sub.projects.sort((a, b) => {
      if (b.pending !== a.pending) return b.pending - a.pending;
      if (b.billedToDate !== a.billedToDate) return b.billedToDate - a.billedToDate;
      return (a.projectName || "").localeCompare(b.projectName || "");
    });
    out.push(sub);
  }
  return out;
}

const labelForStatus = (statusKey) => ({
  potential: "Potential",
  awaiting: "Awaiting",
  awarded: "Awarded",
  closed: "Closed Out",
}[statusKey] || statusKey);
