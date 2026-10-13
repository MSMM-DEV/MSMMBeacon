// Pure Marketing pipeline rules. This module deliberately has no React or
// Supabase dependency so every probability, health and reporting decision has
// one testable source of truth.

const TERMINAL_STAGE = "Contract Signed Won or Lost";
const BUSINESS_TZ = "America/Chicago";

export const MARKETING_STAGES = Object.freeze([
  Object.freeze({ name: "Intro to Target or prospect", min: 0, max: 10, defaultProbability: 5 }),
  Object.freeze({ name: "Initial meeting to showcase products and qualify prospect", min: 10, max: 25, defaultProbability: 20 }),
  Object.freeze({ name: "IQM - Initial Qualified Meeting", min: 25, max: 40, defaultProbability: 30 }),
  Object.freeze({ name: "BANT - Budget Authority Need Time", min: 40, max: 50, defaultProbability: 45 }),
  Object.freeze({ name: "Verbal Approval to Proceed", min: 75, max: 75, defaultProbability: 75 }),
  Object.freeze({ name: "Legal and Contract Negotiation", min: 75, max: 90, defaultProbability: 85 }),
  Object.freeze({ name: TERMINAL_STAGE, min: 0, max: 100, defaultProbability: 100 }),
]);

export const MARKETING_STAGE_NAMES = Object.freeze(MARKETING_STAGES.map(stage => stage.name));
export const MARKETING_LOSS_REASONS = Object.freeze([
  "Price",
  "Did not meet their needs",
  "Timing was not right",
  "Competitor",
  "Internal build",
  "Other",
]);

const STAGE_BY_NAME = new Map(MARKETING_STAGES.map(stage => [stage.name, stage]));

const GUIDANCE_FIELDS = Object.freeze({
  "Intro to Target or prospect": ["clientId", "ownerId", "source", "nextAction"],
  "Initial meeting to showcase products and qualify prospect": ["showcaseMeetingAt", "showcaseOutcome", "nextAction"],
  "IQM - Initial Qualified Meeting": ["problemStatement", "desiredOutcome", "solutionFit", "clarifyingQuestions"],
  "BANT - Budget Authority Need Time": ["budgetNotes", "authorityNotes", "needSummary", "timingSummary", "proposalSentAt"],
  "Verbal Approval to Proceed": ["verbalApprovalAt", "verbalApproverContactId", "targetSignatureDate", "resourcePlanningNote"],
  "Legal and Contract Negotiation": ["msaStatus", "sowStatus", "legalOwnerId", "targetSignatureDate"],
  [TERMINAL_STAGE]: [],
});

export function stageDefinition(name) {
  return STAGE_BY_NAME.get(name) || null;
}

export function transitionDraft(opportunity = {}, toStage) {
  const definition = stageDefinition(toStage);
  if (!definition) throw new Error(`Unknown marketing stage: ${toStage || "(blank)"}`);
  return {
    opportunityId: opportunity.id || null,
    fromStage: opportunity.stage || null,
    toStage,
    probability: definition.defaultProbability,
    outcome: toStage === TERMINAL_STAGE ? (opportunity.outcome || null) : null,
    signedAt: opportunity.signedAt || null,
    finalContractValue: opportunity.finalContractValue ?? null,
    lossReason: opportunity.lossReason || null,
    lossDetail: opportunity.lossDetail || null,
    transitionNote: "",
    missingFields: (GUIDANCE_FIELDS[toStage] || []).filter(field => {
      const value = opportunity[field];
      return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
    }),
  };
}

const errorFor = (field, message) => ({ field, message });

