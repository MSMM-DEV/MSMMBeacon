import React, { useMemo, useState } from "react";
import { Icon } from "./icons.jsx";
import { fmtMoney, MONTHS, companyById, getCompanies } from "./data.js";

// ============================================================================
// Subs Receivables — sub-centric inversion of the project-centric Invoice tab.
// ----------------------------------------------------------------------------
// Three-level drill-down — names first, numbers on demand:
//
//   L1  Sub firm name  (+ sort-metric chip on the right)
//   L2  Project names this sub is on
//   L3  Three numbers — Contract · Billed To Date · Pending
//
// Inclusion criterion: a sub appears only when at least one billing entry
// (any month, any project) is attached to it. Sub firms with a contract
// amount but no billing activity are hidden — execs care about active
// receivables, not idle relationships.
//
// Two flavors of entry land in the same list:
//
//   kind='sub'   — MSMM is Prime; the sub firm bills MSMM (money MSMM owes
//                  out). Bucket per sub firm.
//   kind='prime' — MSMM is Sub; MSMM bills the upstream prime firm (money
//                  owed TO MSMM). All such entries roll up under MSMM with
//                  the upstream prime carried as project context. The MSMM
//                  bucket gets an "AS SUB" badge so viewers know the
//                  pending-money direction is reversed.
// ============================================================================

