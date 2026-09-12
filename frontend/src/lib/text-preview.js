// Display-only excerpt. Always keep the original value in the editor/write path.
export function textPreview(value, wordLimit = 20) {
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const truncated = words.length > wordLimit;
  return {
    text: words.slice(0, wordLimit).join(" ") + (truncated ? "..." : ""),
    truncated,
  };
}
