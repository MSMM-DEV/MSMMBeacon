import React from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui";
import { Icon } from "../icons.jsx";
import {
  MARKETING_STAGES,
  marketingHealth,
} from "../marketing-rules.js";
import { nextMarketingAction } from "../marketing-model.js";
import { marketingStageStyle } from "./stage-colors.js";

// The board is deliberately hook-free: drag-over highlighting and the
// dragging-card state are written straight onto DOM data attributes, so a
// drag never re-renders seven columns of cards, and the components stay
// plain functions that tests can call directly.

const DRAG_TYPE = "text/marketing-opportunity";

// Short, display-only stage labels for the phone stage strip. The canonical
// stage names in marketing-rules.js remain the stored product language and
// are always exposed in full via title / aria-label.
const SHORT_STAGE_LABELS = ["Intro", "Showcase", "IQM", "BANT", "Verbal", "Legal", "Closed"];

const shortDate = value => value ? new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
}).format(new Date(`${String(value).slice(0, 10)}T12:00:00`)) : "";

const compactMoney = value => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
}).format(Number(value || 0));

const HEALTH_META = {
  on_track: { label: "On track", icon: "checkCircle", tone: "success" },
  attention: { label: "Needs attention", icon: "warn", tone: "warning" },
  stalled: { label: "Stalled", icon: "hourglass", tone: "danger" },
  won: { label: "Won", icon: "checkCircle", tone: "success" },
  lost: { label: "Lost", icon: "x", tone: "danger" },
};

const initialsOf = name => String(name || "")
  .split(/[\s/,&]+/).filter(Boolean).slice(0, 2)
  .map(part => part[0]).join("").toUpperCase() || "?";

function dueIsPast(value) {
  if (!value) return false;
  const due = String(value).slice(0, 10);
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return due < key;
}

const bandLabel = stage => stage.min === stage.max ? `${stage.min}%` : `${stage.min}–${stage.max}%`;

// Module-level drag context: dragenter can only read dataTransfer TYPES, not
// the payload, so the source stage is remembered here to avoid highlighting
// the column a card is being dragged out of.
let activeDrag = null;

function clearDropTargets() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".marketing-lane[data-drop-target]").forEach(lane => {
    delete lane.dataset.dropTarget;
    delete lane.dataset.dropDepth;
  });
}

const isCardDrag = event => Array.from(event.dataTransfer?.types || []).includes(DRAG_TYPE);