export const SubsReceivablesPanel = ({ subInvoices, projectsById, onOpenProject }) => {
  const subs = useMemo(
    () => pivotSubsReceivables(subInvoices, projectsById),
    [subInvoices, projectsById]
  );

  const [sortKey, setSortKey] = useState("pending");
  const [expandedSubs, setExpandedSubs] = useState(() => new Set());
  const [expandedProjects, setExpandedProjects] = useState(() => new Set());
  const [query, setQuery] = useState("");

  const toggleSub = (id) => setExpandedSubs(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleProject = (key) => setExpandedProjects(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return subs;
    return subs.filter(s => s.companyName.toLowerCase().includes(q));
  }, [subs, query]);

  const sorted = useMemo(() => {
    const arr = filtered.slice();
    arr.sort((a, b) => {
      const ka = sortKey === "pending" ? a.totalPending : a.totalBilled;
      const kb = sortKey === "pending" ? b.totalPending : b.totalBilled;
      if (kb !== ka) return kb - ka;
      return a.companyName.localeCompare(b.companyName);
    });
    return arr;
  }, [filtered, sortKey]);

  const headlineNumber = sorted.reduce(
    (acc, s) => acc + (sortKey === "pending" ? s.totalPending : s.totalBilled),
    0
  );

  return (
    <section className="quad-card recv-card recv-v2" data-accent="recv">
      <header className="quad-head recv-head">
        <div className="recv-head-l">
          <div className="quad-eyebrow">05 · Receivables</div>
          <h2 className="quad-title">Outstanding Invoices</h2>
          <div className="quad-sub">
            {sorted.length === 0
              ? "No active sub receivables yet"
              : <>
                  {sorted.length} {sorted.length === 1 ? "sub" : "subs"}
                  {" · "}
                  <span className="recv-headline-num">{fmtMoney(headlineNumber, false)}</span>
                  {" "}{sortKey === "pending" ? "pending" : "billed"} across the book
                </>}
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

      <div className="recv-body">
        {sorted.length === 0 ? (
          <div className="recv-empty">
            {query
              ? <>No subs match "<strong>{query}</strong>".</>
              : "Once subs have invoice amounts entered against them, they'll appear here."}
          </div>
        ) : (
          <ul className="recv-subs">
            {sorted.map((sub, idx) => {
              const isOpen = expandedSubs.has(sub.companyId);
              const sortVal = sortKey === "pending" ? sub.totalPending : sub.totalBilled;
              return (
                <li key={sub.companyId}
                    className={"recv-sub" + (isOpen ? " open" : "") + (sub.isMsmm ? " is-msmm" : "")}
                    style={{ "--rank": idx + 1 }}>
                  <button
                    type="button"
                    className="recv-sub-row"
                    onClick={() => toggleSub(sub.companyId)}
                    aria-expanded={isOpen}>
                    <span className="recv-rank mono">{String(idx + 1).padStart(2, "0")}</span>
                    <span className={"recv-chev" + (isOpen ? " open" : "")} aria-hidden="true">
                      <Icon name="chevronRight" size={11}/>
                    </span>
                    <span className="recv-name-text">{sub.companyName}</span>
                    {sub.isMsmm && (
                      <span className="recv-msmm-badge"
                            title="MSMM is the sub on these projects — pending = money owed TO us">
                        As Sub
                      </span>
                    )}
                    <span className="recv-projects-pill">
                      {sub.projects.length} {sub.projects.length === 1 ? "project" : "projects"}
                    </span>
                    <span className="recv-spacer"/>
                    <span className={"recv-metric" + (sortVal > 0 ? ` is-${sortKey}` : " is-zero")}>
                      <span className="recv-metric-num mono">{fmtMoney(sortVal, false)}</span>
                      <span className="recv-metric-label">{sortKey}</span>
                    </span>
                  </button>

                  {isOpen && (
                    <ul className="recv-projects">
                      {sub.projects.map(p => {
                        const pkey = `${sub.companyId}:${p.projectId}`;
                        const pOpen = expandedProjects.has(pkey);
                        return (
                          <li key={pkey} className={"recv-project" + (pOpen ? " open" : "")}>
                            <button
                              type="button"
                              className="recv-project-row"
                              onClick={() => toggleProject(pkey)}
                              aria-expanded={pOpen}>
                              <span className={"recv-chev recv-chev-sm" + (pOpen ? " open" : "")} aria-hidden="true">
                                <Icon name="chevronRight" size={10}/>
                              </span>
                              <span className="recv-project-title">
                                {p.projectName || "Untitled project"}
                              </span>
                              <span className="recv-project-meta">
                                {p.projectNumber && (
                                  <span className="recv-project-pn mono">#{p.projectNumber}</span>
                                )}
                                {p.year && (
                                  <span className="recv-project-year">{p.year}</span>
                                )}
                                {p.statusKey && (
                                  <span className={`recv-status-chip status-${p.statusKey}`}>
                                    {labelForStatus(p.statusKey)}
                                  </span>
                                )}
                                {p.primeFirmName && (
                                  <span className="recv-prime-chip"
                                        title={`MSMM is sub under ${p.primeFirmName}`}>
                                    Prime · {p.primeFirmName}
                                  </span>
                                )}
                              </span>
                              <span className="recv-project-pulse" aria-hidden="true">
                                {p.pending > 0 && (
                                  <span className="pulse-dot pending"
                                        title={`${fmtMoney(p.pending, false)} pending`}/>
                                )}
                                {p.billedToDate > 0 && (
                                  <span className="pulse-dot paid"
                                        title={`${fmtMoney(p.billedToDate, false)} billed`}/>
                                )}
                              </span>
                            </button>

                            {pOpen && (
                              <ProjectDetail
                                project={p}
                                isMsmm={sub.isMsmm}
                                onOpen={() => onOpenProject?.(p.statusKey, p.projectId)}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};

// ----------------------------------------------------------------------------
// L3 — Project detail strip (Contract · Billed · Pending)
// ----------------------------------------------------------------------------
// The drill-down payoff. Three numbers, generously spaced, in mono-display
// type. For MSMM-as-sub the verbal labels shift slightly to reflect that
// the money flows the other way (Pending here = money the prime owes MSMM).
// ----------------------------------------------------------------------------
const ProjectDetail = ({ project, isMsmm, onOpen }) => {
  const pendingLabel = isMsmm ? "Pending Receipt" : "Pending";
  const billedLabel  = isMsmm ? "Received To Date" : "Billed To Date";
  return (
    <div className="recv-detail">
      <div className="recv-detail-strip">
        <div className="recv-kpi">
          <div className="recv-kpi-label">Contract</div>
          <div className={"recv-kpi-val mono" + (project.contractAmount === 0 ? " is-zero" : "")}>
            {project.contractAmount === 0
              ? <span className="recv-kpi-empty">— not set —</span>
              : fmtMoney(project.contractAmount, false)}
          </div>
        </div>
        <div className="recv-kpi-rule" aria-hidden="true"/>
        <div className="recv-kpi">
          <div className="recv-kpi-label">{billedLabel}</div>
          <div className={"recv-kpi-val mono" + (project.billedToDate > 0 ? " is-paid" : "")}>
            {fmtMoney(project.billedToDate, false)}
          </div>
          {project.billingEntries.filter(b => b.paid).length > 0 && (
            <div className="recv-kpi-sub">
              {project.billingEntries.filter(b => b.paid).length} paid invoice
              {project.billingEntries.filter(b => b.paid).length === 1 ? "" : "s"}
            </div>
          )}
        </div>
        <div className="recv-kpi-rule" aria-hidden="true"/>
        <div className="recv-kpi">
          <div className="recv-kpi-label">{pendingLabel}</div>
          <div className={"recv-kpi-val mono" + (project.pending > 0 ? " is-pending" : "")}>
            {fmtMoney(project.pending, false)}
          </div>
          {project.billingEntries.filter(b => !b.paid).length > 0 && (
            <div className="recv-kpi-sub">
              {project.billingEntries.filter(b => !b.paid).length} unpaid invoice
              {project.billingEntries.filter(b => !b.paid).length === 1 ? "" : "s"}
              {" · "}
              {monthsListFromEntries(project.billingEntries.filter(b => !b.paid))}
            </div>
          )}
        </div>
      </div>
      {onOpen && (
        <div className="recv-detail-actions">
          <button type="button" className="recv-open-link" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
            Open project<Icon name="forward" size={10}/>
          </button>
        </div>
      )}
    </div>
  );
};

const monthsListFromEntries = (entries) => {
  if (entries.length === 0) return "";
  const months = entries.map(e => e.monthLabel);
  if (months.length <= 3) return months.join(", ");
  return `${months.slice(0, 3).join(", ")} +${months.length - 3} more`;
};

// ----------------------------------------------------------------------------
// Pivot — flatten subInvoicesMatrix into a sub-centric structure.
// ----------------------------------------------------------------------------
function pivotSubsReceivables(subInvoices, projectsById) {
  if (!subInvoices) return [];
  const byCompany = new Map();

  // Resolve MSMM once. The DB seeds exactly one company with is_msmm=true;
  // adaptCompany surfaces that as `isMsmm` on the cached company list.
  // Synthetic id fallback keeps the bucket distinct even if the lookup
  // fails in some edge case.
  const msmm = (getCompanies() || []).find(c => c.isMsmm) || null;
  const msmmId = msmm?.id || "__msmm__";
  const msmmName = msmm?.name || "MSMM";

  for (const [projectId, entries] of subInvoices) {
    const project = projectsById?.get(projectId);
    if (!project) continue; // skip orphan projects (e.g. only-in-invoice rows)

    for (const e of entries) {
      const isPrimeKind = e.kind === "prime";

      // For kind='sub' entries, drop anything whose company doesn't resolve
      // in the companies cache — those are orphaned project_subs rows
      // pointing at a deleted/missing company. The matrix builder upstream
      // stamps these as "Unknown company"; surfacing them in the exec view
      // is noise.
      if (!isPrimeKind) {
        const resolved = companyById(e.companyId);
        if (!resolved || !resolved.name) continue;
      }

      // Compute billing entries up-front so we can decide whether to keep
      // this (sub, project) at all. Per the user spec: a sub appears only
      // when at least one invoice amount is attached.
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

      // Skip (sub, project) pairs with zero billing activity. A sub firm
      // that's contracted but never invoiced doesn't belong in the
      // outstanding-invoices ledger.
      if (billingEntries.length === 0) continue;

      const contract = e.contractAmount || 0;
      const remaining = contract - billed - pending;

      // Bucket key: kind='prime' rolls up under MSMM (since MSMM is the sub
      // on those projects); kind='sub' uses the sub firm's id directly.
      const bucketId = isPrimeKind ? msmmId : e.companyId;
      const bucketName = isPrimeKind
        ? msmmName
        : (e.companyName || companyById(e.companyId)?.name);

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

  // Order projects within each sub: pending desc, then billed desc, then
  // name asc. Same rule the user-facing sort uses at L1, applied locally.
  const out = [];
  for (const sub of byCompany.values()) {
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
