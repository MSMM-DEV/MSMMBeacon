import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_STAR_MAX,
  HOT_LEAD_STAR_MAX,
  starLabel,
  starOptions,
  starsRank,
} from "../src/star-rating.js";

test("hot leads use a 3-star rating scale while the default stays 5-star", () => {
  assert.equal(DEFAULT_STAR_MAX, 5);
  assert.equal(HOT_LEAD_STAR_MAX, 3);
  assert.deepEqual(starOptions(HOT_LEAD_STAR_MAX), [1, 2, 3]);
  assert.deepEqual(starOptions(), [1, 2, 3, 4, 5]);
});

test("star labels and sort ranks honor the supplied rating scale", () => {
  assert.equal(starLabel(3, HOT_LEAD_STAR_MAX), "3 of 3 stars");
  assert.equal(starLabel(null, HOT_LEAD_STAR_MAX), "Unrated");
  assert.equal(starsRank(3, HOT_LEAD_STAR_MAX), 1);
  assert.equal(starsRank(1, HOT_LEAD_STAR_MAX), 3);
  assert.equal(starsRank(null, HOT_LEAD_STAR_MAX), 99);
});

test("v2 migration tightens only the leads star constraint to 1-3", async () => {
  const sql = await readFile(
    new URL("../../supabase/migrations_v2/20260702120000_leads_three_star_rating.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /alter table beacon_v2\.leads\s+drop constraint if exists leads_stars_range/i);
  assert.match(sql, /check \(stars is null or \(stars between 1 and 3\)\)/i);
  assert.doesNotMatch(sql, /events_stars_range/i);
});

test("hot leads table rating cell has a 3-star visual guard", async () => {
  const tableSource = await readFile(new URL("../src/tables.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(tableSource, /className="td hotlead-rating"/);
  assert.match(tableSource, /<StarRating value=\{r\.stars\}\s+max=\{HOT_LEAD_STAR_MAX\}/);
  assert.match(css, /\.hotlead-rating\s+\.star-btn:nth-of-type\(n\+4\)/);
});
