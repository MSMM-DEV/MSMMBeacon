import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { transform } from "esbuild";
import * as rules from "../src/marketing-rules.js";
import * as model from "../src/marketing-model.js";

const passthrough = ({ children, ...props }) => React.createElement("div", props, children);
const ui = new Proxy({}, { get: () => passthrough });
const icon = { Icon: props => React.createElement("span", props) };

async function compile(file) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  return transform(source, { loader: "jsx", format: "cjs" });
}

const boardModule = { exports: {} };
const boardCompiled = await compile("../src/marketing-components/MarketingBoard.jsx").catch(error => ({ error }));
if (!boardCompiled.error) {
  vm.runInNewContext(boardCompiled.code, {
    module: boardModule,
    exports: boardModule.exports,
    require: name => name === "react" ? React : name.includes("marketing-rules") ? rules : name.includes("marketing-model") ? model : name === "@/ui" ? ui : icon,
    console,
    Date,
    Intl,
  });
}

const nodes = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(nodes)] : [];
const words = node => React.isValidElement(node)
  ? React.Children.toArray(node.props.children).map(words).join(" ") : String(node ?? "");

test("board renders all exact stages in order, with one terminal lane", () => {
  assert.ok(boardModule.exports.MarketingBoard, boardCompiled.error?.message);
  const rows = [
    { id: "a", title: "AI assistant", stage: rules.MARKETING_STAGE_NAMES[0], probability: 5, estimatedValue: 10000 },
    { id: "w", title: "Won deal", stage: rules.MARKETING_STAGE_NAMES[6], outcome: "won", probability: 100 },
    { id: "l", title: "Lost deal", stage: rules.MARKETING_STAGE_NAMES[6], outcome: "lost", probability: 0 },
    { id: "x", title: "Archived secret", stage: rules.MARKETING_STAGE_NAMES[0], archivedAt: "2026-01-01" },
  ];
  const tree = boardModule.exports.MarketingBoard({ opportunities: rows, tasks: [] });
  const headings = nodes(tree).filter(node => node.type === "h3").map(words);
  assert.deepEqual(headings, rules.MARKETING_STAGE_NAMES);
  const text = words(tree);
  assert.match(text, /Won/);
  assert.match(text, /Lost/);
  assert.doesNotMatch(text, /Archived secret/);
  const cards = nodes(tree).filter(node => node.props["data-marketing-card"]);
  assert.ok(cards.every(card => card.props["aria-label"]?.includes("opportunity")));
});

test("move menu sends the original opportunity and exact destination stage", () => {
  const row = { id: "a", title: "AI assistant", stage: rules.MARKETING_STAGE_NAMES[0], probability: 5 };
  const calls = [];
  const tree = boardModule.exports.MarketingBoard({ opportunities: [row], tasks: [], onMoveIntent: (...args) => calls.push(args) });
  const card = nodes(tree).find(node => typeof node.type === "function" && node.props.opportunity === row);
  const select = nodes(card.type(card.props)).find(node => node.type === "select" && node.props["aria-label"]?.startsWith("Move"));
  select.props.onChange({ target: { value: rules.MARKETING_STAGE_NAMES[2] } });
  assert.equal(calls[0][0], row);
  assert.equal(calls[0][1], "IQM - Initial Qualified Meeting");
});

test("terminal lane can filter Won and Lost locally", () => {
  const terminal = rules.MARKETING_STAGE_NAMES.at(-1);
  const tree = boardModule.exports.MarketingBoard({
    opportunities: [
      { id: "w", title: "Won deal", stage: terminal, outcome: "won", probability: 100 },
      { id: "l", title: "Lost deal", stage: terminal, outcome: "lost", probability: 0 },
    ],
    tasks: [],
    terminalOutcome: "won",
  });
  const cardRows = nodes(tree).filter(node => typeof node.type === "function" && node.props.opportunity).map(node => node.props.opportunity.title);
  assert.deepEqual(cardRows, ["Won deal"]);
  assert.ok(nodes(tree).some(node => node.props["aria-label"] === "Filter final stage by outcome"));
});

