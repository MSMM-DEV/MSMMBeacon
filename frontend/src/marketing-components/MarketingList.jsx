import React, { useMemo, useState } from "react";
import { Badge, Button } from "@/ui";
import { Icon } from "../icons.jsx";
import { exportCSV } from "../utils/csv.js";
import { marketingCsvRows, marketingHealth, weightedMarketingValue } from "../marketing-rules.js";

const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value || 0));
const date = value => value ? String(value).slice(0, 10) : "—";

const COLUMNS = [
  { key: "title", label: "Project", value: row => row.title || "" },
  { key: "products", label: "Product", value: row => (row.productTags || []).join(", ") },
  { key: "source", label: "Lead source", value: row => row.source || "" },
  { key: "organizationName", label: "Client", value: row => row.organizationName || "" },
  { key: "poc", label: "POC", value: row => (row.contacts || []).map(contact => contact.name).filter(Boolean).join(" / ") },
  { key: "assignedTeam", label: "Assigned To", value: row => row.assignedTeam || row.ownerName || "" },
  { key: "taskOrder", label: "Task Order", value: row => row.taskOrder || "" },
  { key: "deliveryStatus", label: "Phases / Current Status", value: row => row.deliveryStatus || "" },
  { key: "projectProgress", label: "Project %", value: row => row.projectProgress ?? -1, render: row => row.projectProgress === null || row.projectProgress === undefined ? "—" : `${Number(row.projectProgress)}%` },
  { key: "sourceSalesPhase", label: "Original Sales Phase", value: row => row.sourceSalesPhase || "" },
  { key: "probability", label: "Sales %", value: row => Number(row.probability || 0), render: row => `${Number(row.probability || 0)}%` },
  { key: "stage", label: "Beacon Stage", value: row => row.stage || "" },
  { key: "outcome", label: "Outcome", value: row => row.outcome || "Open" },
  { key: "ownerName", label: "Owner", value: row => row.ownerName || "" },
  { key: "estimatedValue", label: "Estimated value", value: row => Number(row.estimatedValue || 0), render: row => money(row.estimatedValue) },
  { key: "weightedValue", label: "Weighted value", value: weightedMarketingValue, render: row => money(weightedMarketingValue(row)) },
  { key: "expectedCloseDate", label: "Expected close", value: row => row.expectedCloseDate || "", render: row => date(row.expectedCloseDate) },
  { key: "nextAction", label: "Next action", value: row => row.nextAction || "" },
  { key: "nextActionDueAt", label: "Next action due", value: row => row.nextActionDueAt || "", render: row => date(row.nextActionDueAt) },
  { key: "health", label: "Health", value: row => row.health || "" },
  { key: "daysInStage", label: "Days in stage", value: row => row.daysInStage || 0 },
  { key: "lastActivityAt", label: "Last activity", value: row => row.lastActivityAt || "", render: row => date(row.lastActivityAt) },
];

export function MarketingList({ rows = [], tasks = [], usersById = {}, clientsById = {}, stalledAfterDays = 14, onOpen }) {
  const [sort, setSort] = useState({ key: "expectedCloseDate", direction: "ascending" });
  const enriched = useMemo(() => rows.map(row => ({ ...row, health: marketingHealth(row, tasks, { stalledAfterDays }), daysInStage: row.stageEnteredAt ? Math.max(0, Math.floor((Date.now() - new Date(row.stageEnteredAt).getTime()) / 86400000)) : 0 })), [rows, tasks, stalledAfterDays]);
  const sorted = useMemo(() => [...enriched].sort((a, b) => {
    const column = COLUMNS.find(item => item.key === sort.key);
    const av = column?.value(a); const bv = column?.value(b);
    const result = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
    return sort.direction === "ascending" ? result : -result;
  }), [enriched, sort]);
  const setSortKey = key => setSort(current => ({ key, direction: current.key === key && current.direction === "ascending" ? "descending" : "ascending" }));
  const download = () => {
    const exportRows = marketingCsvRows(sorted, { usersById, clientsById }, { tasks, stalledAfterDays });
    const keys = Object.keys(exportRows[0] || {});
    exportCSV(keys.map(key => ({ key, label: key })), exportRows, "beacon-marketing-opportunities.csv");
  };
  return <section className="marketing-list"><div className="marketing-list-actions"><p>{sorted.length} opportunit{sorted.length === 1 ? "y" : "ies"} in the current view</p><Button variant="default" onClick={download} disabled={!sorted.length}><Icon name="download"/>Export current view</Button></div><div className="bx-scroll-x"><table><caption className="sr-only">Sales opportunities in the current filtered view</caption><thead><tr>{COLUMNS.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? sort.direction : "none"}><button type="button" onClick={() => setSortKey(column.key)}>{column.label}<Icon name="sort"/></button></th>)}</tr></thead><tbody>{sorted.map(row => <tr key={row.id}><td><button type="button" className="marketing-list-open" onClick={event => onOpen?.(row, event)}>{row.title}</button>{row.archivedAt && <Badge tone="neutral">Archived</Badge>}</td>{COLUMNS.slice(1).map(column => <td key={column.key}>{column.key === "outcome" ? <Badge tone={row.outcome === "won" ? "success" : row.outcome === "lost" ? "danger" : "neutral"}>{column.value(row)}</Badge> : (column.render ? column.render(row) : column.value(row))}</td>)}</tr>)}</tbody></table></div></section>;
}

export default MarketingList;
