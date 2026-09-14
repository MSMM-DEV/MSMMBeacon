import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/design/pages/invoice.css", import.meta.url), "utf8");

function ruleContaining(selectorFragment, declarationFragment) {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selector, declarations]) => selector.includes(selectorFragment) && declarations.includes(declarationFragment));
  assert.ok(match, `Missing CSS rule containing ${selectorFragment} and ${declarationFragment}`);
  return match[2];
}

function px(declarations, property) {
  const value = declarations.match(new RegExp(`${property.replace(/-/g, "\\-")}\\s*:\\s*(\\d+)px`))?.[1];
  assert.ok(value, `Missing pixel value for ${property}`);
  return Number(value);
}

test("desktop Invoice totals remain readable without letting the fixed rail dominate", () => {
  const table = ruleContaining(".invoice-workspace .invoice-table", "--inv-rem-w");
  const billed = ruleContaining(".invoice-workspace .invoice-table :is(th,td).inv-pin-ytd", "min-width");
  const active = ruleContaining(".inv-mode-active", "--inv-act-w");
  const between = ruleContaining(".inv-mode-between", "--inv-act-w");
  const closed = ruleContaining(".inv-mode-closed", "--inv-act-w");

  const billedWidth = px(billed, "min-width");
  const remainingWidth = px(table, "--inv-rem-w");
  const activeRail = billedWidth + remainingWidth + px(active, "--inv-act-w");
  const betweenRail = billedWidth + remainingWidth + px(between, "--inv-act-w");
  const closedRail = billedWidth + remainingWidth + px(closed, "--inv-act-w");

  assert.ok(billedWidth >= 124, "Total Billed must fit a 14-character currency value");
  assert.ok(remainingWidth >= 124, "Total Remaining must fit a 14-character currency value");
  assert.ok(activeRail <= 332, `active fixed rail is ${activeRail}px; expected at most 332px`);
  assert.ok(betweenRail <= 356, `In-Between fixed rail is ${betweenRail}px; expected at most 356px`);
  assert.ok(closedRail <= 332, `Closed Out fixed rail is ${closedRail}px; expected at most 332px`);
});
