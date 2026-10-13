import React from "react";
import { Badge } from "@/ui";
import { Icon } from "../icons.jsx";
import {
  MARKETING_STAGES,
  marketingHealth,
} from "../marketing-rules.js";
import { nextMarketingAction } from "../marketing-model.js";

const shortDate = value => value ? new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric",
}).format(new Date(`${String(value).slice(0, 10)}T12:00:00`)) : "Not set";

const HEALTH_META = {
  on_track: { label: "On track", icon: "checkCircle", tone: "success" },
  attention: { label: "Needs attention", icon: "warn", tone: "warning" },
  stalled: { label: "Stalled", icon: "hourglass", tone: "danger" },
  won: { label: "Won", icon: "checkCircle", tone: "success" },
  lost: { label: "Lost", icon: "x", tone: "danger" },
};

function OpportunityCard({ opportunity, tasks, stalledAfterDays, onOpen, onMoveIntent }) {
  const healthKey = marketingHealth(opportunity, tasks, { stalledAfterDays });
  const health = HEALTH_META[healthKey] || HEALTH_META.on_track;
  const next = nextMarketingAction(tasks, opportunity.nextAction || "");
  const nextLabel = typeof next === "string" ? next : next?.title;
  const nextDue = typeof next === "object" ? next?.dueAt : opportunity.nextActionDueAt;
  const label = `Open ${opportunity.title} opportunity`;
  const organization = opportunity.organizationName || opportunity.client?.name || "Organization not set";
  const internal = opportunity.sourceSalesPhase === "NOT A SALES CONTRACT";
  const assignment = opportunity.assignedTeam || opportunity.ownerName || opportunity.owner?.display_name || "Unassigned";
  const projectProgress = opportunity.projectProgress !== null && opportunity.projectProgress !== undefined
    ? Number(opportunity.projectProgress)
    : null;
  return (
    <article
      className="marketing-card"
      data-marketing-card={opportunity.id}
      aria-label={label}
      draggable
      onDragStart={event => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/marketing-opportunity", opportunity.id);
      }}
    >
      <button type="button" className="marketing-card-open" aria-label={label} onClick={event => onOpen?.(opportunity, event)}>
        <span className="marketing-card-title" title={opportunity.title}>{opportunity.title}</span>
        <span className="marketing-card-org" title={`${organization}${internal ? " — Internal / non-sales" : ""}`}>
          <span>{organization}</span>
          {internal && <span className="marketing-card-kind">Internal / non-sales</span>}
        </span>
      </button>
      <div className="marketing-card-signals" aria-label="Opportunity status">
        <Badge tone={health.tone}><Icon name={health.icon} size={12}/>{health.label}</Badge>
        <span className="marketing-card-stat" aria-label={`Sales probability ${Number(opportunity.probability || 0)} percent`}><strong>Sales</strong>{Number(opportunity.probability || 0)}%</span>
        {projectProgress !== null && <span className="marketing-card-stat" aria-label={`Project progress ${projectProgress} percent`}><strong>Project</strong>{projectProgress}%</span>}
      </div>
      <div className="marketing-card-context">
        <span title={assignment}><Icon name="user" size={13}/>{assignment}</span>
        {opportunity.deliveryStatus && <span title={opportunity.deliveryStatus}><Icon name="briefcase" size={13}/>{opportunity.deliveryStatus}</span>}
      </div>
      <footer className="marketing-card-actions">
        <div className="marketing-card-next">
          <strong>Next</strong>
          <span title={nextLabel || "Add a next action"}>{nextLabel || "Add a next action"}</span>
          {nextDue && <time dateTime={nextDue}>{shortDate(nextDue)}</time>}
        </div>
        <label className="marketing-card-move">
          <span className="sr-only">Move {opportunity.title}</span>
          <select
            aria-label={`Move ${opportunity.title} to another stage`}
            value=""
            onChange={event => {
              if (event.target.value) onMoveIntent?.(opportunity, event.target.value);
            }}
          >
            <option value="">Move to…</option>
            {MARKETING_STAGES.filter(stage => stage.name !== opportunity.stage).map(stage => (
              <option key={stage.name} value={stage.name}>{stage.name}</option>
            ))}
          </select>
        </label>
      </footer>
    </article>
  );
}

export function MarketingBoard({
  opportunities = [],
  tasks = [],
  stalledAfterDays = 14,
  selectedMobileStage = null,
  onSelectedMobileStage,
  terminalOutcome = "all",
  onTerminalOutcomeChange,
  onOpen,
  onMoveIntent,
}) {
  const active = opportunities.filter(row => !row.archivedAt);
  const byId = new Map(active.map(row => [row.id, row]));

  return (
    <div className="marketing-board-wrap">
      <label className="marketing-mobile-stage">
        <span>Stage</span>
        <select aria-label="Choose pipeline stage" value={selectedMobileStage || MARKETING_STAGES[0].name}
          onChange={event => onSelectedMobileStage?.(event.target.value)}>
          {MARKETING_STAGES.map(stage => <option key={stage.name} value={stage.name}>{stage.name}</option>)}
        </select>
      </label>
      <div className="marketing-board" aria-label="Marketing opportunity pipeline">
        {MARKETING_STAGES.map((stage, index) => {
          const terminal = index === MARKETING_STAGES.length - 1;
          const rows = active.filter(row => row.stage === stage.name && (!terminal || terminalOutcome === "all" || row.outcome === terminalOutcome));
          const headingId = `marketing-stage-${index}`;
          return (
            <section
              key={stage.name}
              className="marketing-lane"
              data-stage={stage.name}
              data-mobile-active={stage.name === selectedMobileStage ? "true" : "false"}
              role="region"
              aria-labelledby={headingId}
              onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
              onDrop={event => {
                event.preventDefault();
                const row = byId.get(event.dataTransfer.getData("text/marketing-opportunity"));
                if (row && row.stage !== stage.name) onMoveIntent?.(row, stage.name);
              }}
            >
              <header className="marketing-lane-head">
                <div><h3 id={headingId}>{stage.name}</h3><span>{stage.min === stage.max ? `${stage.min}%` : `${stage.min}–${stage.max}%`}</span></div>
                <Badge tone="neutral">{rows.length}</Badge>
                {terminal && <select aria-label="Filter final stage by outcome" value={terminalOutcome} onChange={event => onTerminalOutcomeChange?.(event.target.value)}><option value="all">Won &amp; lost</option><option value="won">Won</option><option value="lost">Lost</option></select>}
              </header>
              <div className="marketing-lane-cards">
                {rows.map(row => (
                  <OpportunityCard key={row.id} opportunity={row}
                    tasks={tasks.filter(task => task.opportunityId === row.id)}
                    stalledAfterDays={stalledAfterDays}
                    onOpen={onOpen} onMoveIntent={onMoveIntent}/>
                ))}
                {!rows.length && <p className="marketing-lane-empty">No opportunities</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default MarketingBoard;