function OpportunityCard({ opportunity, tasks, stalledAfterDays, stageIndex = 0, onOpen, onMoveIntent }) {
  const healthKey = marketingHealth(opportunity, tasks, { stalledAfterDays });
  const health = HEALTH_META[healthKey] || HEALTH_META.on_track;
  const next = nextMarketingAction(tasks, opportunity.nextAction || "");
  const nextLabel = typeof next === "string" ? next : next?.title;
  const nextDue = typeof next === "object" ? next?.dueAt : opportunity.nextActionDueAt;
  const overdue = dueIsPast(nextDue);
  const label = `Open ${opportunity.title} opportunity`;
  const organization = opportunity.organizationName || opportunity.client?.name || "Organization not set";
  const internal = opportunity.sourceSalesPhase === "NOT A SALES CONTRACT";
  const assignment = opportunity.assignedTeam || opportunity.ownerName || opportunity.owner?.display_name || "Unassigned";
  const probability = Number(opportunity.probability || 0);
  const projectProgress = opportunity.projectProgress !== null && opportunity.projectProgress !== undefined
    ? Number(opportunity.projectProgress)
    : null;

  const open = event => {
    const card = event.currentTarget;
    // Clicks bubbling out of a portalled menu, or from a nested control,
    // belong to that control — not to the card.
    if (!card.contains(event.target) || event.target.closest?.("[data-card-control]")) return;
    // A drag that just ended must not read as a click.
    if (card.dataset.dragging === "true" || Date.now() - Number(card.dataset.dragEndedAt || 0) < 250) return;
    // Let people select text on a card without opening it.
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (selection && !selection.isCollapsed && card.contains(selection.anchorNode)) return;
    // Focus returns to the card's own button when the sheet closes.
    onOpen?.(opportunity, { currentTarget: card.querySelector(".marketing-card-open") || card });
  };

  return (
    <article
      className="marketing-card"
      data-marketing-card={opportunity.id}
      data-health={healthKey}
      aria-label={label}
      style={marketingStageStyle(stageIndex)}
      draggable
      onClick={open}
      onDragStart={event => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(DRAG_TYPE, opportunity.id);
        activeDrag = { id: opportunity.id, stage: opportunity.stage };
        event.currentTarget.dataset.dragging = "true";
      }}
      onDragEnd={event => {
        const card = event.currentTarget;
        delete card.dataset.dragging;
        card.dataset.dragEndedAt = String(Date.now());
        activeDrag = null;
        clearDropTargets();
      }}
    >
      <div className="marketing-card-top">
        <button type="button" className="marketing-card-open" aria-label={label}>
          <span className="marketing-card-title" title={opportunity.title}>{opportunity.title}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="marketing-card-menu" data-card-control="" aria-label={`Actions for ${opportunity.title}`}>
              <Icon name="more" size={16}/>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="marketing-move-menu">
            <DropdownMenuItem onSelect={() => window.requestAnimationFrame(() => onOpen?.(opportunity, { currentTarget: document.querySelector(`[data-marketing-card="${opportunity.id}"] .marketing-card-open`) }))}>
              <Icon name="external"/> Open details
            </DropdownMenuItem>
            <DropdownMenuSeparator/>
            <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
            {MARKETING_STAGES.map((stage, index) => stage.name === opportunity.stage ? null : (
              <DropdownMenuItem key={stage.name} data-move-stage={stage.name} onSelect={() => onMoveIntent?.(opportunity, stage.name)}>
                <span className="marketing-move-dot" style={marketingStageStyle(index)} aria-hidden="true"/>
                <span className="marketing-move-name">{stage.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="marketing-card-org" title={`${organization}${internal ? " — Internal / non-sales" : ""}`}>
        <span>{organization}</span>
        {internal && <span className="marketing-card-kind">Internal</span>}
      </p>
      <div className="marketing-card-meta">
        <span className="marketing-card-owner" title={assignment}>
          <span className="marketing-card-avatar" aria-hidden="true">{initialsOf(assignment)}</span>
          <span className="marketing-card-owner-name">{assignment}</span>
        </span>
        <span className="marketing-card-stat" aria-label={`Sales probability ${probability} percent`}><span>Sales</span> {probability}%</span>
      </div>
      <div className="marketing-card-status">
        <span className="marketing-card-health" data-tone={health.tone}><span className="marketing-card-health-dot" aria-hidden="true"/>{health.label}</span>
        {projectProgress !== null && <span className="marketing-card-stat" aria-label={`Project progress ${projectProgress} percent`}><span>Project</span> {projectProgress}%</span>}
        {opportunity.deliveryStatus && <span className="marketing-card-delivery" title={opportunity.deliveryStatus}>{opportunity.deliveryStatus}</span>}
      </div>
      <div className="marketing-card-next" data-overdue={overdue ? "true" : undefined} data-empty={nextLabel ? undefined : "true"}>
        <Icon name={overdue ? "warn" : "forward"} size={13}/>
        <span title={nextLabel || "Add a next action"}>{nextLabel || "Add a next action"}</span>
        {nextDue && <time dateTime={nextDue} title={overdue ? `Overdue — was due ${shortDate(nextDue)}` : `Due ${shortDate(nextDue)}`}>{overdue && <span className="sr-only">Overdue, due </span>}{shortDate(nextDue)}</time>}
      </div>
    </article>
  );
}

// Rendered inline (not as a component) so the board stays one static tree.
function outcomeFilter(value = "all", onChange) {
  const options = [["all", "All"], ["won", "Won"], ["lost", "Lost"]];
  return (
    <div className="marketing-outcome-filter" role="group" aria-label="Filter final stage by outcome">
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange?.(key)}>{text}</button>
      ))}
    </div>
  );
}

