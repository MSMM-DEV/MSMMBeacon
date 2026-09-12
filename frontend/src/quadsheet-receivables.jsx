import React, { useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody } from "./ui/dialog.jsx";
import { fmtMoney, fmtDate, MONTHS, companyById, getCompanies, getInvoiceFileSignedUrl } from "./data.js";

// One visible record per firm/project; the existing pivot remains the source
// of all financial values. A single dialog exposes the monthly ledger.
export const SubsReceivablesPanel = ({ subInvoices, projectsById, onOpenProject }) => {
  const subs = useMemo(() => pivotSubsReceivables(subInvoices, projectsById), [subInvoices, projectsById]);
  const [sortKey, setSortKey] = useState("pending");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const returnFocus = useRef(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return subs;
    return subs.flatMap(sub => {
      if (sub.companyName.toLowerCase().includes(q)) return [sub];
      const projects = sub.projects.filter(p => [p.projectName, p.projectNumber, p.primeFirmName].some(v => String(v || "").toLowerCase().includes(q)));
      // Keep firm totals intact; search only changes the records displayed.
      return projects.length ? [{ ...sub, projects }] : [];
    });
  }, [subs, query]);
  const sorted = useMemo(() => filtered.slice().sort((a, b) => {
    const ka = sortKey === "pending" ? a.totalPending : a.totalBilled;
    const kb = sortKey === "pending" ? b.totalPending : b.totalBilled;
    return kb - ka || a.companyName.localeCompare(b.companyName);
  }), [filtered, sortKey]);
  const headlineNumber = sorted.reduce((acc, s) => acc + (sortKey === "pending" ? s.totalPending : s.totalBilled), 0);
  return (
    <section className="quad-card recv-card recv-v2" data-accent="recv">
      <header className="quad-head recv-head">
        <div className="recv-head-l">
          <h2 className="quad-title">Outstanding Invoices</h2>
          <div className="quad-sub">{sorted.length} firms · {fmtMoney(headlineNumber, false)} {sortKey === "pending" ? "pending" : "paid"} across matching firms</div>
          <p className="recv-navigation-hint">Amounts at a glance. Open a record to see every paid and pending invoice.</p>
        </div>
        <div className="recv-head-r">
          <input className="recv-search" type="search" placeholder="Find a firm or project…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Find receivables by firm or project"/>
          <div className="events-view-toggle recv-toggle" role="group" aria-label="Sort receivables by amount">
            <button type="button" aria-pressed={sortKey === "pending"} className={sortKey === "pending" ? "active" : ""} onClick={() => setSortKey("pending")}>Pending</button>
            <button type="button" aria-pressed={sortKey === "paid"} className={sortKey === "paid" ? "active" : ""} onClick={() => setSortKey("paid")}>Paid</button>
          </div>
        </div>
      </header>
      {sorted.length ? <ReceivableRecords subs={sorted} onView={(sub, project, event) => {
        returnFocus.current = event.currentTarget;
        setSelected({ sub, project });
      }}/> : <div className="recv-empty">{query ? "No matching firms or projects." : "No receivables yet."}</div>}
      <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}>
        <DialogContent size="lg" className="recv-ledger-dialog" onCloseAutoFocus={event => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}>
          <DialogHeader>
            <DialogTitle>{selected?.project.projectName || "Invoice details"}</DialogTitle>
            <DialogDescription>{selected?.sub.companyName} · {selected?.project.year}{selected?.sub.isMsmm ? " · Owed to MSMM" : " · Payable to firm"}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {selected && <ProjectDetail project={selected.project} isMsmm={selected.sub.isMsmm} onOpen={onOpenProject ? () => {
              const p = selected.project;
              setSelected(null);
              onOpenProject(p.statusKey, p.projectId);
            } : undefined}/>}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </section>
  );
};

