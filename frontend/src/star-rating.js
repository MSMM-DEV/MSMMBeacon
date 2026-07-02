export const DEFAULT_STAR_MAX = 5;
export const HOT_LEAD_STAR_MAX = 3;

export const starOptions = (max = DEFAULT_STAR_MAX) => (
  Array.from({ length: Math.max(0, Number(max) || 0) }, (_, i) => i + 1)
);

export const starLabel = (value, max = DEFAULT_STAR_MAX) => (
  value ? `${value} of ${max} stars` : "Unrated"
);

export const starsRank = (value, max = DEFAULT_STAR_MAX) => (
  value == null ? 99 : max + 1 - Number(value)
);