test("transition coordinator changes rows only after authoritative success", async () => {
  const marketingModule = { exports: {} };
  const compiled = await compile("../src/marketing.jsx");
  const data = new Proxy({}, { get: () => async () => ({}) });
  vm.runInNewContext(compiled.code, {
    module: marketingModule,
    exports: marketingModule.exports,
    require: name => name === "react" ? React : name === "@/ui" ? ui : name.includes("marketing-rules") ? rules : name.includes("icons") ? icon : data,
    console,
    window: { location: { search: "", pathname: "/" }, history: { replaceState() {} } },
    URLSearchParams,
    Date,
  });
  const original = [{ id: "a", version: 1, stage: rules.MARKETING_STAGE_NAMES[0] }];
  await assert.rejects(() => marketingModule.exports.runMarketingTransition({
    api: async () => { throw new Error("offline"); },
    opportunity: original[0],
    transition: { toStage: rules.MARKETING_STAGE_NAMES[1], probability: 20 },
  }));
  assert.equal(original[0].stage, rules.MARKETING_STAGE_NAMES[0]);

  const returned = { ...original[0], version: 2, stage: rules.MARKETING_STAGE_NAMES[1] };
  const saved = await marketingModule.exports.runMarketingTransition({ api: async () => returned, opportunity: original[0], transition: { toStage: returned.stage, probability: 20 } });
  assert.deepEqual(marketingModule.exports.applyAuthoritativeOpportunity(original, saved), [returned]);
  assert.notEqual(saved, original[0]);

  const workspace = {
    opportunities: [{ ...original[0], contacts: [{ id: "old" }] }], archivedOpportunities: [],
    contacts: [{ opportunityId: "a", id: "old" }], activities: [], tasks: [], documents: [], history: [],
  };
  const reconciled = marketingModule.exports.reconcileMarketingWorkspace(workspace, {
    ...returned, contacts: [{ opportunityId: "a", id: "new" }], activities: [], tasks: [], documents: [], history: [],
  });
  assert.equal(reconciled.contacts[0].id, "new");
  const archived = marketingModule.exports.reconcileMarketingWorkspace(reconciled, { ...reconciled.opportunities[0], archivedAt: "2026-10-12" });
  assert.equal(archived.opportunities.length, 0);
  assert.equal(archived.archivedOpportunities.length, 1);
});

test("create and terminal transitions enforce the marketing rules", () => {
  assert.throws(() => model.marketingOpportunityInsert({ title: "  " }), /required/);
  const invalid = rules.validateMarketingTransition({ toStage: rules.MARKETING_STAGE_NAMES[6], outcome: "won" });
  assert.ok(invalid.errors.length > 0);
  const valid = rules.validateMarketingTransition({
    toStage: rules.MARKETING_STAGE_NAMES[6], probability: 100, outcome: "won", signedAt: "2026-10-12", finalContractValue: 50000,
  });
  assert.equal(valid.errors.length, 0);
});

test("cards keep scan-critical context visible and leave detail fields to the drawer", () => {
  const row = {
    id: "compact",
    title: "HSDRRS",
    stage: rules.MARKETING_STAGE_NAMES[0],
    organizationName: "USACE",
    probability: 90,
    projectProgress: 20,
    deliveryStatus: "Waiting for Contract",
    assignedTeam: "RAJ",
    expectedCloseDate: "2026-12-15",
    stageEnteredAt: "2026-10-01T12:00:00Z",
    estimatedValue: 125000,
    sourceSalesPhase: "Verified BANT and Economic Buyer Approval",
    productTags: ["Parish Intelligence"],
    nextAction: "Send clarifying questions",
    nextActionDueAt: "2026-10-17",
  };
  const tree = boardModule.exports.MarketingBoard({ opportunities: [row], tasks: [] });
  const cardElement = nodes(tree).find(node => typeof node.type === "function" && node.props.opportunity === row);
  const card = cardElement.type(cardElement.props);
  const text = words(card).replace(/\s+/g, " ");

  assert.match(text, /HSDRRS/);
  assert.match(text, /USACE/);
  assert.match(text, /Sales 90\s*%/);
  assert.match(text, /Project 20\s*%/);
  assert.match(text, /RAJ/);
  assert.match(text, /Waiting for Contract/);
  assert.match(text, /Send clarifying questions/);
  assert.ok(nodes(card).some(node => node.type === "select" && node.props["aria-label"]?.startsWith("Move")));

  assert.doesNotMatch(text, /\$125,000/);
  assert.doesNotMatch(text, /Verified BANT and Economic Buyer Approval/);
  assert.doesNotMatch(text, /Parish Intelligence/);
  assert.doesNotMatch(text, /Dec 15, 2026/);
  assert.doesNotMatch(text, /in stage/);
});
