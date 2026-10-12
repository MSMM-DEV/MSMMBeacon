import { MARKETING_LOSS_REASONS, MARKETING_STAGE_NAMES, stageDefinition } from "./marketing-rules.js";

const OPPORTUNITY_FIELDS = Object.freeze({
  title: "title",
  clientId: "client_id",
  ownerId: "owner_id",
  createdBy: "created_by",
  updatedBy: "updated_by",
  stage: "stage",
  stageEnteredAt: "stage_entered_at",
  probability: "probability",
  expectedCloseDate: "expected_close_date",
  estimatedValue: "estimated_value",
  currency: "currency",
  productTags: "product_tags",
  source: "source",
  introducer: "introducer",
  summary: "summary",
  nextAction: "next_action",
  nextActionDueAt: "next_action_due_at",
  lastActivityAt: "last_activity_at",
  showcaseMeetingAt: "showcase_meeting_at",
  showcaseLocation: "showcase_location",
  showcaseProducts: "showcase_products",
  showcaseAttendeesSummary: "showcase_attendees_summary",
  showcaseFit: "showcase_fit",
  showcaseOutcome: "showcase_outcome",
  problemStatement: "problem_statement",
  desiredOutcome: "desired_outcome",
  solutionFit: "solution_fit",
  clarifyingQuestions: "clarifying_questions",
  clarifyingOwnerId: "clarifying_owner_id",
  clarifyingDueAt: "clarifying_due_at",
  clarifyingAnswersStatus: "clarifying_answers_status",
  draftSowStatus: "draft_sow_status",
  budgetAmount: "budget_amount",
  budgetStatus: "budget_status",
  budgetNotes: "budget_notes",
  authorityContactId: "authority_contact_id",
  authorityNotes: "authority_notes",
  needSummary: "need_summary",
  timingSummary: "timing_summary",
  decisionProcess: "decision_process",
  proposalVersion: "proposal_version",
  proposalValue: "proposal_value",
  proposalSentAt: "proposal_sent_at",
  scopeSummary: "scope_summary",
  anticipatedDecisionDate: "anticipated_decision_date",
  verbalApprovalAt: "verbal_approval_at",
  verbalApproverContactId: "verbal_approver_contact_id",
  verbalTerms: "verbal_terms",
  targetSignatureDate: "target_signature_date",
  signatureRisks: "signature_risks",
  resourcePlanningNote: "resource_planning_note",
  msaStatus: "msa_status",
  sowStatus: "sow_status",
  legalOwnerId: "legal_owner_id",
  customerLegalContactId: "customer_legal_contact_id",
  redlineStatus: "redline_status",
  legalIssues: "legal_issues",
  latestDocumentVersion: "latest_document_version",
  outcome: "outcome",
  signedAt: "signed_at",
  finalContractValue: "final_contract_value",
  lossReason: "loss_reason",
  lossDetail: "loss_detail",
  competitor: "competitor",
  lessonLearned: "lesson_learned",
  lastTransitionNote: "last_transition_note",
  archivedAt: "archived_at",
  archivedBy: "archived_by",
});

const ARRAY_FIELDS = new Set(["productTags", "showcaseProducts"]);
const NUMBER_FIELDS = new Set(["probability", "estimatedValue", "budgetAmount", "proposalValue", "finalContractValue"]);
const REQUIRED_STRINGS = new Set(["title"]);
const IMMUTABLE_PATCH_FIELDS = new Set(["createdBy", "stageEnteredAt", "lastActivityAt", "archivedAt", "archivedBy"]);

const cleanText = value => {
  if (value === null || value === undefined) return null;
  const clean = String(value).trim();
  return clean || null;
};

function normalizedField(key, value) {
  if (ARRAY_FIELDS.has(key)) return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
  if (NUMBER_FIELDS.has(key)) {
    if (value === "" || value === null || value === undefined) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`${key} must be a number`);
    return numeric;
  }
  if (typeof value === "string" || value === null) return cleanText(value);
  return value;
}

function validateDomain(payload) {
  if (payload.stage !== undefined && payload.stage !== null && !MARKETING_STAGE_NAMES.includes(payload.stage)) {
    throw new Error("Choose a valid Marketing stage");
  }
  if (payload.loss_reason !== undefined && payload.loss_reason !== null && !MARKETING_LOSS_REASONS.includes(payload.loss_reason)) {
    throw new Error("Choose a valid loss reason");
  }
  if (payload.probability !== undefined && payload.probability !== null && (payload.probability < 0 || payload.probability > 100)) {
    throw new Error("Probability must be between 0 and 100");
  }
  return payload;
}

