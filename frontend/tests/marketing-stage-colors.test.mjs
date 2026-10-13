import assert from "node:assert/strict";
import test from "node:test";
import { MARKETING_STAGES } from "../src/marketing-rules.js";
import {
  MARKETING_STAGE_COLORS,
  marketingStageHue,
  marketingStageStyle,
} from "../src/marketing-components/stage-colors.js";

test("one colour per canonical stage, in pipeline order", () => {
  assert.equal(MARKETING_STAGE_COLORS.length, 7);
  assert.deepEqual(MARKETING_STAGE_COLORS.map(color => color.name), MARKETING_STAGES.map(stage => stage.name));
});

test("ramp runs red → green with strictly increasing hue", () => {
  const hues = MARKETING_STAGE_COLORS.map(color => color.hue);
  assert.ok(hues[0] >= 0 && hues[0] <= 10, `first hue ${hues[0]} should be red`);
  assert.ok(hues.at(-1) >= 120 && hues.at(-1) <= 145, `last hue ${hues.at(-1)} should be green`);
  for (let i = 1; i < hues.length; i += 1) assert.ok(hues[i] > hues[i - 1], `hue ${i} must exceed hue ${i - 1}`);
  // The middle of the pipeline passes through orange / yellow.
  assert.ok(hues[2] > 30 && hues[2] < 60);
});

test("hue helper clamps out-of-range indexes and exposes a CSS custom property", () => {
  assert.equal(marketingStageHue(-3), MARKETING_STAGE_COLORS[0].hue);
  assert.equal(marketingStageHue(99), MARKETING_STAGE_COLORS.at(-1).hue);
  assert.equal(marketingStageStyle(0)["--stage-hue"], String(MARKETING_STAGE_COLORS[0].hue));
});
