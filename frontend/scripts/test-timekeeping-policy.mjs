import assert from "node:assert/strict";
import {
  presenceForCategory,
  patchForIntervalCategory,
} from "../src/timekeepingPolicy.js";

const currentIn = { isOut: false };
const currentOut = { isOut: true };

assert.equal(presenceForCategory("work", currentOut), false, "Working must always be IN/green");
assert.equal(presenceForCategory("travel", currentIn), true, "Site visit must always be OUT/red");
assert.equal(presenceForCategory("lunch", currentIn), true, "Lunch must always be OUT/red");
assert.equal(presenceForCategory("break", currentIn), true, "Break must always be OUT/red");
assert.equal(presenceForCategory("vacation", currentIn), true, "Vacation must always be OUT/red");
assert.equal(presenceForCategory("eod", currentIn), true, "Done for the day must always be OUT/red");

assert.equal(presenceForCategory("meeting", currentIn), false, "Meeting can stay IN/green");
assert.equal(presenceForCategory("meeting", currentOut), true, "Meeting can stay OUT/red");

assert.deepEqual(
  patchForIntervalCategory({ category: "work", interval: currentOut }),
  { category: "work", is_out: false },
  "Working patch should normalize a previously OUT interval to IN",
);

assert.deepEqual(
  patchForIntervalCategory({ category: "meeting", interval: currentIn }),
  { category: "meeting" },
  "Meeting patch should preserve current presence",
);
