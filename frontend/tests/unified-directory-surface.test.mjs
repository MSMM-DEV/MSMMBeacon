import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const tables = readFileSync(new URL("../src/tables.jsx", import.meta.url), "utf8");
const contacts = readFileSync(new URL("../src/contacts.jsx", import.meta.url), "utf8");

test("directory surface has one company model", () => {
  assert.doesNotMatch(app, /getClientsOnly|setClients\b|createTable\("clients"\)/);
  assert.doesNotMatch(tables, /selectedKind === "Client"|groupedRows\.clients/);
  assert.doesNotMatch(contacts, /clientId/);
  assert.match(tables, /Import business cards/);
});
