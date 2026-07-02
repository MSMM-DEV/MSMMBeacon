import assert from "node:assert/strict";
import test from "node:test";

import { serverSupabase } from "../api/_lib/beacon-api.mjs";

test("serverSupabase can use Vite Supabase env with a user bearer token", () => {
  assert.doesNotThrow(() => serverSupabase({
    VITE_SUPABASE_URL: "https://example.supabase.co",
    VITE_SUPABASE_ANON_KEY: "anon-key",
  }, "user-access-token"));
});