function buildPayload(input = {}, { patch = false } = {}) {
  const result = {};
  for (const [key, column] of Object.entries(OPPORTUNITY_FIELDS)) {
    if (!(key in input) || (patch && IMMUTABLE_PATCH_FIELDS.has(key))) continue;
    const value = normalizedField(key, input[key]);
    if (REQUIRED_STRINGS.has(key) && !value) throw new Error("Opportunity name is required");
    result[column] = value;
  }
  return validateDomain(result);
}

export function marketingOpportunityInsert(input = {}) {
  const title = cleanText(input.title);
  if (!title) throw new Error("Opportunity name is required");
  const stage = input.stage || MARKETING_STAGE_NAMES[0];
  const payload = buildPayload({ ...input, title, stage });
  if (!("probability" in payload)) payload.probability = stageDefinition(stage)?.defaultProbability ?? 5;
  if (!("currency" in payload)) payload.currency = "USD";
  return payload;
}

export function marketingOpportunityPatch(input = {}, expectedVersion) {
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error("A valid expected version is required");
  return { patch: buildPayload(input, { patch: true }), expectedVersion: version };
}

const objectName = value => value?.display_name || value?.name || value?.short_name || null;

export function adaptMarketingOpportunity(row = {}) {
  const result = {
    id: row.id,
    version: Number(row.version ?? 1),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
  for (const [key, column] of Object.entries(OPPORTUNITY_FIELDS)) {
    const value = row[column];
    result[key] = NUMBER_FIELDS.has(key)
      ? (value === null || value === undefined || value === "" ? null : Number(value))
      : ARRAY_FIELDS.has(key) ? [...(value || [])] : (value ?? null);
  }
  result.client = row.client ? { ...row.client } : null;
  result.owner = row.owner ? { ...row.owner } : null;
  result.organizationName = objectName(row.client);
  result.ownerName = objectName(row.owner);
  result.primaryContact = row.primary_contact ? { ...row.primary_contact } : null;
  result.contacts = (row.contacts || []).map(adaptMarketingContact);
  result.activities = (row.activities || []).map(adaptMarketingActivity);
  result.tasks = (row.tasks || []).map(adaptMarketingTask);
  result.documents = (row.documents || []).map(adaptMarketingDocument);
  result.history = (row.history || []).map(adaptMarketingHistory);
  return result;
}

export function adaptMarketingContact(row = {}) {
  const contact = row.contact ? { ...row.contact } : null;
  return {
    opportunityId: row.opportunity_id,
    contactId: row.contact_id,
    role: row.role || "Other",
    isPrimary: !!row.is_primary,
    notes: row.notes || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    contact,
    name: contact?.name || "Unknown contact",
    email: contact?.email || null,
    phone: contact?.phone || null,
    companyId: contact?.company_id || null,
  };
}

export function adaptMarketingActivity(row = {}) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    activityType: row.activity_type,
    occurredAt: row.occurred_at,
    authorId: row.author_id || null,
    summary: row.summary,
    outcome: row.outcome || "",
    nextStep: row.next_step || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    userIds: (row.users || row.marketing_activity_users || []).map(item => item.user_id),
    contactIds: (row.contacts || row.marketing_activity_contacts || []).map(item => item.contact_id),
  };
}

export function adaptMarketingTask(row = {}) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    title: row.title,
    assigneeId: row.assignee_id || null,
    dueAt: row.due_at || null,
    priority: row.priority || "normal",
    status: row.status || "open",
    notes: row.notes || "",
    alertId: row.alert_id || null,
    completedAt: row.completed_at || null,
    completedBy: row.completed_by || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export const adaptMarketingDocument = (row = {}) => ({
  id: row.id,
  opportunityId: row.opportunity_id,
  documentType: row.document_type,
  filePath: row.file_path,
  fileName: row.file_name,
  mimeType: row.mime_type || null,
  sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
  uploadedBy: row.uploaded_by || null,
  uploadedAt: row.uploaded_at || null,
});

export const adaptMarketingHistory = (row = {}) => ({
  id: row.id,
  opportunityId: row.opportunity_id,
  fromStage: row.from_stage || null,
  toStage: row.to_stage,
  previousProbability: row.previous_probability == null ? null : Number(row.previous_probability),
  newProbability: Number(row.new_probability ?? 0),
  previousOutcome: row.previous_outcome || null,
  newOutcome: row.new_outcome || null,
  transitionNote: row.transition_note || "",
  changedBy: row.changed_by || null,
  changedAt: row.changed_at || null,
});

export class MarketingConflictError extends Error {
  constructor(message = "This opportunity changed while you were editing it.", latestVersion = null) {
    super(message);
    this.name = "MarketingConflictError";
    this.latestVersion = latestVersion == null ? null : Number(latestVersion);
    this.code = "MARKETING_CONFLICT";
  }
}

export { OPPORTUNITY_FIELDS };
