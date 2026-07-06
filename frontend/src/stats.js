import { HOT_LEAD_STAR_MAX } from "./star-rating.js";

export function hotLeadStatsBreakdown(leads = []) {
  const buckets = {
    3: 0,
    2: 0,
    1: 0,
    untagged: 0,
  };

  for (const lead of leads || []) {
    const amount = Number(lead?.anticipatedAmount) || 0;
    const stars = Number(lead?.stars);
    if (Number.isInteger(stars) && stars >= 1 && stars <= HOT_LEAD_STAR_MAX) {
      buckets[stars] += amount;
    } else {
      buckets.untagged += amount;
    }
  }

  return {
    total: Object.values(buckets).reduce((sum, value) => sum + value, 0),
    items: [
      { key: "3", label: "3-star", value: buckets[3] },
      { key: "2", label: "2-star", value: buckets[2] },
      { key: "1", label: "1-star", value: buckets[1] },
      { key: "untagged", label: "Untagged", value: buckets.untagged },
    ],
  };
}
