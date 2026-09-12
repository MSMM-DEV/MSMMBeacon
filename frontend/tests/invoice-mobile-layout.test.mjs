import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { decorateInvoiceLedger, resolveInvoiceFocusMonth } from "../src/invoice-mobile-layout.js";

const months = [
  { abs: 24323, year: 2026, monthIdx: 11, label: "Dec 2026" },
  { abs: 24324, year: 2027, monthIdx: 0, label: "Jan 2027" },
];

test("month focus survives a window shift and falls back to current or nearest month", () => {
  assert.equal(resolveInvoiceFocusMonth(months, 24323, 2027, 0), 24323);
  assert.equal(resolveInvoiceFocusMonth(months, null, 2027, 0), 24324);
  assert.equal(resolveInvoiceFocusMonth(months, 24322, 2026, 8), 24323);
  assert.equal(resolveInvoiceFocusMonth([], 24323, 2027, 0), null);
});

test("layout preserves every cell, editor, handler and key when month focus changes", () => {
  const onEdit = () => {};
  const editor = React.createElement("input", { key: "editor", onChange: onEdit });
  const row = React.createElement("tr", { key: "project", className: "expanded", onDoubleClick: onEdit },
    ...Array.from({ length: 8 }, (_, i) => React.createElement("td", { key: `meta-${i}` }, `field ${i}`)),
    ...months.map(month => React.createElement("td", { key: month.abs, onClick: onEdit }, editor)),
    ...["billed", "remaining", "actions"].map(key => React.createElement("td", { key }, key)));
  const first = decorateInvoiceLedger(row, months, months[0].abs)[0];
  const second = decorateInvoiceLedger(row, months, months[1].abs)[0];
  const a = React.Children.toArray(first.props.children);
  const b = React.Children.toArray(second.props.children);
  assert.equal(a.length, 13);
  assert.equal(first.props.onDoubleClick, onEdit);
  assert.deepEqual(a.map(cell => cell.key), b.map(cell => cell.key));
  assert.equal(a[8].props["data-mobile-selected"], true);
  assert.equal(b[8].props["data-mobile-selected"], false);
  assert.equal(a[8].props.onClick, onEdit);
  assert.equal(a[8].props.children[1].props.children, editor);
  assert.equal(a[8].props.children[0].props.children, "Dec 2026");
  assert.equal(a[10].props.children[0].props.children, "Total billed");
});

test("colspan rows keep their full-width messages and actions without false month labels", () => {
  const add = React.createElement("tr", { className: "invoice-sub-add-row" },
    React.createElement("td", null), React.createElement("td", null),
    React.createElement("td", { colSpan: 8 }, React.createElement("button", null, "Add sub")),
    React.createElement("td", null), React.createElement("td", null), React.createElement("td", null));
  const output = decorateInvoiceLedger(React.createElement(React.Fragment, { key: "group" }, add), months, 24323)[0];
  const cells = React.Children.toArray(output.props.children[0].props.children);
  assert.equal(cells[2].props.colSpan, 8);
  assert.match(cells[2].props.className, /invoice-mobile-wide/);
  assert.equal(cells[2].props["data-mobile-selected"], undefined);
  assert.equal(cells[2].props.children.type, "button");
});
