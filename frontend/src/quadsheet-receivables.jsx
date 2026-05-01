import React, { useMemo, useState } from "react";
import { Icon } from "./icons.jsx";
import { fmtMoney, fmtDate, MONTHS, companyById, getCompanies, getInvoiceFileSignedUrl } from "./data.js";

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
                    {sub.totalBilled === 0 && sub.totalPending === 0 ? (
                      // Contract-only sub: no invoices issued yet. Cleaner
                      // to flag this state than to show "$0 pending".
                      <span className="recv-metric is-empty">
                        <span className="recv-metric-num mono">{fmtMoney(sub.totalContract, false)}</span>
                        <span className="recv-metric-label">contract · no invoices</span>
                      </span>
                    ) : (
                      <span className={"recv-metric" + (sortVal > 0 ? ` is-${sortKey}` : " is-zero")}>
                        <span className="recv-metric-num mono">{fmtMoney(sortVal, false)}</span>
                        <span className="recv-metric-label">{sortKey}</span>
                      </span>
                    )}
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
//
// L4 — Per-invoice ledger: Billed and Pending are click-to-expand. Each
// expansion reveals the underlying monthly invoices that compose the total
// (month label · amount · file link), sorted Jan→Dec. Both can be open
// simultaneously; Contract isn't expandable since there's no list to show.
// ----------------------------------------------------------------------------
const ProjectDetail = ({ project, isMsmm, onOpen }) => {
  const pendingLabel = isMsmm ? "Pending Receipt" : "Pending";
  const billedLabel  = isMsmm ? "Received To Date" : "Billed To Date";

  const paidEntries    = useMemo(
    () => project.billingEntries.filter(b => b.paid).sort((a, b) => a.monthIdx - b.monthIdx),
    [project.billingEntries]
  );
  const pendingEntries = useMemo(
    () => project.billingEntries.filter(b => !b.paid).sort((a, b) => a.monthIdx - b.monthIdx),
    [project.billingEntries]
  );

  // Independent expansion state — Billed and Pending toggle separately.
  const [paidOpen,    setPaidOpen]    = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);

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

        <KpiExpandable
          label={billedLabel}
          value={project.billedToDate}
          tone="paid"
          entries={paidEntries}
          isOpen={paidOpen}
          onToggle={() => setPaidOpen(v => !v)}
        />
        <div className="recv-kpi-rule" aria-hidden="true"/>

        <KpiExpandable
          label={pendingLabel}
          value={project.pending}
          tone="pending"
          entries={pendingEntries}
          isOpen={pendingOpen}
          onToggle={() => setPendingOpen(v => !v)}
        />
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

// ----------------------------------------------------------------------------
// KpiExpandable — one of the two clickable KPIs (Billed / Pending). Renders
// the value + caption normally; on click, reveals an inline per-invoice
// ledger underneath. Disabled when there are no entries to show.
// ----------------------------------------------------------------------------
const KpiExpandable = ({ label, value, tone, entries, isOpen, onToggle }) => {
  const canExpand = entries.length > 0;
  const verbForm = tone === "paid" ? "paid" : "unpaid";
  const verbLabel = `${verbForm} invoice${entries.length === 1 ? "" : "s"}`;

  return (
    <div className={"recv-kpi recv-kpi-x" + (canExpand ? " is-clickable" : "") + (isOpen ? " open" : "")}>
      <button
        type="button"
        className="recv-kpi-trigger"
        onClick={canExpand ? onToggle : undefined}
        disabled={!canExpand}
        aria-expanded={canExpand ? isOpen : undefined}
        aria-controls={canExpand ? `kpi-list-${tone}` : undefined}>
        <div className="recv-kpi-label">
          <span>{label}</span>
          {canExpand && (
            <span className={"recv-kpi-chev" + (isOpen ? " open" : "")} aria-hidden="true">
              <Icon name="chevronRight" size={9}/>
            </span>
          )}
        </div>
        <div className={"recv-kpi-val mono" + (value > 0 ? ` is-${tone}` : "")}>
          {fmtMoney(value, false)}
        </div>
        {canExpand && (
          <div className="recv-kpi-sub">
            {entries.length} {verbLabel}
          </div>
        )}
      </button>

      {isOpen && canExpand && (
        <ul className={`recv-kpi-entries tone-${tone}`} id={`kpi-list-${tone}`}>
          {entries.map(e => (
            <InvoiceEntryRow key={e.monthIdx} entry={e} tone={tone}/>
          ))}
        </ul>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// InvoiceEntryRow — one month's invoice entry: month chip · amount · file
// link. Multiple files surface as a "+N" superscript on the link icon; the
// button opens the most recently uploaded file in a new tab via a signed URL.
// ----------------------------------------------------------------------------
const InvoiceEntryRow = ({ entry, tone }) => {
  const fileCount = entry.files?.length || 0;
  const primaryFile = fileCount > 0 ? entry.files[0] : null;
  const handleOpen = async () => {
    if (!primaryFile) return;
    try {
      const url = await getInvoiceFileSignedUrl(primaryFile.file_path, 60);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch { /* signed URL flake — silent; user can retry */ }
  };
  return (
    <li className={"recv-entry tone-" + tone}>
      <span className="recv-entry-month">{entry.monthLabel}</span>
      <span className="recv-entry-amt mono">{fmtMoney(entry.amount, false)}</span>
      <span className="recv-entry-file">
        {fileCount > 0 ? (
          <button
            type="button"
            className="recv-entry-file-btn"
            title={fileCount === 1
              ? `Open ${primaryFile.file_name || "invoice"}`
              : `Open ${primaryFile.file_name || "most recent invoice"} (+${fileCount - 1} more attached)`}
            onClick={handleOpen}>
            <Icon name="link" size={10}/>
            <span className="recv-entry-file-label">
              {fileCount === 1 ? "View" : `View · +${fileCount - 1}`}
            </span>
          </button>
        ) : (
          <span className="recv-entry-no-file" title="No file uploaded for this invoice">
            <Icon name="link" size={10}/>
            <span>No file</span>
          </span>
        )}
      </span>
      {entry.paid && entry.paidAt && (
        <span className="recv-entry-meta" title={`Paid ${fmtDate(entry.paidAt)}`}>
          paid {fmtDate(entry.paidAt)}
        </span>
      )}
    </li>
  );
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

      // Inclusion rule: keep the (sub, project) pair when EITHER a contract
      // amount is set OR there's at least one invoice attached. This keeps
      // contract-only relationships visible (the exec view should surface
      // "we have $X in subcontracts that haven't been billed yet" alongside
      // active invoicing). Pairs with neither contract nor billing are still
      // dropped — those are noise.
      if (billingEntries.length === 0 && (e.contractAmount || 0) === 0) continue;

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