export function validateMarketingTransition(input = {}) {
  const definition = stageDefinition(input.toStage);
  const errors = [];
  const warnings = [];
  if (!definition) {
    errors.push(errorFor("toStage", "Choose a valid Sales stage."));
    return { errors, warnings, normalized: { ...input } };
  }

  let probability = Number(input.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
    errors.push(errorFor("probability", "Probability must be between 0 and 100."));
    probability = definition.defaultProbability;
  }

  const normalized = {
    ...input,
    toStage: definition.name,
    probability,
    outcome: input.outcome || null,
    signedAt: input.signedAt || null,
    finalContractValue: input.finalContractValue === "" || input.finalContractValue === undefined
      ? null : input.finalContractValue,
    lossReason: input.lossReason || null,
    lossDetail: input.lossDetail || null,
  };

  if (definition.name === TERMINAL_STAGE) {
    if (normalized.outcome === "won") {
      normalized.probability = 100;
      normalized.lossReason = null;
      normalized.lossDetail = null;
      if (!normalized.signedAt) errors.push(errorFor("signedAt", "Signature date is required for Won opportunities."));
      if (normalized.finalContractValue === null || !Number.isFinite(Number(normalized.finalContractValue)) || Number(normalized.finalContractValue) < 0) {
        errors.push(errorFor("finalContractValue", "Final contract value is required for Won opportunities."));
      } else {
        normalized.finalContractValue = Number(normalized.finalContractValue);
      }
    } else if (normalized.outcome === "lost") {
      normalized.probability = 0;
      normalized.signedAt = null;
      normalized.finalContractValue = null;
      if (!MARKETING_LOSS_REASONS.includes(normalized.lossReason)) {
        errors.push(errorFor("lossReason", "Choose why the opportunity was lost."));
      }
    } else {
      errors.push(errorFor("outcome", "Choose Won or Lost."));
    }
  } else {
    normalized.outcome = null;
    normalized.signedAt = null;
    normalized.finalContractValue = null;
    normalized.lossReason = null;
    normalized.lossDetail = null;
    if (probability < definition.min || probability > definition.max) {
      warnings.push({
        field: "probability",
        message: definition.min === definition.max
          ? `The recommended probability for this stage is ${definition.min}%.`
          : `The recommended probability for this stage is ${definition.min}–${definition.max}%.`,
      });
    }
  }
  return { errors, warnings, normalized };
}

export function weightedMarketingValue(opportunity = {}) {
  const value = Number(opportunity.estimatedValue ?? 0);
  const probability = Number(opportunity.probability ?? 0);
  if (!Number.isFinite(value) || !Number.isFinite(probability)) return 0;
  return value * probability / 100;
}

function chicagoParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(+date)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const read = type => Number(parts.find(part => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function dateOnlyParts(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return chicagoParts(value);
}

const dayKey = parts => parts ? parts.year * 10000 + parts.month * 100 + parts.day : null;
const quarter = parts => parts ? Math.floor((parts.month - 1) / 3) + 1 : null;

function daysSince(value, now) {
  if (!value) return null;
  const then = new Date(value);
  if (Number.isNaN(+then)) return null;
  return (now.getTime() - then.getTime()) / 86400000;
}

function isOpenTask(task) {
  return String(task?.status || "open").toLowerCase() !== "completed";
}

export function marketingHealth(opportunity = {}, tasks = [], { now = new Date(), stalledAfterDays = 14 } = {}) {
  if (opportunity.outcome === "won" || opportunity.outcome === "lost") return opportunity.outcome;
  const activityAnchor = opportunity.lastActivityAt || opportunity.stageEnteredAt || opportunity.createdAt;
  const age = daysSince(activityAnchor, now);
  if (age !== null && age >= Number(stalledAfterDays || 14)) return "stalled";

  const overdueTask = tasks.some(task => {
    if (task.opportunityId && opportunity.id && task.opportunityId !== opportunity.id) return false;
    const due = task.dueAt ? new Date(task.dueAt) : null;
    return isOpenTask(task) && due && !Number.isNaN(+due) && due.getTime() < now.getTime();
  });
  const today = dayKey(chicagoParts(now));
  const close = dayKey(dateOnlyParts(opportunity.expectedCloseDate));
  if (overdueTask || (close !== null && close < today)) return "attention";
  return "on_track";
}

function normalizedList(value) {
  if (value === null || value === undefined || value === "" || value === "all") return [];
  return Array.isArray(value) ? value : [value];
}

export function filterMarketingOpportunities(rows = [], filters = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const todayParts = chicagoParts(now);
  const today = dayKey(todayParts);
  const search = String(filters.search || "").trim().toLowerCase();
  const stages = normalizedList(filters.stages || filters.stage);
  const owners = normalizedList(filters.ownerIds || filters.ownerId);
  const clients = normalizedList(filters.clientIds || filters.clientId);
  const products = normalizedList(filters.products || filters.product);
  const health = normalizedList(filters.health);
  const outcome = filters.outcome || "all";
  return (rows || []).filter(row => {
    if (filters.archived === true ? !row.archivedAt : filters.archived !== "all" && row.archivedAt) return false;
    if (search) {
      const haystack = [row.title, row.summary, row.organizationName, row.ownerName, row.source, ...(row.productTags || [])]
        .filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (stages.length && !stages.includes(row.stage)) return false;
    if (owners.length && !owners.includes(row.ownerId)) return false;
    if (clients.length && !clients.includes(row.clientId)) return false;
    if (products.length && !products.some(product => (row.productTags || []).includes(product))) return false;
    if (outcome === "open" && row.outcome) return false;
    if ((outcome === "won" || outcome === "lost") && row.outcome !== outcome) return false;
    if (health.length && !health.includes(marketingHealth(row, options.tasks || [], options))) return false;
    if (filters.closePeriod && filters.closePeriod !== "all") {
      const close = dateOnlyParts(row.expectedCloseDate);
      if (!close) return false;
      if (filters.closePeriod === "overdue" && !(dayKey(close) < today)) return false;
      if (filters.closePeriod === "month" && !(close.year === todayParts.year && close.month === todayParts.month)) return false;
      if (filters.closePeriod === "quarter" && !(close.year === todayParts.year && quarter(close) === quarter(todayParts))) return false;
    }
    return true;
  });
}

function countBy(rows, labelOf, valueOf = () => 0) {
  const map = new Map();
  for (const row of rows) {
    const label = labelOf(row) || "Unspecified";
    const current = map.get(label) || { label, count: 0, value: 0 };
    current.count += 1;
    current.value += Number(valueOf(row) || 0);
    map.set(label, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function buildMarketingInsights(rows = [], tasks = [], activities = [], options = {}) {
  const { now = new Date(), stalledAfterDays = 14 } = options;
  const active = rows.filter(row => !row.archivedAt && !row.outcome);
  const won = rows.filter(row => !row.archivedAt && row.outcome === "won");
  const lost = rows.filter(row => !row.archivedAt && row.outcome === "lost");
  const today = chicagoParts(now);
  const closingThisQuarter = active.filter(row => {
    const close = dateOnlyParts(row.expectedCloseDate);
    return close && close.year === today.year && quarter(close) === quarter(today);
  });
  const stageRows = MARKETING_STAGES.map(stage => {
    const items = rows.filter(row => !row.archivedAt && row.stage === stage.name);
    return {
      stage: stage.name,
      count: items.length,
      value: items.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0),
      weightedValue: items.reduce((sum, row) => sum + weightedMarketingValue(row), 0),
    };
  });
  const visible = rows.filter(row => !row.archivedAt);
  const visibleIds = new Set(visible.map(row => row.id));
  const scopedTasks = tasks.filter(task => visibleIds.has(task.opportunityId));
  const scopedActivities = activities.filter(activity => visibleIds.has(activity.opportunityId));
  const expectedCloseMonths = countBy(visible.filter(row => row.expectedCloseDate), row => String(row.expectedCloseDate).slice(0, 7), row => row.estimatedValue);
  const expectedCloseQuarters = countBy(visible.filter(row => row.expectedCloseDate), row => {
    const close = dateOnlyParts(row.expectedCloseDate);
    return close ? `${close.year} Q${quarter(close)}` : "Unspecified";
  }, row => row.estimatedValue);
  const usersById = options.usersById || {};
  const clientsById = options.clientsById || {};
  const history = options.history || [];
  const durations = new Map(MARKETING_STAGE_NAMES.map(stage => [stage, []]));
  for (const row of visible) {
    const rowHistory = history.filter(item => item.opportunityId === row.id).sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
    let enteredAt = row.createdAt ? new Date(row.createdAt) : null;
    for (const item of rowHistory) {
      if (!item.fromStage || item.fromStage === item.toStage) continue;
      const changedAt = new Date(item.changedAt);
      if (enteredAt && !Number.isNaN(+changedAt) && !Number.isNaN(+enteredAt)) {
        durations.get(item.fromStage)?.push(Math.max(0, (changedAt - enteredAt) / 86400000));
      } else durations.get(item.fromStage)?.push(0);
      enteredAt = changedAt;
    }
    if (!row.outcome && row.stage) {
      const start = row.stageEnteredAt ? new Date(row.stageEnteredAt) : enteredAt;
      durations.get(row.stage)?.push(start && !Number.isNaN(+start) ? Math.max(0, (now - start) / 86400000) : 0);
    }
  }
  const stageVelocity = MARKETING_STAGE_NAMES.map(stage => {
    const values = durations.get(stage) || [];
    return { stage, samples: values.length, averageDays: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 };
  });
  return {
    activeCount: active.length,
    activeValue: active.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0),
    weightedValue: active.reduce((sum, row) => sum + weightedMarketingValue(row), 0),
    wonCount: won.length,
    lostCount: lost.length,
    wonValue: won.reduce((sum, row) => sum + Number(row.finalContractValue ?? row.estimatedValue ?? 0), 0),
    lostValue: lost.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0),
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : 0,
    closingThisQuarterCount: closingThisQuarter.length,
    closingThisQuarterValue: closingThisQuarter.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0),
    overdueTaskCount: scopedTasks.filter(task => isOpenTask(task) && task.dueAt && new Date(task.dueAt).getTime() < now.getTime()).length,
    stalledCount: active.filter(row => marketingHealth(row, scopedTasks, { now, stalledAfterDays }) === "stalled").length,
    stages: stageRows,
    lossReasons: countBy(lost, row => row.lossReason, row => row.estimatedValue),
    sources: countBy(rows.filter(row => !row.archivedAt), row => row.source, row => row.estimatedValue),
    products: countBy(rows.filter(row => !row.archivedAt).flatMap(row => (row.productTags || []).map(product => ({ product, estimatedValue: row.estimatedValue }))), row => row.product, row => row.estimatedValue),
    activityTypes: countBy(scopedActivities, row => row.activityType || row.type),
    activityOwners: countBy(scopedActivities, row => usersById[row.authorId]?.name || row.authorName || "Unassigned"),
    owners: countBy(visible, row => usersById[row.ownerId]?.name || row.ownerName || "Unassigned", row => row.estimatedValue),
    organizations: countBy(visible, row => clientsById[row.clientId]?.name || row.organizationName || "Unspecified", row => row.estimatedValue),
    competitors: countBy(lost.filter(row => row.competitor), row => row.competitor, row => row.estimatedValue),
    expectedCloseMonths,
    expectedCloseQuarters,
    stageVelocity,
    attention: active.filter(row => ["attention", "stalled"].includes(marketingHealth(row, scopedTasks, { now, stalledAfterDays }))),
  };
}

export function marketingCsvRows(rows = [], { usersById = {}, clientsById = {} } = {}, options = {}) {
  const taskList = options.tasks || [];
  return rows.map(row => ({
    product: (row.productTags || []).join("; "),
    project: row.title || "",
    leadSource: row.source || "",
    client: clientsById[row.clientId]?.name || row.organizationName || "",
    poc: (row.contacts || []).map(contact => contact.name).filter(Boolean).join("; "),
    assignedTo: row.assignedTeam || usersById[row.ownerId]?.name || row.ownerName || "",
    taskOrder: row.taskOrder || "",
    currentStatus: row.deliveryStatus || "",
    projectPercent: row.projectProgress ?? "",
    salesPhase: row.sourceSalesPhase || "",
    salesPercent: row.probability ?? "",
    opportunity: row.title || "",
    organization: clientsById[row.clientId]?.name || row.organizationName || "",
    stage: row.stage || "",
    outcome: row.outcome || "",
    owner: usersById[row.ownerId]?.name || row.ownerName || "",
    estimatedValue: Number(row.estimatedValue || 0),
    weightedValue: weightedMarketingValue(row),
    probability: Number(row.probability || 0),
    expectedCloseDate: row.expectedCloseDate || "",
    nextAction: row.nextAction || "",
    nextActionDueAt: row.nextActionDueAt || "",
    health: marketingHealth(row, taskList, options),
    daysInStage: row.stageEnteredAt ? Math.max(0, Math.floor(daysSince(row.stageEnteredAt, options.now || new Date()) || 0)) : "",
    products: (row.productTags || []).join("; "),
    lastActivityAt: row.lastActivityAt || "",
    budget: row.budgetNotes || "",
    authority: row.authorityNotes || "",
    need: row.needSummary || "",
    timing: row.timingSummary || "",
    lossReason: row.lossReason || "",
    lossDetail: row.lossDetail || "",
  }));
}
