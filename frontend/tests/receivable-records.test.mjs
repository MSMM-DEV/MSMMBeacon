import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import React from "react";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/quadsheet-receivables.jsx", import.meta.url), "utf8");
const compiled = await transform(source, { loader: "jsx", format: "cjs" });
const fileReads = [];
const openedFiles = [];
const deps = new Proxy({ fmtMoney: v => `$${v}`, getInvoiceFileSignedUrl: async (path, expiry) => {
  fileReads.push([path, expiry]); return `https://example.test/${path}`;
} }, { get: (o, k) => o[k] ?? (() => null) });
const module = { exports: {} };
vm.runInNewContext(compiled.code, { module, exports: module.exports, require: n => n === "react" ? React : deps, console, window: { open: (...args) => openedFiles.push(args) } });
const nodes = n => React.isValidElement(n) ? [n, ...React.Children.toArray(n.props.children).flatMap(nodes)] : [];
const words = n => React.isValidElement(n) ? React.Children.toArray(n.props.children).map(words).join(" ") : String(n ?? "");
const project = { projectId: "p1", projectName: "Bridge renewal", projectNumber: "B-1", year: 2026, statusKey: "awarded", contractAmount: 1000, billedToDate: 200, pending: 300, remaining: 500, billingEntries: [] };
const sub = { companyId: "c1", companyName: "Engineering firm", projects: [project], isMsmm: true };

test("receivables expose firm, project and all amounts without an expansion", () => {
  const tree = module.exports.ReceivableRecords({ subs: [sub] });
  const text = words(tree);
  for (const value of ["Engineering firm", "Bridge renewal", "$1000", "$200", "$300", "$800", "Owed to MSMM"]) assert.ok(text.includes(value), value);
  assert.ok(!nodes(tree).some(n => n.props["aria-expanded"] !== undefined));
});

test("one View invoices action passes the original firm and project without mutation", () => {
  const calls = [];
  const before = JSON.stringify(sub);
  const tree = module.exports.ReceivableRecords({ subs: [sub], onView: (...args) => calls.push(args) });
  const button = nodes(tree).find(n => n.type === "button");
  const event = { currentTarget: {} };
  button.props.onClick(event);
  assert.equal(calls[0][0], sub);
  assert.equal(calls[0][1], project);
  assert.equal(calls[0][2], event);
  assert.equal(JSON.stringify(sub), before);
});

test("contract-only records stay visible and unset contracts are identified", () => {
  const tree = module.exports.ReceivableRecords({ subs: [{ ...sub, projects: [{ ...project, contractAmount: 0, billedToDate: 0, pending: 0 }] }] });
  assert.ok(words(tree).includes("Not set"));
  assert.ok(words(tree).includes("No invoices yet"));
});

test("separate firm relationships on the same project retain distinct row identities and actions", () => {
  const paired = { ...project, primeFirmName: "Joint venture" };
  const tree = module.exports.ReceivableRecords({ subs: [{ ...sub, projects: [project, paired] }] });
  const rows = nodes(tree).filter(n => n.type === "tr" && nodes(n).some(c => c.type === "td"));
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(r => r.key)).size, 2);
  const labels = nodes(tree).filter(n => n.type === "button").map(n => n.props["aria-label"]);
  assert.equal(new Set(labels).size, 2);
});

test("every attached invoice file has its own named action using the existing signed-file reader", async () => {
  const tree = module.exports.InvoiceEntryRow({ tone: "pending", entry: { monthLabel: "Sep", amount: 300, files: [{id:"f1", file_name:"Invoice A.pdf", file_path:"a.pdf"}, {id:"f2", file_name:"Invoice B.pdf", file_path:"b.pdf"}] } });
  const buttons = nodes(tree).filter(n => n.type === "button");
  assert.equal(buttons.length, 2);
  assert.ok(words(buttons[0]).includes("Invoice A.pdf"));
  assert.ok(words(buttons[1]).includes("Invoice B.pdf"));
  await buttons[1].props.onClick();
  assert.deepEqual(fileReads.at(-1), ["b.pdf", 60]);
  assert.deepEqual(openedFiles.at(-1), ["https://example.test/b.pdf", "_blank", "noopener,noreferrer"]);
});
