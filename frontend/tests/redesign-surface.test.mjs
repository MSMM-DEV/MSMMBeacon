import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const design = new URL("../src/design/", import.meta.url);
const css = readFileSync(new URL("tokens.css", design), "utf8");
const [light, dark] = css.split('[data-theme="dark"]');
const declarations = source => Object.fromEntries([...source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
const base = declarations(light);
const resolve = (tokens, name) => {
  const value = tokens[name];
  assert.ok(value, `Missing token ${name}`);
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  return reference ? resolve(tokens, reference[1]) : value;
};
const luminance = hex => {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const pairs = [
  ["--text", "--surface"], ["--text-muted", "--surface"], ["--text-soft", "--surface-2"],
  ["--accent-on", "--accent-solid"], ["--accent-on", "--accent-hover"], ["--accent-ink", "--accent-soft"],
  ["--sage-ink", "--sage-soft"], ["--rose-ink", "--rose-soft"], ["--blue-ink", "--blue-soft"],
  ["--destructive-foreground", "--destructive"], ["--success-foreground", "--success"],
  ["--warning-foreground", "--warning"], ["--info-foreground", "--info"],
  ["--invoice-actual-ink", "--invoice-actual-bg"],
  ["--invoice-projection-ink", "--invoice-projection-bg"],
  ["--invoice-paid-ink", "--invoice-paid-bg"],
];
for (const [theme, tokens] of [["light", base], ["dark", {...base, ...declarations(dark.split("}")[0])}]]) {
  test(`${theme} theme semantic text pairs meet WCAG AA normal-text contrast`, () => {
    for (const [foreground, background] of pairs) {
      const a = luminance(resolve(tokens, foreground));
      const b = luminance(resolve(tokens, background));
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  });
}

test("each redesigned page stylesheet is integrated and exists", () => {
  const index = readFileSync(new URL("index.css", design), "utf8");
  const pages = ["proposals", "awarded", "projects", "events", "invoice", "directory", "team-calendar", "timesheet", "time-admin", "licenses", "project-detail", "login", "potential", "hotleads", "openbids", "admin", "record-editors", "between", "closed", "leads-archive", "proposals-archive"];
  for (const page of pages) {
    assert.ok(index.includes(`./pages/${page}.css`), `Missing import for ${page}`);
    assert.ok(existsSync(new URL(`pages/${page}.css`, design)), `Missing CSS for ${page}`);
  }
});

test("shared motion honours the system reduced-motion preference", () => {
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /animation-duration:\s*1ms\s*!important/);
  assert.match(css, /transition-duration:\s*1ms\s*!important/);
});

test("legacy primary buttons use the same accessible filled-action tokens", () => {
  const workspace = readFileSync(new URL("workspace.css", design), "utf8");
  const primary = workspace.match(/\.btn\.primary\s*\{([^}]+)\}/)?.[1] || "";
  const hover = workspace.match(/\.btn\.primary:hover\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(primary, /background:\s*var\(--accent-solid\)/);
  assert.match(primary, /color:\s*var\(--accent-on\)/);
  assert.match(hover, /background:\s*var\(--accent-hover\)/);
});

test("literal interface icons all resolve in the shared registry", () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  const registrySource = readFileSync(new URL("icons.jsx", sourceRoot), "utf8");
  const names = new Set([...registrySource.matchAll(/^  (\w+):/gm)].map(m => m[1]));
  const visit = directory => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".jsx") && entry.name !== "icons.jsx") {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/<Icon\b[^>]*\bname="([^"]+)"/g)) {
          assert.ok(names.has(match[1]), `${file.pathname}: unknown icon ${match[1]}`);
        }
      }
    }
  };
  visit(sourceRoot);
});
