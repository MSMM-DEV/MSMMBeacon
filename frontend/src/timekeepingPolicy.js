const FORCE_IN_CATEGORIES = new Set(["work"]);
const FORCE_OUT_CATEGORIES = new Set([
  "travel",
  "lunch",
  "break",
  "eod",
  "vacation",
  "holiday",
  "off",
  "meeting_untagged",
]);

export function presenceForCategory(category, interval = null) {
  if (FORCE_IN_CATEGORIES.has(category)) return false;
  if (FORCE_OUT_CATEGORIES.has(category)) return true;
  return interval?.isOut;
}

export function patchForIntervalCategory({ category, interval = null }) {
  const patch = { category };
  const isOut = presenceForCategory(category, interval);
  if (typeof isOut === "boolean" && isOut !== interval?.isOut) {
    patch.is_out = isOut;
  }
  return patch;
}