// When the seven columns don't fit, the board scrolls sideways — and its
// native scrollbar sits at the bottom of a (possibly tall) board. These two
// buttons keep horizontal travel reachable from the top. A separate component
// so its hooks never run inside the hook-free board.
function BoardScrollNav() {
  const anchorRef = React.useRef(null);
  const [state, setState] = React.useState({ overflow: false, left: false, right: false });
  React.useEffect(() => {
    const board = anchorRef.current?.closest(".marketing-board-wrap")?.querySelector(".marketing-board");
    if (!board) return undefined;
    const measure = () => {
      const max = board.scrollWidth - board.clientWidth;
      const next = { overflow: max > 2, left: board.scrollLeft > 2, right: board.scrollLeft < max - 2 };
      setState(current => (current.overflow === next.overflow && current.left === next.left && current.right === next.right) ? current : next);
    };
    measure();
    board.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(board);
    return () => { board.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, []);
  const step = direction => {
    const board = anchorRef.current?.closest(".marketing-board-wrap")?.querySelector(".marketing-board");
    const lane = board?.querySelector(".marketing-lane");
    if (!board || !lane) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    board.scrollBy({ left: direction * (lane.getBoundingClientRect().width + 10), behavior: reduce ? "auto" : "smooth" });
  };
  return (
    <div ref={anchorRef} className="marketing-board-nav" hidden={!state.overflow}>
      <button type="button" aria-label="Scroll stages left" disabled={!state.left} onClick={() => step(-1)}><Icon name="chevronLeft" size={16}/></button>
      <button type="button" aria-label="Scroll stages right" disabled={!state.right} onClick={() => step(1)}><Icon name="chevronRight" size={16}/></button>
    </div>
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
  const mobileStage = selectedMobileStage || MARKETING_STAGES[0].name;
  const lanes = MARKETING_STAGES.map((stage, index) => {
    const terminal = index === MARKETING_STAGES.length - 1;
    const rows = active.filter(row => row.stage === stage.name && (!terminal || terminalOutcome === "all" || row.outcome === terminalOutcome));
    const value = rows.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0);
    return { stage, index, terminal, rows, value };
  });

  return (
    <div className="marketing-board-wrap">
      <div className="marketing-mobile-stage" role="group" aria-label="Choose pipeline stage">
        {lanes.map(({ stage, index, rows }) => (
          <button key={stage.name} type="button" style={marketingStageStyle(index)}
            aria-pressed={stage.name === mobileStage}
            aria-label={`${stage.name}, ${rows.length} opportunit${rows.length === 1 ? "y" : "ies"}`}
            title={stage.name}
            onClick={() => onSelectedMobileStage?.(stage.name)}>
            <span className="marketing-chip-dot" aria-hidden="true"/>
            {SHORT_STAGE_LABELS[index] || stage.name}
            <span className="marketing-chip-count">{rows.length}</span>
          </button>
        ))}
      </div>
      <BoardScrollNav/>
      <div className="marketing-board" aria-label="Sales opportunity pipeline">
        {lanes.map(({ stage, index, terminal, rows, value }) => {
          const headingId = `marketing-stage-${index}`;
          return (
            <section
              key={stage.name}
              className="marketing-lane"
              data-stage={stage.name}
              data-mobile-active={stage.name === mobileStage ? "true" : "false"}
              style={marketingStageStyle(index)}
              role="region"
              aria-labelledby={headingId}
              onDragEnter={event => {
                if (!isCardDrag(event) || activeDrag?.stage === stage.name) return;
                const lane = event.currentTarget;
                lane.dataset.dropDepth = String(Number(lane.dataset.dropDepth || 0) + 1);
                lane.dataset.dropTarget = "true";
              }}
              onDragLeave={event => {
                const lane = event.currentTarget;
                if (!lane.dataset.dropDepth) return;
                const depth = Number(lane.dataset.dropDepth) - 1;
                if (depth <= 0) { delete lane.dataset.dropDepth; delete lane.dataset.dropTarget; }
                else lane.dataset.dropDepth = String(depth);
              }}
              onDragOver={event => {
                if (!isCardDrag(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={event => {
                event.preventDefault();
                clearDropTargets();
                const id = event.dataTransfer.getData(DRAG_TYPE) || activeDrag?.id;
                const row = byId.get(id);
                activeDrag = null;
                if (row && row.stage !== stage.name) onMoveIntent?.(row, stage.name);
              }}
            >
              <header className="marketing-lane-head">
                <h3 id={headingId} title={stage.name}>{stage.name}</h3>
                <div className="marketing-lane-meta">
                  <span className="marketing-lane-band" title="Probability band">{bandLabel(stage)}</span>
                  <span className="marketing-lane-count" aria-label={`${rows.length} opportunit${rows.length === 1 ? "y" : "ies"}`}>{rows.length}</span>
                  {value > 0 && <span className="marketing-lane-value" title={`Estimated value of the ${rows.length} opportunit${rows.length === 1 ? "y" : "ies"} in this stage`}>{compactMoney(value)}</span>}
                </div>
                {terminal && outcomeFilter(terminalOutcome, onTerminalOutcomeChange)}
              </header>
              <div className="marketing-lane-cards">
                {rows.map(row => (
                  <OpportunityCard key={row.id} opportunity={row}
                    tasks={tasks.filter(task => task.opportunityId === row.id)}
                    stalledAfterDays={stalledAfterDays}
                    stageIndex={index}
                    onOpen={onOpen} onMoveIntent={onMoveIntent}/>
                ))}
                {!rows.length && <p className="marketing-lane-empty"><span className="marketing-lane-empty-idle">No opportunities</span><span className="marketing-lane-empty-drop">Drop here</span></p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default MarketingBoard;
