import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import React from "react";
import { transform } from "esbuild";

// Execute the real page renderer with inert UI/data dependencies. No browser,
// credentials or network is involved; callback assertions exercise its controls.
const source = await readFile(new URL("../src/tables.jsx", import.meta.url), "utf8");
const compiled = await transform(source, { loader: "jsx", format: "cjs" });
const fixtures = {
  getCompanies: () => [], getClientsOnly: () => [], getCompaniesOnly: () => [],
  getUsers: () => [], buildClientOrCompanyOptions: () => [],
  companyById: () => ({ name: "Sample client", orgType: "Public" }),
  userById: () => ({ name: "Sample manager" }),
  fmtDate: value => value, fmtMoney: value => String(value),
};
const deps = new Proxy(fixtures, { get: (target, key) => target[key] ?? (() => null) });
const module = { exports: {} };
vm.runInNewContext(compiled.code, {
  module, exports: module.exports,
  require: name => name === "react" ? React : deps,
  console, Date, Set, Map,
});
const { AwaitingTable } = module.exports;
const descendants = node => {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(descendants)];
};
const sample = { id: "proposal-1", name: "A long proposal project name", projectNumber: "P-001", year: 2026, role: "Prime", pmIds: [], subs: [], dateSubmitted: "2026-08-01" };
function render(props = {}) {
  const root = AwaitingTable({ rows: [sample], tab: "awaiting", ...props });
  const table = descendants(root).find(node => node.props.renderRow);
  const columns = table.props.columns.filter(col => !col.defaultHidden);
  return { table, columns, row: table.props.renderRow(sample, 0, "42px 240px", columns) };
}

test("proposal records give every visible data field an actual label and preserve cell roles", () => {
  const { columns, row } = render();
  const elements = descendants(row);
  for (const col of columns.filter(col => !col.label.startsWith("__"))) {
    const cell = elements.find(node => node.props["data-proposal-field"] === col.label);
    assert.ok(cell, `${col.label} has its record cell`);
    assert.equal(cell.props.role, "cell");
    assert.ok(descendants(cell).some(node => node.props.className === "proposal-field-label" && node.props.children === col.label));
  }
});

test("revealing an optional column exposes its labeled editor and original update callback", () => {
  const changes = [];
  const { table } = render({ updateRow: (...args) => changes.push(args) });
  const row = table.props.renderRow(sample, 0, "1fr", table.props.columns);
  const notes = descendants(row).find(node => node.props["data-proposal-field"] === "Notes");
  assert.ok(notes);
  descendants(notes).find(node => node.props.type === "textarea").props.onChange("Follow up");
  assert.equal(changes.length, 1);
  assert.equal(changes[0][0], sample.id);
  assert.equal(changes[0][1].notes, "Follow up");
  assert.deepEqual(Object.keys(changes[0][1]), ["notes"]);
});

test("record layout honors column order and preserves the original grouped rows", () => {
  const { table, columns } = render();
  const reordered = [...columns].reverse();
  const row = table.props.renderRow(sample, 0, "1fr", reordered);
  assert.deepEqual(descendants(row).filter(node => node.props["data-proposal-field"]).map(node => node.props["data-proposal-field"]), reordered.map(col => col.label));
  const grouped = table.props.postProcess([sample]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[1], sample);
  const heading = table.props.renderRow(grouped[0], 0, "1fr", columns);
  assert.equal(heading.props.role, "row");
  assert.ok(descendants(heading).some(node => node.props["aria-colspan"] === columns.length));
});

test("record decisions and deleted-record restoration use the existing callbacks", () => {
  const calls = [];
  const { row } = render({ onForward: (...args) => calls.push(args), onCloseOut: r => calls.push([r, "close"]) });
  const buttons = descendants(row).filter(node => node.type === "button");
  buttons.find(node => node.props["aria-label"]?.startsWith("Award ")).props.onClick();
  buttons.find(node => node.props["aria-label"]?.startsWith("Close out ")).props.onClick();
  const deleted = render({ deletedMode: true, onRestore: r => calls.push([r, "restore"]) });
  descendants(deleted.row).find(node => node.props["aria-label"]?.startsWith("Restore ")).props.onClick();
  assert.deepEqual(calls, [[sample, "Awarded"], [sample, "close"], [sample, "restore"]]);
  assert.ok(!descendants(deleted.row).some(node => node.props["aria-label"]?.startsWith("Award ")));
});
