import React from "react";
import { Badge } from "@/ui";
import { Icon } from "../icons.jsx";
import {
  MARKETING_STAGES,
  marketingHealth,
  weightedMarketingValue,
} from "../marketing-rules.js";
import { nextMarketingAction } from "../marketing-model.js";

const money = value => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
}).format(Number(value || 0));

const shortDate = value => value ? new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric",
}).format(new Date(`${String(value).slice(0, 10)}T12:00:00`)) : "Not set";

const daysInStage = value => {
  if (!value) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
};

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
        <span className="marketing-card-title">{opportunity.title}</span>
        <span className="marketing-card-org">{opportunity.organizationName || opportunity.client?.name || "Organization not set"}</span>
      </button>
      <div className="marketing-card-badges">
        {opportunity.outcome && <Badge tone={opportunity.outcome === "won" ? "success" : "danger"}>{opportunity.outcome === "won" ? "Won" : "Lost"}</Badge>}
        {opportunity.sourceSalesPhase === "NOT A SALES CONTRACT" && <Badge tone="neutral">Internal / non-sales</Badge>}
        <Badge tone={health.tone}><Icon name={health.icon} size={12}/>{health.label}</Badge>
        <Badge tone="neutral">{Number(opportunity.probability || 0)}%</Badge>
      </div>
      <dl className="marketing-card-metrics">
        <div><dt>Estimated</dt><dd>{money(opportunity.estimatedValue)}</dd></div>
        <div><dt>Weighted</dt><dd>{money(weightedMarketingValue(opportunity))}</dd></div>
      </dl>
      <div className="marketing-card-meta">
        <span><Icon name="user" size={13}/>{opportunity.assignedTeam || opportunity.ownerName || opportunity.owner?.display_name || "Unassigned"}</span>
        <span><Icon name="calendar" size={13}/>{shortDate(opportunity.expectedCloseDate)}</span>
        <span><Icon name="clock" size={13}/>{daysInStage(opportunity.stageEnteredAt)}d in stage</span>
      </div>
      {!!opportunity.productTags?.length && (
        <div className="marketing-card-tags" aria-label="Products">
          {opportunity.productTags.map(tag => <span key={tag}>{tag}</span>)}
        </div>
      )}
      {(opportunity.deliveryStatus || opportunity.projectProgress !== null && opportunity.projectProgress !== undefined || opportunity.sourceSalesPhase) && (
        <section className="marketing-card-portfolio" aria-label="Portfolio context">
          {opportunity.deliveryStatus && <p><strong>Current status</strong><span>{opportunity.deliveryStatus}</span></p>}
          {opportunity.projectProgress !== null && opportunity.projectProgress !== undefined && <div className="marketing-card-progress"><span><strong>Project progress</strong><b>{Number(opportunity.projectProgress)}%</b></span><progress max="100" value={Number(opportunity.projectProgress)} aria-label={`Project progress ${Number(opportunity.projectProgress)} percent`}/></div>}
          {opportunity.sourceSalesPhase && <p><strong>Original sales phase</strong><span>{opportunity.sourceSalesPhase}</span></p>}
        </section>
      )}
      <div className="marketing-card-next">
        <strong>Next</strong>
        <span>{nextLabel || "Add a next action"}</span>
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