export const ReceivableRecords = ({ subs, onView }) => (
  <div className="recv-register-scroll" role="region" aria-label="Receivables by firm and project" tabIndex={0}>
    <table className="recv-register">
      <thead><tr><th scope="col">Firm / direction</th><th scope="col">Project</th><th scope="col">Contract</th><th scope="col">Paid</th><th scope="col">Pending</th><th scope="col">Remaining</th><th scope="col"><span className="sr-only">Invoice details</span></th></tr></thead>
      <tbody>{subs.flatMap(sub => sub.projects.map(p => (
        <tr key={JSON.stringify([sub.companyId, p.projectId, p.year, p.primeFirmName])}>
          <td data-label="Firm"><strong>{sub.companyName}</strong><small>{sub.isMsmm ? "Owed to MSMM" : "Payable to firm"}</small></td>
          <td data-label="Project"><strong>{p.projectName || "Untitled project"}</strong><small>{[p.projectNumber, p.year, labelForStatus(p.statusKey)].filter(Boolean).join(" · ")}</small>{p.primeFirmName && <small>Prime · {p.primeFirmName}</small>}</td>
          <td data-label="Contract">{p.contractAmount ? fmtMoney(p.contractAmount, false) : <span className="recv-unset">Not set</span>}</td>
          <td data-label="Paid" className="recv-record-paid">{fmtMoney(p.billedToDate, false)}</td>
          <td data-label="Pending">{fmtMoney(p.pending, false)}</td>
          <td data-label="Remaining">{p.contractAmount ? fmtMoney(p.contractAmount - p.billedToDate, false) : <span className="recv-unset">Not set</span>}</td>
          <td className="recv-record-action"><button type="button" className="btn" aria-label={"View invoices for " + sub.companyName + " · " + (p.projectName || "Untitled project") + (p.primeFirmName ? " · Prime " + p.primeFirmName : "")} onClick={event => onView?.(sub, p, event)}>View invoices</button>{p.billingEntries.length === 0 && <small>No invoices yet</small>}</td>
        </tr>
      )))}</tbody>
    </table>
  </div>
);

const ProjectDetail = ({ project, isMsmm, onOpen }) => {
  const paidEntries = useMemo(() => project.billingEntries.filter(b => b.paid).sort((a, b) => a.monthIdx - b.monthIdx), [project.billingEntries]);
  const pendingEntries = useMemo(() => project.billingEntries.filter(b => !b.paid).sort((a, b) => a.monthIdx - b.monthIdx), [project.billingEntries]);
  // Retain the existing displayed definition: pending is NOT subtracted.
  const remaining = project.contractAmount - project.billedToDate;
  return (
    <div className="recv-ledger">
      <dl className="recv-ledger-summary">
        <div><dt>Contract</dt><dd>{project.contractAmount ? fmtMoney(project.contractAmount, false) : "Not set"}</dd></div>
        <div><dt>Remaining</dt><dd>{project.contractAmount ? fmtMoney(remaining, false) : "Set contract"}</dd>{project.contractAmount > 0 && <small>{remaining < 0 ? "Over contract" : Math.round(project.billedToDate / project.contractAmount * 100) + "% billed"}</small>}</div>
      </dl>
      <InvoiceEntries label={isMsmm ? "Pending receipt" : "Pending payment"} value={project.pending} entries={pendingEntries} tone="pending"/>
      <InvoiceEntries label={isMsmm ? "Received to date" : "Paid invoices"} value={project.billedToDate} entries={paidEntries} tone="paid"/>
      {onOpen && <button type="button" className="btn recv-ledger-project" onClick={onOpen}>Open project<Icon name="forward" size={14}/></button>}
    </div>
  );
};

const InvoiceEntries = ({ label, value, entries, tone }) => (
  <section className={"recv-ledger-section tone-" + tone}>
    <h3>{label}<span>{fmtMoney(value, false)}</span></h3>
    {entries.length ? <ul className={"recv-kpi-entries tone-" + tone}>{entries.map(e => <InvoiceEntryRow key={e.monthIdx} entry={e} tone={tone}/>)}</ul> : <p className="recv-unset">No invoices in this group.</p>}
  </section>
);

// ----------------------------------------------------------------------------
// InvoiceEntryRow — one month's invoice entry: month chip · amount · file
// links. Every existing attachment opens directly through the same signed URL reader.
// ----------------------------------------------------------------------------
export const InvoiceEntryRow = ({ entry, tone }) => {
  const fileCount = entry.files?.length || 0;
  const handleOpen = async (file) => {
    if (!file) return;
    try {
      const url = await getInvoiceFileSignedUrl(file.file_path, 60);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch { /* signed URL flake — silent; user can retry */ }
  };
  return (
    <li className={"recv-entry tone-" + tone}>
      <span className="recv-entry-month">{entry.monthLabel}</span>
      <span className="recv-entry-amt mono">{fmtMoney(entry.amount, false)}</span>
      <span className="recv-entry-file">
        {fileCount > 0 ? entry.files.map((file, index) => (
          <button
            key={file.id || file.file_path || index}
            type="button"
            className="recv-entry-file-btn"
            title={`Open ${file.file_name || "invoice"}`}
            onClick={() => handleOpen(file)}>
            <Icon name="link" size={10}/>
            <span className="recv-entry-file-label">
              {file.file_name || `View invoice ${index + 1}`}
            </span>
          </button>
        )) : (
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
