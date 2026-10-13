// Sales (marketing) pipeline stage colours — a red → orange → yellow → green
// ramp that reads as "how far along" a deal is. Pure, so it can be unit
// tested and reused by any surface that wants to echo a stage's colour.
//
// Only a HUE is produced. Saturation / lightness live in CSS
// (design/pages/marketing.css) and are tuned separately for the light and
// dark themes, so the same hue yields readable ink on a tinted surface in
// both — text is never placed on the saturated accent itself.
import { MARKETING_STAGES } from "../marketing-rules.js";

export const STAGE_HUE_START = 4;    // red
export const STAGE_HUE_END = 138;    // green

/** Hue (degrees) for stage `index` of `count`, evenly spaced along the ramp. */
export function marketingStageHue(index, count = MARKETING_STAGES.length) {
  const steps = Math.max(1, count - 1);
  const clamped = Math.min(Math.max(Number(index) || 0, 0), steps);
  return Math.round((STAGE_HUE_START + ((STAGE_HUE_END - STAGE_HUE_START) * clamped) / steps) * 10) / 10;
}

/** One entry per canonical stage, in pipeline order. */
export const MARKETING_STAGE_COLORS = Object.freeze(MARKETING_STAGES.map((stage, index, all) => Object.freeze({
  name: stage.name,
  index,
  hue: marketingStageHue(index, all.length),
})));

/** Inline style object carrying the stage hue as a CSS custom property. */
export function marketingStageStyle(index, count = MARKETING_STAGES.length) {
  return { "--stage-hue": String(marketingStageHue(index, count)) };
}
